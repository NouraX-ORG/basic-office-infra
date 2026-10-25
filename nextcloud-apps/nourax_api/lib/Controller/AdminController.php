<?php

declare(strict_types=1);

/**
 * The admin-only organisations and teams API (docs/teams.md). It is called by the Nourax
 * administrator's tools only, never offered as an MCP tool, and every request is signed with the
 * admin key (HmacAuth), not the NoMail key.
 *
 * Every call goes through signed(): 503 not_configured until the admin key is imported; 413 for a
 * body over 2 MB; 401 unauthorized (a missing or wrong signature, counted by the brute-force
 * protection), stale_timestamp (timestamp more than 5 minutes off) or replayed (nonce used before);
 * 429 when the admin rate limit is full; then the endpoint. Ids come from the signed path, never
 * from the body. Every call writes one audit row (no body); failures also log one warning line.
 *
 * Answers of the PUT calls: 200 {"ok":true,"applied":true,"version","steps":[...]} when every
 * step worked, 502 with the same body when a step failed (send it again), 200 with
 * "applied":false and "reason":"stale_version" when a newer version is already stored,
 * 423 {"error":"busy"} while another call works on the same object. The reconcile call answers
 * 200 when everything matches afterwards and 502 otherwise (ReconcileService).
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\NouraxApi\Controller;

use OCA\NouraxApi\Http\AuthFailed;
use OCA\NouraxApi\Http\HmacAuth;
use OCA\NouraxApi\Http\RateLimiter;
use OCA\NouraxApi\Service\AdminRequest;
use OCA\NouraxApi\Service\AdminStore;
use OCA\NouraxApi\Service\ApiException;
use OCA\NouraxApi\Service\AuditLog;
use OCA\NouraxApi\Service\OrgService;
use OCA\NouraxApi\Service\PeopleService;
use OCA\NouraxApi\Service\PersonRequest;
use OCA\NouraxApi\Service\ProvisionRequest;
use OCA\NouraxApi\Service\ReconcileService;
use OCA\NouraxApi\Service\TeamService;
use OCP\AppFramework\Http\Attribute\BruteForceProtection;
use OCP\AppFramework\Http\Attribute\NoCSRFRequired;
use OCP\AppFramework\Http\Attribute\PublicPage;
use OCP\AppFramework\Http\JSONResponse;
use OCP\IRequest;
use OCP\Security\Bruteforce\IThrottler;
use Psr\Log\LoggerInterface;

class AdminController extends JsonController {
	public const BRUTE_FORCE_ACTION = 'nourax_api_admin';
	public const DEFAULT_AUDIT_ROWS = 100;
	public const MAX_AUDIT_ROWS = 500;

	private const APP_PREFIX = '/apps/nourax_api';
	private const ORG_PATH = '#^/v1/admin/orgs/(?<org>[^/?]+)$#D';
	private const TEAM_PATH = '#^/v1/admin/orgs/(?<org>[^/?]+)/teams/(?<team>[^/?]+)$#D';
	private const PERSON_PATH = '#^/v1/admin/people/(?<user>[^/?]+)$#D';
	private const RECONCILE_PATH = '#^/v1/admin/orgs/(?<org>[^/?]+)/reconcile$#D';
	private const AUDIT_PATH = '#^/v1/admin/audit(?:\?(?<query>.*))?$#D';

	/** What the audit row names as the call's object, e.g. "team:<team_id>". Never a body. */
	private ?string $auditTarget = null;
	/** The audit result when it is not simply "ok" or the error code. */
	private ?string $auditResult = null;

	public function __construct(
		IRequest $request,
		RateLimiter $limiter,
		AuditLog $audit,
		LoggerInterface $logger,
		private HmacAuth $auth,
		private IThrottler $throttler,
		private OrgService $orgs,
		private TeamService $teams,
		private PeopleService $people,
		private ReconcileService $reconciler,
	) {
		parent::__construct($request, $limiter, $audit, $logger);
	}

	/** PUT /v1/admin/orgs/{org_id} {"name","version"} */
	#[PublicPage]
	#[NoCSRFRequired]
	#[BruteForceProtection(action: self::BRUTE_FORCE_ACTION)]
	public function putOrg(): JSONResponse {
		return $this->signed('PUT /v1/admin/orgs/{org_id}', self::ORG_PATH, function (array $path, string $body): JSONResponse {
			$orgId = AdminRequest::id($path['org']);
			$this->auditTarget = AdminStore::orgGroup($orgId);
			return $this->outcome($this->orgs->put($orgId, AdminRequest::nameAndVersion($body)));
		});
	}

	/** GET /v1/admin/orgs/{org_id} */
	#[PublicPage]
	#[NoCSRFRequired]
	#[BruteForceProtection(action: self::BRUTE_FORCE_ACTION)]
	public function getOrg(): JSONResponse {
		return $this->signed('GET /v1/admin/orgs/{org_id}', self::ORG_PATH, function (array $path): JSONResponse {
			$orgId = AdminRequest::id($path['org']);
			$this->auditTarget = AdminStore::orgGroup($orgId);
			return $this->json($this->orgs->status($orgId));
		});
	}

	/** PUT /v1/admin/orgs/{org_id}/teams/{team_id} {"name","version"} */
	#[PublicPage]
	#[NoCSRFRequired]
	#[BruteForceProtection(action: self::BRUTE_FORCE_ACTION)]
	public function putTeam(): JSONResponse {
		return $this->signed('PUT /v1/admin/orgs/{org_id}/teams/{team_id}', self::TEAM_PATH, function (array $path, string $body): JSONResponse {
			[$orgId, $teamId] = AdminRequest::teamIds($path['org'], $path['team']);
			$this->auditTarget = AdminStore::teamGroup($teamId);
			return $this->outcome($this->teams->put($orgId, $teamId, AdminRequest::nameAndVersion($body)));
		});
	}

	/** GET /v1/admin/orgs/{org_id}/teams/{team_id} */
	#[PublicPage]
	#[NoCSRFRequired]
	#[BruteForceProtection(action: self::BRUTE_FORCE_ACTION)]
	public function getTeam(): JSONResponse {
		return $this->signed('GET /v1/admin/orgs/{org_id}/teams/{team_id}', self::TEAM_PATH, function (array $path): JSONResponse {
			[$orgId, $teamId] = AdminRequest::teamIds($path['org'], $path['team']);
			$this->auditTarget = AdminStore::teamGroup($teamId);
			return $this->json($this->teams->status($orgId, $teamId));
		});
	}

	/** PUT /v1/admin/people/{user_id} {"email","display_name","org_id","teams","active","version"} */
	#[PublicPage]
	#[NoCSRFRequired]
	#[BruteForceProtection(action: self::BRUTE_FORCE_ACTION)]
	public function putPerson(): JSONResponse {
		return $this->signed('PUT /v1/admin/people/{user_id}', self::PERSON_PATH, function (array $path, string $body): JSONResponse {
			$userId = self::userId($path['user']);
			$this->auditTarget = $userId;
			return $this->outcome($this->people->put(PersonRequest::fromJson($userId, $body)));
		});
	}

	/** GET /v1/admin/people/{user_id} */
	#[PublicPage]
	#[NoCSRFRequired]
	#[BruteForceProtection(action: self::BRUTE_FORCE_ACTION)]
	public function getPerson(): JSONResponse {
		return $this->signed('GET /v1/admin/people/{user_id}', self::PERSON_PATH, function (array $path): JSONResponse {
			$userId = self::userId($path['user']);
			$this->auditTarget = $userId;
			return $this->json($this->people->status($userId));
		});
	}

	/** POST /v1/admin/orgs/{org_id}/reconcile {"teams":[...],"people":[...],"dry_run"?} */
	#[PublicPage]
	#[NoCSRFRequired]
	#[BruteForceProtection(action: self::BRUTE_FORCE_ACTION)]
	public function reconcile(): JSONResponse {
		return $this->signed('POST /v1/admin/orgs/{org_id}/reconcile', self::RECONCILE_PATH, function (array $path, string $body): JSONResponse {
			$orgId = AdminRequest::id($path['org']);
			$this->auditTarget = AdminStore::orgGroup($orgId);
			return $this->outcome($this->reconciler->reconcile($orgId, $body));
		});
	}

	/** GET /v1/admin/audit?limit=100[&target=team:<team_id>] - the newest audit rows first */
	#[PublicPage]
	#[NoCSRFRequired]
	#[BruteForceProtection(action: self::BRUTE_FORCE_ACTION)]
	public function audit(): JSONResponse {
		return $this->signed('GET /v1/admin/audit', self::AUDIT_PATH, function (array $path): JSONResponse {
			parse_str($path['query'] ?? '', $query);
			$limit = $query['limit'] ?? (string)self::DEFAULT_AUDIT_ROWS;
			$target = $query['target'] ?? null;
			if (!is_string($limit) || preg_match('/^[0-9]{1,3}$/D', $limit) !== 1
				|| (int)$limit < 1 || (int)$limit > self::MAX_AUDIT_ROWS
				|| ($target !== null && (!is_string($target) || $target === '' || strlen($target) > 128))) {
				throw new ApiException('invalid_request', 400);
			}
			return $this->json(['ok' => true, 'rows' => $this->audit->recent((int)$limit, $target)]);
		});
	}

	/** A person's uid from the path: a Supabase user id, a QA id or a demo id (400 otherwise). */
	private static function userId(string $userId): string {
		if (!ProvisionRequest::validPersonId($userId)) {
			throw new ApiException('invalid_request', 400);
		}
		return $userId;
	}

	/** 200 for a full or a stale answer, 502 when a step failed. */
	private function outcome(array $answer): JSONResponse {
		if (($answer['applied'] ?? true) === false) {
			$this->auditResult = 'stale_version';
		} elseif (($answer['ok'] ?? false) !== true) {
			$this->auditResult = 'step_failed';
			return $this->json($answer, 502);
		}
		return $this->json($answer);
	}

	/**
	 * Checks the call (key, size, signature, time, nonce, rate limit), then runs $handler with
	 * the parts of the signed path that $pattern names and the raw body.
	 *
	 * @param \Closure(array<string, string>, string): JSONResponse $handler
	 */
	private function signed(string $route, string $pattern, \Closure $handler): JSONResponse {
		$started = microtime(true);
		$keyId = '-';
		$this->auditTarget = null;
		$this->auditResult = null;
		try {
			if (!$this->auth->isConfigured()) {
				$response = $this->error('not_configured', 503);
			} else {
				$body = $this->readBody();
				$path = $this->signedPath();
				$response = null;
				try {
					$keyId = $this->auth->verify($this->request, $path, $body);
				} catch (AuthFailed $e) {
					$response = $this->error($e->errorCode, 401);
					if ($e->throttle) {
						// No metadata: a reset only clears misses whose metadata matches, and it passes [].
						$response->throttle();
					}
				}
				if ($response === null) {
					// A good signature: earlier misses from this address stop slowing it down.
					$this->throttler->resetDelay($this->request->getRemoteAddress(), self::BRUTE_FORCE_ACTION, []);
					if (!$this->limiter->hit('admin')) {
						$response = $this->tooManyRequests();
					} elseif (preg_match($pattern, $path, $parts) !== 1) {
						$response = $this->error('invalid_request', 400);
					} else {
						$response = $handler($parts, $body);
					}
				}
			}
		} catch (ApiException $e) {
			$response = $this->error($e->errorCode, $e->httpStatus);
		} catch (\Throwable $e) {
			$response = $this->failed($e, 'admin ' . $route);
		}

		$status = $response->getStatus();
		$data = $response->getData();
		$result = $this->auditResult
			?? ($status < 300 ? 'ok' : (is_array($data) && is_string($data['error'] ?? null) ? $data['error'] : 'error'));
		$this->audit->record($keyId, $this->request->getMethod(), $route, $this->auditTarget, $status, $result,
			$this->request->getRemoteAddress(), self::since($started));
		if ($status >= 400) {
			$this->logger->warning('nourax_api admin ' . $route . ' -> ' . $status . ' ' . $result
				. ($this->auditTarget === null ? '' : ' (' . $this->auditTarget . ')'), ['app' => 'nourax_api']);
		}
		return $response;
	}

	/**
	 * The raw request body, at most 2 MB (413 too_large otherwise). php://input can be read again
	 * after the server has read a JSON body itself.
	 *
	 * @throws ApiException 413 too_large
	 */
	private function readBody(): string {
		$length = $this->request->getHeader('Content-Length');
		if ($length !== '' && (!ctype_digit($length) || strlen($length) > 12 || (int)$length > HmacAuth::MAX_BODY)) {
			throw new ApiException('too_large', 413);
		}
		$body = file_get_contents('php://input', false, null, 0, HmacAuth::MAX_BODY + 1);
		$body = $body === false ? '' : $body;
		if (strlen($body) > HmacAuth::MAX_BODY) {
			throw new ApiException('too_large', 413);
		}
		return $body;
	}

	/**
	 * The path as signed: from /v1/ on, with ?query if any, exactly as the caller sent it. The
	 * base may be /apps/nourax_api or /index.php/apps/nourax_api.
	 */
	private function signedPath(): string {
		$uri = $this->request->getRequestUri();
		$at = strpos($uri, self::APP_PREFIX . '/v1/');
		return $at === false ? '' : substr($uri, $at + strlen(self::APP_PREFIX));
	}
}
