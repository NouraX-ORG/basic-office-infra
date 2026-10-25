<?php

declare(strict_types=1);

/**
 * Global rate limits (all callers together, not per IP), kept in Redis so every PHP worker sees
 * the same counts. NoMail's Edge Functions have no fixed IP, so per-IP limits would not help.
 *
 * Defaults (calls per minute): health 120, provision 60, scan 60, admin 120; scans at most 2 at
 * once. They sit well above NoMail's batches (10 provisions and 20 scans per run, one run a minute).
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\NouraxApi\Http;

use OCA\NouraxApi\Settings;
use OCP\AppFramework\Utility\ITimeFactory;
use OCP\ICacheFactory;
use OCP\IMemcache;

class RateLimiter {
	/** What a 429 tells the caller to wait, in seconds. */
	public const RETRY_AFTER = 30;

	private ?IMemcache $cache = null;

	public function __construct(
		ICacheFactory $cacheFactory,
		private Settings $settings,
		private ITimeFactory $time,
	) {
		if ($cacheFactory->isAvailable()) {
			$cache = $cacheFactory->createDistributed('nourax_api');
			// Redis implements IMemcache (atomic add and inc); without it there is no shared limit.
			$this->cache = $cache instanceof IMemcache ? $cache : null;
		}
	}

	/** Counts one call in this minute's window. False when the bucket is over its limit. */
	public function hit(string $bucket): bool {
		$limit = $this->settings->rateLimit($bucket);
		if ($limit <= 0 || $this->cache === null) {
			return true;
		}
		$key = 'rl/' . $bucket . '/' . intdiv($this->time->getTime(), 60);
		// The counter lives two minutes; inc keeps the expiry that add set.
		$this->cache->add($key, 0, 120);
		$count = $this->cache->inc($key);
		return !is_int($count) || $count <= $limit;
	}

	/**
	 * Takes one of $max slots for $bucket, e.g. for scans that may run at most two at once.
	 * Returns the slot to give back with releaseSlot(), or null when all are taken. A slot frees
	 * itself after $ttl seconds if the process dies without giving it back.
	 */
	public function acquireSlot(string $bucket, int $max, int $ttl): ?string {
		if ($this->cache === null) {
			return '';
		}
		for ($i = 0; $i < $max; $i++) {
			$key = 'slot/' . $bucket . '/' . $i;
			if ($this->cache->add($key, 1, $ttl)) {
				return $key;
			}
		}
		return null;
	}

	public function releaseSlot(?string $slot): void {
		if ($slot !== null && $slot !== '' && $this->cache !== null) {
			$this->cache->remove($slot);
		}
	}
}
