<?php

declare(strict_types=1);

/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\NouraxBranding\Service;

use OCA\NouraxBranding\AppInfo\Application;
use OCA\NouraxBranding\BackgroundJob\RefreshSweep;
use OCP\App\AppPathNotFoundException;
use OCP\App\IAppManager;
use OCP\BackgroundJob\IJobList;
use OCP\IAppConfig;
use OCP\IConfig;
use OCP\ServerVersion;
use Psr\Log\LoggerInterface;

/**
 * Runs the text sweep: reads the translations of core, lib and every enabled app, lets L10nSweeper
 * work out the changes and writes them into the theme folder (themes/<theme> in the Nextcloud
 * folder, the one named by the 'theme' setting):
 * - <folder>/<lang>.json for the server, for example themes/nourax/apps/settings/l10n/de.json;
 * - <app>/l10n/<lang>.js for the browser (core: core/core/l10n/<lang>.js), a full copy;
 * - sweep-state.json: the server version, the rules and the version of every app it swept, which
 *   the background job and scripts/check-branding.sh --server compare with what is installed.
 *
 * A file is only written when its content changes, always in one step (a temporary file, then a
 * rename), and nothing is ever deleted. Called by occ nourax_branding:sweep, by AppChangeListener
 * when an app is switched on or updated, and by the RefreshSweep background job.
 */
class SweepRunner {
	public const STATE_FILE = 'sweep-state.json';

	public function __construct(
		private IConfig $config,
		private IAppConfig $appConfig,
		private IAppManager $appManager,
		private IJobList $jobList,
		private ServerVersion $serverVersion,
		private LoggerInterface $logger,
	) {
	}

	/** The theme named in config.php ('' when none is set). */
	public function theme(): string {
		return trim($this->config->getSystemValueString('theme', ''));
	}

	public function themeRoot(): string {
		$theme = $this->theme();
		if ($theme === '' || preg_match('/^[A-Za-z0-9_-]+$/', $theme) !== 1) {
			throw new \RuntimeException("No usable theme is set (theme is '$theme'): run occ config:system:set theme --value=nourax first");
		}
		return \OC::$SERVERROOT . '/themes/' . $theme;
	}

	public function serverVersionString(): string {
		return implode('.', $this->serverVersion->getVersion());
	}

	/** The folder with rules.json and en-overrides.json (protected so a test can point elsewhere). */
	protected function sweepDir(): string {
		return $this->appManager->getAppPath(Application::APP_ID) . '/sweep';
	}

	public function sweeper(): L10nSweeper {
		return new L10nSweeper(self::readJson($this->sweepDir() . '/rules.json'), self::readJson($this->sweepDir() . '/en-overrides.json'));
	}

	/** Changes when the rules, the curated texts or the sweep itself change. */
	public function rulesDigest(): string {
		$dir = $this->sweepDir();
		return hash('sha256', L10nSweeper::VERSION . "\n" . (string)file_get_contents("$dir/rules.json")
			. "\n" . (string)file_get_contents("$dir/en-overrides.json"));
	}

	/** @return array<string, string> app id => installed version, for every enabled app */
	public function enabledVersions(): array {
		$apps = $this->appManager->getEnabledApps();
		sort($apps, SORT_STRING);
		$versions = [];
		foreach ($apps as $app) {
			$versions[$app] = (string)$this->appManager->getAppVersion($app);
		}
		return $versions;
	}

	/**
	 * @param list<string>|null $only
	 * @return array<string, string> folder id ('core', 'lib' or an app id) => its l10n folder
	 */
	private function folders(?array $only): array {
		$root = \OC::$SERVERROOT;
		$folders = ['core' => "$root/core/l10n", 'lib' => "$root/lib/l10n"];
		$apps = $this->appManager->getEnabledApps();
		sort($apps, SORT_STRING);
		foreach ($apps as $app) {
			try {
				$path = $this->appManager->getAppPath($app);
			} catch (AppPathNotFoundException) {
				continue;
			}
			if (is_dir("$path/l10n")) {
				$folders[$app] = "$path/l10n";
			}
		}
		return $only === null ? $folders : array_intersect_key($folders, array_flip($only));
	}

	/**
	 * What the background job has to sweep: null when sweep-state.json matches what is installed,
	 * full when the server, the rules or the sweep changed, otherwise the apps that are new or updated.
	 *
	 * @return array{full: bool, apps: list<string>}|null
	 */
	public function needed(): ?array {
		$state = self::readJsonOrNull($this->themeRoot() . '/' . self::STATE_FILE);
		if (!is_array($state) || ($state['server'] ?? null) !== $this->serverVersionString()
			|| ($state['rules'] ?? null) !== $this->rulesDigest() || ($state['version'] ?? null) !== L10nSweeper::VERSION) {
			return ['full' => true, 'apps' => []];
		}
		$have = is_array($state['apps'] ?? null) ? $state['apps'] : [];
		$enabled = $this->enabledVersions();
		$apps = [];
		foreach ($enabled as $app => $version) {
			if ((string)($have[$app] ?? '') !== $version) {
				$apps[] = (string)$app;
			}
		}
		$gone = array_diff(array_map('strval', array_keys($have)), array_keys($enabled));
		return $apps === [] && $gone === [] ? null : ['full' => false, 'apps' => $apps];
	}

	/**
	 * @param list<string>|null $apps null sweeps everything: core, lib and every enabled app.
	 *                                A list sweeps only those ids ('core' and 'lib' included).
	 * @param bool $dryRun work everything out but write nothing
	 * @param bool $bump raise the theming cache buster even when no file changed
	 * @return array{theme: string, folders: array<string, array>, written: int, same: int, changed: int, filled: int, left: int, notes: list<string>}
	 */
	public function run(?array $apps = null, bool $dryRun = false, bool $bump = false): array {
		$themeRoot = $this->themeRoot();
		if (!$dryRun && !is_dir($themeRoot) && !mkdir($themeRoot, 0755, true) && !is_dir($themeRoot)) {
			throw new \RuntimeException("cannot make the theme folder $themeRoot");
		}
		$lock = $dryRun ? null : $this->lock($themeRoot);
		try {
			$sweeper = $this->sweeper();
			$sum = ['theme' => $themeRoot, 'folders' => [], 'written' => 0, 'same' => 0, 'changed' => 0, 'filled' => 0, 'left' => 0, 'notes' => []];
			$swept = [];
			$folders = $this->folders($apps);
			foreach ($folders as $id => $dir) {
				try {
					$folder = $this->sweepFolder($sweeper, $id, $dir, $themeRoot, $dryRun);
				} catch (\Throwable $e) {
					$sum['notes'][] = "$id: not swept: " . $e->getMessage();
					$this->logger->error('Branding sweep: {folder} not swept', ['app' => Application::APP_ID, 'folder' => $id, 'exception' => $e]);
					continue;
				}
				$swept[] = $id;
				$sum['folders'][$id] = $folder;
				foreach (['written', 'same', 'changed', 'filled'] as $k) {
					$sum[$k] += $folder[$k];
				}
				$sum['left'] += count($folder['left']);
			}
			if (!$dryRun) {
				// What was asked for and did not fail counts as swept, also an app without
				// translations. A folder that failed is left out, so the background job tries again.
				$failed = array_map('strval', array_keys(array_diff_key($folders, array_flip($swept))));
				$asked = $apps ?? array_merge(['core', 'lib'], array_keys($this->enabledVersions()));
				$this->writeState($themeRoot, $apps === null && $failed === [], array_values(array_diff($asked, $failed)), $failed);
				if ($sum['written'] > 0 || $bump) {
					$this->bumpCache();
				}
				$this->ensureJob();
			}
			return $sum;
		} finally {
			if ($lock !== null) {
				flock($lock, LOCK_UN);
				fclose($lock);
			}
		}
	}

	/** @return array{langs: int, written: int, same: int, changed: int, filled: int, left: list<array{0: string, 1: string}>, unknown: list<array{0: string, 1: string}>, notes: list<string>} */
	private function sweepFolder(L10nSweeper $sweeper, string $id, string $dir, string $themeRoot, bool $dryRun): array {
		$root = \OC::$SERVERROOT;
		if (!str_starts_with($dir, $root . '/')) {
			throw new \RuntimeException("$dir is outside $root, so a theme cannot change it");
		}
		$rel = substr($dir, strlen($root) + 1);
		$out = ['langs' => 0, 'written' => 0, 'same' => 0, 'changed' => 0, 'filled' => 0, 'left' => [], 'unknown' => [], 'notes' => []];

		$orig = [];
		$keys = [];
		foreach (glob("$dir/*.json") ?: [] as $file) {
			$lang = basename($file, '.json');
			$data = self::readJsonOrNull($file);
			if (!is_array($data) || !is_array($data['translations'] ?? null)) {
				$out['notes'][] = "$rel/$lang.json is not a translation file (skipped)";
				continue;
			}
			$orig[$lang] = [
				'translations' => $data['translations'],
				'plural' => is_string($data['pluralForm'] ?? null) ? $data['pluralForm'] : '',
			];
			foreach (array_keys($data['translations']) as $k) {
				$keys[(string)$k] = true;
			}
		}
		foreach ($sweeper->overrideKeys($id) as [$kind, $key]) {
			if (!isset($keys[$key])) {
				$out['notes'][] = "en-overrides.json $kind $id: no such text installed: " . self::short($key);
			}
		}

		// The name the browser file registers, from the app's own files (usually the app id).
		$jsName = $id;
		foreach (glob("$dir/*.js") ?: [] as $file) {
			$head = (string)file_get_contents($file, false, null, 0, 512);
			if (preg_match('/OC\.L10N\.register\(\s*("(?:[^"\\\\]|\\\\.)*")/', $head, $m) === 1) {
				$name = json_decode($m[1]);
				if (is_string($name) && $name !== '') {
					$jsName = $name;
					break;
				}
			}
		}

		$themeDir = "$themeRoot/$rel";
		$theme = [];
		foreach (glob("$themeDir/*.json") ?: [] as $file) {
			$data = self::readJsonOrNull($file);
			$theme[basename($file, '.json')] = is_array($data) ? $data : null;
		}

		$jsDir = $this->jsDir($id, $themeRoot);
		foreach ($sweeper->build($id, $orig, $theme) as $lang => $r) {
			$lang = (string)$lang;
			$jsonPath = "$themeDir/$lang.json";
			if ($r['translations'] === [] && !array_key_exists($lang, $theme)) {
				continue;
			}
			$out['langs']++;
			$out['changed'] += $r['changed'];
			$out['filled'] += $r['filled'];
			$file = $theme[$lang] ?? null;
			if (is_array($file) && $r['translations'] === $r['foreign'] && ($file['translations'] ?? null) === $r['foreign']) {
				// Another tool's file that needs nothing more: left as it is, so that tool and the sweep
				// do not keep rewriting it in turn.
				$out['same']++;
			} else {
				$this->put($jsonPath, $sweeper->encodeJson($r['translations'], $r['plural'], $r['foreign']), $dryRun, $out);
			}
			$full = $orig[$lang]['translations'] ?? [];
			foreach ($r['translations'] as $k => $v) {
				$full[$k] = $v;
			}
			if ($jsDir !== null) {
				$this->put("$jsDir/$lang.js", $sweeper->encodeJs($jsName, $full, $r['plural']), $dryRun, $out);
			}
			foreach ($sweeper->leftovers($full) as $k) {
				$out['left'][] = [$lang, $k];
			}
			foreach ($r['unknown'] as $k) {
				$out['unknown'][] = [$lang, $k];
			}
		}
		return $out;
	}

	/**
	 * Where the browser looks for an app's translations in the theme, first. JSResourceLocator tries,
	 * in order, core/<res>, <theme>/core/<res>, <res>, <theme>/<res> and then the app's own file, and
	 * stops at the first one that exists. The NoGantt step writes <theme>/nc_gantt/l10n too, so the
	 * sweep uses the same place for apps. Core needs <theme>/core/core/l10n (core/l10n is its own).
	 * The server-side lib folder has no browser file.
	 */
	private function jsDir(string $id, string $themeRoot): ?string {
		if ($id === 'lib') {
			return null;
		}
		if ($id === 'core' || is_dir(\OC::$SERVERROOT . '/' . $id)) {
			return "$themeRoot/core/$id/l10n";
		}
		return "$themeRoot/$id/l10n";
	}

	/** @param array{written: int, same: int} $out */
	private function put(string $path, string $content, bool $dryRun, array &$out): void {
		if (is_file($path) && file_get_contents($path) === $content) {
			$out['same']++;
			return;
		}
		$out['written']++;
		if ($dryRun) {
			return;
		}
		$dir = dirname($path);
		if (!is_dir($dir) && !mkdir($dir, 0755, true) && !is_dir($dir)) {
			throw new \RuntimeException("cannot make $dir");
		}
		$tmp = $path . '.tmp-' . getmypid() . '-' . bin2hex(random_bytes(4));
		if (file_put_contents($tmp, $content) !== strlen($content) || !rename($tmp, $path)) {
			// Our own temporary file from this run, never a real one.
			@unlink($tmp);
			throw new \RuntimeException("cannot write $path");
		}
	}

	/**
	 * 'server' and 'rules' say that core, lib and every app were swept for that server version with
	 * those rules: only a complete full run sets them. 'apps' lists each app with the version it was
	 * swept at.
	 *
	 * @param bool $complete a full run in which nothing failed
	 * @param list<string> $done the ids this run swept
	 * @param list<string> $failed the ids that failed: left out, so the background job tries again
	 */
	private function writeState(string $themeRoot, bool $complete, array $done, array $failed): void {
		$path = "$themeRoot/" . self::STATE_FILE;
		$old = self::readJsonOrNull($path);
		$enabled = $this->enabledVersions();
		if ($complete) {
			$server = $this->serverVersionString();
			$rules = $this->rulesDigest();
			$list = $enabled;
		} else {
			$coreFailed = in_array('core', $failed, true) || in_array('lib', $failed, true);
			$server = !$coreFailed && is_string($old['server'] ?? null) ? $old['server'] : null;
			$rules = !$coreFailed && is_string($old['rules'] ?? null) ? $old['rules'] : null;
			$have = is_array($old['apps'] ?? null) ? $old['apps'] : [];
			$list = [];
			foreach ($enabled as $app => $version) {
				if (in_array($app, $done, true)) {
					$list[$app] = $version;
				} elseif (!in_array($app, $failed, true) && isset($have[$app])) {
					$list[$app] = (string)$have[$app];
				}
			}
		}
		$doc = [
			'about' => 'Written by occ nourax_branding:sweep (docs/branding.md). scripts/check-branding.sh --server and the background job compare it with what is installed.',
			'version' => L10nSweeper::VERSION,
			'server' => $server,
			'rules' => $rules,
			'apps' => (object)$list,
		];
		$content = json_encode($doc, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE) . "\n";
		$out = ['written' => 0, 'same' => 0];
		$this->put($path, $content, false, $out);
	}

	/** Browsers fetch scripts again when the theming cache buster in their ?v= part changes. */
	private function bumpCache(): void {
		try {
			\OCP\Server::get(\OCA\Theming\ThemingDefaults::class)->increaseCacheBuster();
		} catch (\Throwable $e) {
			$this->logger->warning('Branding sweep: theming could not raise its cache buster, raising it here', ['app' => Application::APP_ID, 'exception' => $e]);
			$this->appConfig->setValueInt('theming', 'cachebuster', $this->appConfig->getValueInt('theming', 'cachebuster', 0) + 1);
		}
	}

	/** The background job is added here too, so this app needs no version bump for it. */
	public function ensureJob(): void {
		try {
			if (!$this->jobList->has(RefreshSweep::class, null)) {
				$this->jobList->add(RefreshSweep::class);
			}
		} catch (\Throwable $e) {
			$this->logger->warning('Branding sweep: could not add its background job', ['app' => Application::APP_ID, 'exception' => $e]);
		}
	}

	/** @return resource */
	private function lock(string $themeRoot) {
		$handle = fopen("$themeRoot/.sweep.lock", 'c');
		if ($handle === false || !flock($handle, LOCK_EX)) {
			throw new \RuntimeException('cannot take the sweep lock in ' . $themeRoot);
		}
		return $handle;
	}

	private static function readJson(string $file): array {
		$data = self::readJsonOrNull($file);
		if (!is_array($data)) {
			throw new \RuntimeException("cannot read $file");
		}
		return $data;
	}

	private static function readJsonOrNull(string $file): ?array {
		if (!is_file($file)) {
			return null;
		}
		$data = json_decode((string)file_get_contents($file), true);
		return is_array($data) ? $data : null;
	}

	public static function short(string $s, int $n = 70): string {
		$s = preg_replace('/\s+/u', ' ', $s) ?? $s;
		return mb_strlen($s) > $n ? mb_substr($s, 0, $n - 1) . '…' : $s;
	}
}
