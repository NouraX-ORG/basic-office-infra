<?php

declare(strict_types=1);

/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\NouraxBranding\Middleware;

use OCA\NouraxBranding\AppInfo\Application;
use OCP\AppFramework\Controller;
use OCP\AppFramework\Http;
use OCP\AppFramework\Http\RedirectResponse;
use OCP\AppFramework\Http\Response;
use OCP\AppFramework\Http\TemplateResponse;
use OCP\AppFramework\Middleware;
use OCP\IRequest;
use OCP\IURLGenerator;
use OCP\IUserSession;
use OCP\Settings\IManager as ISettingsManager;
use Psr\Log\LoggerInterface;

/**
 * Sends a Personal settings address that would show an empty page to the first Personal settings page.
 *
 * Nextcloud 35 answers every /settings/user/<section> address with a settings page, even when no app
 * has that section. For example /settings/user/privacy, now that scripts/configure.d/20-branding.sh
 * switches the Privacy app off: the page is empty. Such an address now gets a 303 redirect to
 * /settings/user (Profile and contact) instead. Real sections are not touched.
 *
 * It is a global middleware, so that it runs for the settings app's own controller. It looks only at
 * the settings page that controller made for a signed-in person (PersonalSettingsController::index).
 * Anything else, such as the sign-in redirect for people who are not signed in, passes unchanged.
 */
final class EmptySettingsPageMiddleware extends Middleware {
	private const CONTROLLER = 'OCA\Settings\Controller\PersonalSettingsController';
	// The page the settings app shows at /settings/user, and the one people are sent to.
	private const FIRST_SECTION = 'profile-contact';

	public function __construct(
		private IRequest $request,
		private IURLGenerator $urlGenerator,
		private IUserSession $userSession,
		private ISettingsManager $settingsManager,
		private LoggerInterface $logger,
	) {
	}

	#[\Override]
	public function afterController(Controller $controller, string $methodName, Response $response): Response {
		if ($methodName !== 'index' || $controller::class !== self::CONTROLLER
			|| !($response instanceof TemplateResponse) || $response->getStatus() !== Http::STATUS_OK
			|| $response->getApp() !== 'settings' || $response->getTemplateName() !== 'settings/frame'
			|| !$this->userSession->isLoggedIn()) {
			return $response;
		}

		$section = $this->request->getParam('section');
		if (!is_string($section) || $section === '' || $section === self::FIRST_SECTION) {
			return $response;
		}

		try {
			if ($this->hasContent($section)) {
				return $response;
			}
		} catch (\Throwable $e) {
			// The settings page must still work: show it as Nextcloud made it.
			$this->logger->warning('Could not check the Personal settings section, showing the page as it is', [
				'app' => Application::APP_ID,
				'exception' => $e,
			]);
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
