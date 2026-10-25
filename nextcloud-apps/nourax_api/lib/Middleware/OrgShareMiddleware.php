<?php

declare(strict_types=1);

/**
 * Privacy between organisations for the apps' own shares and hand-overs (docs/teams.md).
 *
 * These apps share with, or hand something to, whatever account or group id they are sent, even
 * when sharing is limited to group members: their dialogs only find people of one's own
 * organisation, but their APIs take any id. This middleware is registered for every app's
 * controllers and looks only at the actions below. It answers 403 when the person or group named
 * is outside the person's organisation (OrgPrivacy), so nothing is shared or handed over:
 *
 * | App | Action (controller::method) | What is checked |
 * |---|---|---|
 * | NoBoard (deck) | Board, BoardApi, BoardOcs ::addAcl | the new board share (type, participant) |
 * | NoBoard | Board::transferOwner | the new owner (newOwner) |
 * | NoBoard | Board::import (upload), BoardImportApi::import | every account and group the import names |
 * | NoForms (forms) | ShareApi::newShare | the new share (shareType 0 person, 1 group, 7 team) |
 * | NoForms | Api::updateForm | a new owner (keyValuePairs.ownerId) |
 * | NoGantt (nc_gantt) | Share::create | the new project share (principal_type, principal_id) |
 * | NoGantt | Resource::create, Resource::update | the account a planning resource stands for (uid) |
 * | NoDrive (files) | TransferOwnership::transfer | the person asked to take the files (recipient) |
 *
 * It also takes out, after the call, the names the ONLYOFFICE editor asks for
 * (Editor::userInfo, any account id) of people outside the person's organisation.
 *
 * - Only while sharing is limited to group members (the org privacy step is on).
 * - The service account nourax-teams, which shares the team boards (DeckClient), is never limited.
 * - Every other controller call passes straight through: one class and method lookup.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\NouraxApi\Middleware;

use OCA\NouraxApi\Service\OrgPrivacy;
use OCP\AppFramework\Controller;
use OCP\AppFramework\Http;
use OCP\AppFramework\Http\DataResponse;
use OCP\AppFramework\Http\JSONResponse;
use OCP\AppFramework\Http\Response;
use OCP\AppFramework\Middleware;
use OCP\IConfig;
use OCP\IRequest;
use OCP\IUser;
use OCP\IUserSession;

class OrgShareMiddleware extends Middleware {
	/** controller class => [method => the check]. Exact classes, as the apps' routes name them. */
	private const ACTIONS = [
		'OCA\\Deck\\Controller\\BoardController' => ['addAcl' => 'deckAcl', 'transferOwner' => 'deckOwner', 'import' => 'deckUpload'],
		'OCA\\Deck\\Controller\\BoardApiController' => ['addAcl' => 'deckAcl'],
		'OCA\\Deck\\Controller\\BoardOcsController' => ['addAcl' => 'deckAcl'],
		'OCA\\Deck\\Controller\\BoardImportApiController' => ['import' => 'deckImport'],
		'OCA\\Forms\\Controller\\ShareApiController' => ['newShare' => 'formsShare'],
		'OCA\\Forms\\Controller\\ApiController' => ['updateForm' => 'formsOwner'],
		'OCA\\NcGantt\\Controller\\ShareController' => ['create' => 'ganttShare'],
		'OCA\\NcGantt\\Controller\\ResourceController' => ['create' => 'ganttResource', 'update' => 'ganttResource'],
		'OCA\\Files\\Controller\\TransferOwnershipController' => ['transfer' => 'filesTransfer'],
	];
	private const ONLYOFFICE_EDITOR = 'OCA\\Onlyoffice\\Controller\\EditorController';
	/** Forms' share types (OCP\Share\IShare::TYPE_USER, TYPE_GROUP, TYPE_CIRCLE). */
	private const SHARE_USER = 0;
	private const SHARE_GROUP = 1;
	private const SHARE_CIRCLE = 7;
	/** The largest board export read here (Deck reads the whole upload too). */
	private const MAX_IMPORT_BYTES = 33554432;

	public function __construct(
		private IRequest $request,
		private IUserSession $userSession,
		private OrgPrivacy $privacy,
		private IConfig $config,
	) {
	}

	#[\Override]
	public function beforeController(Controller $controller, string $methodName): void {
		$check = self::ACTIONS[$controller::class][$methodName] ?? null;
		if ($check === null || !$this->privacy->isOn()) {
			return;
		}
		$user = $this->userSession->getUser();
		if ($user === null) {
			return;
		}
		$refusal = match ($check) {
			'deckAcl' => $this->deckAcl($user),
			'deckOwner' => $this->person($user, 'newOwner'),
			'deckUpload' => $this->deckUpload($user),
			'deckImport' => $this->deckImport($user),
			'formsShare' => $this->formsShare($user),
			'formsOwner' => $this->formsOwner($user),
			'ganttShare' => $this->ganttShare($user),
			'ganttResource' => $this->ganttResource($user),
			'filesTransfer' => $this->person($user, 'recipient'),
		};
		if ($refusal !== null) {
			throw new OrgShareRefused($refusal);
		}
	}

	#[\Override]
	public function afterController(Controller $controller, string $methodName, Response $response): Response {
		if ($methodName !== 'userInfo' || $controller::class !== self::ONLYOFFICE_EDITOR
			|| !($response instanceof DataResponse) || !$this->privacy->isOn()) {
			return $response;
		}
		$user = $this->userSession->getUser();
		$data = $response->getData();
		if ($user === null || !is_array($data)) {
			return $response;
		}
		// The editor names people "<instance id>_<uid>" (EditorController::buildUserId).
		$prefix = $this->config->getSystemValueString('instanceid') . '_';
		$kept = [];
		foreach ($data as $entry) {
			$id = is_array($entry) ? (string)($entry['id'] ?? '') : '';
			$uid = str_starts_with($id, $prefix) ? substr($id, strlen($prefix)) : $id;
			if ($uid !== '' && $this->privacy->canSeeUser($user, $uid)) {
				$kept[] = $entry;
			}
		}
		$response->setData($kept);
		return $response;
	}

	#[\Override]
	public function afterException(Controller $controller, string $methodName, \Exception $exception): Response {
		if (!($exception instanceof OrgShareRefused)) {
			throw $exception;
		}
		// For the OCS controllers (Deck's OCS API, NoForms, NoGantt, files), the server's OCS
		// middleware turns this into an OCS answer with status 403 and this message.
		return new JSONResponse(['status' => Http::STATUS_FORBIDDEN, 'message' => $exception->getMessage()], Http::STATUS_FORBIDDEN);
	}

	/** One named account; a missing or empty parameter is left to the app. */
	private function person(IUser $user, string $param): ?string {
		$uid = $this->request->getParam($param);
		return is_string($uid) && $uid !== '' ? $this->privacy->checkReach($user, $uid) : null;
	}

	private function deckAcl(IUser $user): ?string {
		$type = $this->request->getParam('type');
		$participant = $this->request->getParam('participant');
		if (!is_numeric($type) || !is_scalar($participant)) {
			// Deck refuses a share without them on its own.
			return null;
		}
		return $this->privacy->checkDeckAcl($user, (int)$type, (string)$participant);
	}

	/** The web import: one uploaded Deck JSON file (BoardController::import). */
	private function deckUpload(IUser $user): ?string {
		$file = $this->request->getUploadedFile('file');
		$path = is_array($file) ? ($file['tmp_name'] ?? null) : null;
		if (!is_string($path) || !is_uploaded_file($path) || filesize($path) > self::MAX_IMPORT_BYTES) {
			return null;
		}
		$json = file_get_contents($path);
		return $json === false ? null : $this->privacy->checkDeckImport($user, null, json_decode($json));
	}

	/** The import API: a system, its config (uidRelation) and the export (BoardImportApiController::import). */
	private function deckImport(IUser $user): ?string {
		$config = self::objects($this->request->getParam('config'));
		$data = $this->request->getParam('system') === 'DeckJson' ? self::objects($this->request->getParam('data')) : null;
		return $this->privacy->checkDeckImport($user, $config, $data);
	}

	private function formsShare(IUser $user): ?string {
		$type = $this->request->getParam('shareType');
		$with = $this->request->getParam('shareWith');
		if (!is_numeric($type) || !is_string($with)) {
			return null;
		}
		return match ((int)$type) {
			self::SHARE_USER => $this->privacy->checkReach($user, $with),
			self::SHARE_GROUP => $this->privacy->checkGroup($user, $with),
			self::SHARE_CIRCLE => $this->privacy->checkOther($user),
			default => null,
		};
	}

	private function formsOwner(IUser $user): ?string {
		$pairs = $this->request->getParam('keyValuePairs');
		if (!is_array($pairs) || !array_key_exists('ownerId', $pairs)) {
			return null;
		}
		return is_string($pairs['ownerId']) ? $this->privacy->checkReach($user, $pairs['ownerId']) : OrgPrivacy::REFUSED_PERSON;
	}

	private function ganttShare(IUser $user): ?string {
		$type = $this->request->getParam('principal_type') ?? 'user';
		$id = $this->request->getParam('principal_id');
		if (!is_string($id) || $id === '') {
			return null;
		}
		return match ($type) {
			'user' => $this->privacy->checkReach($user, $id),
			'group' => $this->privacy->checkGroup($user, $id),
			default => $this->privacy->checkOther($user),
		};
	}

	/** A NoGantt person resource names an account (uid); a role resource names none. */
	private function ganttResource(IUser $user): ?string {
		return $this->request->getParam('type') === 'role' ? null : $this->person($user, 'uid');
	}

	/** Request parameters as Deck reads them: JSON objects, not arrays. */
	private static function objects(mixed $value): mixed {
		return is_array($value) ? json_decode((string)json_encode($value)) : null;
	}
}
