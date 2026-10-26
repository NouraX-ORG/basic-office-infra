<?php

declare(strict_types=1);

/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\NouraxApi\AppInfo;

use OCA\DAV\Events\SabrePluginAddEvent;
use OCA\NouraxApi\Listener\GroupDriftListener;
use OCA\NouraxApi\Listener\SabrePluginAddListener;
use OCA\NouraxApi\Listener\SettingsStyleListener;
use OCA\NouraxApi\Middleware\OrgShareMiddleware;
use OCP\AppFramework\App;
use OCP\AppFramework\Http\Events\BeforeTemplateRenderedEvent;
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
		// The same listener adds the org privacy check of calendar and address book shares.
		$context->registerEventListener(SabrePluginAddEvent::class, SabrePluginAddListener::class);
		// Privacy between organisations for the apps' own shares and hand-overs (NoBoard, NoForms,
		// NoGantt, file ownership transfers) and the ONLYOFFICE editor's names: registered for
		// every app's controllers, it looks only at those actions (docs/teams.md).
		$context->registerMiddleware(OrgShareMiddleware::class, true);
		// The admin settings section "Nourax Workspace" keeps its icon's colours in the dark theme.
		$context->registerEventListener(BeforeTemplateRenderedEvent::class, SettingsStyleListener::class);
	}

	public function boot(IBootContext $context): void {
	}
}
