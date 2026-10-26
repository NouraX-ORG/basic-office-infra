<?php

declare(strict_types=1);

/**
 * The routes behind the admin page's privacy switch (AdminSettings/PrivacySettings):
 *   GET  /apps/nourax_api/admin/org-privacy                  the page's view, as JSON
 *   POST /apps/nourax_api/admin/org-privacy {"state":"on"}   switch on (or "off")
 *
 * Both are for admins only: no NoAdminRequired, so the server answers 403 to anyone else before
 * this code runs; no NoCSRFRequired, so a request without the page's CSRF token gets 412. The
 * POST also needs a password confirmation from the last 30 minutes (PasswordConfirmationRequired:
 * signing in counts, and the page asks for the password when it is older), so neither an app
 * password nor a session left open for long can switch. Each switch writes an audit row with the
 * admin's account id (OrgPrivacySwitch).
 *
 * Answers: 200 with {result, changed, status, effects, on_note, off_warning, history};
 * 400 invalid_state; 409 app_needs_upgrade; 423 busy; 500 failed (with the view, since a switch
 * that stopped half-way may have changed some settings). Errors are {error, message}.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\NouraxApi\Controller;

use OCA\NouraxApi\AdminSettings\PrivacySettings;
use OCA\NouraxApi\AppInfo\Application;
use OCA\NouraxApi\Service\ApiException;
use OCA\NouraxApi\Service\OrgPrivacySwitch;
use OCP\AppFramework\Controller;
use OCP\AppFramework\Http\Attribute\PasswordConfirmationRequired;
use OCP\AppFramework\Http\JSONResponse;
use OCP\IRequest;
use OCP\IUserSession;
use Psr\Log\LoggerInterface;

class PrivacySettingsController extends Controller {
	public function __construct(
		IRequest $request,
		private OrgPrivacySwitch $switch,
		private IUserSession $userSession,
		private LoggerInterface $logger,
	) {
		parent::__construct(Application::APP_ID, $request);
	}

	public function status(): JSONResponse {
		return $this->json(PrivacySettings::view($this->switch));
	}

	#[PasswordConfirmationRequired]
	public function setState(string $state = ''): JSONResponse {
		if ($state !== 'on' && $state !== 'off') {
			return $this->json(['error' => 'invalid_state', 'message' => 'The state must be on or off.'], 400);
		}
		$uid = $this->userSession->getUser()?->getUID() ?? '';
		try {
			$done = $this->switch->apply($state, false, [
				'key_id' => 'admin-page',
				'method' => 'POST',
				'who' => $uid,
				'ip' => $this->request->getRemoteAddress(),
				'http_status' => 200,
			]);
		} catch (ApiException $e) {
			return $this->json(['error' => $e->errorCode, 'message' => match ($e->errorCode) {
				'busy' => 'Another switch is running. Try again in a minute.',
				'app_needs_upgrade' => 'Nothing was changed: the Federation or Teams app is installed at another version than its code. Run occ app:enable for it on the server first.',
				default => 'Nothing was changed.',
			}], $e->httpStatus);
		} catch (\Throwable $e) {
			$this->logger->error('nourax_api org privacy switch ' . $state . ' failed: ' . get_class($e) . ': ' . $e->getMessage(), ['app' => Application::APP_ID]);
			return $this->json(['error' => 'failed', 'message' => 'The switch stopped with an error, so some settings may have changed. Check the list of settings and switch again.']
				+ PrivacySettings::view($this->switch), 500);
		}
		return $this->json(['result' => $done['result'], 'changed' => $done['changed']] + PrivacySettings::view($this->switch));
	}

	private function json(array $data, int $status = 200): JSONResponse {
		$response = new JSONResponse($data, $status);
		$response->addHeader('Cache-Control', 'no-store');
		return $response;
	}
}
