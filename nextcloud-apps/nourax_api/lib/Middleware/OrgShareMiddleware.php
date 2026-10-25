<?php

declare(strict_types=1);

/**
 * Privacy between organisations for Deck boards (NoBoard, docs/teams.md).
 *
 * Deck shares a board with whatever account or group id it is sent (BoardService::addAcl), even
 * when sharing is limited to group members. Its share dialog only finds people of one's own
 * organisation, but its APIs take any id. This middleware is registered for every app's
 * controllers and looks only at Deck's three "add a board share" actions (the web app, the REST
 * API and the OCS API). It answers 403 when the new sharee is outside the person's organisation
 * (OrgPrivacy), so nothing is shared.
 *
 * - Only while sharing is limited to group members (the org privacy step is on).
 * - The service account nourax-teams, which shares the team boards (DeckClient), is never limited.
 * - Every other controller call passes straight through: one method-name and class check.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\NouraxApi\Middleware;

use OCA\NouraxApi\Service\OrgPrivacy;
use OCP\AppFramework\Controller;
use OCP\AppFramework\Http;
use OCP\AppFramework\Http\JSONResponse;
use OCP\AppFramework\Http\Response;
use OCP\AppFramework\Middleware;
use OCP\IRequest;
use OCP\IUserSession;

class OrgShareMiddleware extends Middleware {
	/** Deck's controllers with an addAcl action (routes board#addAcl, board_api#addAcl, board_ocs#addAcl). */
	private const DECK_CONTROLLERS = [
		'OCA\\Deck\\Controller\\BoardController',
		'OCA\\Deck\\Controller\\BoardApiController',
		'OCA\\Deck\\Controller\\BoardOcsController',
	];

	public function __construct(
		private IRequest $request,
		private IUserSession $userSession,
		private OrgPrivacy $privacy,
	) {
	}

	#[\Override]
	public function beforeController(Controller $controller, string $methodName): void {
		if ($methodName !== 'addAcl' || !self::isDeckBoardController($controller) || !$this->privacy->isOn()) {
			return;
		}
		$user = $this->userSession->getUser();
		if ($user === null) {
			return;
		}
		$type = $this->request->getParam('type');
		$participant = $this->request->getParam('participant');
		if (!is_numeric($type) || !is_scalar($participant)) {
			// Deck refuses a share without them on its own.
			return;
		}
		$refusal = $this->privacy->checkDeckAcl($user, (int)$type, (string)$participant);
		if ($refusal !== null) {
			throw new OrgShareRefused($refusal);
		}
	}

	#[\Override]
	public function afterException(Controller $controller, string $methodName, \Exception $exception): Response {
		if (!($exception instanceof OrgShareRefused)) {
			throw $exception;
		}
		// For Deck's OCS controller, the server's OCS middleware turns this into an OCS answer with
		// status 403 and this message.
		return new JSONResponse(['status' => Http::STATUS_FORBIDDEN, 'message' => $exception->getMessage()], Http::STATUS_FORBIDDEN);
	}

	private static function isDeckBoardController(Controller $controller): bool {
		foreach (self::DECK_CONTROLLERS as $class) {
			if (is_a($controller, $class)) {
				return true;
			}
		}
		return false;
	}
}
