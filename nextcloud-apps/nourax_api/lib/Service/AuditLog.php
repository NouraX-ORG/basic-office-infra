<?php

declare(strict_types=1);

/**
 * One row per API call in nourax_api_audit: who (which key), what (method, route, target id),
 * the answer and how long it took. Never a request or response body, never a key.
 * Also one row per switch of privacy between organisations (OrgPrivacySwitch): route
 * "org-privacy" with key id "occ" (method CLI, HTTP status 0), or route "settings/org-privacy"
 * with key id "admin-page"; the target is who switched (the admin's account id, or occ's --by
 * name), the result what it did.
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

	/**
	 * The newest rows first, for GET /v1/admin/audit. $target narrows them to one object
	 * (e.g. "team:<team_id>" or a uid).
	 *
	 * @return list<array{id: int, at: string, key_id: string, method: string, route: string, target: ?string, http_status: int, result: ?string, remote_ip: string, duration_ms: int}>
	 */
	public function recent(int $limit, ?string $target = null): array {
		$qb = $this->db->getQueryBuilder();
		$qb->select('*')->from('nourax_api_audit')
			->orderBy('id', 'DESC')
			->setMaxResults(max(1, $limit));
		if ($target !== null) {
			$qb->where($qb->expr()->eq('target', $qb->createNamedParameter($target)));
		}
		$rows = [];
		$result = $qb->executeQuery();
		while (($row = $result->fetchAssociative()) !== false) {
			$rows[] = self::row($row);
		}
		$result->closeCursor();
		return $rows;
	}

	/**
	 * The newest rows of the given routes first, optionally only those with one of $results (for
	 * the privacy switch's "Recent changes" on the admin page).
	 *
	 * @param list<string> $routes
	 * @param list<string> $results
	 * @return list<array{id: int, at: string, key_id: string, method: string, route: string, target: ?string, http_status: int, result: ?string, remote_ip: string, duration_ms: int}>
	 */
	public function recentForRoutes(array $routes, int $limit, array $results = []): array {
		$qb = $this->db->getQueryBuilder();
		$qb->select('*')->from('nourax_api_audit')
			->where($qb->expr()->in('route', $qb->createNamedParameter($routes, IQueryBuilder::PARAM_STR_ARRAY)))
			->orderBy('id', 'DESC')
			->setMaxResults(max(1, $limit));
		if ($results !== []) {
			$qb->andWhere($qb->expr()->in('result', $qb->createNamedParameter($results, IQueryBuilder::PARAM_STR_ARRAY)));
		}
		$rows = [];
		$result = $qb->executeQuery();
		while (($row = $result->fetchAssociative()) !== false) {
			$rows[] = self::row($row);
		}
		$result->closeCursor();
		return $rows;
	}

	private static function row(array $row): array {
		return [
			'id' => (int)$row['id'],
			'at' => gmdate('c', (int)$row['at']),
			'key_id' => (string)$row['key_id'],
			'method' => (string)$row['method'],
			'route' => (string)$row['route'],
			'target' => $row['target'] === null ? null : (string)$row['target'],
			'http_status' => (int)$row['http_status'],
			'result' => $row['result'] === null ? null : (string)$row['result'],
			'remote_ip' => (string)$row['remote_ip'],
			'duration_ms' => (int)$row['duration_ms'],
		];
	}
}
