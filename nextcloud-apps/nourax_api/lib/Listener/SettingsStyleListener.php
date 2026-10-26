<?php

declare(strict_types=1);

/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\NouraxApi\Listener;

use OCA\NouraxApi\AppInfo\Application;
use OCP\AppFramework\Http\Events\BeforeTemplateRenderedEvent;
use OCP\EventDispatcher\Event;
use OCP\EventDispatcher\IEventListener;
use OCP\IGroupManager;
use OCP\IRequest;
use OCP\IUserSession;
use OCP\Util;

/**
 * On an admin's settings pages: css/settings-nav.css, so the "Nourax Workspace" entry of the
 * settings menu keeps its white mark on a cobalt tile in the dark theme too. The menu turns every
 * section icon into its negative there (it expects dark icons), which would make the tile amber.
 * Only admins see the section, and the file is one rule, so other pages and people get nothing.
 *
 * @template-implements IEventListener<BeforeTemplateRenderedEvent>
 */
final class SettingsStyleListener implements IEventListener {
	public function __construct(
		private IRequest $request,
		private IUserSession $userSession,
		private IGroupManager $groupManager,
	) {
	}

	public function handle(Event $event): void {
		if (!($event instanceof BeforeTemplateRenderedEvent) || !$event->isLoggedIn()) {
			return;
		}
		try {
			$path = $this->request->getPathInfo();
		} catch (\Throwable) {
			return;
		}
		if (!is_string($path) || !str_starts_with($path, '/settings/')) {
			return;
		}
		$user = $this->userSession->getUser();
		if ($user === null || !$this->groupManager->isAdmin($user->getUID())) {
			return;
		}
		Util::addStyle(Application::APP_ID, 'settings-nav');
	}
}
