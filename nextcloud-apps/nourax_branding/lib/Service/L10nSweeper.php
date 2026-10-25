<?php

declare(strict_types=1);

/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\NouraxBranding\Service;

/**
 * The rules of the text sweep, applied to one translation folder at a time. It uses no Nextcloud
 * class, so tests/run.php loads it on its own. SweepRunner reads and writes the files.
 *
 * Nextcloud 35 reads a theme's translations in two ways (checked in the 35.0.2 source):
 * - the server (OC\L10N\Factory::getL10nFilesForApp) loads themes/<theme>/<folder>/<lang>.json after
 *   the app's own file and merges the two, so the theme file holds only the texts that change;
 * - the browser gets one <lang>.js per app: OC\Template\JSResourceLocator stops at the first file it
 *   finds and looks in the theme first, so the theme's file is a full copy with the changes in it.
 *
 * The rules come from sweep/rules.json (shared with scripts/check-branding.sh) and the curated
 * texts from sweep/en-overrides.json.
 */
final class L10nSweeper {
	/** Raise this when the same input gives other output: the background job then sweeps again. */
	public const VERSION = 2;
	/** Top-level key of the theme JSON files the sweep writes. Nextcloud reads only "translations". */
	public const MARKER = 'nouraxSweep';
	public const DEFAULT_PLURAL = 'nplurals=2; plural=(n != 1);';
	private const JSON_FLAGS = JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE;
	private const BOM = "\xEF\xBB\xBF";
	/** A letter of a script that adds endings to names: "Nextcloudi" becomes "Nourax Workspace-i". */
	private const ENDING = '~\G[\p{Latin}\p{Cyrillic}\p{Greek}\p{Armenian}\p{Georgian}]~u';
	/** An Arabic-script letter (not the tatweel itself, which PCRE also counts as Arabic). */
	private const ARABIC_BEFORE = '~(?=\p{Arabic})(?!\x{0640})\p{L}\p{M}*$~u';
	private const ARABIC_AFTER = '~\G(?=\p{Arabic})(?!\x{0640})\p{L}~u';
	/** Placeholders such as {productName}, %s, %1$s and %n are never changed. */
	private const PLACEHOLDER = '~\{[A-Za-z0-9_.-]+\}|%(?:\d+\$)?[sdfnu]~';

	private string $product;
	/** @var list<string> name patterns that become the product name */
	private array $names = [];
	/** @var list<string> every name pattern: does a text name the upstream at all */
	private array $detect = [];
	/** @var list<string> */
	private array $links = [];
	/** @var list<array{re: string, to: string, langs: string}> */
	private array $phrases = [];
	/** @var array<string, array<string, list<array{0: string, 1: string}>>> app => key => [from, to] */
	private array $keyRules = [];
	/** @var array<string, array<string, string|list<string>>> */
	private array $english = [];
	/** @var array<string, array<string, string|list<string>>> */
	private array $everyLanguage = [];
	/** @var array<string, array<string, array<string, string|list<string>>>> lang => app => key => text */
	private array $byLanguage = [];
	/** @var list<string> */
	private array $keep = [];
	/**
	 * near_name from rules.json, ready to use: the name's letters, its letter pairs, the word pattern.
	 * @var array{chars: list<string>, pairs: list<string>, need: int, distance: int, min: int, max: int, word: string}|null
	 */
	private ?array $near = null;
	/** @var array<string, true> spellings near_name found since the last takeGuessed() */
	private array $guessed = [];

	/**
	 * @param array $rules the decoded sweep/rules.json
	 * @param array $overrides the decoded sweep/en-overrides.json
	 */
	public function __construct(array $rules, array $overrides) {
		$sweep = is_array($rules['sweep'] ?? null) ? $rules['sweep'] : [];
		$this->product = (string)($sweep['product'] ?? 'Nourax Workspace');
		$skip = is_array($sweep['generic_skip'] ?? null) ? $sweep['generic_skip'] : [];
		foreach ($rules['name_patterns'] ?? [] as $p) {
			$re = self::compile((string)$p['re']);
			$this->detect[] = $re;
			if (!in_array($p['id'] ?? '', $skip, true)) {
				$this->names[] = $re;
			}
		}
		foreach ($rules['link_patterns'] ?? [] as $p) {
			$this->links[] = self::compile((string)$p['re']);
		}
		foreach ($sweep['phrases'] ?? [] as $p) {
			$langs = (string)($p['langs'] ?? 'all');
			if (!in_array($langs, ['all', 'en', 'other'], true)) {
				throw new \InvalidArgumentException('phrase langs must be en, other or left out: ' . $p['re']);
			}
			$this->phrases[] = ['re' => self::compile((string)$p['re']), 'to' => (string)$p['to'], 'langs' => $langs];
		}
		foreach ($sweep['key_rules'] ?? [] as $r) {
			$this->keyRules[(string)$r['app']][(string)$r['key']][] = [(string)$r['from'], (string)$r['to']];
		}
		$this->english = is_array($overrides['english'] ?? null) ? $overrides['english'] : [];
		$this->everyLanguage = is_array($overrides['every_language'] ?? null) ? $overrides['every_language'] : [];
		$this->byLanguage = is_array($overrides['by_language'] ?? null) ? $overrides['by_language'] : [];
		$this->keep = array_map('strval', is_array($sweep['keep'] ?? null) ? $sweep['keep'] : []);
		$near = $rules['near_name'] ?? null;
		if (is_array($near) && is_string($near['word'] ?? null) && $near['word'] !== '') {
			$chars = mb_str_split(mb_strtolower($near['word'], 'UTF-8'), 1, 'UTF-8');
			$pairs = [];
			for ($i = 0; $i + 1 < count($chars); $i++) {
				$pairs[$chars[$i] . $chars[$i + 1]] = true;
			}
			$distance = max(0, (int)($near['max_distance'] ?? 2));
			$min = max(1, (int)($near['min_length'] ?? count($chars) - $distance));
			$this->near = [
				'chars' => $chars,
				'pairs' => array_map('strval', array_keys($pairs)),
				// One edit breaks at most three letter pairs of the name (a swap does), so a spelling
				// within the distance keeps at least this many: a quick test before the real one.
				'need' => max(1, count($pairs) - 3 * $distance),
				'distance' => $distance,
				'min' => $min,
				'max' => max($min, (int)($near['max_length'] ?? count($chars) + $distance)),
				'word' => '~(?<!\p{L})[A-Za-z\x{00C0}-\x{00D6}\x{00D8}-\x{00F6}\x{00F8}-\x{024F}]{' . $min . ',}~u',
			];
		}
	}

	private static function compile(string $re): string {
		$re = '~' . $re . '~u';
		if (@preg_match($re, '') === false) {
			throw new \InvalidArgumentException('not a valid pattern: ' . $re);
		}
		return $re;
	}

	public static function isEnglish(string $lang): bool {
		return $lang === 'en' || str_starts_with($lang, 'en_') || str_starts_with($lang, 'en@');
	}

	public static function isPluralKey(string $key): bool {
		return preg_match('/^_(.*)_::_(.*)_$/s', $key) === 1;
	}

	/** The number of plural forms in a pluralForm string such as "nplurals=2; plural=(n != 1);". */
	public static function nplurals(string $plural): int {
		return preg_match('/nplurals\s*=\s*(\d+)/', $plural, $m) ? max(1, (int)$m[1]) : 2;
	}

	/**
	 * Reads a translation file. Nextcloud (OC\L10N\L10N::load) decodes it with json_decode as it is,
	 * which fails on a file that starts with a byte order mark (onlyoffice's eu.json does): Nextcloud
	 * then shows that language's texts in English. The sweep reads such a file all the same.
	 *
	 * @return array{0: array|null, 1: bool} the decoded file (null when it is no JSON object) and
	 *                                       whether Nextcloud itself can read it
	 */
	public static function decodeFile(string $raw): array {
		$data = json_decode($raw, true);
		if (is_array($data)) {
			return [$data, true];
		}
		if (str_starts_with($raw, self::BOM)) {
			$data = json_decode(substr($raw, strlen(self::BOM)), true);
			if (is_array($data)) {
				return [$data, false];
			}
		}
		return [null, false];
	}

	/**
	 * Reads a browser translation file, OC.L10N.register("app", {...}, "plural").
	 *
	 * @return array|null its translations, or null when it is not in that form
	 */
	public static function decodeJs(string $raw): ?array {
		if (str_starts_with($raw, self::BOM)) {
			$raw = substr($raw, strlen(self::BOM));
		}
		if (preg_match('~OC\.L10N\.register\(\s*"(?:[^"\\\\]|\\\\.)*"\s*,\s*(\{.*\})\s*,\s*"(?:[^"\\\\]|\\\\.)*"\s*\)\s*;?\s*$~s', $raw, $m) !== 1) {
			return null;
		}
		$data = json_decode($m[1], true);
		if (!is_array($data)) {
			// JavaScript allows escapes JSON does not, such as \$ in onlyoffice's files: \$ is $.
			$fixed = preg_replace_callback('~\\\\(.)~su', fn (array $e): string => str_contains('"\\/bfnrtu', $e[1]) ? $e[0] : $e[1], $m[1]);
			$data = is_string($fixed) ? json_decode($fixed, true) : null;
		}
		return is_array($data) ? $data : null;
	}

	/**
	 * The full browser file of one language. The browser shows the app's own .js file, which is not
	 * always the same as its .json file (onlyoffice's ja.js has texts its ja.json does not), so the
	 * copy starts from the .js texts and sweeps them too; the .json texts fill in what the .js lacks.
	 *
	 * @param array $json the folder's own .json translations of this language
	 * @param array|null $js the folder's own .js translations of this language (null: none or unreadable)
	 * @param array $changes what build() returned as 'translations' (the changed texts and the
	 *                       texts of other tools, see foreign())
	 * @param array $foreign what build() returned as 'foreign': these stay as they are
	 */
	public function browserCopy(string $app, string $lang, array $json, ?array $js, array $changes, array $foreign): array {
		$full = $json;
		foreach ($changes as $k => $v) {
			$full[$k] = $v;
		}
		foreach ($js ?? [] as $k => $v) {
			if (array_key_exists($k, $foreign) || (!is_string($v) && !is_array($v))) {
				continue;
			}
			if (array_key_exists($k, $json) && $json[$k] === $v) {
				// The same text as in the .json file: build() swept it already (or left it alone).
				continue;
			}
			if ($v === '' || $v === []) {
				// An empty text shows the English source text: keep what the .json side has.
				continue;
			}
			$full[$k] = $this->value($app, (string)$k, $v, $lang);
		}
		return $full;
	}

	/** @return list<string> the words that must stay as they are (ONLYOFFICE) */
	public function keepWords(): array {
		return $this->keep;
	}

	/** Whether a text names the upstream project in any known spelling, or in one close to it. */
	public function hasName(string $s): bool {
		foreach ($this->detect as $re) {
			if (preg_match($re, $s) === 1) {
				return true;
			}
		}
		return $this->nearHits($s) !== [];
	}

	/**
	 * The words of a text that begin with a spelling close to the name (near_name in rules.json),
	 * also spellings that no name pattern lists.
	 *
	 * @return list<array{0: int, 1: int}> byte offset and byte length of each such beginning
	 */
	public function nearHits(string $s): array {
		$n = $this->near;
		if ($n === null || preg_match_all($n['word'], $s, $m, PREG_OFFSET_CAPTURE) < 1) {
			return [];
		}
		$hits = [];
		foreach ($m[0] as [$word, $offset]) {
			$len = $this->nearLength($word);
			if ($len > 0) {
				$hits[] = [$offset, strlen(mb_substr($word, 0, $len, 'UTF-8'))];
			}
		}
		return $hits;
	}

	/** How many letters at the start of a word spell the name (0: none). On a tie the longer wins. */
	private function nearLength(string $word): int {
		$n = $this->near;
		$lower = mb_strtolower($word, 'UTF-8');
		$have = 0;
		foreach ($n['pairs'] as $pair) {
			if (str_contains($lower, $pair) && ++$have >= $n['need']) {
				break;
			}
		}
		if ($have < $n['need']) {
			return 0;
		}
		// Optimal string alignment distance of each beginning of the word to the name: row $i of the
		// table is the beginning of $i letters. Letters are lowered one by one, so they stay in step.
		$a = array_map(fn (string $c): string => mb_strtolower($c, 'UTF-8'), mb_str_split($word, 1, 'UTF-8'));
		$t = $n['chars'];
		$tn = count($t);
		$rows = min(count($a), $n['max']);
		$prev2 = [];
		$prev = range(0, $tn);
		$best = PHP_INT_MAX;
		$bestLen = 0;
		for ($i = 1; $i <= $rows; $i++) {
			$cur = [$i];
			for ($j = 1; $j <= $tn; $j++) {
				$v = min($prev[$j] + 1, $cur[$j - 1] + 1, $prev[$j - 1] + ($a[$i - 1] === $t[$j - 1] ? 0 : 1));
				if ($i > 1 && $j > 1 && $a[$i - 1] === $t[$j - 2] && $a[$i - 2] === $t[$j - 1]) {
					$v = min($v, $prev2[$j - 2] + 1);
				}
				$cur[$j] = $v;
			}
			if ($i >= $n['min'] && $cur[$tn] <= $best) {
				$best = $cur[$tn];
				$bestLen = $i;
			}
			$prev2 = $prev;
			$prev = $cur;
		}
		return $best <= $n['distance'] ? $bestLen : 0;
	}

	/** @return list<string> the spellings near_name found and replaced since the last call, in lower case */
	public function takeGuessed(): array {
		$g = array_map('strval', array_keys($this->guessed));
		sort($g, SORT_STRING);
		$this->guessed = [];
		return $g;
	}

	/** Whether a link points to the upstream project (any address with the name in it counts). */
	public function isUpstreamLink(string $url): bool {
		$u = html_entity_decode(trim($url), ENT_QUOTES | ENT_HTML5, 'UTF-8');
		if (preg_match('~^[a-z][a-z0-9+.-]*:~i', $u) !== 1) {
			$u = 'https://' . ltrim($u, '/');
		}
		foreach ($this->links as $re) {
			if (preg_match($re, $u) === 1) {
				return true;
			}
		}
		return $this->hasName($u);
	}

	/**
	 * One text, in one language: links to the upstream lose their address, then the phrases, then
	 * every spelling of the name becomes the product name. Running it twice gives the same text.
	 */
	public function transform(string $s, string $lang): string {
		if (!$this->hasName($s)) {
			return $s;
		}
		// Placeholders that happen to hold the name are code, not text: hide them while sweeping.
		$masks = [];
		$s = preg_replace_callback(self::PLACEHOLDER, function (array $m) use (&$masks): string {
			if (!$this->hasName($m[0])) {
				return $m[0];
			}
			$token = "\u{E000}" . count($masks) . "\u{E001}";
			$masks[$token] = $m[0];
			return $token;
		}, $s) ?? $s;
		$s = $this->unlink($s);
		$english = self::isEnglish($lang);
		foreach ($this->phrases as $p) {
			if (($p['langs'] === 'en' && !$english) || ($p['langs'] === 'other' && $english)) {
				continue;
			}
			$s = preg_replace($p['re'], $p['to'], $s) ?? $s;
		}
		$s = $this->replaceNames($s);
		return $masks === [] ? $s : strtr($s, $masks);
	}

	private function unlink(string $s): string {
		// HTML links keep their text: <a href="https://github.com/nextcloud/...">community</a>.
		$s = preg_replace_callback(
			'~<a\b[^>]*?\bhref\s*=\s*(["\'])(.*?)\1[^>]*>(.*?)</a\s*>~uis',
			fn (array $m): string => $this->isUpstreamLink($m[2]) ? $m[3] : $m[0],
			$s,
		) ?? $s;
		// Markdown links keep their text; Markdown images of the upstream go.
		$s = preg_replace_callback(
			'~(!?)\[([^\]\n]*)\]\(\s*<?([^()\s<>]+)>?(?:\s+"[^"\n]*")?\s*\)~u',
			fn (array $m): string => $this->isUpstreamLink($m[3]) ? ($m[1] === '!' ? '' : $m[2]) : $m[0],
			$s,
		) ?? $s;
		// Bare addresses: with a scheme, or the upstream hosts and e-mail addresses written without one.
		// Example cloud IDs such as user@your-nextcloud.org stay for the phrases to rewrite.
		$dropped = false;
		$s = preg_replace_callback(
			'~[ \t]*(?<![\w@./-])((?:https?://|mailto:)[^\s<>"\'()\[\]]+|(?:[\w.+-]+@)?(?:[a-z0-9-]+\.)*next ?cloud\.com\b[^\s<>"\'()\[\]]*|(?:www\.)?github\.com/nextcloud[^\s<>"\'()\[\]]*)~iu',
			function (array $m) use (&$dropped): string {
				$url = rtrim($m[1], '.,;:!?');
				if (!$this->isUpstreamLink($url)) {
					return $m[0];
				}
				$dropped = true;
				return substr($m[1], strlen($url));
			},
			$s,
		) ?? $s;
		if ($dropped) {
			// "(see https://nextcloud.com/x)" leaves "(see )": drop brackets left empty.
			$s = preg_replace('~[ \t]*\(\s*\)~u', '', $s) ?? $s;
		}
		return $s;
	}

	private function replaceNames(string $s): string {
		foreach ($this->names as $re) {
			if (preg_match_all($re, $s, $m, PREG_OFFSET_CAPTURE) < 1) {
				continue;
			}
			$spans = [];
			foreach ($m[0] as [$text, $offset]) {
				$spans[] = [$offset, strlen($text)];
			}
			$s = $this->replaceSpans($s, $spans);
		}
		// Last, the spellings no pattern lists: kept for --report, so they can be added to the rules.
		$spans = $this->nearHits($s);
		foreach ($spans as [$offset, $len]) {
			$this->guessed[mb_strtolower(substr($s, $offset, $len), 'UTF-8')] = true;
		}
		return $spans === [] ? $s : $this->replaceSpans($s, $spans);
	}

	/** @param list<array{0: int, 1: int}> $spans byte offset and byte length of each name, in order */
	private function replaceSpans(string $s, array $spans): string {
		$out = '';
		$pos = 0;
		foreach ($spans as [$offset, $len]) {
			if ($len === 0 || $offset < $pos) {
				continue;
			}
			$end = $offset + $len;
			$name = $this->product;
			// An Arabic prefix such as ل joins a Latin name with a tatweel: لـNourax Workspace.
			$prev = mb_substr(substr($s, 0, $offset), -4, null, 'UTF-8');
			if (preg_match(self::ARABIC_BEFORE, $prev) === 1) {
				$name = "\u{0640}" . $name;
			}
			// An ending stays, after a hyphen ("Nextcloudhoz" becomes "Nourax Workspace-hoz"); an
			// Arabic-script ending after a space.
			if (preg_match(self::ENDING, $s, $unused, 0, $end) === 1) {
				$name .= '-';
			} elseif (preg_match(self::ARABIC_AFTER, $s, $unused, 0, $end) === 1) {
				$name .= ' ';
			}
			$out .= substr($s, $pos, $offset - $pos) . $name;
			$pos = $end;
		}
		return $out . substr($s, $pos);
	}

	/** @return string|list<string>|null the curated text for this key and language, if there is one */
	public function override(string $app, string $key, string $lang): string|array|null {
		$o = $this->byLanguage[$lang][$app][$key] ?? $this->everyLanguage[$app][$key] ?? null;
		if ($o === null && self::isEnglish($lang)) {
			$o = $this->english[$app][$key] ?? null;
		}
		return $o;
	}

	/** @return list<array{0: string, 1: string}> curated keys of an app that are worth checking for */
	public function overrideKeys(string $app): array {
		$keys = [];
		foreach (['english' => $this->english, 'every_language' => $this->everyLanguage] as $kind => $list) {
			foreach (array_keys($list[$app] ?? []) as $k) {
				$keys[] = [$kind, (string)$k];
			}
		}
		foreach ($this->byLanguage as $lang => $apps) {
			foreach (array_keys(is_array($apps[$app] ?? null) ? $apps[$app] : []) as $k) {
				$keys[] = ["by_language $lang", (string)$k];
			}
		}
		return $keys;
	}

	/** @return list<string> the app ids that have curated texts */
	public function overrideApps(): array {
		$apps = array_merge(array_keys($this->english), array_keys($this->everyLanguage));
		foreach ($this->byLanguage as $list) {
			$apps = array_merge($apps, array_keys(is_array($list) ? $list : []));
		}
		return array_values(array_unique(array_map('strval', $apps)));
	}

	/** Whether a translation key must be translated in every language (it names the upstream). */
	public function isNameKey(string $app, string $key): bool {
		return $this->hasName($key) || isset($this->keyRules[$app][$key])
			|| isset($this->english[$app][$key]) || isset($this->everyLanguage[$app][$key]);
	}

	/** @param string|list<string> $o */
	private static function forms(string|array $o, int $n): array {
		$o = array_values(array_map('strval', (array)$o));
		if ($n <= 1) {
			return [end($o)];
		}
		$forms = [];
		for ($i = 0; $i < $n; $i++) {
			$forms[] = $o[min($i, count($o) - 1)];
		}
		return $forms;
	}

	private function text(string $app, string $key, string $s, string $lang): string {
		foreach ($this->keyRules[$app][$key] ?? [] as [$from, $to]) {
			$s = str_replace($from, $to, $s);
		}
		return $this->transform($s, $lang);
	}

	/**
	 * The swept translation of one key in one language.
	 *
	 * @param string|array $value the translation as it is now (a list for a plural key)
	 * @return string|array
	 */
	public function value(string $app, string $key, string|array $value, string $lang): string|array {
		$o = $this->override($app, $key, $lang);
		if ($o !== null) {
			return is_array($value) ? self::forms($o, count($value)) : (is_array($o) ? (string)$o[0] : $o);
		}
		if (is_array($value)) {
			return array_map(fn ($v) => is_string($v) ? $this->text($app, $key, $v, $lang) : $v, $value);
		}
		return $this->text($app, $key, $value, $lang);
	}

	/**
	 * The text for a key that names the upstream but has no translation in this language. Nextcloud
	 * would show the English source text, so this is that text, swept (or the curated text).
	 *
	 * @return string|list<string>
	 */
	public function fill(string $app, string $key, string $lang, int $nplurals): string|array {
		$o = $this->byLanguage[$lang][$app][$key] ?? $this->everyLanguage[$app][$key] ?? $this->english[$app][$key] ?? null;
		if (preg_match('/^_(.*)_::_(.*)_$/s', $key, $pk) === 1) {
			$o ??= [$this->text($app, $key, $pk[1], 'en'), $this->text($app, $key, $pk[2], 'en')];
			return self::forms($o, $nplurals);
		}
		if ($o !== null) {
			return is_array($o) ? (string)$o[0] : $o;
		}
		return $this->text($app, $key, $key, 'en');
	}

	/**
	 * The translations another tool wrote into a theme file (for example the NoGantt wording of
	 * scripts/configure.d/55-gantt.sh). A file the sweep wrote and nobody changed since carries its
	 * marker with the digest of its translations: its foreign part is the one stored in the marker.
	 * Any other file is foreign as a whole, and the sweep builds on top of it.
	 *
	 * @param array|null $file the decoded theme JSON file, or null when there is none
	 */
	public static function foreign(?array $file): array {
		if (!is_array($file) || !is_array($file['translations'] ?? null)) {
			return [];
		}
		$marker = $file[self::MARKER] ?? null;
		if (is_array($marker) && ($marker['sha256'] ?? null) === self::digest($file['translations'])) {
			return is_array($marker['foreign'] ?? null) ? $marker['foreign'] : [];
		}
		return $file['translations'];
	}

	public static function digest(array $translations): string {
		return hash('sha256', (string)json_encode((object)$translations, self::JSON_FLAGS));
	}

	/**
	 * Sweep one translation folder.
	 *
	 * @param array<string, array{translations: array, plural: string, unreadable?: bool}> $orig the
	 *        folder's own files, by language; 'unreadable' when Nextcloud cannot read the file itself
	 *        (see decodeFile)
	 * @param array<string, array|null> $theme the theme's files for the folder as they are now, by language
	 * @return array<string, array{translations: array, server: array, foreign: array, plural: string, unreadable: bool, changed: int, filled: int, unknown: list<string>}>
	 *               by language: 'translations' are the texts that change, 'server' what the theme
	 *               JSON file must hold (the same, or every text when Nextcloud cannot read the
	 *               folder's own file). 'en' is always there.
	 */
	public function build(string $app, array $orig, array $theme): array {
		$langs = array_values(array_unique(array_map('strval', array_merge(array_keys($orig), array_keys($theme), ['en']))));
		sort($langs, SORT_STRING);
		$nameKeys = [];
		foreach ($langs as $lang) {
			foreach (array_keys($orig[$lang]['translations'] ?? []) as $k) {
				$k = (string)$k;
				if (!isset($nameKeys[$k]) && $this->isNameKey($app, $k)) {
					$nameKeys[$k] = true;
				}
			}
		}
		$result = [];
		foreach ($langs as $lang) {
			$plural = $orig[$lang]['plural'] ?? null;
			if (!is_string($plural) || $plural === '') {
				$plural = is_string($theme[$lang]['pluralForm'] ?? null) ? $theme[$lang]['pluralForm'] : self::DEFAULT_PLURAL;
			}
			$foreign = self::foreign($theme[$lang] ?? null);
			$own = $orig[$lang]['translations'] ?? [];
			$base = $own;
			foreach ($foreign as $k => $v) {
				$base[$k] = $v;
			}
			$tr = $foreign;
			$changed = 0;
			$filled = 0;
			$unknown = [];
			foreach ($base as $k => $v) {
				if (!is_string($v) && !is_array($v)) {
					continue;
				}
				$k = (string)$k;
				if ($v === '' && isset($nameKeys[$k])) {
					// An empty translation: the browser shows the English source text instead (and the
					// server stops with an error), so it gets the swept English text.
					$tr[$k] = $this->fill($app, $k, $lang, self::nplurals($plural));
					$filled++;
					continue;
				}
				$nv = $this->value($app, $k, $v, $lang);
				if ($nv !== $v) {
					$tr[$k] = $nv;
					$changed++;
				} elseif (!self::isEnglish($lang) && isset($nameKeys[$k]) && $this->hasName($k)
					&& array_key_exists($k, $own) && !array_key_exists($k, $foreign)) {
					// The key names the upstream but the translation has no spelling we know: either the
					// translator left the name out, or it is a new spelling for rules.json.
					$unknown[] = $k;
				}
			}
			foreach (array_keys($nameKeys) as $k) {
				$k = (string)$k;
				if (!array_key_exists($k, $base)) {
					$tr[$k] = $this->fill($app, $k, $lang, self::nplurals($plural));
					$filled++;
				}
			}
			$unreadable = !empty($orig[$lang]['unreadable']);
			$result[$lang] = [
				'translations' => $tr,
				'server' => $unreadable ? array_replace($own, $tr) : $tr,
				'foreign' => $foreign,
				'plural' => $plural,
				'unreadable' => $unreadable,
				'changed' => $changed,
				'filled' => $filled,
				'unknown' => $unknown,
			];
		}
		return $result;
	}

	/** The theme JSON file for the server: the changed texts only, and the sweep's marker. */
	public function encodeJson(array $translations, string $plural, array $foreign): string {
		$doc = [
			'translations' => (object)$translations,
			'pluralForm' => $plural,
			self::MARKER => [
				'about' => 'Written by occ nourax_branding:sweep (docs/branding.md). Change the rules, not this file.',
				'version' => self::VERSION,
				'sha256' => self::digest($translations),
				'foreign' => (object)$foreign,
			],
		];
		return json_encode($doc, self::JSON_FLAGS | JSON_PRETTY_PRINT) . "\n";
	}

	/** The browser file: every translation of the app in this language, in Nextcloud's own format. */
	public function encodeJs(string $name, array $translations, string $plural): string {
		return "OC.L10N.register(\n    " . json_encode($name, self::JSON_FLAGS) . ",\n    "
			. json_encode((object)$translations, self::JSON_FLAGS | JSON_PRETTY_PRINT) . ",\n"
			. json_encode($plural, self::JSON_FLAGS) . ");\n";
	}

	/** Every text in a set of translations that still names the upstream (should be none). */
	public function leftovers(array $translations): array {
		$left = [];
		foreach ($translations as $k => $v) {
			foreach ((array)$v as $s) {
				if (is_string($s) && $this->hasName($s)) {
					$left[] = (string)$k;
					break;
				}
			}
		}
		return $left;
	}
}
