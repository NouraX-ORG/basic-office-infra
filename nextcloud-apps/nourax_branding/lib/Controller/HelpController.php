<?php

declare(strict_types=1);

/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\NouraxBranding\Controller;

use OCA\NouraxBranding\AppInfo\Application;
use OCP\AppFramework\Controller;
use OCP\AppFramework\Http\Attribute\FrontpageRoute;
use OCP\AppFramework\Http\Attribute\NoCSRFRequired;
use OCP\AppFramework\Http\Attribute\NoSameSiteCookieRequired;
use OCP\AppFramework\Http\Attribute\NoTwoFactorRequired;
use OCP\AppFramework\Http\Attribute\OpenAPI;
use OCP\AppFramework\Http\Attribute\PublicPage;
use OCP\AppFramework\Http\TemplateResponse;
use OCP\IRequest;
use OCP\IURLGenerator;

/**
 * The help page of Nourax Workspace: /apps/nourax_branding/help, and every address below it.
 *
 * scripts/configure.d/20-branding.sh sets the theming documentation address (docBaseUrl) to
 * https://<drive host>/apps/nourax_branding/help, so every help link Nextcloud builds
 * (<docBaseUrl>/server/35/go.php?to=<topic>: the help in Security, Sharing and the other settings
 * pages) opens this page instead of the upstream manual. Middleware\UpstreamPagesMiddleware sends
 * /settings/help here too. Until our own help pages exist, it says so in plain words.
 *
 * Public, so that it also works from the login page and from e-mails.
 */
#[OpenAPI(scope: OpenAPI::SCOPE_IGNORE)]
final class HelpController extends Controller {
	public function __construct(
		IRequest $request,
		private IURLGenerator $urlGenerator,
	) {
		parent::__construct(Application::APP_ID, $request);
	}

	#[PublicPage]
	#[NoCSRFRequired]
	#[NoTwoFactorRequired]
	#[NoSameSiteCookieRequired]
	#[FrontpageRoute(verb: 'GET', url: '/help')]
	public function index(): TemplateResponse {
		return $this->page();
	}

	/** Any topic, for example /help/server/35/go.php?to=user-2fa: the same page for now. */
	#[PublicPage]
	#[NoCSRFRequired]
	#[NoTwoFactorRequired]
	#[NoSameSiteCookieRequired]
	#[FrontpageRoute(verb: 'GET', url: '/help/{path}', requirements: ['path' => '.+'])]
	public function topic(string $path = ''): TemplateResponse {
		return $this->page();
	}

	private function page(): TemplateResponse {
		return new TemplateResponse(Application::APP_ID, 'help', [
			// The start page: NoDrive when signed in, the login page otherwise.
			'backUrl' => $this->urlGenerator->getAbsoluteURL('/'),
		], TemplateResponse::RENDER_AS_GUEST);
	}
}
