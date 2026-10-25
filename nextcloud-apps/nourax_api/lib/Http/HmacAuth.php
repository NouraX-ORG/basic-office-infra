<?php

declare(strict_types=1);

/**
 * The admin API's request check. Every admin request is signed with the admin key
 * (server secret nodrive_admin_api_key), so a request cannot be changed or sent twice:
 *
 *   X-Nourax-Key-Id     which key signed it (default "admin-1"), so a key can be rotated
 *   X-Nourax-Timestamp  Unix seconds; must be within 300 seconds of the server's clock
 *   X-Nourax-Nonce      16-64 characters of [A-Za-z0-9_-], used only once
 *   X-Nourax-Signature  hex HMAC-SHA256 with the key over the canonical string:
 *
 *   "NOURAX-ADMIN-V1\n" + METHOD + "\n" + PATH + "\n" + TIMESTAMP + "\n" + NONCE + "\n" + sha256hex(body)
 *
 * PATH starts at /v1/ and includes ?query when there is one, exactly as sent. The body is the
 * raw request body (empty for GET). Signatures are compared with hash_equals. Each nonce is kept
 * in nourax_api_nonces for 600 seconds (in the database: Redis keeps nothing on disk here), and a
 * second use is refused as "replayed".
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\NouraxApi\Http;

use OCA\NouraxApi\Settings;
use OCP\AppFramework\Utility\ITimeFactory;
use OCP\DB\Exception as DbException;
use OCP\DB\QueryBuilder\IQueryBuilder;
use OCP\IDBConnection;
use OCP\IRequest;

class HmacAuth {
	public const PREFIX = 'NOURAX-ADMIN-V1';
	public const DEFAULT_KEY_ID = 'admin-1';
	/** Seconds a timestamp may be off from the server's clock, either way. */
	public const WINDOW = 300;
	/** Seconds a nonce is remembered. Twice the window, so a replay is caught either way. */
	public const NONCE_TTL = 600;
	/** Largest accepted request body, in bytes. */
	public const MAX_BODY = 2097152;

	private const KEY_ID = '/^[a-z0-9-]{1,16}$/D';
	private const TIMESTAMP = '/^[0-9]{1,12}$/D';
	private const NONCE = '/^[A-Za-z0-9_-]{16,64}$/D';
	private const SIGNATURE = '/^[0-9a-fA-F]{64}$/D';

	public function __construct(
		private Settings $settings,
		private IDBConnection $db,
		private ITimeFactory $time,
	) {
	}

	/** False until `occ nourax_api:secret admin_key` has stored a key. */
	public function isConfigured(): bool {
		return $this->settings->adminKeys() !== [];
	}

	public static function canonical(string $method, string $path, string $timestamp, string $nonce, string $body): string {
		return self::PREFIX . "\n" . strtoupper($method) . "\n" . $path . "\n" . $timestamp . "\n" . $nonce . "\n" . hash('sha256', $body);
	}

	public static function sign(#[\SensitiveParameter] string $key, string $canonical): string {
		return hash_hmac('sha256', $canonical, $key);
	}

	/**
	 * Checks the signature, the time and the nonce, in that order, and remembers the nonce.
	 *
	 * @param string $path the signed path: from /v1/ on, with ?query if any
	 * @return string the key id that signed the request
	 * @throws AuthFailed
	 */
	public function verify(IRequest $request, string $path, string $body): string {
		$keyId = $request->getHeader('X-Nourax-Key-Id');
		$keyId = $keyId === '' ? self::DEFAULT_KEY_ID : $keyId;
		$timestamp = $request->getHeader('X-Nourax-Timestamp');
		$nonce = $request->getHeader('X-Nourax-Nonce');
		$signature = $request->getHeader('X-Nourax-Signature');

		$keys = $this->settings->adminKeys();
		if (preg_match(self::KEY_ID, $keyId) !== 1 || !isset($keys[$keyId])
			|| preg_match(self::TIMESTAMP, $timestamp) !== 1
			|| preg_match(self::NONCE, $nonce) !== 1
			|| preg_match(self::SIGNATURE, $signature) !== 1) {
			throw new AuthFailed('unauthorized', true);
		}

		$expected = self::sign($keys[$keyId], self::canonical($request->getMethod(), $path, $timestamp, $nonce, $body));
		if (!hash_equals($expected, strtolower($signature))) {
			throw new AuthFailed('unauthorized', true);
		}

		// A good signature from a clock that is too far off: not an attack, so not throttled.
		$now = $this->time->getTime();
		if (abs($now - (int)$timestamp) > self::WINDOW) {
			throw new AuthFailed('stale_request', false);
		}

		if (!$this->remember($keyId . ':' . $nonce, $now + self::NONCE_TTL)) {
			throw new AuthFailed('replayed', false);
		}
		return $keyId;
	}

	/** Stores a nonce. False when it is already there (the request was sent before). */
	private function remember(string $nonce, int $expiresAt): bool {
		try {
			$qb = $this->db->getQueryBuilder();
			$qb->insert('nourax_api_nonces')
				->values([
					'nonce' => $qb->createNamedParameter($nonce),
					'expires_at' => $qb->createNamedParameter($expiresAt, IQueryBuilder::PARAM_INT),
				])
				->executeStatement();
			return true;
		} catch (DbException $e) {
			if ($e->getReason() === DbException::REASON_UNIQUE_CONSTRAINT_VIOLATION) {
				return false;
			}
			throw $e;
		}
	}
}
