<?php

declare(strict_types=1);

/**
 * What one virus scan found (ClamdClient::scan): clean, infected (with the virus name), too
 * large, or failed (with a short reason for the server log, never any of the file's bytes).
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\NouraxApi\Service;

final class ScanResult {
	public const CLEAN = 'clean';
	public const INFECTED = 'infected';
	public const TOO_LARGE = 'too_large';
	public const FAILED = 'failed';

	/** The longest virus name passed on (NoMail keeps 200 characters too). */
	public const MAX_SIGNATURE = 200;

	private function __construct(
		public readonly string $verdict,
		public readonly int $bytes,
		public readonly ?string $signature = null,
		public readonly string $detail = '',
	) {
	}

	public static function clean(int $bytes): self {
		return new self(self::CLEAN, $bytes);
	}

	public static function infected(int $bytes, string $signature): self {
		return new self(self::INFECTED, $bytes, self::cleanSignature($signature));
	}

	public static function tooLarge(int $bytes, string $detail): self {
		return new self(self::TOO_LARGE, $bytes, null, $detail);
	}

	public static function failed(int $bytes, string $detail): self {
		return new self(self::FAILED, $bytes, null, $detail);
	}

	/** A virus name as clamd gives it, made safe to send: no control characters, 200 at most. */
	public static function cleanSignature(string $name): string {
		$name = trim((string)preg_replace('/[\x00-\x1f\x7f]+/', ' ', $name));
		$name = substr($name, 0, self::MAX_SIGNATURE);
		// clamd's names are ASCII; anything else is cut to valid UTF-8 so the JSON answer works.
		$name = mb_scrub($name, 'UTF-8');
		return $name === '' ? 'Unknown virus' : $name;
	}
}
