# NoGantt: project plans on a Gantt timeline, with resources and links to NoBoard cards. It is the
# nc_Gantt app (app id nc_gantt, AGPL-3.0-or-later). What it does and why: docs/gantt.md.
# Sourced by scripts/configure.sh with its helpers (occ, dc, log). Safe to run again.
# SPDX-License-Identifier: AGPL-3.0-or-later

# The reviewed release. To move to a new one, follow "Updating NoGantt" in docs/gantt.md: review the
# new archive, then change these three lines together.
GANTT_VERSION=2.4.1
GANTT_URL=https://codeberg.org/fds2610/NC-Gantt/releases/download/v2.4.1-9a09070/nc_gantt-2.4.1-9a09070.tar.gz
GANTT_SHA256=9003904a4398f94f1870cc93e6a129d6c7e72298de05b3c5d0104efa976bcfb9

log "NoGantt (nc_gantt $GANTT_VERSION)"

# Install from the pinned archive, checked against its SHA-256 before anything is unpacked. The app
# store would install whatever release is newest, so it is not used for the first install.
gantt_path="$(occ app:getpath nc_gantt 2>/dev/null || true)"
if [ -z "$gantt_path" ]; then
	log "  installing nc_gantt $GANTT_VERSION from the pinned release archive"
	gantt_tmp="$(mktemp)"
	if ! curl -fsSL --proto '=https' --max-time 300 -o "$gantt_tmp" "$GANTT_URL"; then
		log "  WARNING: could not download $GANTT_URL - NoGantt not installed this time"
	elif ! printf '%s  %s\n' "$GANTT_SHA256" "$gantt_tmp" | sha256sum -c --quiet - >/dev/null 2>&1; then
		log "  WARNING: the nc_gantt archive does not match its pinned SHA-256 - not installed"
	else
		# The archive must hold the nc_gantt/ folder and nothing else.
		gantt_bad="$(tar -tzf "$gantt_tmp" | grep -Ecv '^nc_gantt/' || true)"
		gantt_up="$(tar -tzf "$gantt_tmp" | grep -Ec '(^|/)\.\.(/|$)' || true)"
		if [ "$gantt_bad" != 0 ] || [ "$gantt_up" != 0 ]; then
			log "  WARNING: the nc_gantt archive holds files outside nc_gantt/ - not installed"
		else
			dc exec -T -u www-data app tar -xzf - --no-same-owner -C /var/www/html/custom_apps < "$gantt_tmp"
			gantt_path="$(occ app:getpath nc_gantt 2>/dev/null || true)"
		fi
	fi
	rm -f "$gantt_tmp"   # this run's own download
fi

if [ -n "$gantt_path" ]; then
	if occ app:list --output=json | jq -e '.enabled.nc_gantt != null' >/dev/null; then
		log "  nc_gantt already enabled"
	elif ! occ app:enable nc_gantt; then
		log "  WARNING: nc_gantt could not be enabled - see: docker compose logs app"
	fi
	gantt_have="$(occ app:list --output=json | jq -r '.enabled.nc_gantt // empty')"
	if [ "$gantt_have" != "$GANTT_VERSION" ]; then
		log "  NOTE: nc_gantt is at ${gantt_have:-?}, the pinned release is $GANTT_VERSION (see docs/gantt.md)"
	fi

	# Wording: the app names itself "nc_Gantt" and some texts say "Nextcloud". Nextcloud lets a theme
	# override single translations: the server reads themes/<theme>/<app path>/l10n/<lang>.json on top
	# of the app's own file, and the browser loads themes/<theme>/nc_gantt/l10n/<lang>.js instead of
	# the app's file. The overrides are rebuilt from the installed app on every run, so they follow app
	# updates. The theme folder holds nothing else, so naming one changes nothing else.
	gantt_theme="$(occ config:system:get theme 2>/dev/null || true)"
	if [ -z "$gantt_theme" ]; then
		log "  theme folder 'nourax' for translation overrides"
		occ config:system:set theme --value=nourax
		gantt_theme=nourax
	fi
	log "  wording: NoGantt instead of nc_Gantt, no upstream name (theme '$gantt_theme')"
	if ! dc exec -T -u www-data app php -- "$gantt_theme" "$gantt_path" <<'PHP'
<?php
// Builds the NoGantt translation overrides from the installed app. Arguments: theme, app path.
[, $theme, $appPath] = $argv;
$root = '/var/www/html';
$appId = 'nc_gantt';

// Nourax wording, applied to English source texts and to the app's own translations.
function nourax_wording(string $s): string {
	$s = preg_replace('/\b(?:nc|NC)[-_ ]?Gantt\b/', 'NoGantt', $s);
	$s = preg_replace('/\bNextcloud Calendar\b/i', 'NoCalendar', $s);
	$s = preg_replace('/\bNextcloud Tasks\b/i', 'NoTasks', $s);
	$s = preg_replace('/\bNextcloud Deck\b/i', 'NoBoard', $s);
	$s = preg_replace('/\byour Nextcloud\b/i', 'NoDrive', $s);
	return preg_replace('/Nextcloud/i', 'Nourax', $s);
}

// A quoted JavaScript or PHP string literal, as written in the source.
$lit = '"(?:[^"\\\\]|\\\\.)*"|\'(?:[^\'\\\\]|\\\\.)*\'';
function unquote(string $q, bool $js): ?string {
	$quote = $q[0];
	$body = substr($q, 1, -1);
	if ($quote === "'") {
		if (!$js) {
			return str_replace(['\\\'', '\\\\'], ['\'', '\\'], $body);
		}
		$body = str_replace(['\\\'', '"'], ['\'', '\\"'], $body);
	}
	$body = preg_replace('/\\\\x([0-9a-fA-F]{2})/', '\\u00$1', $body);
	$s = json_decode('"' . $body . '"');
	return is_string($s) ? $s : null;
}

// Every source text of the app: translation keys, t()/n() calls in the browser code and in PHP.
$keys = [];
foreach (glob("$appPath/l10n/*.json") as $file) {
	$data = json_decode(file_get_contents($file), true);
	foreach (array_keys($data['translations'] ?? []) as $k) {
		$keys[$k] = true;
	}
}
foreach (glob("$appPath/js/*.js") as $file) {
	preg_match_all('/(["\'])' . $appId . '\1\s*,\s*(' . $lit . ')(?:\s*,\s*(' . $lit . '))?/', file_get_contents($file), $m, PREG_SET_ORDER);
	foreach ($m as $hit) {
		$one = unquote($hit[2], true);
		$many = isset($hit[3]) && $hit[3] !== '' ? unquote($hit[3], true) : null;
		if ($one !== null) {
			$keys[$many !== null ? "_{$one}_::_{$many}_" : $one] = true;
		}
	}
}
$php = new RecursiveIteratorIterator(new RecursiveDirectoryIterator("$appPath/lib", FilesystemIterator::SKIP_DOTS));
foreach ($php as $file) {
	if (!str_ends_with($file->getFilename(), '.php')) {
		continue;
	}
	preg_match_all('/->(t|n)\(\s*(' . $lit . ')(?:\s*,\s*(' . $lit . '))?/', file_get_contents($file->getPathname()), $m, PREG_SET_ORDER);
	foreach ($m as $hit) {
		$one = unquote($hit[2], false);
		$many = $hit[1] === 'n' && isset($hit[3]) && $hit[3] !== '' ? unquote($hit[3], false) : null;
		if ($one !== null) {
			$keys[$many !== null ? "_{$one}_::_{$many}_" : $one] = true;
		}
	}
}
// Only the texts the wording changes need an override.
$keys = array_filter(array_keys($keys), static function (string $k): bool {
	return nourax_wording($k) !== $k;
});

$langs = ['en', 'en_GB'];
foreach (glob("$appPath/l10n/*.json") as $file) {
	$langs[] = basename($file, '.json');
}
$jsonDir = $root . '/themes/' . $theme . substr($appPath, strlen($root)) . '/l10n';
$jsDir = "$root/themes/$theme/$appId/l10n";
foreach ([$jsonDir, $jsDir] as $dir) {
	if (!is_dir($dir) && !mkdir($dir, 0755, true)) {
		fwrite(STDERR, "cannot create $dir\n");
		exit(1);
	}
}
$left = 0;
$summary = [];
foreach (array_unique($langs) as $lang) {
	$own = "$appPath/l10n/$lang.json";
	$src = is_file($own) ? json_decode(file_get_contents($own), true) : [];
	$plural = $src['pluralForm'] ?? 'nplurals=2; plural=(n != 1);';
	$forms = preg_match('/nplurals\s*=\s*(\d+)/', $plural, $pm) ? max(1, (int)$pm[1]) : 2;
	// The browser file replaces the app's own one, so it carries all of the app's translations.
	$out = [];
	foreach ($src['translations'] ?? [] as $k => $v) {
		$out[$k] = is_array($v) ? array_map('nourax_wording', $v) : nourax_wording((string)$v);
	}
	$added = 0;
	foreach ($keys as $k) {
		if (array_key_exists($k, $out)) {
			continue;
		}
		if (preg_match('/^_(.*)_::_(.*)_$/s', $k, $pk)) {
			$out[$k] = array_merge([nourax_wording($pk[1])], array_fill(0, $forms - 1, nourax_wording($pk[2])));
		} else {
			$out[$k] = nourax_wording($k);
		}
		$added++;
	}
	foreach ($out as $v) {
		foreach ((array)$v as $s) {
			if (preg_match('/nextcloud/i', $s) || preg_match('/\b(?:nc|NC)[-_ ]?Gantt\b/', $s)) {
				$left++;
			}
		}
	}
	$flags = JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES;
	$json = json_encode(['translations' => (object)$out, 'pluralForm' => $plural], $flags) . "\n";
	$js = 'OC.L10N.register(' . "\n    " . json_encode($appId) . ",\n    "
		. json_encode((object)$out, $flags) . ",\n" . json_encode($plural) . ");\n";
	foreach (["$jsonDir/$lang.json" => $json, "$jsDir/$lang.js" => $js] as $path => $content) {
		if (!is_file($path) || file_get_contents($path) !== $content) {
			file_put_contents($path, $content);
		}
	}
	$summary[] = "$lang " . count($out) . ($added ? " (+$added)" : '');
}
echo '  overrides: ' . count($keys) . ' texts reworded; files per language: ' . implode(', ', $summary) . "\n";
echo "  texts still naming the upstream project: $left\n";
exit($left === 0 ? 0 : 1);
PHP
	then
		log "  WARNING: the NoGantt wording overrides are incomplete - see the lines above"
	fi

	# Colour: projects without their own colour get the upstream brand blue (#0082c9) from the app.
	# Show Nourax cobalt instead, in the chart bars, the colour dots and the colour swatches.
	log "  colours: Nourax cobalt in place of the upstream default project colour"
	gantt_css_block='/* NoGantt:start - Nourax cobalt in place of the default project colour #0082c9 (scripts/configure.d/55-gantt.sh) */
body:has(#content.app-nc_gantt) .gantt-fill-0082c9 .bar { fill: #2563EB !important; }
body:has(#content.app-nc_gantt) .gantt-fill-0082c9 .bar-progress { fill: #2563EBcc !important; }
body:has(#content.app-nc_gantt) [style*="background: rgb(0, 130, 201)"],
body:has(#content.app-nc_gantt) [style*="background-color: rgb(0, 130, 201)"] { background: #2563EB !important; }
body:has(#content.app-nc_gantt) [fill="#0082c9" i] { fill: #2563EB !important; }
body:has(#content.app-nc_gantt) [stroke="#0082c9" i] { stroke: #2563EB !important; }
/* NoGantt:end */'
	# configure.sh writes the theme CSS fresh before this file runs; drop an older copy of the block
	# anyway, so running this file on its own does not add it twice.
	gantt_css="$(occ config:app:get theming_customcss customcss || true)"
	gantt_css="$(printf '%s\n' "$gantt_css" | sed '/\/\* NoGantt:start/,/\/\* NoGantt:end \*\//d')"
	occ config:app:set theming_customcss customcss --value="$gantt_css"$'\n'"$gantt_css_block" \
		--no-lazy --no-interaction >/dev/null
	occ config:app:set theming_customcss cachebuster --value="$(date +%s)"
fi
