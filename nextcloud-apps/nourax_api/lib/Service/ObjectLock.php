<?php

declare(strict_types=1);

/**
 * One admin call per object at a time: a Redis lock per organisation, team or person. A second
 * call for the same object meanwhile gets 423 {"error":"busy"} and is sent again later. A lock
 * frees itself after its time-to-live if the PHP process dies while holding it.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\NouraxApi\Service;

use OCP\ICacheFactory;
use OCP\IMemcache;

class ObjectLock {
	/** Seconds an admin call may hold its object's lock. */
	public const TTL = 120;

	private ?IMemcache $cache = null;

	public function __construct(ICacheFactory $cacheFactory) {
		if ($cacheFactory->isAvailable()) {
			$cache = $cacheFactory->createDistributed('nourax_api');
			$this->cache = $cache instanceof IMemcache ? $cache : null;
		}
	}

	/**
	 * Runs $work while holding the lock $name (e.g. "team/<team_id>").
	 *
	 * @template T
	 * @param callable(): T $work
	 * @return T
	 * @throws ApiException 423 busy
	 */
	public function with(string $name, callable $work): mixed {
		$key = 'admin-lock/' . $name;
		if ($this->cache !== null && !$this->cache->add($key, 1, self::TTL)) {
			throw new ApiException('busy', 423);
		}
		try {
			return $work();
		} finally {
			$this->cache?->remove($key);
		}
	}

	/**
	 * Like with(), but waits up to $seconds for the lock instead of giving up at once. For short
	 * shared sections, e.g. choosing a team folder name within one organisation.
	 *
	 * @template T
	 * @param callable(): T $work
	 * @return T
	 * @throws ApiException 423 busy
	 */
	public function waitFor(string $name, int $seconds, callable $work): mixed {
		$key = 'admin-lock/' . $name;
		if ($this->cache !== null) {
			$until = microtime(true) + $seconds;
			while (!$this->cache->add($key, 1, 30)) {
				if (microtime(true) >= $until) {
					throw new ApiException('busy', 423);
				}
				usleep(100000);
			}
		}
		try {
			return $work();
		} finally {
			$this->cache?->remove($key);
		}
	}
}
