<?php

declare(strict_types=1);

/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\NouraxAntivirus\Service;

use OCA\DAV\Connector\Sabre\Exception\UnsupportedMediaType;
use OCA\Files_Antivirus\Activity\Provider;
use OCA\Files_Antivirus\Scanner\ScannerFactory;
use OCA\Files_Antivirus\Status;
use OCA\NouraxAntivirus\AppInfo\Application;
use OCP\Activity\IManager as IActivityManager;
use OCP\App\IAppManager;
use OCP\Files\InvalidContentException;
use OCP\Files\Storage\IStorage;
use OCP\IAppConfig;
use OCP\L10N\IFactory as IL10NFactory;
use OCP\Server;
use Psr\Log\LoggerInterface;

/**
 * Scans a file uploaded in parts right after R2 has joined the parts, while the upload's last
 * request (the WebDAV MOVE) still waits for its answer. It uses files_antivirus's own scanner and
 * settings (ClamAV at clamav:3310, 100 MiB streams).
 *
 * - Infected: the file is removed and the MOVE is answered 415 "Virus ... is detected in the file.
 *   Upload cannot be completed.", with the same log line and Activity entry as an infected upload
 *   in one piece. Like there, an infected upload over an existing file removes that file too; its
 *   earlier content stays in its versions.
 * - Clean: the file is marked as scanned, so the stored-file scan doesn't read it again.
 * - Bigger than the app setting chunked_scan_max_size (256 MiB unless set; 0 switches this off),
 *   or ClamAV not answering: the file is kept and the stored-file scan checks it within about 15
 *   minutes, as before this app. A find there is only logged.
 *
 * The size limit keeps the MOVE well inside the 100 seconds Cloudflare waits for an answer:
 * reading back and scanning takes a few seconds per 100 MiB.
 */
class UploadScanner {
	public const DEFAULT_MAX_SIZE = 268435456;
	private const READ_SIZE = 1048576;

	public function __construct(
		private readonly IAppManager $appManager,
		private readonly IAppConfig $appConfig,
		private readonly IActivityManager $activityManager,
		private readonly IL10NFactory $l10nFactory,
		private readonly InternalFiles $internalFiles,
		private readonly LoggerInterface $logger,
	) {
	}

	/**
	 * Never throws, apart from the 415 for an infected upload.
	 */
	public function afterChunkedUpload(IStorage $storage, string $mountPoint, string $path, int $size): void {
		$where = rtrim($mountPoint, '/') . '/' . $path;
		try {
			if ($size <= 0 || !$this->appManager->isEnabledForAnyone('files_antivirus')
				|| !class_exists(ScannerFactory::class)) {
				return;
			}
			$limit = $this->appConfig->getValueInt(Application::APP_ID, 'chunked_scan_max_size', self::DEFAULT_MAX_SIZE);
			$avLimit = $this->appConfig->getValueInt('files_antivirus', 'av_max_file_size', -1);
			if ($limit <= 0 || $size > $limit || ($avLimit > -1 && $size > $avLimit)) {
				$this->logger->info("Upload in parts of $size bytes left for the stored-file scan: $where", ['app' => Application::APP_ID]);
				return;
			}
			$blockUnscannable = $this->appConfig->getValueBool('files_antivirus', 'av_block_unscannable', false);
			[$status, $read] = $this->scan($storage, $where, $path, $size);
		} catch (\Throwable $e) {
			$this->logger->warning("Could not scan an upload in parts after it arrived, the stored-file scan will check it: $where", ['app' => Application::APP_ID, 'exception' => $e]);
			return;
		}

		$result = $status->getNumericStatus();
		if ($result === Status::SCANRESULT_INFECTED
			|| ($result === Status::SCANRESULT_UNSCANNABLE && $blockUnscannable)) {
			$this->refuse($storage, $path, (string)$status->getDetails());
		}
		if ($read !== $size) {
			$this->logger->warning("Read $read of $size bytes of an upload in parts, the stored-file scan will check it: $where", ['app' => Application::APP_ID]);
			return;
		}
		if ($result === Status::SCANRESULT_CLEAN || $result === Status::SCANRESULT_UNSCANNABLE) {
			try {
				$fileId = $storage->getCache()->getId($path);
				if ($fileId > 0) {
					$this->internalFiles->markScanned($fileId);
				}
			} catch (\Throwable $e) {
				$this->logger->warning("Could not mark a scanned upload in parts as scanned: $where", ['app' => Application::APP_ID, 'exception' => $e]);
			}
			return;
		}
		$this->logger->warning('Upload in parts not checked (' . $status->getDetails() . "), the stored-file scan will check it: $where", ['app' => Application::APP_ID]);
	}

	/**
	 * Streams the stored file to ClamAV in 1 MiB pieces.
	 *
	 * @return array{0: Status, 1: int} the result and the number of bytes read
	 */
	private function scan(IStorage $storage, string $where, string $path, int $size): array {
		$handle = $storage->fopen($path, 'r');
		if (!is_resource($handle)) {
			throw new \RuntimeException("Could not open $where");
		}
		$scanner = Server::get(ScannerFactory::class)->getScanner($where, $size);
		$scanner->initScanner();
		$read = 0;
		$buffer = '';
		try {
			while (!feof($handle)) {
				$data = fread($handle, self::READ_SIZE);
				if ($data === false) {
					throw new \RuntimeException("Could not read $where");
				}
				if ($data === '') {
					break;
				}
				$read += strlen($data);
				$buffer .= $data;
				if (strlen($buffer) >= self::READ_SIZE) {
					$scanner->onAsyncData($buffer);
					$buffer = '';
				}
			}
			if ($buffer !== '') {
				$scanner->onAsyncData($buffer);
			}
		} finally {
			fclose($handle);
		}
		return [$scanner->completeAsyncScan(), $read];
	}

	/**
	 * @throws UnsupportedMediaType always
	 */
	private function refuse(IStorage $storage, string $path, string $details): never {
		$owner = $storage->getOwner($path) ?: '';
		// The trash bin's wrapper sits outside ours, so this never goes to Deleted files.
		$storage->unlink($path);
		$this->logger->warning("Infected file deleted. $details Account: $owner Path: $path (upload in parts)", [
			'app' => Application::APP_ID,
			'userId' => $owner,
			'file' => $path,
		]);
		if ($owner !== '') {
			try {
				$activity = $this->activityManager->generateEvent();
				$activity->setApp('files_antivirus')
					->setSubject(Provider::SUBJECT_VIRUS_DETECTED_UPLOAD, [$details])
					->setMessage(Provider::MESSAGE_FILE_DELETED)
					->setObject('', 0, $path)
					->setAffectedUser($owner)
					->setType(Provider::TYPE_VIRUS_DETECTED);
				$this->activityManager->publish($activity);
			} catch (\Throwable $e) {
				$this->logger->warning('Could not add the Activity entry for an infected upload', ['app' => Application::APP_ID, 'exception' => $e]);
			}
		}
		// files_antivirus's own message, so it reads the same in every language as the one-piece case.
		$message = $this->l10nFactory->get('files_antivirus')
			->t('Virus %s is detected in the file. Upload cannot be completed.', [$details]);
		throw new UnsupportedMediaType($message, 0, new InvalidContentException($message));
	}
}
