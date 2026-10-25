<?php

declare(strict_types=1);

/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\NouraxAntivirus\Storage;

use OC\Files\Storage\Wrapper\Wrapper;
use OCA\NouraxAntivirus\Service\UploadScanner;
use OCP\Files\GenericFileException;
use OCP\Files\InvalidContentException;

/**
 * Sits on every storage that keeps its files in the object store (R2), right on top of it.
 *
 * Uploads in one piece: files_antivirus refuses an infected file by throwing an
 * InvalidContentException while the data streams into the object store. The object store wraps
 * every error there in a GenericFileException ("Error while writing stream to object store"), which
 * the file server's WebDAV code catches and turns into a generic 400 size-mismatch answer. Here the
 * virus message is taken back out, so WebDAV answers 415 with "... Upload cannot be completed."
 * Nothing else about the upload changes: it is still refused and nothing is stored.
 *
 * Uploads in parts: R2 joins the parts itself, so files_antivirus never sees the data. Right after
 * the parts are joined, UploadScanner reads the file back and scans it.
 */
class UploadScanWrapper extends Wrapper {
	private UploadScanner $uploadScanner;
	private string $mountPoint;

	/**
	 * @param array{storage: \OCP\Files\Storage\IStorage, mountPoint: string, uploadScanner: UploadScanner} $parameters
	 */
	public function __construct(array $parameters) {
		parent::__construct($parameters);
		$this->uploadScanner = $parameters['uploadScanner'];
		$this->mountPoint = $parameters['mountPoint'];
	}

	public function writeStream(string $path, $stream, ?int $size = null): int {
		try {
			return parent::writeStream($path, $stream, $size);
		} catch (GenericFileException $e) {
			for ($cause = $e->getPrevious(); $cause !== null; $cause = $cause->getPrevious()) {
				if ($cause instanceof InvalidContentException) {
					throw new InvalidContentException($cause->getMessage(), $cause->getCode(), $e);
				}
			}
			throw $e;
		}
	}

	/**
	 * Called by the WebDAV chunked upload (the MOVE at the end) when the object store supports
	 * multipart uploads. The base Wrapper passes it on through __call; this one scans afterwards.
	 */
	public function completeChunkedWrite(string $targetPath, string $writeToken): int {
		$storage = $this->getWrapperStorage();
		$size = $storage->completeChunkedWrite($targetPath, $writeToken);
		$this->uploadScanner->afterChunkedUpload($storage, $this->mountPoint, $targetPath, (int)$size);
		return $size;
	}
}
