<?php

declare(strict_types=1);

/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\NouraxBranding\Service;

/**
 * Removes languages that are listed twice. Nextcloud 35 builds its list of languages from the files
 * in core/l10n and then adds the files of the theme's core/l10n without removing doubles
 * (OC\L10N\Factory::findAvailableLanguages), so once the text sweep writes a theme file for a
 * language, the language menu of Personal settings would show that language twice. It uses no
 * Nextcloud class, so tests/run.php loads it on its own.
 */
final class LanguageList {
	/**
	 * @param string $json an initial state as Nextcloud stores it (JSON)
	 * @param string $field the member that holds {commonLanguages: [...], otherLanguages: [...]}
	 * @return string|null the same state without doubles, or null when there were none
	 */
	public static function fix(string $json, string $field): ?string {
		// Objects stay objects, so empty ones are written back as {} and not as [].
		$data = json_decode($json, false);
		if (!($data instanceof \stdClass) || !(($data->{$field} ?? null) instanceof \stdClass)) {
			return null;
		}
		$map = $data->{$field};
		$seen = [];
		$changed = false;
		foreach (['commonLanguages', 'otherLanguages'] as $list) {
			if (!is_array($map->{$list} ?? null)) {
				continue;
			}
			$kept = [];
			foreach ($map->{$list} as $language) {
				$code = is_object($language) && isset($language->code) ? (string)$language->code : null;
				if ($code !== null && isset($seen[$code])) {
					$changed = true;
					continue;
				}
				if ($code !== null) {
					$seen[$code] = true;
				}
				$kept[] = $language;
			}
			$map->{$list} = $kept;
		}
		return $changed ? json_encode($data, JSON_THROW_ON_ERROR) : null;
	}
}
