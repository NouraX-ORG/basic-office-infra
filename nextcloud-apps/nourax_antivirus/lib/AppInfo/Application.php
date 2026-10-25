<?php

declare(strict_types=1);

/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\NouraxAntivirus\AppInfo;

use OCA\NouraxAntivirus\Listener\FilesystemSetupListener;
use OCP\AppFramework\App;
use OCP\AppFramework\Bootstrap\IBootContext;
use OCP\AppFramework\Bootstrap\IBootstrap;
use OCP\AppFramework\Bootstrap\IRegistrationContext;
use OCP\Files\Events\BeforeFileSystemSetupEvent;

class Application extends App implements IBootstrap {
	public const APP_ID = 'nourax_antivirus';

	public function __construct(array $urlParams = []) {
		parent::__construct(self::APP_ID, $urlParams);
	}

	public function register(IRegistrationContext $context): void {
		// Our storage wrapper goes on every storage kept in the object store (see UploadScanWrapper).
		$context->registerEventListener(BeforeFileSystemSetupEvent::class, FilesystemSetupListener::class);
	}

	public function boot(IBootContext $context): void {
	}
}
