<?php

declare(strict_types=1);

/**
 * The privacy switch's list and its dry runs (nourax_api OrgPrivacySwitch), inside the app
 * container as www-data. It switches nothing:
 *   sudo docker compose exec -T -u www-data app php < tests/org-privacy-switch.php
 * tests/org-privacy-switch.sh runs it, also without -u www-data: started as root, it first becomes
 * the owner of config.php (www-data), as the server's own occ file does.
 *
 * - The list is exactly the one scripts/configure.d/60-org-privacy.sh had on 2026-10-25 (copied
 *   below, so a change to the list must change this test too), plus the two NoForms options that
 *   50-apps.sh switches off while privacy is on; the apps are federation and circles.
 * - status() reads what the server reads (occ config:app:get, config.php, the app list), and its
 *   state is "on" exactly when every setting has its on value and both apps are off.
 * - A dry run of on and of off lists what would change and changes nothing: every value, the apps,
 *   the stored step and the audit rows are the same afterwards. A dry run of off lists every
 *   setting whose two values differ, both apps and the step.
 * - A second switch while one runs gets 423 busy (the lock), and a state other than on or off
 *   is refused.
 * - The page's view: the effects of On (the NoForms one only while NoForms is enabled), what Off
 *   means, and no upstream name in any of those texts (nourax_branding's rules.json).
 * - The admin page: the section "Nourax Workspace" and its one form are registered (from
 *   info.xml), the form cannot be delegated, and the rendered form shows the state, every effect
 *   of On, what Off means, the confirmation and one table row per setting and app; no upstream
 *   name, link or blue in it, its script, styles or icon; its initial state names the switch's
 *   address /apps/nourax_api/settings/org-privacy.
 * - The audit routes: "org-privacy" for occ, "settings/org-privacy" for the admin page.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace NouraxTests;

use OCA\NouraxApi\AdminSettings\PrivacySettings;
use OCA\NouraxApi\AdminSettings\WorkspaceSection;
use OCA\NouraxApi\Service\ApiException;
use OCA\NouraxApi\Service\ObjectLock;
use OCA\NouraxApi\Service\OrgPrivacySwitch;
use OCP\App\IAppManager;
use OCP\DB\QueryBuilder\IQueryBuilder;
use OCP\IAppConfig;
use OCP\IConfig;
use OCP\IDBConnection;
use OCP\Server;
use OCP\Settings\IDelegatedSettings;
use OCP\Settings\IManager as ISettingsManager;

// Piped in as root (docker compose exec without -u www-data): become the owner of config.php
// first, as the server's own occ file does (35.0.2), so nothing is written as root. Nothing may
// be printed before the server has read its config: it takes any earlier output for "leading
// content" in config.php.
$startedAsRoot = null;
if (function_exists('posix_getuid') && posix_getuid() === 0) {
	$owner = fileowner('/var/www/html/config/config.php');
	$account = $owner === false ? false : posix_getpwuid($owner);
	if ($account === false || $owner === 0 || !posix_setgid($account['gid'])
		|| !posix_initgroups($account['name'], $account['gid']) || !posix_setuid($owner)) {
		echo "FAIL could not become the owner of config.php; run it with -u www-data\n";
		exit(1);
	}
	$startedAsRoot = $account['name'];
	unset($owner, $account);
}
require_once '/var/www/html/lib/base.php';
if ($startedAsRoot !== null) {
	echo "started as root, now running as $startedAsRoot, the owner of config.php\n";
}
Server::get(IAppManager::class)->loadApp('nourax_api');

$fails = 0;
function check(string $name, mixed $expected, mixed $actual): void {
	global $fails;
	if ($expected === $actual) {
		echo "PASS $name\n";
		return;
	}
	echo 'FAIL ' . $name . ': expected ' . json_encode($expected, JSON_UNESCAPED_SLASHES)
		. ', got ' . json_encode($actual, JSON_UNESCAPED_SLASHES) . "\n";
	$fails++;
}

function text(string|bool $value): string {
	return is_bool($value) ? ($value ? 'true' : 'false') : $value;
}

$config = Server::get(IConfig::class);
$appConfig = Server::get(IAppConfig::class);
$appManager = Server::get(IAppManager::class);
$switch = Server::get(OrgPrivacySwitch::class);
$formsOn = $appManager->isEnabledForAnyone('forms');

// --- The list ------------------------------------------------------------------------------------
// [app, key, on, off], as 60-org-privacy.sh set and undid them on 2026-10-25, then NoForms.
$expected = [
	['core', 'shareapi_only_share_with_group_members', 'yes', 'no'],
	['core', 'shareapi_only_share_with_group_members_exclude_group_list', '["admin"]', '[]'],
	['core', 'shareapi_allow_share_dialog_user_enumeration', 'yes', 'yes'],
	['core', 'shareapi_restrict_user_enumeration_to_group', 'yes', 'no'],
	['core', 'shareapi_restrict_user_enumeration_to_phone', 'no', 'no'],
	['core', 'shareapi_restrict_user_enumeration_full_match', 'no', 'yes'],
	['core', 'shareapi_restrict_user_enumeration_full_match_user_id', 'no', 'yes'],
	['core', 'shareapi_restrict_user_enumeration_full_match_email', 'no', 'yes'],
	['core', 'shareapi_restrict_user_enumeration_full_match_displayname', 'no', 'yes'],
	['files_sharing', 'outgoing_server2server_share_enabled', 'no', 'yes'],
	['files_sharing', 'incoming_server2server_share_enabled', 'no', 'yes'],
	['files_sharing', 'outgoing_server2server_group_share_enabled', 'no', 'no'],
	['files_sharing', 'incoming_server2server_group_share_enabled', 'no', 'no'],
	['files_sharing', 'lookupServerEnabled', 'no', 'no'],
	['files_sharing', 'lookupServerUploadEnabled', 'no', 'no'],
	['federatedfilesharing', 'outgoing_server2server_share_enabled', 'no', 'yes'],
	['federatedfilesharing', 'incoming_server2server_share_enabled', 'no', 'yes'],
	['dav', 'system_addressbook_exposed', 'false', 'true'],
	['system', 'profile.enabled', 'false', 'true'],
	['forms', 'allowPermitAll', 'false', 'true'],
	['forms', 'allowShowToAll', 'false', 'true'],
];
check('the list is the old step\'s list plus the two NoForms options', $expected,
	array_map(fn (array $i): array => [$i[0], $i[1], text($i[2]), text($i[3])], OrgPrivacySwitch::ITEMS));
check('the apps: federation and circles', ['federation', 'circles'], OrgPrivacySwitch::APPS);
check('the audit routes: org-privacy (occ, configure), settings/org-privacy (the admin page)',
	['org-privacy', 'settings/org-privacy'], [OrgPrivacySwitch::AUDIT_ROUTE, OrgPrivacySwitch::AUDIT_ROUTE_PAGE]);
check('every setting has a plain-English effect', [],
	array_values(array_filter(OrgPrivacySwitch::ITEMS, fn (array $i): bool => !isset(OrgPrivacySwitch::EFFECTS[$i[5]]))));

// --- status() reads what the server reads -----------------------------------------------------------
/** The raw value as the server stores it, or null when it was never stored. */
function raw(string $app, string $key): ?string {
	$config = Server::get(IConfig::class);
	$appConfig = Server::get(IAppConfig::class);
	if ($app === 'system') {
		$v = $config->getSystemValue($key, null);
		return $v === null ? null : text((bool)$v);
	}
	if (!$appConfig->hasKey($app, $key, null)) {
		return null;
	}
	$type = $appConfig->getValueType($app, $key);
	if ($type === IAppConfig::VALUE_BOOL) {
		return text($appConfig->getValueBool($app, $key, false, $appConfig->isLazy($app, $key)));
	}
	return (string)$config->getAppValue($app, $key, '');
}

$status = $switch->status();
check('status lists every setting once', count(OrgPrivacySwitch::ITEMS), count($status['items']));
$mismatch = [];
$allOn = true;
foreach ($status['items'] as $n => $item) {
	if ($item['now'] === 'not_used') {
		if (OrgPrivacySwitch::ITEMS[$n][6] === null || $appManager->isEnabledForAnyone(OrgPrivacySwitch::ITEMS[$n][6])) {
			$mismatch[] = $item['id'] . ' is marked not used';
		}
		continue;
	}
	if ($item['value'] !== raw($item['app'], $item['key'])) {
		$mismatch[] = $item['id'] . ': status ' . json_encode($item['value']) . ', server ' . json_encode(raw($item['app'], $item['key']));
	}
	$allOn = $allOn && in_array($item['now'], ['on', 'both'], true);
}
check('status: every value is what the server stores', [], $mismatch);
check('status: NoForms options used exactly while NoForms is enabled', $formsOn ? ['on', 'on'] : ['not_used', 'not_used'],
	array_values(array_map(fn (array $i): string => $i['now'] === 'not_used' ? 'not_used' : 'on',
		array_filter($status['items'], fn (array $i): bool => $i['app'] === 'forms'))));
foreach (OrgPrivacySwitch::APPS as $app) {
	check("status: app $app as the app list has it", $appManager->isEnabledForAnyone($app), $status['apps'][$app]['enabled']);
	$allOn = $allOn && !$status['apps'][$app]['enabled'];
}
check('status: state on exactly when every setting is on and both apps are off', $allOn ? 'on' : 'not on',
	$status['state'] === 'on' ? 'on' : 'not on');
check('status: step is the stored org_privacy_step', $config->getAppValue('nourax_api', 'org_privacy_step', '') ?: null, $status['step']);

// --- Dry runs change nothing ---------------------------------------------------------------------
function snapshot(): array {
	$appManager = Server::get(IAppManager::class);
	$values = [];
	foreach (OrgPrivacySwitch::ITEMS as $i) {
		$values[$i[0] . '/' . $i[1]] = raw($i[0], $i[1]);
	}
	foreach (OrgPrivacySwitch::APPS as $app) {
		$values['app/' . $app] = $appManager->isEnabledForAnyone($app);
	}
	$values['step'] = Server::get(IConfig::class)->getAppValue('nourax_api', 'org_privacy_step', '');
	$qb = Server::get(IDBConnection::class)->getQueryBuilder();
	$qb->select($qb->func()->count('*', 'n'))->from('nourax_api_audit')
		->where($qb->expr()->in('route', $qb->createNamedParameter(OrgPrivacySwitch::AUDIT_ROUTES, IQueryBuilder::PARAM_STR_ARRAY)));
	$values['audit_rows'] = (int)$qb->executeQuery()->fetchOne();
	return $values;
}
$actor = ['key_id' => 'occ', 'method' => 'CLI', 'who' => 'tests', 'ip' => '', 'http_status' => 0];
$before = snapshot();

if ($status['state'] === 'on') {
	$dry = $switch->apply('on', true, $actor);
	check('dry run of on while on: nothing to change', ['result' => 'unchanged', 'changed' => [], 'dry_run' => true], $dry);
}
$dry = $switch->apply('off', true, $actor);
if ($status['state'] === 'on') {
	$wouldChange = [];
	foreach (OrgPrivacySwitch::ITEMS as $i) {
		if (text($i[2]) !== text($i[3]) && ($i[6] === null || $appManager->isEnabledForAnyone($i[6]))) {
			$wouldChange[] = $i[0] . ' ' . $i[1] . ' = ' . text($i[3]);
		}
	}
	$wouldChange[] = 'app federation enabled';
	$wouldChange[] = 'app circles enabled';
	$wouldChange[] = 'nourax_api org_privacy_step = off';
	check('dry run of off while on: every setting whose values differ, both apps and the step',
		['result' => 'would_switch_off', 'changed' => $wouldChange, 'dry_run' => true], $dry);
}
check('dry runs changed nothing (values, apps, step, audit rows)', $before, snapshot());

// --- One switch at a time ----------------------------------------------------------------------
$busy = 'no answer';
try {
	Server::get(ObjectLock::class)->with('org-privacy', function () use ($switch, $actor) {
		return $switch->apply('on', true, $actor);
	});
} catch (ApiException $e) {
	$busy = $e->errorCode . ' ' . $e->httpStatus;
}
check('a second switch while one runs -> busy 423', 'busy 423', $busy);
$refused = 'accepted';
try {
	$switch->apply('maybe', true, $actor);
} catch (\InvalidArgumentException) {
	$refused = 'refused';
}
check('a state other than on or off is refused', 'refused', $refused);
check('the refusals changed nothing either', $before, snapshot());

// --- The page's texts ----------------------------------------------------------------------------
$view = PrivacySettings::view($switch);
check('view: the effects of On that apply here', $formsOn ? count(OrgPrivacySwitch::EFFECTS) : count(OrgPrivacySwitch::EFFECTS) - 1,
	count($view['effects']));
check('view: Off says everyone finds everyone again',
	true, str_contains($view['off_warning'], 'Everyone on the server can find everyone again'));
check('view: Off says the federation and Teams (circles) apps come back',
	true, str_contains($view['off_warning'], 'The federation and Teams (circles) apps come back.'));
check('view: the history holds only switches, at most 5', true,
	count($view['history']) <= 5 && array_filter($view['history'], fn (array $r): bool => !preg_match('/^(Switched (on|off)|A switch stopped with an error) by /', $r['text'])) === []);

$rules = json_decode((string)file_get_contents('/var/www/html/nourax_apps/nourax_branding/sweep/rules.json'), true);
$texts = array_merge(array_values(OrgPrivacySwitch::EFFECTS), [OrgPrivacySwitch::OFF_WARNING, OrgPrivacySwitch::ON_NOTE]);
$hits = [];
foreach (array_merge($rules['name_patterns'] ?? [], $rules['blue_patterns'] ?? []) as $rule) {
	$re = '/' . str_replace('/', '\/', preg_replace('/^\(\?i\)/', '', $rule['re'])) . '/' . (str_starts_with($rule['re'], '(?i)') ? 'i' : '');
	foreach ($texts as $text) {
		if (@preg_match($re, $text) === 1) {
			$hits[] = $rule['id'] . ': ' . $text;
		}
	}
}
check('no upstream name or blue in the page\'s texts (rules.json)', [], $hits);
check('rules.json was read', true, is_array($rules) && count($rules['name_patterns'] ?? []) > 0);

// --- The admin page: registered, and rendered ----------------------------------------------------
$settingsManager = Server::get(ISettingsManager::class);
$sections = [];
foreach ($settingsManager->getAdminSections() as $byPriority) {
	foreach ($byPriority as $section) {
		$sections[$section->getID()] = $section;
	}
}
$section = $sections[WorkspaceSection::ID] ?? null;
check('the admin section "Nourax Workspace" is registered', 'Nourax Workspace', $section?->getName());
check('its icon is the app\'s white-on-cobalt mark', true,
	$section !== null && str_ends_with((string)preg_replace('/\?.*$/', '', $section->getIcon()), '/nourax_api/img/nourax-workspace.svg'));
$forms = array_merge(...array_values($settingsManager->getAdminSettings(WorkspaceSection::ID)));
check('its one form is PrivacySettings', [PrivacySettings::class], array_map('get_class', $forms));
check('the form cannot be delegated to non-admins (not IDelegatedSettings)', false,
	(Server::get(PrivacySettings::class)) instanceof IDelegatedSettings);

$html = Server::get(PrivacySettings::class)->getForm()->render();
$pageState = json_decode(Server::get(\OC\InitialStateService::class)->getInitialStates()['nourax_api-org-privacy'] ?? 'null', true);
check('rendered: its initial state names the switch\'s address /apps/nourax_api/settings/org-privacy', true,
	str_ends_with((string)($pageState['url'] ?? ''), '/apps/nourax_api/settings/org-privacy'));
$e = fn (string $s): string => htmlspecialchars($s, ENT_QUOTES);
$state = $status['state'];
check('rendered: the section and its title', true,
	str_contains($html, '<div id="nourax-org-privacy"') && str_contains($html, '<h2>Privacy between organisations</h2>'));
check("rendered: the state pill says $state", 1,
	preg_match('/class="nourax-privacy__pill nourax-privacy__pill--' . $state . '"[^>]*>' . ['on' => 'On', 'off' => 'Off', 'mixed' => 'Some settings differ'][$state] . '</', $html));
check('rendered: every effect of On, twice (page and confirmation)', [], array_values(array_filter($view['effects'],
	fn (string $t): bool => substr_count($html, $e($t)) !== 2)));
check('rendered: what Off means, twice (page and confirmation)', 2, substr_count($html, $e(OrgPrivacySwitch::OFF_WARNING)));
check('rendered: the confirmation dialog and its two buttons', true, str_contains($html, '<dialog id="nourax-privacy-dialog"')
	&& str_contains($html, 'value="cancel"') && str_contains($html, 'id="nourax-privacy-confirm"'));
check('rendered: one table row per setting and per app', count(OrgPrivacySwitch::ITEMS) . ' ' . count(OrgPrivacySwitch::APPS),
	substr_count($html, '<tr data-item="') . ' ' . substr_count($html, '<tr data-app="'));
check('rendered: the button that does not apply is hidden', 1,
	preg_match($state === 'on' ? '/id="nourax-privacy-on"[^>]*hidden/' : ($state === 'off' ? '/id="nourax-privacy-off"[^>]*hidden/' : '/^/'), $html));

// The page, its script, styles and icon against the branding rules: names, blues, and links.
$appDir = '/var/www/html/nourax_apps/nourax_api';
$files = ['rendered page' => $html];
foreach (['js/admin-privacy.js', 'css/admin-privacy.css', 'css/settings-nav.css', 'img/nourax-workspace.svg'] as $path) {
	$files[$path] = (string)file_get_contents("$appDir/$path");
}
$hits = [];
foreach (array_merge($rules['name_patterns'] ?? [], $rules['blue_patterns'] ?? []) as $rule) {
	$re = '/' . str_replace('/', '\/', preg_replace('/^\(\?i\)/', '', $rule['re'])) . '/' . (str_starts_with($rule['re'], '(?i)') ? 'i' : '');
	foreach ($files as $where => $body) {
		if (@preg_match($re, $body) === 1) {
			$hits[] = $rule['id'] . ' in ' . $where;
		}
	}
}
preg_match_all('/\s(?:href|src|action)="([^"]*)"/', $html, $links);
foreach ($rules['link_patterns'] ?? [] as $rule) {
	$re = '/' . str_replace('/', '\/', preg_replace('/^\(\?i\)/', '', $rule['re'])) . '/' . (str_starts_with($rule['re'], '(?i)') ? 'i' : '');
	foreach ($links[1] as $link) {
		if (@preg_match($re, $link) === 1) {
			$hits[] = $rule['id'] . ': ' . $link;
		}
	}
}
check('no upstream name, link or blue in the page, its script, styles or icon (rules.json)', [], $hits);
check('the icon: a white mark on the cobalt tile', true,
	str_contains($files['img/nourax-workspace.svg'], 'fill="#2563EB"') && str_contains($files['img/nourax-workspace.svg'], 'fill="#fff"'));

if ($fails > 0) {
	echo "$fails check(s) failed\n";
	exit(1);
}
echo "all org-privacy-switch checks passed\n";
