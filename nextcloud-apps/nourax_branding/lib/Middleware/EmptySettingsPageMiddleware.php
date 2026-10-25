<?php

declare(strict_types=1);

/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\NouraxBranding\Middleware;

use OCP\AppFramework\Controller;
use OCP\AppFramework\Http\RedirectResponse;
use OCP\AppFramework\Http\Response;
use OCP\AppFramework\Middleware;
use OCP\IRequest;
use OCP\IURLGenerator;
use OCP\Settings\IManager as ISettingsManager;

/**
 * Sends a Personal settings address that would show an empty page to the first Personal settings page.
 *
 * Nextcloud 35 answers every /settings/user/<section> address with a settings page, even when no app
 * has that section. For example /settings/user/privacy, now that scripts/configure.d/20-branding.sh
 * switches the Privacy app off: the page is empty. Such an address now gets a 303 redirect to
 * /settings/user (Profile and contact) instead. Real sections are not touched.
 *
 * It is a global middleware, so that it runs for the settings app's own controller, and it looks only
 * at that controller's index page (the settings app's PersonalSettingsController::index).
 */
final class EmptySettingsPageMiddleware extends Middleware {
	private const CONTROLLER = 'OCA\Settings\Controller\PersonalSettingsController';
	// The page the settings app shows at /settings/user, and the one people are sent to.
	private const FIRST_SECTION = 'profile-contact';

	public function __construct(
		private IRequest $request,
		private IURLGenerator $urlGenerator,
		private ISettingsManager $settingsManager,
	) {
	}

	#[\Override]
	public function afterController(Controller $controller, string $methodName, Response $response): Response {
		if ($methodName !== 'index' || $controller::class !== self::CONTROLLER) {
			return $response;
		}

		$section = $this->request->getParam('section');
		if (!is_string($section) || $section === '' || $section === self::FIRST_SECTION
			|| $this->hasContent($section)) {
			return $response;
		}

		return new RedirectResponse($this->urlGenerator->linkToRoute('settings.PersonalSettings.index'));
	}

	/**
	 * True when the section is in the Personal settings menu of this person, or has settings of its own.
	 */
	private function hasContent(string $section): bool {
		foreach ($this->settingsManager->getPersonalSections() as $sections) {
			foreach ($sections as $known) {
				if ($known->getID() === $section) {
					return true;
				}
			}
		}
		return $this->settingsManager->getPersonalSettings($section) !== [];
	}
}
