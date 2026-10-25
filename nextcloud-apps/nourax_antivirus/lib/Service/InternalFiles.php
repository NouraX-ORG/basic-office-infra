<?php

declare(strict_types=1);

/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\NouraxAntivirus\Service;

use OCA\NouraxAntivirus\AppInfo\Application;
use OCP\App\IAppManager;
use OCP\AppFramework\Utility\ITimeFactory;
use OCP\DB\QueryBuilder\IQueryBuilder;
use OCP\Files\IMimeTypeLoader;
use OCP\IDBConnection;
use Psr\Log\LoggerInterface;

/**
 * Keeps files_antivirus's list of scanned files (table files_antivirus: fileid, check_time) right
 * for files kept in the object store.
 *
 * Why: the app's stored-file scan picks "never scanned" files from the file list, and leaves out
 * everything in a person's storage that is outside files/ (versions, trash, editor history, upload
 * leftovers) only when that storage's name starts with "home::". With the object store a person's
 * storage is "object::user:<uid>" and a team folder's is "object::store:object::groupfolder:...",
 * so those entries are picked as well. The scan can't open them, logs "Tried to scan non file",
 * and picks the same ones again on every run, so with more of them than one run takes (10 for the
 * app's cron job) it never reaches new files. Entering them here as scanned, as the upstream rule
 * intends, lets every run reach the real files.
 *
 * Their check time is the time they are entered, not "never": a trash item put back into files/
 * is then scanned again with the 28-day rescan.
 */
class InternalFiles {
	private const STORAGE_PREFIXES = ['object::user:', 'object::store:object::groupfolder:'];
	private const BATCH = 10000;

	public function __construct(
		private readonly IDBConnection $db,
		private readonly IMimeTypeLoader $mimeTypeLoader,
		private readonly IAppManager $appManager,
		private readonly ITimeFactory $timeFactory,
		private readonly LoggerInterface $logger,
	) {
	}

	public function antivirusEnabled(): bool {
		return $this->appManager->isEnabledForAnyone('files_antivirus');
	}

	/**
	 * Enters every not-yet-listed entry outside files/ in a person's or a team folder's object
	 * storage as scanned.
	 *
	 * @return int how many were entered
	 */
	public function skipInternal(): int {
		if (!$this->antivirusEnabled()) {
			return 0;
		}
		$qb = $this->db->getQueryBuilder();
		$storages = [];
		foreach (self::STORAGE_PREFIXES as $prefix) {
			$storages[] = $qb->expr()->like('s.id', $qb->createNamedParameter($this->db->escapeLikeParameter($prefix) . '%'));
		}
		$qb->select('fc.fileid')
			->from('filecache', 'fc')
			->innerJoin('fc', 'storages', 's', $qb->expr()->eq('fc.storage', 's.numeric_id'))
			->leftJoin('fc', 'files_antivirus', 'fa', $qb->expr()->eq('fc.fileid', 'fa.fileid'))
			->where($qb->expr()->isNull('fa.fileid'))
			->andWhere($qb->expr()->orX(...$storages))
			->andWhere($qb->expr()->notLike('fc.path', $qb->createNamedParameter('files/%')))
			->andWhere($qb->expr()->neq('fc.mimetype', $qb->createNamedParameter($this->mimeTypeLoader->getId('httpd/unix-directory'), IQueryBuilder::PARAM_INT)))
			->andWhere($qb->expr()->neq('fc.size', $qb->createNamedParameter(0, IQueryBuilder::PARAM_INT)))
			->setMaxResults(self::BATCH);

		$result = $qb->executeQuery();
		$fileIds = [];
		while (($fileId = $result->fetchOne()) !== false) {
			$fileIds[] = (int)$fileId;
		}
		$result->closeCursor();

		$now = $this->timeFactory->getTime();
		$entered = 0;
		foreach ($fileIds as $fileId) {
			$entered += $this->db->insertIgnoreConflict('files_antivirus', ['fileid' => $fileId, 'check_time' => $now]);
		}
		if ($entered > 0) {
			$this->logger->info("Entered $entered version, trash, editor or upload entries as not for the stored-file scan", ['app' => Application::APP_ID]);
		}
		return $entered;
	}

	/**
	 * Records that a file was scanned now (what files_antivirus does for a clean one-piece upload).
	 */
	public function markScanned(int $fileId): void {
		$now = $this->timeFactory->getTime();
		$qb = $this->db->getQueryBuilder();
		$updated = $qb->update('files_antivirus')
			->set('check_time', $qb->createNamedParameter($now, IQueryBuilder::PARAM_INT))
			->where($qb->expr()->eq('fileid', $qb->createNamedParameter($fileId, IQueryBuilder::PARAM_INT)))
			->executeStatement();
		if ($updated === 0) {
			$this->db->insertIgnoreConflict('files_antivirus', ['fileid' => $fileId, 'check_time' => $now]);
		}
	}
}
