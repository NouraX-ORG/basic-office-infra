<?php

declare(strict_types=1);

/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\NouraxApi\AppInfo;

use OCA\DAV\Events\SabrePluginAddEvent;
use OCA\NouraxApi\Listener\GroupDriftListener;
use OCA\NouraxApi\Listener\SabrePluginAddListener;
use OCP\AppFramework\App;
use OCP\AppFramework\Bootstrap\IBootContext;
use OCP\AppFramework\Bootstrap\IBootstrap;
use OCP\AppFramework\Bootstrap\IRegistrationContext;
use OCP\Group\Events\GroupDeletedEvent;
use OCP\Group\Events\UserAddedEvent;
use OCP\Group\Events\UserRemovedEvent;

class Application extends App implements IBootstrap {
	public const APP_ID = 'nourax_api';

	public function __construct(array $urlParams = []) {
		parent::__construct(self::APP_ID, $urlParams);
	}

	public function register(IRegistrationContext $context): void {
		// Changes to org:* and team:* groups made outside this API are noted as drift, so the
		// reconcile job can put them back the way NoMail (the source of truth) has them.
		$context->registerEventListener(UserAddedEvent::class, GroupDriftListener::class);
		$context->registerEventListener(UserRemovedEvent::class, GroupDriftListener::class);
		$context->registerEventListener(GroupDeletedEvent::class, GroupDriftListener::class);
		// The directories and team address books are read-only for members: a write gets 403.
		$context->registerEventListener(SabrePluginAddEvent::class, SabrePluginAddListener::class);
	}

	public function boot(IBootContext $context): void {
	}
}
