<?php

declare(strict_types=1);

/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\NouraxAntivirus\Listener;

use OC\Files\ObjectStore\ObjectStoreStorage;
use OCA\NouraxAntivirus\Service\UploadScanner;
use OCA\NouraxAntivirus\Storage\UploadScanWrapper;
use OCP\EventDispatcher\Event;
use OCP\EventDispatcher\IEventListener;
use OCP\Files\Events\BeforeFileSystemSetupEvent;
use OCP\Files\Storage\ISharedStorage;
use OCP\Files\Storage\IStorage;

/** @template-implements IEventListener<BeforeFileSystemSetupEvent> */
class FilesystemSetupListener implements IEventListener {
	/**
	 * Higher numbers are applied first, so they sit closer to the real storage. The core wrappers
	 * use 50; files_antivirus and the trash bin use 1. At 40 ours sits between them: inside the
	 * virus scanner's wrapper, right on top of the object store whose error it fixes, and inside
	 * the trash bin's wrapper, so removing an infected upload never puts it in Deleted files.
	 */
	private const PRIORITY = 40;

	public function __construct(
		private readonly UploadScanner $uploadScanner,
	) {
	}

	public function handle(Event $event): void {
		if (!$event instanceof BeforeFileSystemSetupEvent) {
			return;
		}

		$event->addStorageWrapper(
			UploadScanWrapper::class,
			function (string $mountPoint, IStorage $storage): IStorage {
				// Shares point into their owner's storage, which has the wrapper already. The share
				// check comes first because it doesn't make the share load its source.
				if ($storage->instanceOfStorage(ISharedStorage::class)
					|| !$storage->instanceOfStorage(ObjectStoreStorage::class)
					|| $storage->instanceOfStorage(UploadScanWrapper::class)) {
					return $storage;
				}
				return new UploadScanWrapper([
					'storage' => $storage,
					'mountPoint' => $mountPoint,
					'uploadScanner' => $this->uploadScanner,
				]);
			},
			self::PRIORITY,
		);
	}
}
