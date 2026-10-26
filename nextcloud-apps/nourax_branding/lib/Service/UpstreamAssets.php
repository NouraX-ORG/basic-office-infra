<?php

declare(strict_types=1);

/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\NouraxBranding\Service;

/**
 * Small rules for upstream colours, pictures and links, shared by Middleware\UpstreamPagesMiddleware,
 * Service\CalendarColours and Service\ExampleContact. It uses no Nextcloud class, so tests/run.php
 * loads it on its own.
 */
final class UpstreamAssets {
	/** The upstream blues (docs/branding.md) and the Nourax cobalt that takes their place. */
	public const UPSTREAM_BLUES = ['0082c9', '00679e'];
	public const COBALT = '#2563EB';

	/**
	 * Every upstream blue in a stylesheet becomes the Nourax cobalt: #00679E, #0082c9 and their
	 * #rrggbbaa forms (the alpha is kept). Nextcloud 35 puts #00679E into the Assistant gradient of
	 * every theme it serves (--color-element-assistant and --color-element-assistant-icon).
	 */
	public static function recolourCss(string $css): string {
		$pattern = '~#(' . implode('|', self::UPSTREAM_BLUES) . ')([0-9a-f]{2})?(?![0-9a-f])~i';
		return (string)preg_replace_callback($pattern, static fn (array $m): string => self::COBALT . ($m[2] ?? ''), $css);
	}

	/**
	 * The shipped backgrounds of the theming app without those that credit the upstream company
	 * (Nextcloud 35: "Fluid" and "Globe", "… - Nextcloud GmbH", linking nextcloud.com/trademarks;
	 * the picker of Appearance and accessibility shows that credit as the button's title) and without
	 * those named in $off (rules.json backgrounds_off: mostly in the upstream blue).
	 *
	 * @param array<string, mixed> $backgrounds file name => details, as BackgroundService::SHIPPED_BACKGROUNDS
	 * @param list<string> $off file names to leave out
	 * @return array<string, mixed>
	 */
	public static function filterBackgrounds(array $backgrounds, array $off = []): array {
		return array_filter($backgrounds, static function ($details, $file) use ($off): bool {
			if (in_array((string)$file, $off, true)) {
				return false;
			}
			if (!is_array($details)) {
				return true;
			}
			$credit = (string)($details['attribution'] ?? '');
			$url = (string)($details['attribution_url'] ?? '');
			return stripos($credit, 'nextcloud') === false && !self::isUpstreamUrl($url);
		}, ARRAY_FILTER_USE_BOTH);
	}

	/** True for a colour within $tolerance (distance in RGB) of an upstream blue, as the audit measures. */
	public static function isUpstreamBlue(int $r, int $g, int $b, int $tolerance = 28): bool {
		$t2 = $tolerance * $tolerance;
		return $r ** 2 + ($g - 130) ** 2 + ($b - 201) ** 2 <= $t2 || $r ** 2 + ($g - 103) ** 2 + ($b - 158) ** 2 <= $t2;
	}

	/**
	 * A letter avatar as Nextcloud draws one, letters in $fg on a tint of it ($bg), drawn in $toFg on
	 * $toBg instead. Each pixel keeps its place between the two colours, so the letters' smooth edges
	 * stay smooth, and its transparency. The PNG, or null when GD cannot read it.
	 *
	 * @param array{0: int, 1: int, 2: int} $fg
	 * @param array{0: int, 1: int, 2: int} $bg
	 * @param array{0: int, 1: int, 2: int} $toFg
	 * @param array{0: int, 1: int, 2: int} $toBg
	 */
	public static function recolourAvatar(string $png, array $fg, array $bg, array $toFg, array $toBg): ?string {
		if (!function_exists('imagecreatefromstring') || $png === '') {
			return null;
		}
		$im = @imagecreatefromstring($png);
		if ($im === false) {
			return null;
		}
		imagepalettetotruecolor($im);
		imagealphablending($im, false);
		imagesavealpha($im, true);
		$d = [$fg[0] - $bg[0], $fg[1] - $bg[1], $fg[2] - $bg[2]];
		$dd = $d[0] ** 2 + $d[1] ** 2 + $d[2] ** 2;
		if ($dd === 0) {
			return null;
		}
		$map = [];
		$w = imagesx($im);
		$h = imagesy($im);
		for ($y = 0; $y < $h; $y++) {
			for ($x = 0; $x < $w; $x++) {
				$c = imagecolorat($im, $x, $y);
				if (!isset($map[$c])) {
					$r = ($c >> 16) & 0xff;
					$g = ($c >> 8) & 0xff;
					$b = $c & 0xff;
					$t = (($r - $bg[0]) * $d[0] + ($g - $bg[1]) * $d[1] + ($b - $bg[2]) * $d[2]) / $dd;
					$t = max(0.0, min(1.0, $t));
					$map[$c] = imagecolorallocatealpha($im,
						(int)round($toBg[0] + $t * ($toFg[0] - $toBg[0])),
						(int)round($toBg[1] + $t * ($toFg[1] - $toBg[1])),
						(int)round($toBg[2] + $t * ($toFg[2] - $toBg[2])),
						($c >> 24) & 0x7f);
				}
				imagesetpixel($im, $x, $y, $map[$c]);
			}
		}
		ob_start();
		imagepng($im);
		$out = (string)ob_get_clean();
		return $out !== '' ? $out : null;
	}

	/**
	 * How much of a picture is in an upstream blue, the way the browser audit measures it
	 * (branding/audit/scan-pictures.js): pixels within $tolerance (distance in RGB) of #0082C9 or
	 * #00679E among the opaque ones. Needs GD; null when the file cannot be read.
	 *
	 * @return array{opaque: int, blue: int}|null
	 */
	public static function upstreamBlueShare(string $file, int $tolerance = 28): ?array {
		if (!function_exists('imagecreatefromstring')) {
			return null;
		}
		$data = @file_get_contents($file);
		$im = is_string($data) && $data !== '' ? @imagecreatefromstring($data) : false;
		if ($im === false) {
			return null;
		}
		$w = imagesx($im);
		$h = imagesy($im);
		$opaque = 0;
		$blue = 0;
		for ($y = 0; $y < $h; $y++) {
			for ($x = 0; $x < $w; $x++) {
				$c = imagecolorat($im, $x, $y);
				if (imageistruecolor($im)) {
					$a = ($c >> 24) & 0x7f;
					$r = ($c >> 16) & 0xff;
					$g = ($c >> 8) & 0xff;
					$b = $c & 0xff;
				} else {
					$i = imagecolorsforindex($im, $c);
					[$a, $r, $g, $b] = [$i['alpha'], $i['red'], $i['green'], $i['blue']];
				}
				// GD's alpha runs from 0 (opaque) to 127 (clear); the audit counts alpha 128 of 255 or more.
				if ($a > 63) {
					continue;
				}
				$opaque++;
				if (self::isUpstreamBlue($r, $g, $b, $tolerance)) {
					$blue++;
				}
			}
		}
		return ['opaque' => $opaque, 'blue' => $blue];
	}

	/**
	 * Our theme previews for Appearance and accessibility, from the app's img/theme-previews folder:
	 * theme id (the file name, as the theming app's /apps/theming/img/<id>.jpg) => address, with
	 * ?v= and the start of the file's SHA-1, so browsers fetch a picture again when it changes.
	 * $urlOf turns a path below img/ into its address (IURLGenerator::imagePath).
	 *
	 * @param callable(string): string $urlOf
	 * @return array<string, string>
	 */
	public static function themePreviews(string $dir, callable $urlOf): array {
		$previews = [];
		foreach (glob($dir . '/*.png') ?: [] as $file) {
			$id = basename($file, '.png');
			if (preg_match('/^[a-z0-9-]+$/', $id) !== 1 || !is_file($file)) {
				continue;
			}
			$previews[$id] = $urlOf('theme-previews/' . $id . '.png') . '?v=' . substr((string)sha1_file($file), 0, 8);
		}
		ksort($previews);
		return $previews;
	}

	/**
	 * A whole HTML page in a right-to-left language gets dir="rtl" on its <body>, as Nextcloud 35 does
	 * only for signed-in pages (layout.user.php): its login, public share and other guest pages set
	 * no direction, so Arabic ran left to right there. The language is the page's own <html lang>;
	 * $directionOf maps it to "rtl" or "ltr" (IFactory::getLanguageDirection). A page whose <body>
	 * already has a dir, and anything that is not a whole page, is returned as it is.
	 *
	 * @param callable(string): string $directionOf
	 */
	public static function pageDirection(string $html, callable $directionOf): string {
		$head = substr($html, 0, 4096);
		if (!preg_match('~<html\b[^>]*\blang="([A-Za-z_-]{2,12})"~', $head, $m) || !str_contains($html, '<body')) {
			return $html;
		}
		if ($directionOf($m[1]) !== 'rtl') {
			return $html;
		}
		return (string)preg_replace_callback('~<body\b([^>]*)>~', static function (array $b): string {
			return preg_match('~\sdir\s*=~i', $b[1]) ? $b[0] : '<body dir="rtl"' . $b[1] . '>';
		}, $html, 1);
	}

	/** True for an address on the upstream's own websites (nextcloud.com and its subdomains, its GitHub). */
	public static function isUpstreamUrl(string $url): bool {
		$parts = parse_url(trim($url));
		if (!is_array($parts) || !isset($parts['host'])) {
			return false;
		}
		$host = strtolower($parts['host']);
		if ($host === 'nextcloud.com' || str_ends_with($host, '.nextcloud.com')) {
			return true;
		}
		$path = strtolower($parts['path'] ?? '');
		return $host === 'github.com' && ($path === '/nextcloud' || str_starts_with($path, '/nextcloud/'));
	}

	/**
	 * A colour value that is, as a whole, one of the upstream blues (#0082C9, #00679e, any case, with
	 * or without the #, with or without an alpha), the way calendar programs store a calendar's colour:
	 * the same value in $with (a #rrggbb colour, the Nourax cobalt by default), alpha kept. Anything
	 * else, a longer colour too, gives null.
	 */
	public static function recolourValue(string $colour, string $with = self::COBALT): ?string {
		$pattern = '~^\s*#?(' . implode('|', self::UPSTREAM_BLUES) . ')([0-9a-f]{2})?\s*$~i';
		if (preg_match($pattern, $colour, $m) !== 1) {
			return null;
		}
		return $with . ($m[2] ?? '');
	}

	/**
	 * The upstream example contact (the dav app's exampleContact.vcf, "Leon Green") made Nourax's: a
	 * website on an upstream address becomes $url, any other property that names the upstream is left
	 * out, and everything else, the photo too, stays as it is, byte for byte. It works on the text, so
	 * it needs no vCard library. Pictures, sounds and keys are never looked into.
	 *
	 * @return array{card: string, changed: list<string>} the card, and what changed ("URL", "ORG left out")
	 */
	public static function exampleCard(string $vcf, string $url): array {
		$eol = str_contains($vcf, "\r\n") ? "\r\n" : "\n";
		$groups = [];
		foreach (preg_split('/\r\n|\n|\r/', $vcf) ?: [] as $line) {
			// A line that starts with a space or a tab goes on with the line before it (RFC 6350 3.2).
			if ($groups !== [] && $line !== '' && ($line[0] === ' ' || $line[0] === "\t")) {
				$groups[count($groups) - 1][] = $line;
			} else {
				$groups[] = [$line];
			}
		}
		$out = [];
		$changed = [];
		foreach ($groups as $lines) {
			$logical = $lines[0];
			foreach (array_slice($lines, 1) as $more) {
				$logical .= substr($more, 1);
			}
			$colon = strpos($logical, ':');
			$head = $colon === false ? $logical : substr($logical, 0, $colon);
			$value = $colon === false ? '' : substr($logical, $colon + 1);
			// "item1.URL;TYPE=work" is the property URL.
			$name = strtoupper((string)preg_replace('/^[^.;]*\./', '', (string)strtok($head, ';')));
			$binary = in_array($name, ['PHOTO', 'LOGO', 'SOUND', 'KEY'], true) || stripos($head, 'ENCODING=B') !== false;
			if (!$binary && $name === 'URL' && self::namesUpstream($value)) {
				$out[] = $head . ':' . $url;
				$changed[] = 'URL';
				continue;
			}
			if (!$binary && self::namesUpstream($logical)) {
				$changed[] = $name . ' left out';
				continue;
			}
			array_push($out, ...$lines);
		}
		return ['card' => implode($eol, $out), 'changed' => $changed];
	}

	/** The upstream's name or one of its addresses in a line of text. */
	private static function namesUpstream(string $s): bool {
		return preg_match('~next\s*-?\s*cloud~i', $s) === 1;
	}
}
