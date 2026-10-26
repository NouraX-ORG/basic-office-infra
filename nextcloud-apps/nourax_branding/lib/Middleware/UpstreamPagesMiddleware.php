<?php

declare(strict_types=1);

/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\NouraxBranding\Middleware;

use OCA\NouraxBranding\AppInfo\Application;
use OCA\NouraxBranding\Service\SweepRunner;
use OCA\NouraxBranding\Service\UpstreamAssets;
use OCP\AppFramework\Controller;
use OCP\AppFramework\Http;
use OCP\AppFramework\Http\DataDisplayResponse;
use OCP\AppFramework\Http\JSONResponse;
use OCP\AppFramework\Http\NotFoundResponse;
use OCP\AppFramework\Http\RedirectResponse;
use OCP\AppFramework\Http\Response;
use OCP\AppFramework\Http\TemplateResponse;
use OCP\AppFramework\Middleware;
use OCP\IInitialStateService;
use OCP\IRequest;
use OCP\IURLGenerator;
use OCP\L10N\IFactory;
use OCP\Util;
use Psr\Log\LoggerInterface;

/**
 * Upstream links, pictures and colours in answers of other apps' controllers (Nextcloud 35.0.2),
 * each fixed where the answer is made, so no page or file people get carries them:
 *
 * - theming manifests (/apps/theming/manifest/<app>): the app's summary from its info.xml, for
 *   example "A Calendar app for Nextcloud", which no translation file holds, gets the text sweep;
 * - theming stylesheets (/apps/theming/theme/<theme>.css): the upstream blue of the Assistant
 *   gradient becomes the Nourax cobalt (Service\UpstreamAssets::recolourCss);
 * - /settings/help, which upstream fills with links to its documentation and forum, sends people to
 *   this app's help page (Controller\HelpController);
 * - /settings/download/reasons, the upstream's "Reasons to use Nextcloud" PDF, answers 404;
 * - Personal settings > Appearance and accessibility: the two backgrounds that credit the upstream
 *   company are left out of the picker (Service\UpstreamAssets::filterBackgrounds), and the theme
 *   previews are our own pictures (js/theme-previews.js, img/theme-previews);
 * - Personal settings > Sharing: when sharing with other servers is on (privacy between
 *   organisations off, scripts/configure.d/60-org-privacy.sh), the Federated Cloud section's
 *   "share it" buttons point at this app's help page instead of nextcloud.com/sharing.
 *
 * It is a global middleware, so that it runs for the theming and settings apps' controllers. When
 * something goes wrong, the answer goes out as the other app made it.
 */
final class UpstreamPagesMiddleware extends Middleware {
	private const THEMING = 'OCA\Theming\Controller\ThemingController';
	private const HELP = 'OCA\Settings\Controller\HelpController';
	private const REASONS = 'OCA\Settings\Controller\ReasonsController';
	private const PERSONAL = 'OCA\Settings\Controller\PersonalSettingsController';
	private const BACKGROUNDS = 'OCA\Theming\Service\BackgroundService';

	public function __construct(
		private IRequest $request,
		private IURLGenerator $urlGenerator,
		private IInitialStateService $initialState,
		private IFactory $l10nFactory,
		private SweepRunner $sweepRunner,
		private LoggerInterface $logger,
	) {
	}

	#[\Override]
	public function afterController(Controller $controller, string $methodName, Response $response): Response {
		$class = $controller::class;
		if ($class !== self::THEMING && $class !== self::HELP && $class !== self::REASONS && $class !== self::PERSONAL) {
			return $response;
		}
		try {
			return match (true) {
				$class === self::THEMING && $methodName === 'getManifest' => $this->manifest($response),
				$class === self::THEMING && $methodName === 'getThemeStylesheet' => $this->stylesheet($response),
				$class === self::HELP => new RedirectResponse($this->urlGenerator->linkToRoute(Application::APP_ID . '.help.index')),
				$class === self::REASONS => new NotFoundResponse(),
				$class === self::PERSONAL && $methodName === 'index' => $this->personalSettings($response),
				default => $response,
			};
		} catch (\Throwable $e) {
			$this->logger->warning('Could not take the upstream branding out of {controller}::{method}, sending it as it is', [
				'app' => Application::APP_ID,
				'controller' => $class,
				'method' => $methodName,
				'exception' => $e,
			]);
			return $response;
		}
	}

	private function manifest(Response $response): Response {
		if (!($response instanceof JSONResponse) || $response->getStatus() !== Http::STATUS_OK) {
			return $response;
		}
		$data = $response->getData();
		if (!is_array($data)) {
			return $response;
		}
		$sweeper = $this->sweepRunner->sweeper();
		$lang = $this->l10nFactory->findLanguage();
		foreach (['name', 'short_name', 'description'] as $key) {
			if (isset($data[$key]) && is_string($data[$key]) && $sweeper->hasName($data[$key])) {
				$data[$key] = $sweeper->transform($data[$key], $lang);
			}
		}
		$response->setData($data);
		return $response;
	}

	private function stylesheet(Response $response): Response {
		if (!($response instanceof DataDisplayResponse) || $response->getStatus() !== Http::STATUS_OK) {
			return $response;
		}
		$css = $response->getData();
		if (is_string($css)) {
			$response->setData(UpstreamAssets::recolourCss($css));
		}
		return $response;
	}

	private function personalSettings(Response $response): Response {
		if (!($response instanceof TemplateResponse) || $response->getStatus() !== Http::STATUS_OK) {
			return $response;
		}
		$section = $this->request->getParam('section');
		if ($section === 'theming') {
			$this->themePreviews();
			if (class_exists(self::BACKGROUNDS) && defined(self::BACKGROUNDS . '::SHIPPED_BACKGROUNDS')) {
				$shipped = constant(self::BACKGROUNDS . '::SHIPPED_BACKGROUNDS');
				if (is_array($shipped)) {
					// Replaces what the theming app gave its page; the page is rendered after this.
					$this->initialState->provideInitialState('theming', 'shippedBackgrounds', UpstreamAssets::filterBackgrounds($shipped));
				}
			}
		} elseif ($section === 'sharing') {
			$this->initialState->provideInitialState('federatedfilesharing', 'reference',
				$this->urlGenerator->linkToRouteAbsolute(Application::APP_ID . '.help.topic', ['path' => 'sharing']));
		}
		return $response;
	}

	/**
	 * Appearance and accessibility: the theme previews. The theming app's page builds each picture's
	 * address in the browser from the theme's id (/apps/theming/img/<id>.jpg, upstream pictures with
	 * the upstream logo and blue header), so js/theme-previews.js puts our own picture of the same
	 * theme in its place there; this gives it their addresses.
	 */
	private function themePreviews(): void {
		$previews = UpstreamAssets::themePreviews(dirname(__DIR__, 2) . '/img/theme-previews',
			fn (string $file): string => $this->urlGenerator->imagePath(Application::APP_ID, $file));
		$this->initialState->provideInitialState(Application::APP_ID, 'theme_previews', $previews);
		Util::addScript(Application::APP_ID, 'theme-previews');
	}
}
