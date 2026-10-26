<?php

declare(strict_types=1);

/**
 * The switch for privacy between organisations (docs/teams.md): the one list of server settings
 * and apps it changes, with status(), and apply('on'|'off') to switch it.
 *
 * Three ways in, all through this class, so the list lives only here:
 * - occ nourax_api:org-privacy status|on|off (Command/OrgPrivacyCommand);
 * - scripts/configure.d/60-org-privacy.sh (ORG_PRIVACY=on|off, and every configure.sh run keeps the
 *   stored state), which calls that command;
 * - the admin settings page "Nourax Workspace" (AdminSettings/PrivacySettings and
 *   Controller/PrivacySettingsController).
 *
 * The rule itself (who may share with whom while sharing is limited to group members) is
 * OrgPrivacy; this class only sets the switches it reads.
 *
 * - apply() writes a value only when it differs, so a second run changes nothing (idempotent).
 * - Sharing settings first, then the apps, then the stored state nourax_api org_privacy_step,
 *   which every later configure.sh run follows.
 * - One switch at a time: a second one meanwhile gets 423 busy (an ObjectLock, 120 s at most).
 * - Switching off enables an app again only when its code and installed versions match;
 *   otherwise nothing is changed and the answer says to run occ app:enable on the server.
 * - Every on and off (not a dry run) writes an audit row (AuditLog): who, how and what it did
 *   (switched_on, switched_off, unchanged or failed). Its route says how: "org-privacy" for occ
 *   and the configure step, "settings/org-privacy" (the switch's address under /apps/nourax_api/)
 *   for the admin page.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\NouraxApi\Service;

use OCA\NouraxApi\AppInfo\Application;
use OCP\App\IAppManager;
use OCP\IAppConfig;
use OCP\IConfig;
use OCP\Server;

class OrgPrivacySwitch {
	/** The stored state: "on" or "off" (unset before the first switch). configure.sh follows it. */
	public const STEP_KEY = 'org_privacy_step';
	/** The route of the audit rows of occ and the configure step. */
	public const AUDIT_ROUTE = 'org-privacy';
	/** The route of the admin page's audit rows: the switch's address under /apps/nourax_api/. */
	public const AUDIT_ROUTE_PAGE = 'settings/org-privacy';
	/** Both, for reading every switch back. */
	public const AUDIT_ROUTES = [self::AUDIT_ROUTE, self::AUDIT_ROUTE_PAGE];
	/** Audit results that are a change (the admin page's "Recent changes" shows only these). */
	public const AUDIT_CHANGES = ['switched_on', 'switched_off', 'failed'];

	private const LOCK = 'org-privacy';
	private const LOCK_TTL = 120;

	/** How a value is stored. */
	/** An app setting of type "mixed", as occ config:app:set stores it without --type. */
	private const MIXED = 'mixed';
	/** The same, holding a JSON list ("" counts as []). */
	private const LIST = 'list';
	/** An app setting of type boolean. */
	private const BOOL = 'bool';
	/** An app setting of type boolean that is lazy (read only when asked for). */
	private const BOOL_LAZY = 'bool-lazy';
	/** A boolean in config.php. */
	private const SYSTEM_BOOL = 'system-bool';

	/**
	 * Every setting the switch changes: [app, key, value when on, value when off, how it is
	 * stored, which effect (EFFECTS), only while this app is enabled (or null)].
	 *
	 * The off values are the server's own defaults (35.0.2), so a setting that was never stored
	 * counts as off. The list is the one 60-org-privacy.sh had on 2026-10-25, plus the two NoForms
	 * options that 50-apps.sh switches off while privacy is on (they reach every account on the
	 * server); switching off gives them back.
	 */
	public const ITEMS = [
		// Sharing: only with people who share a group (an organisation or a team) and only with
		// one's own groups. "admin" holds only the emergency admin nodrive; being in it together
		// never counts.
		['core', 'shareapi_only_share_with_group_members', 'yes', 'no', self::MIXED, 'share', null],
		['core', 'shareapi_only_share_with_group_members_exclude_group_list', '["admin"]', '[]', self::LIST, 'share', null],
		// Finding people (share dialog, autocomplete, @-mentions, calendar invitees, the contacts
		// menu): suggestions come from one's own groups only ...
		['core', 'shareapi_allow_share_dialog_user_enumeration', 'yes', 'yes', self::MIXED, 'find', null],
		['core', 'shareapi_restrict_user_enumeration_to_group', 'yes', 'no', self::MIXED, 'find', null],
		['core', 'shareapi_restrict_user_enumeration_to_phone', 'no', 'no', self::MIXED, 'find', null],
		// ... and typing someone's exact name, email address or account id from another
		// organisation finds nobody either.
		['core', 'shareapi_restrict_user_enumeration_full_match', 'no', 'yes', self::MIXED, 'exact', null],
		['core', 'shareapi_restrict_user_enumeration_full_match_user_id', 'no', 'yes', self::MIXED, 'exact', null],
		['core', 'shareapi_restrict_user_enumeration_full_match_email', 'no', 'yes', self::MIXED, 'exact', null],
		['core', 'shareapi_restrict_user_enumeration_full_match_displayname', 'no', 'yes', self::MIXED, 'exact', null],
		// No shares with or from other servers, and no public lookup directory. The keys live in
		// files_sharing (FederatedShareProvider and Share20\Manager read them there) ...
		['files_sharing', 'outgoing_server2server_share_enabled', 'no', 'yes', self::MIXED, 'servers', null],
		['files_sharing', 'incoming_server2server_share_enabled', 'no', 'yes', self::MIXED, 'servers', null],
		['files_sharing', 'outgoing_server2server_group_share_enabled', 'no', 'no', self::MIXED, 'servers', null],
		['files_sharing', 'incoming_server2server_group_share_enabled', 'no', 'no', self::MIXED, 'servers', null],
		['files_sharing', 'lookupServerEnabled', 'no', 'no', self::MIXED, 'servers', null],
		['files_sharing', 'lookupServerUploadEnabled', 'no', 'no', self::MIXED, 'servers', null],
		// ... and the same two answers under federatedfilesharing, so a check of either app reads
		// the same (nothing reads them there).
		['federatedfilesharing', 'outgoing_server2server_share_enabled', 'no', 'yes', self::MIXED, 'servers', null],
		['federatedfilesharing', 'incoming_server2server_share_enabled', 'no', 'yes', self::MIXED, 'servers', null],
		// The "Accounts" address book of every account on the server is not offered to anyone;
		// each organisation has its own directory. (Lazy, as the dav app declares it.)
		['dav', 'system_addressbook_exposed', false, true, self::BOOL_LAZY, 'directory', null],
		// No public profile pages (/u/<uid>).
		['system', 'profile.enabled', false, true, self::SYSTEM_BOOL, 'profiles', null],
		// NoForms: "show to all accounts" and "all accounts may open it".
		['forms', 'allowPermitAll', false, true, self::BOOL, 'forms', 'forms'],
		['forms', 'allowShowToAll', false, true, self::BOOL, 'forms', 'forms'],
	];

	/**
	 * Apps that are off while privacy is on. Trusted servers (federation) are not used. The Teams
	 * app (circles) lets anyone add any account to a team and finds every account on the server,
	 * whatever the settings above say (tested on 2026-10-25); team folders, boards and the team
	 * address books do not need it.
	 */
	public const APPS = ['federation', 'circles'];

	/** What each part of the list does while privacy is on, in plain English (the admin page). */
	public const EFFECTS = [
		'find' => 'People see only people of their own organisation and teams in the share dialog, autocomplete, @-mentions, calendar invitees and the contacts menu.',
		'exact' => 'Typing the exact name, email address or account id of someone in another organisation finds nobody.',
		'share' => 'Files, folders, calendars, address books, boards, projects, forms and albums can be shared only with people of one\'s own organisation and teams, and only with one\'s own groups. Being in the admin group together does not count.',
		'directory' => 'The "Accounts" address book, which lists every account on the server, is hidden. Each organisation has its own directory instead.',
		'profiles' => 'Public profile pages are off.',
		'servers' => 'No sharing with other servers, and no public lookup directory.',
		'apps' => 'The Federation (trusted servers) and Teams (circles) apps are switched off. Team folders, boards and team address books do not need them.',
		'forms' => 'The NoForms options "show to all accounts" and "all accounts may open it" are off.',
	];

	/** What switching off means, in plain English (the admin page's confirmation). */
	public const OFF_WARNING = 'Everyone on the server can find everyone again, in every organisation: names, email addresses and account ids show up in the share dialog, autocomplete and @-mentions, and anyone can share with anyone. The federation and Teams (circles) apps come back. Public profile pages, sharing with other servers and the "Accounts" address book with every account on the server come back too.';

	/** What switching on leaves alone. */
	public const ON_NOTE = 'Shares that already exist stay; only new shares are checked.';

	public function __construct(
		private IConfig $config,
		private IAppConfig $appConfig,
		private IAppManager $appManager,
		private OrgPrivacy $orgPrivacy,
		private ObjectLock $lock,
		private AuditLog $audit,
	) {
	}

	/**
	 * Where every setting and app stands now.
	 * - state: "on" when every setting has its on value and both apps are off, "off" when every
	 *   setting has its off value and both apps are on, "mixed" otherwise;
	 * - step: the stored state (org_privacy_step), null before the first switch;
	 * - sharing_limited: whether OrgPrivacy refuses shares across organisations now;
	 * - items: each setting with its value (null when never stored, so the server's default, which
	 *   is the off value) and now: on, off, both (the two values are the same), other, or not_used
	 *   (its app is not enabled);
	 * - apps: each app, enabled or not, with its installed and code versions.
	 *
	 * @return array{state: string, step: ?string, sharing_limited: bool, items: list<array<string, mixed>>, apps: array<string, array<string, mixed>>}
	 */
	public function status(): array {
		$allOn = true;
		$allOff = true;
		$items = [];
		foreach (self::ITEMS as [$app, $key, $onValue, $offValue, $type, $effect, $needs]) {
			$used = $needs === null || $this->appManager->isEnabledForAnyone($needs);
			$stored = $used ? $this->read($app, $key, $type) : null;
			$current = $stored ?? $offValue;
			$isOn = self::same($current, $onValue, $type);
			$isOff = self::same($current, $offValue, $type);
			if ($used) {
				$allOn = $allOn && $isOn;
				$allOff = $allOff && $isOff;
			}
			$items[] = [
				'id' => $app . '/' . $key,
				'app' => $app,
				'key' => $key,
				'effect' => $effect,
				'on' => self::text($onValue),
				'off' => self::text($offValue),
				'value' => $stored === null ? null : self::text($stored),
				'now' => !$used ? 'not_used' : ($isOn && $isOff ? 'both' : ($isOn ? 'on' : ($isOff ? 'off' : 'other'))),
			];
		}
		$apps = [];
		foreach (self::APPS as $app) {
			$enabled = $this->appManager->isEnabledForAnyone($app);
			$installed = $this->installedVersion($app);
			if ($installed !== '') {
				$allOn = $allOn && !$enabled;
				$allOff = $allOff && $enabled;
			}
			$apps[$app] = [
				'enabled' => $enabled,
				'installed_version' => $installed === '' ? null : $installed,
				'version' => $this->codeVersion($app),
			];
		}
		$step = $this->config->getAppValue(Application::APP_ID, self::STEP_KEY, '');
		return [
			'state' => $allOn ? 'on' : ($allOff ? 'off' : 'mixed'),
			'step' => $step === '' ? null : $step,
			'sharing_limited' => $this->orgPrivacy->isOn(),
			'items' => $items,
			'apps' => $apps,
		];
	}

	/**
	 * Switches privacy on or off. A dry run only lists what it would change and writes no audit row.
	 *
	 * @param string $state "on" or "off"
	 * @param array{key_id: string, method: string, route?: string, who: string, ip: string, http_status: int} $actor
	 *   for the audit row; route is one of AUDIT_ROUTES (default AUDIT_ROUTE, occ's)
	 * @return array{result: string, changed: list<string>, dry_run: bool}
	 *   result: switched_on or switched_off when something changed, unchanged otherwise (a dry
	 *   run: would_switch_on, would_switch_off or unchanged)
	 * @throws ApiException 423 busy (another switch is running), 409 app_needs_upgrade
	 * @throws \InvalidArgumentException a state other than on or off
	 */
	public function apply(string $state, bool $dryRun, array $actor): array {
		if ($state !== 'on' && $state !== 'off') {
			throw new \InvalidArgumentException('state must be on or off');
		}
		if (!in_array($actor['route'] ?? self::AUDIT_ROUTE, self::AUDIT_ROUTES, true)) {
			throw new \InvalidArgumentException('the audit route must be one of ' . implode(', ', self::AUDIT_ROUTES));
		}
		$started = microtime(true);
		return $this->lock->with(self::LOCK, function () use ($state, $dryRun, $actor, $started): array {
			try {
				$changed = $this->switchTo($state, $dryRun);
			} catch (\Throwable $e) {
				if (!$dryRun) {
					// app_needs_upgrade changed nothing; anything else may have stopped half-way.
					$this->record($actor, $e instanceof ApiException ? $e->errorCode : 'failed', $started,
						$e instanceof ApiException ? $e->httpStatus : 500);
				}
				throw $e;
			}
			$result = $changed === [] ? 'unchanged' : ($dryRun ? 'would_switch_' : 'switched_') . $state;
			if (!$dryRun) {
				$this->record($actor, $result, $started);
			}
			return ['result' => $result, 'changed' => $changed, 'dry_run' => $dryRun];
		}, self::LOCK_TTL);
	}

	/**
	 * The last switches (not the runs that changed nothing), newest first, for the admin page.
	 *
	 * @return list<array{at: string, who: string, how: string, result: string}>
	 */
	public function history(int $limit = 5): array {
		$rows = [];
		foreach ($this->audit->recentForRoutes(self::AUDIT_ROUTES, $limit, self::AUDIT_CHANGES) as $row) {
			$rows[] = [
				'at' => $row['at'],
				'who' => (string)$row['target'],
				'how' => $row['key_id'] === 'occ' ? 'occ' : 'admin page',
				'result' => (string)$row['result'],
			];
		}
		return $rows;
	}

	/** @return list<string> what was (or, in a dry run, would be) changed, in order */
	private function switchTo(string $state, bool $dryRun): array {
		$on = $state === 'on';
		if (!$on) {
			// Before anything is written: an app is enabled again only at the version it is
			// installed at, as the Apps page and occ app:enable would leave it.
			foreach (self::APPS as $app) {
				$installed = $this->installedVersion($app);
				if (!$this->appManager->isEnabledForAnyone($app) && $installed !== ''
					&& !version_compare($installed, $this->codeVersion($app), '=')) {
					throw new ApiException('app_needs_upgrade', 409);
				}
			}
		}

		$changed = [];
		foreach (self::ITEMS as [$app, $key, $onValue, $offValue, $type, , $needs]) {
			if ($needs !== null && !$this->appManager->isEnabledForAnyone($needs)) {
				continue;
			}
			$want = $on ? $onValue : $offValue;
			$stored = $this->read($app, $key, $type);
			// A setting never stored is written too, so status and occ config:app:get read it.
			if ($stored !== null && self::same($stored, $want, $type)) {
				continue;
			}
			if (!$dryRun) {
				$this->write($app, $key, $want, $type);
			}
			$changed[] = $app . ' ' . $key . ' = ' . self::text($want);
		}

		foreach (self::APPS as $app) {
			$enabled = $this->appManager->isEnabledForAnyone($app);
			if ($on && $enabled) {
				if (!$dryRun) {
					$this->appManager->disableApp($app);
				}
				$changed[] = 'app ' . $app . ' disabled';
			} elseif (!$on && !$enabled && $this->installedVersion($app) !== '') {
				if (!$dryRun) {
					$this->enableApp($app);
				}
				$changed[] = 'app ' . $app . ' enabled';
			}
		}

		if ($this->config->getAppValue(Application::APP_ID, self::STEP_KEY, '') !== $state) {
			if (!$dryRun) {
				$this->config->setAppValue(Application::APP_ID, self::STEP_KEY, $state);
			}
			$changed[] = Application::APP_ID . ' ' . self::STEP_KEY . ' = ' . $state;
		}
		return $changed;
	}

	/**
	 * What occ app:enable and the Apps page do for an app that is installed but disabled: its
	 * install steps again (at the same version: no migration, only its repair steps and background
	 * jobs), then enable it, which also sweeps its translations (nourax_branding listens).
	 */
	private function enableApp(string $app): void {
		Server::get(\OC\Installer::class)->installApp($app);
		$this->appManager->enableApp($app);
	}

	private function installedVersion(string $app): string {
		return $this->config->getAppValue($app, 'installed_version', '');
	}

	private function codeVersion(string $app): ?string {
		try {
			$version = $this->appManager->getAppVersion($app, false);
		} catch (\Throwable) {
			return null;
		}
		return $version === '' ? null : $version;
	}

	/** @return string|bool|null the stored value, or null when it was never stored */
	private function read(string $app, string $key, string $type): string|bool|null {
		if ($type === self::SYSTEM_BOOL) {
			$value = $this->config->getSystemValue($key, null);
			return $value === null ? null : self::bool($value);
		}
		if (!$this->appConfig->hasKey($app, $key, null)) {
			return null;
		}
		if ($type === self::BOOL || $type === self::BOOL_LAZY) {
			return $this->appConfig->getValueBool($app, $key, false, $this->appConfig->isLazy($app, $key));
		}
		return (string)$this->config->getAppValue($app, $key, '');
	}

	private function write(string $app, string $key, string|bool $value, string $type): void {
		match ($type) {
			self::SYSTEM_BOOL => $this->config->setSystemValue($key, (bool)$value),
			self::BOOL => $this->appConfig->setValueBool($app, $key, (bool)$value,
				$this->appConfig->hasKey($app, $key, null) && $this->appConfig->isLazy($app, $key)),
			self::BOOL_LAZY => $this->appConfig->setValueBool($app, $key, (bool)$value, true),
			default => $this->config->setAppValue($app, $key, (string)$value),
		};
	}

	/** Whether a stored value means the same as one of the list's values. */
	private static function same(string|bool $stored, string|bool $value, string $type): bool {
		if (is_bool($value)) {
			return self::bool($stored) === $value;
		}
		if ($type === self::LIST) {
			$a = json_decode(trim((string)$stored) === '' ? '[]' : (string)$stored, true);
			$b = json_decode($value, true);
			if (!is_array($a) || !is_array($b)) {
				return false;
			}
			sort($a);
			sort($b);
			return $a === $b;
		}
		return (string)$stored === $value;
	}

	private static function bool(mixed $value): bool {
		if (is_bool($value)) {
			return $value;
		}
		return in_array(strtolower(trim((string)$value)), ['1', 'true', 'yes', 'on'], true);
	}

	/** A value as text: yes, no, ["admin"], true, false. */
	private static function text(string|bool $value): string {
		return is_bool($value) ? ($value ? 'true' : 'false') : $value;
	}

	/**
	 * @param array{key_id: string, method: string, route?: string, who: string, ip: string, http_status: int} $actor
	 * @param ?int $failedStatus the HTTP status of a failure (occ's rows keep status 0)
	 */
	private function record(array $actor, string $result, float $started, ?int $failedStatus = null): void {
		$status = $actor['http_status'] === 0 || $failedStatus === null ? $actor['http_status'] : $failedStatus;
		$this->audit->record($actor['key_id'], $actor['method'], $actor['route'] ?? self::AUDIT_ROUTE, $actor['who'],
			$status, $result, $actor['ip'], (int)round((microtime(true) - $started) * 1000));
	}
}
