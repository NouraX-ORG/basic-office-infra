<?php

declare(strict_types=1);

/**
 * Privacy between organisations for the apps' own shares, hand-overs and answers about one named
 * person (docs/teams.md).
 *
 * These apps share with, or hand something to, whatever account or group id they are sent, even
 * when sharing is limited to group members: their dialogs only find people of one's own
 * organisation, but their APIs take any id. This middleware is registered for every app's
 * controllers (and the server's own) and looks only at the actions below. It answers 403 when the
 * person or group named is outside the person's organisation (OrgPrivacy), so nothing is shared
 * or handed over:
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
 * | Out of office (dav) | OutOfOffice::setOutOfOffice | the replacement (replacementUserId), whose name it answers |
 *
 * Answers about one person, asked by account id, are given as for an account that does not exist
 * when the person asking may not see that account (no group in common):
 *
 * | Where | Action | The answer then |
 * |---|---|---|
 * | Avatars (server) | Avatar::getAvatar, getAvatarDark (/avatar/<id>/<size>) | 404 `[]`, or the guest picture of the id typed (guestFallback) |
 * | Online status | Statuses::find (/statuses/<id>) | 404 "No status for the requested userId" |
 * | Out of office | OutOfOffice::getOutOfOffice, getCurrentOutOfOfficeData | 404, no data |
 * | NoCalendar | Appointment::index (/apps/calendar/appointments/<id>, a public page) | the "not found" page, unless the person has a public booking page |
 *
 * After the call it also takes out the names the ONLYOFFICE editor asks for (Editor::userInfo,
 * any account id) and, in NoBoard card comments (CommentsApi::list, create, update), shows the id
 * instead of the name of a mentioned person outside the organisation (MentionNames).
 *
 * - Only while sharing is limited to group members (the org privacy step is on).
 * - Only for a signed-in person, except the public appointments page.
 * - The service account nourax-teams, which shares the team boards (DeckClient), is never limited.
 * - Every other controller call passes straight through: one class and method lookup.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\NouraxApi\Middleware;

use OCA\NouraxApi\Service\MentionNames;
use OCA\NouraxApi\Service\OrgPrivacy;
use OCP\AppFramework\Controller;
use OCP\AppFramework\Http;
use OCP\AppFramework\Http\DataResponse;
use OCP\AppFramework\Http\FileDisplayResponse;
use OCP\AppFramework\Http\JSONResponse;
use OCP\AppFramework\Http\Response;
use OCP\AppFramework\Http\TemplateResponse;
use OCP\AppFramework\Middleware;
use OCP\AppFramework\OCS\OCSNotFoundException;
use OCP\IAvatarManager;
use OCP\IConfig;
use OCP\IRequest;
use OCP\IUser;
use OCP\IUserManager;
use OCP\IUserSession;
use OCP\Server;

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
		'OCA\\DAV\\Controller\\OutOfOfficeController' => ['setOutOfOffice' => 'absenceReplacement',
			'getOutOfOffice' => 'absence', 'getCurrentOutOfOfficeData' => 'absence'],
		'OC\\Core\\Controller\\AvatarController' => ['getAvatar' => 'avatar', 'getAvatarDark' => 'avatarDark'],
		'OCA\\UserStatus\\Controller\\StatusesController' => ['find' => 'status'],
		'OCA\\Calendar\\Controller\\AppointmentController' => ['index' => 'appointments'],
	];
	private const ONLYOFFICE_EDITOR = 'OCA\\Onlyoffice\\Controller\\EditorController';
	private const DECK_COMMENTS = 'OCA\\Deck\\Controller\\CommentsApiController';
	private const DECK_COMMENT_ANSWERS = ['list', 'create', 'update'];
	/** Calendar's public booking pages (OCA\Calendar\Db\AppointmentConfig::VISIBILITY_PUBLIC). */
	private const CALENDAR_CONFIGS = 'OCA\\Calendar\\Service\\Appointments\\AppointmentConfigService';
	private const CALENDAR_PUBLIC = 'PUBLIC';
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
		private IUserManager $userManager,
	) {
	}

	#[\Override]
	public function beforeController(Controller $controller, string $methodName): void {
		$check = self::ACTIONS[$controller::class][$methodName] ?? null;
		if ($check === null || !$this->privacy->isOn()) {
			return;
		}
		$user = $this->userSession->getUser();
		if ($check === 'appointments') {
			// A public page: also for people who are not signed in.
			$this->appointments($user);
			return;
		}
		if ($user === null) {
			return;
		}
		if (in_array($check, ['avatar', 'avatarDark', 'status', 'absence'], true)) {
			$this->aboutOnePerson($controller, $user, $check);
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
			'absenceReplacement' => $this->person($user, 'replacementUserId'),
		};
		if ($refusal !== null) {
			throw new OrgShareRefused($refusal);
		}
	}

	#[\Override]
	public function afterController(Controller $controller, string $methodName, Response $response): Response {
		// The server turns a plain controller's DataResponse into a JSONResponse before any
		// middleware sees it (Dispatcher::executeController); both carry the data.
		if ($methodName !== 'userInfo' || $controller::class !== self::ONLYOFFICE_EDITOR
			|| !($response instanceof JSONResponse || $response instanceof DataResponse) || !$this->privacy->isOn()) {
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

	/** NoBoard card comments: the rendered answer (JSON or XML), with hidden mention names. */
	#[\Override]
	public function beforeOutput(Controller $controller, string $methodName, string $output): string {
		if ($controller::class !== self::DECK_COMMENTS || !in_array($methodName, self::DECK_COMMENT_ANSWERS, true)
			|| $output === '' || !$this->privacy->isOn()) {
			return $output;
		}
		$user = $this->userSession->getUser();
		if ($user === null) {
			return $output;
		}
		return MentionNames::hide($output, fn (string $uid): bool => $this->privacy->canSeeUser($user, $uid)) ?? $output;
	}

	#[\Override]
	public function afterException(Controller $controller, string $methodName, \Exception $exception): Response {
		if ($exception instanceof OrgAnswer) {
			return $exception->response;
		}
		if (!($exception instanceof OrgShareRefused)) {
			throw $exception;
		}
		// For the OCS controllers (Deck's OCS API, NoForms, NoGantt, files, out of office), the
		// server's OCS middleware turns this into an OCS answer with status 403 and this message.
		// Through /index.php (Deck's import API) that is OCS version 1: HTTP 200 with status 403
		// in the answer.
		return new JSONResponse(['status' => Http::STATUS_FORBIDDEN, 'message' => $exception->getMessage()], Http::STATUS_FORBIDDEN);
	}

	/**
	 * An answer about the account named by the route's userId, for someone who may not see it: the
	 * app's own answer for an account that does not exist (or has nothing to show).
	 *
	 * @throws OrgAnswer|OCSNotFoundException
	 */
	private function aboutOnePerson(Controller $controller, IUser $user, string $check): void {
		$uid = $this->request->getParam('userId');
		if (!is_string($uid) || $uid === '' || $this->privacy->canSeeUser($user, $uid)
			|| $this->userManager->get($uid) === null) {
			// Visible, or truly missing: the app answers itself.
			return;
		}
		match ($check) {
			'avatar', 'avatarDark' => throw new OrgAnswer($this->noAvatar($uid, $check === 'avatarDark')),
			// The server's OCS middleware answers it, exactly as StatusesController::find does.
			'status' => throw new OCSNotFoundException('No status for the requested userId'),
			// OutOfOfficeController's own answer: DataResponse(null, 404), in the asked format.
			'absence' => throw new OrgAnswer($controller->buildResponse(new DataResponse(null, Http::STATUS_NOT_FOUND), $this->ocsFormat($controller))),
		};
	}

	/**
	 * AvatarController for an account that does not exist: 404 with "[]", or with guestFallback
	 * the guest picture of the id that was asked for (GuestAvatarController, the same steps).
	 */
	private function noAvatar(string $uid, bool $dark): Response {
		// Read as the server casts a bool parameter (Dispatcher::executeController).
		$fallback = $this->request->getParam('guestFallback', false);
		if ($fallback === 'false' || !(bool)$fallback) {
			return new JSONResponse([], Http::STATUS_NOT_FOUND);
		}
		$size = (int)$this->request->getParam('size', 64) <= 64 ? 64 : 512;
		try {
			$avatar = Server::get(IAvatarManager::class)->getGuestAvatar($uid);
			$file = $avatar->getFile($size, $dark);
			$response = new FileDisplayResponse($file, $avatar->isCustomAvatar() ? Http::STATUS_OK : Http::STATUS_CREATED,
				['Content-Type' => $file->getMimeType(), 'X-NC-IsCustomAvatar' => (int)$avatar->isCustomAvatar()]);
			$response->cacheFor(1800, false, true);
			return $response;
		} catch (\Exception) {
			$response = new Response();
			$response->setStatus(Http::STATUS_INTERNAL_SERVER_ERROR);
			return $response;
		}
	}

	/** The format the server's OCS middleware answers in (OCSMiddleware::getFormat). */
	private function ocsFormat(Controller $controller): string {
		$format = $this->request->getParam('format');
		return is_string($format) ? $format : $controller->getResponderByHTTPHeader($this->request->getHeader('Accept'), 'xml');
	}

	/**
	 * NoCalendar's public appointments page answers the name of any account id, to anyone. For a
	 * person the viewer may not see (or anyone not signed in), an account without a public booking
	 * page gets the page Calendar shows for an account that does not exist. A public booking page
	 * is the person's own choice to be found, like a public link, and stays.
	 *
	 * @throws OrgAnswer
	 */
	private function appointments(?IUser $viewer): void {
		$uid = $this->request->getParam('userId');
		if (!is_string($uid) || $uid === '' || ($viewer !== null && $this->privacy->canSeeUser($viewer, $uid))
			|| $this->userManager->get($uid) === null || $this->hasPublicBookingPage($uid)) {
			return;
		}
		// AppointmentController::index for an account that does not exist.
		throw new OrgAnswer(new TemplateResponse('calendar', 'appointments/404-index', [], TemplateResponse::RENDER_AS_GUEST));
	}

	private function hasPublicBookingPage(string $uid): bool {
		try {
			return Server::get(self::CALENDAR_CONFIGS)->getAllAppointmentConfigurations($uid, self::CALENDAR_PUBLIC) !== [];
		} catch (\Throwable) {
			// Calendar changed: the page shows nobody rather than someone it should not.
			return false;
		}
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

	/**
	 * A NoGantt person resource names an account (uid); a role resource names none (NoGantt
	 * drops a role's uid, and a resource's type cannot change: "type_immutable").
	 */
	private function ganttResource(IUser $user): ?string {
		return $this->request->getParam('type') === 'role' ? null : $this->person($user, 'uid');
	}

	/** Request parameters as Deck reads them: JSON objects, not arrays. */
	private static function objects(mixed $value): mixed {
		return is_array($value) ? json_decode((string)json_encode($value)) : null;
	}
}
