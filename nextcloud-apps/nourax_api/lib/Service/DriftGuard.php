<?php

declare(strict_types=1);

/**
 * Marks group changes that this app makes itself, so GroupDriftListener only notes changes made
 * elsewhere (an admin in the web UI, another app). Usage: DriftGuard::run(fn () => $group->addUser($u));
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\NouraxApi\Service;

final class DriftGuard {
	private static int $depth = 0;

	/**
	 * @template T
	 * @param callable(): T $change
	 * @return T
	 */
	public static function run(callable $change): mixed {
		self::$depth++;
		try {
			return $change();
		} finally {
			self::$depth--;
		}
	}

	public static function active(): bool {
		return self::$depth > 0;
	}
}
