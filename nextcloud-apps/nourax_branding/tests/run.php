<?php

declare(strict_types=1);

/**
 * Tests of the text sweep's rules, of the language list fix and of the upstream colour, background
 * and address rules, with the real sweep/rules.json and sweep/en-overrides.json. Plain PHP, no test framework and no Nextcloud needed:
 *   docker compose exec -T -u www-data app php /var/www/html/nourax_apps/nourax_branding/tests/run.php
 * Prints one line per check and exits 1 when any check fails.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

require_once __DIR__ . '/../lib/Service/L10nSweeper.php';
require_once __DIR__ . '/../lib/Service/LanguageList.php';
require_once __DIR__ . '/../lib/Service/UpstreamAssets.php';

use OCA\NouraxBranding\Service\L10nSweeper;
use OCA\NouraxBranding\Service\LanguageList;
use OCA\NouraxBranding\Service\UpstreamAssets;

$passed = 0;
$failed = 0;
function check(bool $ok, string $label, string $detail = ''): void {
	global $passed, $failed;
	if ($ok) {
		$passed++;
		echo "ok   $label\n";
	} else {
		$failed++;
		echo "FAIL $label" . ($detail !== '' ? "\n     $detail" : '') . "\n";
	}
}
function same(mixed $got, mixed $want, string $label): void {
	check($got === $want, $label, 'got ' . json_encode($got, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES)
		. ', want ' . json_encode($want, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES));
}

$rules = json_decode((string)file_get_contents(__DIR__ . '/../sweep/rules.json'), true);
$overrides = json_decode((string)file_get_contents(__DIR__ . '/../sweep/en-overrides.json'), true);
check(is_array($rules) && is_array($overrides), 'rules.json and en-overrides.json are valid JSON');
$sw = new L10nSweeper($rules, $overrides);
check(true, 'every pattern in rules.json compiles');

// [language, text, expected]
$cases = [
	// Links to the upstream lose the address and keep the text; other links stay.
	['de', 'Bitte melde dieses Problem an die <a href="https://github.com/nextcloud/server/issues" target="_blank">Nextcloud Community</a>.', 'Bitte melde dieses Problem an die Nourax Workspace Community.'],
	['en', 'See <a href="https://example.org/help">Nextcloud help</a>', 'See <a href="https://example.org/help">Nourax Workspace help</a>'],
	['en', 'Send people a link [using this app](https://apps.nextcloud.com/apps/appointments)', 'Send people a link using this app'],
	['en', 'Based on the [c-dav library](https://github.com/nextcloud/cdav-library) and [ical.js](https://github.com/mozilla-comm/ical.js)', 'Based on the c-dav library and [ical.js](https://github.com/mozilla-comm/ical.js)'],
	['en', 'Powered by [pdf.js](https://mozilla.github.io/pdf.js/) in Nextcloud', 'Powered by [pdf.js](https://mozilla.github.io/pdf.js/) in Nourax Workspace'],
	['en', 'A ![logo](https://nextcloud.com/logo.png) B', 'A  B'],
	['en', 'Nextcloud docs: https://docs.nextcloud.com/server/latest/', 'Nourax Workspace docs:'],
	['en', 'Help (https://nextcloud.com/support) here', 'Help here'],
	['en', 'Write to privacy@nextcloud.com today', 'Write to today'],
	// Example cloud IDs, in every language.
	['en', 'user@your-nextcloud.org', 'user@drive.nourax.org'],
	['hu', 'felhasználó@az-ön-nextcloudja.org', 'felhasználó@drive.nourax.org'],
	['vi', 'người_dùng@nextcloud_của_bạn.org', 'người_dùng@drive.nourax.org'],
	['en', '[user@your-nextcloud.org](mailto:user@your-nextcloud.org)', 'user@drive.nourax.org'],
	// Product phrases.
	['en', 'Choose from Nextcloud Files', 'Choose from NoDrive'],
	['de', 'Aus Nextcloud Dateien auswählen', 'Aus NoDrive auswählen'],
	['en', 'Welcome to Nextcloud Calendar!', 'Welcome to NoCalendar!'],
	['en', 'The Nextcloud contacts app', 'The NoContacts app'],
	['en', 'Welcome to Nextcloud Deck!', 'Welcome to NoBoard!'],
	['en', 'Nextcloud Assistant result copied', 'Nourax AI result copied'],
	['en', 'Play sound when a call started (requires Nextcloud Talk)', 'Play sound when a call started (requires Talk)'],
	['en', 'Nextcloud Text', 'Text'],
	['en', 'Office suite switching is managed through the Nextcloud All-in-One interface.', 'Office suite switching is managed through the All-in-One interface.'],
	['en', 'Nextcloud Appstore', 'App store'],
	['en', 'read (from Nextcloud client)', 'read (from NoDrive client)'],
	['de', 'gelesen (vom Nextcloud-Client)', 'gelesen (vom NoDrive-Client)'],
	['en', 'the Nextcloud desktop client', 'the NoDrive desktop client'],
	['en', 'Share with me through my #Nextcloud Federated Cloud ID', 'Share with me through my #NouraxWorkspace Federated Cloud ID'],
	['en', 'we expect that Nextcloud Hub 27 Winter (Nextcloud 36) will no longer work', 'we expect that Nourax Workspace will no longer work'],
	['en', 'As of Hub 10 / Nextcloud 31, admins must be members', 'As of Nourax Workspace 31, admins must be members'],
	['en', 'it looks like the server to federate with is too old (Nextcloud <= 9).', 'it looks like the server to federate with is too old.'],
	['hu', 'a föderálandó kiszolgáló túl régi. (Nextcloud <= 9).', 'a föderálandó kiszolgáló túl régi.'],
	['sl', 'nepodprto staro različico oblaka (Nextzcloud ≤ 9).', 'nepodprto staro različico oblaka.'],
	['en', 'If you need this feature, consider using Nextcloud Enterprise.', 'If you need this feature, consider using an enterprise subscription.'],
	['de', 'Erwäge Nextcloud Enterprise zu nutzen.', 'Erwäge Enterprise zu nutzen.'],
	['vi', 'Liên hệ với GmbH', 'Liên hệ với the upstream project'],
	['en', 'Contact NC GmbH', 'Contact the upstream project'],
	// Every other spelling becomes the product name; endings stay after a hyphen.
	['en', 'Nextcloud', 'Nourax Workspace'],
	['en', 'Consider checking the nextcloud log', 'Consider checking the Nourax Workspace log'],
	['fi', 'Julkisen linkin lisääminen Nextcloudiisi epäonnistui', 'Julkisen linkin lisääminen Nourax Workspace-iisi epäonnistui'],
	['hu', 'a nyilvános hivatkozást a Nexcloudjához', 'a nyilvános hivatkozást a Nourax Workspace-jához'],
	['de', 'Nextcloud-Server', 'Nourax Workspace-Server'],
	['tr', "Nextcloud'a bağlan", "Nourax Workspace'a bağlan"],
	['tr', 'bağlantı Nextcould üzerine eklenemedi', 'bağlantı Nourax Workspace üzerine eklenemedi'],
	['tr', 'IP adresini Nextcolud sunucusuna', 'IP adresini Nourax Workspace sunucusuna'],
	['et_EE', 'Nexctcloudi võimalustest', 'Nourax Workspace-i võimalustest'],
	['ko', 'Nextcloud에 추가', 'Nourax Workspace에 추가'],
	['ja', 'Nextcloudで最高のパフォーマンス', 'Nourax Workspaceで最高のパフォーマンス'],
	['ar', 'خادم نكست كلاود', 'خادم Nourax Workspace'],
	['ar', 'تطبيق التقويم لنكست كلاود', 'تطبيق التقويم لـNourax Workspace'],
	['ar', 'الخاص بـنكست كلاود.', 'الخاص بـNourax Workspace.'],
	['ar', 'اشتراكك الحالي في نكست كلود.', 'اشتراكك الحالي في Nourax Workspace.'],
	['ar', 'لتسجيل الدخول إلى نيكست كلاود', 'لتسجيل الدخول إلى Nourax Workspace'],
	['fa', 'سرور نکست‌کلود', 'سرور Nourax Workspace'],
	['fa', 'نکست‌کلودشان', 'Nourax Workspace شان'],
	['sr', 'Неуспело додавање јавне везе ка Вашем Некстклауду', 'Неуспело додавање јавне везе ка Вашем Nourax Workspace-у'],
	['mn', 'Нэкстклауд Календарь', 'Nourax Workspace Календарь'],
	['sr@latin', 'Nekst klaud server', 'Nourax Workspace server'],
	['vi', 'Máy chủ vWorkspace', 'Máy chủ Nourax Workspace'],
	['uz', "Keyingi bulutga umumiy havolani qo'shib bo'lmadi", "Nourax Workspace-ga umumiy havolani qo'shib bo'lmadi"],
	['uz', 'Next bulutli Server', 'Nourax Workspace-li Server'],
	['hi_IN', 'नेक्स्टक्लाउड में', 'Nourax Workspace में'],
	// Spellings QA found on the server (fix round 1), and the others the same scan found.
	['ar', 'مرحبًا بكم على متن ناكست كلاود يا %s', 'مرحبًا بكم على متن Nourax Workspace يا %s'],
	['ar', 'حول مزايا نسخة نسكت كلاود المؤسسية', 'حول مزايا نسخة Nourax Workspace المؤسسية'],
	['tr', 'Nexctloud antivirus uygulamasıdır', 'Nourax Workspace antivirus uygulamasıdır'],
	['ast', 'persones y grupos de Nextclouod.', 'persones y grupos de Nourax Workspace.'],
	['ast', 'nun ye visible pa Nexrcloud.', 'nun ye visible pa Nourax Workspace.'],
	['ast', 'nun ye visible a Nextlcloud.', 'nun ye visible a Nourax Workspace.'],
	['eu', 'Nextlcloudeko kontua', 'Nourax Workspace-eko kontua'],
	['et_EE', 'Nexticloudi võimalustest', 'Nourax Workspace-i võimalustest'],
	['es', 'Nexttcloud no y Nexstcloud en', 'Nourax Workspace no y Nourax Workspace en'],
	['sl', 'Nextcoud', 'Nourax Workspace'],
	['sc', 'Nextloud o', 'Nourax Workspace o'],
	['br', 'Nextclpoud ha Nexclouf', 'Nourax Workspace ha Nourax Workspace'],
	// near_name: spellings that no pattern lists are found by their likeness to the name.
	['en', 'Open Nextclaud now', 'Open Nourax Workspace now'],
	['et_EE', 'Nextcluodi kaudu', 'Nourax Workspace-i kaudu'],
	['de', 'Das Nextclodu-Konto', 'Das Nourax Workspace-Konto'],
	['fr', 'Votre NEXTKLOUD', 'Votre Nourax Workspace'],
	// Placeholders and ONLYOFFICE are never changed.
	['en', 'Developed by the {communityopen}Nextcloud community{linkclose}', 'Developed by the {communityopen}Nourax Workspace community{linkclose}'],
	['en', '{nextcloudUrl} is Nextcloud', '{nextcloudUrl} is Nourax Workspace'],
	['en', '%s via Nextcloud %1$s, %n files', '%s via Nourax Workspace %1$s, %n files'],
	['en', 'Log in to {productName}', 'Log in to {productName}'],
	['en', 'Edit within Nextcloud using ONLYOFFICE Docs.', 'Edit within Nourax Workspace using ONLYOFFICE Docs.'],
	['de', 'ONLYOFFICE', 'ONLYOFFICE'],
];
foreach ($cases as [$lang, $in, $want]) {
	$got = $sw->transform($in, $lang);
	same($got, $want, "transform $lang: " . mb_substr($in, 0, 60));
	same($sw->transform($got, $lang), $got, "  again gives the same text ($lang)");
	// Placeholders are code and stay as they are, even with the name in them.
	check(!$sw->hasName(preg_replace('/\{[A-Za-z0-9_.-]+\}/', '', $got)), '  no upstream name left', $got);
	foreach ($sw->keepWords() as $word) {
		check(substr_count($got, $word) === substr_count($in, $word), "  $word kept");
	}
}

// Placeholder keys.
same($sw->value('settings', '{productName} iOS app', '{productName} iOS-App', 'de'), 'NoDrive iOS-App', 'key rule: {productName} iOS app is NoDrive');
same($sw->value('settings', '{productName} Talk for Android', '{productName} Talk für Android', 'de'), 'Talk für Android', 'key rule: {productName} Talk is Talk');
same($sw->value('core', 'Log in to {productName}', 'Bei {productName} anmelden', 'de'), 'Bei {productName} anmelden', 'other {productName} texts stay');

// Curated texts: English only, and every language.
$update = 'The update was unsuccessful. Please report this issue to the <a href="https://github.com/nextcloud/server/issues" target="_blank">Nextcloud community</a>.';
same($sw->value('core', $update, $update, 'en_GB'), 'The update was unsuccessful. Please tell your administrator.', 'curated English text for en_GB');
same($sw->fill('core', $update, 'en', 2), 'The update was unsuccessful. Please tell your administrator.', 'curated English text for en (no file of its own)');
same($sw->value('core', $update, 'Das Update ist fehlgeschlagen. Bitte melde dieses Problem an die <a href="https://github.com/nextcloud/server/issues" target="_blank">Nextcloud Community</a>.', 'de'),
	'Das Update ist fehlgeschlagen. Bitte melde dieses Problem an die Nourax Workspace Community.', 'other languages keep their own translation, swept');
same($sw->value('notifications', 'Contact Nextcloud GmbH', 'Die Nextcloud GmbH kontaktieren', 'de'), 'More information', 'every-language curated text');
foreach (['english', 'every_language'] as $kind) {
	foreach ($overrides[$kind] as $app => $list) {
		foreach ($list as $key => $text) {
			foreach ((array)$text as $t) {
				check(!$sw->hasName($t), "curated $kind $app text has no upstream name", $t);
			}
		}
	}
}
foreach ($overrides['by_language'] ?? [] as $lang => $apps) {
	foreach ($apps as $app => $list) {
		foreach ($list as $key => $text) {
			foreach ((array)$text as $t) {
				check(!$sw->hasName($t) && str_contains($t, 'Nourax Workspace'), "curated $lang $app text names Nourax Workspace, not the upstream", $t);
			}
		}
	}
}
$publicLink = 'Failed to add the public link to your Nextcloud';
same($sw->value('core', $publicLink, 'فشل في إضافة الرابط العام إلى الخادم السحابي الخاص بك', 'ar'),
	'فشل في إضافة الرابط العام إلى Nourax Workspace الخاص بك', 'curated text for one language (core ar)');
same($sw->value('core', $publicLink, 'Fehler beim Hinzufügen des öffentlichen Links zu Ihrer Nextcloud', 'de'),
	'Fehler beim Hinzufügen des öffentlichen Links zu Ihrer Nourax Workspace', 'other languages are swept as usual');
same($sw->fill('core', $publicLink, 'ar', 6), 'فشل في إضافة الرابط العام إلى Nourax Workspace الخاص بك', 'curated text for one language when the text is missing there');

// near_name leaves ordinary words alone (the words at distance 3 in the server scan, among others).
foreach ([
	['en', 'Exclude groups from the next login'],
	['de', 'Dateien in der Cloud'],
	['ca', 'Les versions exclouen de la quota'],
	['en', 'Next, cloud storage'],
	['en', 'Nextflow and Nextdoor'],
	['fr', 'Partager avec des utilisateurs externes'],
	['en', 'Connected to the network'],
] as [$lang, $text]) {
	check(!$sw->hasName($text), "near_name: no name in \"$text\"");
	same($sw->transform($text, $lang), $text, '  left as it is');
}
$sw->takeGuessed();
$sw->transform('Open Nextclaud now', 'en');
$sw->transform('Nexctloud antivirus', 'tr');
same($sw->takeGuessed(), ['nextclaud'], 'near_name: spellings no pattern lists are kept for --report (listed ones are not)');
same($sw->takeGuessed(), [], 'near_name: and handed over once');

// The Arabic loanword for cloud is found but never replaced, so a new spelling before it shows up.
check($sw->hasName('خدمة آي كلاود'), 'arabic-cloud: the loanword is found');
same($sw->transform('خدمة آي كلاود', 'ar'), 'خدمة آي كلاود', 'arabic-cloud: never replaced');
same($sw->leftovers(['k' => 'خدمة آي كلاود']), ['k'], 'arabic-cloud: reported as still named');

// A file with a byte order mark: read all the same, and marked as one Nextcloud cannot read.
same(L10nSweeper::decodeFile("\xEF\xBB\xBF{\"translations\":{\"a\":\"b\"},\"pluralForm\":\"x\"}"), [['translations' => ['a' => 'b'], 'pluralForm' => 'x'], false], 'decodeFile: byte order mark');
same(L10nSweeper::decodeFile('{"translations":{"a":"b"}}'), [['translations' => ['a' => 'b']], true], 'decodeFile: plain file');
same(L10nSweeper::decodeFile('not json'), [null, false], 'decodeFile: not JSON');
$bomOrig = [
	'de' => ['translations' => ['Edit within Nextcloud' => 'In Nextcloud bearbeiten', 'Save' => 'Speichern'], 'plural' => 'nplurals=2; plural=(n != 1);'],
	'eu' => ['translations' => ['Edit within Nextcloud' => 'Nextcloud-en editatu', 'Save' => 'Gorde'], 'plural' => 'nplurals=2; plural=(n != 1);', 'unreadable' => true],
];
$bom = $sw->build('demo', $bomOrig, []);
same($bom['de']['server'], ['Edit within Nextcloud' => 'In Nourax Workspace bearbeiten'], 'unreadable file: other languages get the changed texts only');
same($bom['eu']['server'], ['Edit within Nextcloud' => 'Nourax Workspace-en editatu', 'Save' => 'Gorde'], 'unreadable file: the theme file holds every text');
$bomTheme = ['eu' => json_decode($sw->encodeJson($bom['eu']['server'], $bom['eu']['plural'], $bom['eu']['foreign']), true)];
$bom2 = $sw->build('demo', $bomOrig, $bomTheme);
same([$bom2['eu']['server'], $bom2['eu']['foreign']], [$bom['eu']['server'], []], 'unreadable file: the same on the next run');

// The browser copy starts from the app's own .js texts (they can differ from its .json texts).
$jsRaw = "OC.L10N.register(\n    \"demo\",\n    {\n    \"Edit within Nextcloud\" : \"Nextcloud内で編集\",\n    \"Only in js\" : \"ONLYOFFICE のみ\"\n},\n\"nplurals=1; plural=0;\");\n";
same(L10nSweeper::decodeJs($jsRaw), ['Edit within Nextcloud' => 'Nextcloud内で編集', 'Only in js' => 'ONLYOFFICE のみ'], 'decodeJs: Nextcloud\'s browser format');
same(L10nSweeper::decodeJs('var x = 1;'), null, 'decodeJs: anything else');
same(L10nSweeper::decodeJs("OC.L10N.register(\"onlyoffice\", {\"Price\" : \"\\\$5 \\\\\$ \\\"ok\\\" \\u00e9\"}, \"nplurals=2; plural=(n != 1);\");"),
	['Price' => '$5 \\$ "ok" é'], 'decodeJs: JavaScript escapes JSON lacks (\\$ in onlyoffice\'s files)');
same(L10nSweeper::decodeJs($sw->encodeJs('demo', ['a' => 'b'], 'nplurals=2; plural=(n != 1);')), ['a' => 'b'], 'decodeJs: reads what encodeJs writes');
$jsonTr = ['Edit within Nextcloud' => 'Nextcloudで編集', 'Save' => '保存', 'Only in json' => 'Nextcloud json'];
$jsTr = ['Edit within Nextcloud' => 'Nextcloud内で編集', 'Save' => '保存', 'Only in js' => 'ONLYOFFICE のみ', 'Empty' => '', 'Kept' => 'Nextcloud from js'];
$bc = $sw->browserCopy('demo', 'ja', $jsonTr, $jsTr, ['Edit within Nextcloud' => 'Nourax Workspaceで編集', 'Only in json' => 'Nourax Workspace json', 'Kept' => 'NoGantt from the other tool'], ['Kept' => 'NoGantt from the other tool']);
same($bc, ['Edit within Nextcloud' => 'Nourax Workspace内で編集', 'Save' => '保存', 'Only in json' => 'Nourax Workspace json', 'Kept' => 'NoGantt from the other tool', 'Only in js' => 'ONLYOFFICE のみ'],
	'browserCopy: the .js wording, swept; .json fills in; other tools\' texts stay; empty .js texts dropped');
same($sw->browserCopy('demo', 'ja', $jsonTr, null, ['Edit within Nextcloud' => 'X'], []), ['Edit within Nextcloud' => 'X', 'Save' => '保存', 'Only in json' => 'Nextcloud json'], 'browserCopy: no .js file, the .json texts with the changes');

// An empty translation of a text with the name shows the English text: it gets the swept one.
$empty = $sw->build('demo', ['fr' => ['translations' => ['Nextcloud settings' => '', 'Files' => ''], 'plural' => 'nplurals=2; plural=(n > 1);']], []);
same($empty['fr']['translations'], ['Nextcloud settings' => 'Nourax Workspace settings'], 'build: empty translation of a named text filled in, others left');

// One folder: plural padding, the English file, filled-in keys and the foreign layer.
$plural = '_%n Nextcloud app_::_%n Nextcloud apps_';
$orig = [
	'en_GB' => ['translations' => ['Nextcloud settings' => 'Nextcloud settings', 'Files' => 'Files', $plural => ['%n Nextcloud app', '%n Nextcloud apps']], 'plural' => 'nplurals=2; plural=(n != 1);'],
	'de' => ['translations' => ['Nextcloud settings' => 'Nextcloud-Einstellungen', 'Files' => 'Dateien'], 'plural' => 'nplurals=2; plural=(n != 1);'],
	'cs' => ['translations' => ['Files' => 'Soubory'], 'plural' => 'nplurals=4; plural=(n==1) ? 0 : (n>=2 && n<=4) ? 1 : 3;'],
	'ja' => ['translations' => ['Files' => 'ファイル'], 'plural' => 'nplurals=1; plural=0;'],
];
$res = $sw->build('demo', $orig, []);
same(array_keys($res), ['cs', 'de', 'en', 'en_GB', 'ja'], 'build: every language of the folder, and en');
same($res['en']['translations'], ['Nextcloud settings' => 'Nourax Workspace settings', $plural => ['%n Nourax Workspace app', '%n Nourax Workspace apps']], 'build: en has the swept source texts');
same($res['de']['translations'], ['Nextcloud settings' => 'Nourax Workspace-Einstellungen', $plural => ['%n Nourax Workspace app', '%n Nourax Workspace apps']], 'build: de, swept and filled in');
same($res['cs']['translations'][$plural], ['%n Nourax Workspace app', '%n Nourax Workspace apps', '%n Nourax Workspace apps', '%n Nourax Workspace apps'], 'build: plural padded to 4 forms (cs)');
same($res['ja']['translations'][$plural], ['%n Nourax Workspace apps'], 'build: 1 plural form (ja)');
same(array_key_exists('Files', $res['de']['translations']), false, 'build: texts without the name are not in the theme file');
same([$res['de']['changed'], $res['de']['filled']], [1, 1], 'build: counts');

// What the files look like, and that a second run with the written files changes nothing.
$theme = [];
$files = [];
foreach ($res as $lang => $r) {
	$json = $sw->encodeJson($r['translations'], $r['plural'], $r['foreign']);
	$files[$lang] = $json;
	$doc = json_decode($json, true);
	check(is_array($doc['translations'] ?? null) && ($doc['pluralForm'] ?? null) === $r['plural'], "json file for $lang has translations and pluralForm");
	$theme[$lang] = $doc;
	$full = $orig[$lang]['translations'] ?? [];
	foreach ($r['translations'] as $k => $v) {
		$full[$k] = $v;
	}
	$js = $sw->encodeJs('demo', $full, $r['plural']);
	$ok = preg_match('/^OC\.L10N\.register\(\s*("(?:[^"\\\\]|\\\\.)*")\s*,\s*(\{.*\})\s*,\s*("(?:[^"\\\\]|\\\\.)*")\s*\)\s*;?\s*$/s', $js, $m) === 1;
	check($ok && json_decode($m[1]) === 'demo' && json_decode($m[2], true) == $full && json_decode($m[3]) === $r['plural'], "js file for $lang is a full copy in Nextcloud's format");
	same($sw->leftovers($full), [], "nothing left with the name ($lang)");
}
$again = $sw->build('demo', $orig, $theme);
$same = true;
foreach ($again as $lang => $r) {
	$same = $same && $sw->encodeJson($r['translations'], $r['plural'], $r['foreign']) === $files[$lang];
}
check($same, 'a second run on its own output gives the same files');

// Another tool's file (no marker) is kept and built on, also on the next run.
$gantt = ['translations' => ['Nextcloud settings' => 'NoGantt settings', 'Extra' => 'Nextcloud extra'], 'pluralForm' => 'nplurals=2; plural=(n != 1);'];
$r1 = $sw->build('demo', $orig, ['de' => $gantt])['de'];
same($r1['foreign'], $gantt['translations'], 'foreign file: taken as the base');
same($r1['translations']['Nextcloud settings'], 'NoGantt settings', 'foreign file: its wording stays');
same($r1['translations']['Extra'], 'Nourax Workspace extra', 'foreign file: swept on top');
$written = json_decode($sw->encodeJson($r1['translations'], $r1['plural'], $r1['foreign']), true);
$r2 = $sw->build('demo', $orig, ['de' => $written])['de'];
same([$r2['translations'], $r2['foreign']], [$r1['translations'], $r1['foreign']], 'foreign file: same result on the next run');
$edited = $written;
$edited['translations']['Nextcloud settings'] = 'Edited by hand';
same(L10nSweeper::foreign($edited), $edited['translations'], 'a sweep file changed by someone else counts as foreign');

// The language menus.
$state = '{"languageMap":{"activeLanguage":{"code":"en_GB","name":"English (British English)"},"commonLanguages":[{"code":"en","name":"English (US)"},{"code":"de","name":"Deutsch"}],"otherLanguages":[{"code":"en_GB","name":"English (British English)"},{"code":"en_GB","name":"English (British English)"},{"code":"de","name":"Deutsch"},{"code":"ga","name":"Gaeilge"}]},"emptyObject":{},"emptyList":[]}';
$fixed = LanguageList::fix($state, 'languageMap');
$want = '{"languageMap":{"activeLanguage":{"code":"en_GB","name":"English (British English)"},"commonLanguages":[{"code":"en","name":"English (US)"},{"code":"de","name":"Deutsch"}],"otherLanguages":[{"code":"en_GB","name":"English (British English)"},{"code":"ga","name":"Gaeilge"}]},"emptyObject":{},"emptyList":[]}';
same($fixed, $want, 'language list: doubles removed, everything else as it was');
same(LanguageList::fix($want, 'languageMap'), null, 'language list: nothing to fix');
same(LanguageList::fix('{"other":1}', 'languageMap'), null, 'language list: other states left alone');

// Upstream colours, backgrounds and addresses (Middleware\UpstreamPagesMiddleware).
$css = ':root { --color-element-assistant:linear-gradient(214deg, #A569D3 12%, #00679E 39%, #422083 86%); --a:#0082c9; --b:#0082c980; --c:#00679e1; --d:#10082c9; }';
same(UpstreamAssets::recolourCss($css),
	':root { --color-element-assistant:linear-gradient(214deg, #A569D3 12%, #2563EB 39%, #422083 86%); --a:#2563EB; --b:#2563EB80; --c:#00679e1; --d:#10082c9; }',
	'theme CSS: upstream blues become cobalt, alpha kept, longer colours left alone');
$shipped = [
	'jo-myoung-hee-fluid.webp' => ['attribution' => 'Fluid (Jo Myoung Hee - Nextcloud GmbH, CC-BY-SA-4.0)', 'attribution_url' => 'https://nextcloud.com/trademarks/'],
	'kamil-porembinski-clouds.jpg' => ['attribution' => 'Clouds (Kamil Porembiński, CC BY-SA)', 'attribution_url' => 'https://www.flickr.com/photos/paszczak000/8715851521/'],
	'other.webp' => ['attribution' => 'Other (someone)', 'attribution_url' => 'https://github.com/nextcloud/server'],
];
same(array_keys(UpstreamAssets::filterBackgrounds($shipped)), ['kamil-porembinski-clouds.jpg'], 'backgrounds: those crediting or linking the upstream are left out');
same(UpstreamAssets::isUpstreamUrl('https://docs.nextcloud.com/server/35/go.php?to=user'), true, 'upstream address: docs');
same(UpstreamAssets::isUpstreamUrl('https://github.com/NextCloud'), true, 'upstream address: GitHub organisation, any case');
same(UpstreamAssets::isUpstreamUrl('https://github.com/nextcloudfan/x'), false, 'upstream address: another GitHub account');
same(UpstreamAssets::isUpstreamUrl('https://notnextcloud.com/'), false, 'upstream address: a look-alike host');
same(UpstreamAssets::isUpstreamUrl('/apps/files/?dir=/nextcloud.com'), false, 'upstream address: a path on our site');

echo "\n$passed passed, $failed failed\n";
exit($failed === 0 ? 0 : 1);
