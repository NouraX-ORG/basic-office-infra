<?php

declare(strict_types=1);

/**
 * One row per API call in nourax_api_audit: who (which key), what (method, route, target id),
 * the answer and how long it took. Never a request or response body, never a key.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\NouraxApi\Service;

use OCP\AppFramework\Utility\ITimeFactory;
use OCP\DB\QueryBuilder\IQueryBuilder;
use OCP\IDBConnection;
use Psr\Log\LoggerInterface;

class AuditLog {
	public function __construct(
		private IDBConnection $db,
		private ITimeFactory $time,
		private LoggerInterface $logger,
	) {
	}

	public function record(
		string $keyId,
		string $method,
		string $route,
		?string $target,
		int $httpStatus,
		?string $result,
		string $remoteIp,
		int $durationMs,
	): void {
		try {
			$qb = $this->db->getQueryBuilder();
			$qb->insert('nourax_api_audit')
				->values([
					'at' => $qb->createNamedParameter($this->time->getTime(), IQueryBuilder::PARAM_INT),
					'key_id' => $qb->createNamedParameter(substr($keyId, 0, 16)),
					'method' => $qb->createNamedParameter(substr($method, 0, 8)),
					'route' => $qb->createNamedParameter(substr($route, 0, 128)),
					'target' => $qb->createNamedParameter($target === null ? null : substr($target, 0, 128)),
					'http_status' => $qb->createNamedParameter($httpStatus, IQueryBuilder::PARAM_INT),
					'result' => $qb->createNamedParameter($result === null ? null : substr($result, 0, 32)),
					'remote_ip' => $qb->createNamedParameter(substr($remoteIp, 0, 64)),
					'duration_ms' => $qb->createNamedParameter(max(0, $durationMs), IQueryBuilder::PARAM_INT),
				])
				->executeStatement();
		} catch (\Throwable $e) {
			// The call itself already happened; a missing audit row must not turn it into an error.
			$this->logger->warning('nourax_api: audit row not written: ' . get_class($e) . ': ' . $e->getMessage(), ['app' => 'nourax_api']);
		}
	}
}
