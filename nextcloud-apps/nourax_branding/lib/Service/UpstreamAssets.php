<?php

declare(strict_types=1);

/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\NouraxBranding\Service;

/**
 * Small rules for upstream colours, pictures and links, shared by Middleware\UpstreamPagesMiddleware.
 * It uses no Nextcloud class, so tests/run.php loads it on its own.
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
	 * (Nextcloud 35: "Fluid" and "Globe", "… - Nextcloud GmbH", linking nextcloud.com/trademarks).
	 * The picker of Appearance and accessibility shows that credit as the button's title.
	 *
	 * @param array<string, mixed> $backgrounds file name => details, as BackgroundService::SHIPPED_BACKGROUNDS
	 * @return array<string, mixed>
	 */
	public static function filterBackgrounds(array $backgrounds): array {
		return array_filter($backgrounds, static function ($details): bool {
			if (!is_array($details)) {
				return true;
			}
			$credit = (string)($details['attribution'] ?? '');
			$url = (string)($details['attribution_url'] ?? '');
			return stripos($credit, 'nextcloud') === false && !self::isUpstreamUrl($url);
		});
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
}
