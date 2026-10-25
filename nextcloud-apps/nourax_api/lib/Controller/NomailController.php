<?php

declare(strict_types=1);

/**
 * The NoMail API (Drive handoff, section 2), called by NoMail's Supabase Edge Functions with
 * "Authorization: Bearer <NODRIVE_API_KEY>".
 *
 * Every call goes through guarded(): 503 {"error":"not_configured"} until a key is imported,
 * 401 for a missing or wrong key (counted by the brute-force protection, which slows and then
 * blocks that IP for this action), 429 with Retry-After when a global bucket is full, the
 * {"error":"<code>"} of an ApiException (400, 409, 413, 503), and 500 for anything unexpected
 * (logged as class and message only).
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\NouraxApi\Controller;

use OCA\NouraxApi\Http\ApiKeyAuth;
use OCA\NouraxApi\Http\RateLimiter;
use OCA\NouraxApi\Service\ApiException;
use OCA\NouraxApi\Service\AuditLog;
use OCA\NouraxApi\Service\HealthService;
use OCA\NouraxApi\Service\ProvisionRequest;
use OCA\NouraxApi\Service\ProvisionService;
use OCP\AppFramework\Http\Attribute\BruteForceProtection;
use OCP\AppFramework\Http\Attribute\NoCSRFRequired;
use OCP\AppFramework\Http\Attribute\PublicPage;
use OCP\AppFramework\Http\JSONResponse;
use OCP\IRequest;
use OCP\Security\Bruteforce\IThrottler;
use Psr\Log\LoggerInterface;

class NomailController extends JsonController {
	public const BRUTE_FORCE_ACTION = 'nourax_api_key';
	public const KEY_ID = 'nomail';

	/** The id an endpoint is acting on (e.g. the uid), for its audit row. Never a body. */
	private ?string $auditTarget = null;

	public function __construct(
		IRequest $request,
		RateLimiter $limiter,
		AuditLog $audit,
		LoggerInterface $logger,
		private ApiKeyAuth $auth,
		private IThrottler $throttler,
		private HealthService $health,
		private ProvisionService $provisioner,
	) {
		parent::__construct($request, $limiter, $audit, $logger);
	}

	/** GET /v1/health → 200 {"status":"ok","clamav":"ok"|"unavailable","signatures":"YYYY-MM-DD"|null} */
	#[PublicPage]
	#[NoCSRFRequired]
	#[BruteForceProtection(action: self::BRUTE_FORCE_ACTION)]
	public function health(): JSONResponse {
		// NoMail asks for health every minute, so only refusals are audited.
		return $this->guarded('health', 'GET /v1/health', fn (): JSONResponse => $this->json($this->health->report()), null, false);
	}

	/**
	 * POST /v1/provision {"user_id","email","display_name"}
	 * → 200 {"uid","login","app_password","created"}; 400 invalid_request, 413 too_large,
	 * 409 uid_not_oidc | account_disabled | busy | folder_conflict, 503 oidc_* (see ProvisionService).
	 */
	#[PublicPage]
	#[NoCSRFRequired]
	#[BruteForceProtection(action: self::BRUTE_FORCE_ACTION)]
	public function provision(): JSONResponse {
		return $this->guarded('provision', 'POST /v1/provision', function (): JSONResponse {
			$request = ProvisionRequest::fromJson(self::readBody(ProvisionRequest::MAX_BODY));
			$this->auditTarget = $request->userId;
			return $this->json($this->provisioner->provision($request));
		});
	}

	/**
	 * The raw request body, read up to one byte past $max, so a longer body is noticed without
	 * reading all of it.
	 */
	private static function readBody(int $max): string {
		$body = file_get_contents('php://input', false, null, 0, $max + 1);
		return $body === false ? '' : $body;
	}

	/**
	 * Runs $handler for an authorised caller within the bucket's rate limit.
	 *
	 * @param \Closure(): JSONResponse $handler
	 * @param bool $auditSuccess false to audit only refusals and errors (for frequent calls)
	 */
	protected function guarded(string $bucket, string $route, \Closure $handler, ?string $target = null, bool $auditSuccess = true): JSONResponse {
		$started = microtime(true);
		$keyId = '-';
		try {
			if (!$this->auth->isConfigured()) {
				$response = $this->error('not_configured', 503);
			} elseif (!$this->auth->check($this->request)) {
				$response = $this->error('unauthorized', 401, ['WWW-Authenticate' => 'Bearer']);
				// No metadata: a reset only clears misses whose metadata matches, and it passes [].
				$response->throttle();
			} else {
				$keyId = self::KEY_ID;
				// The right key: earlier misses from this address stop slowing it down.
				$this->throttler->resetDelay($this->request->getRemoteAddress(), self::BRUTE_FORCE_ACTION, []);
				$response = $this->limiter->hit($bucket) ? $handler() : $this->tooManyRequests();
			}
		} catch (ApiException $e) {
			$response = $this->error($e->errorCode, $e->httpStatus);
		} catch (\Throwable $e) {
			$response = $this->failed($e, $route);
		}
		$target ??= $this->auditTarget;

		$status = $response->getStatus();
		if ($auditSuccess || $status >= 300) {
			$data = $response->getData();
			$result = $status < 300 ? 'ok' : (is_array($data) && is_string($data['error'] ?? null) ? $data['error'] : 'error');
			$this->audit->record($keyId, $this->request->getMethod(), $route, $target, $status, $result,
				$this->request->getRemoteAddress(), self::since($started));
		}
		return $response;
	}
}
