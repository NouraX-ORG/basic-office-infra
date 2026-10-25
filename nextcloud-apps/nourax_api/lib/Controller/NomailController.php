<?php

declare(strict_types=1);

/**
 * The NoMail API (Drive handoff, section 2), called by NoMail's Supabase Edge Functions with
 * "Authorization: Bearer <NODRIVE_API_KEY>".
 *
 * Every call goes through guarded(): 503 {"error":"not_configured"} until a key is imported,
 * 401 for a missing or wrong key (counted by the brute-force protection, which slows and then
 * blocks that IP for this action), 429 with Retry-After when a global bucket is full, and 500 for
 * anything unexpected (logged as class and message only).
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\NouraxApi\Controller;

use OCA\NouraxApi\Http\ApiKeyAuth;
use OCA\NouraxApi\Http\RateLimiter;
use OCA\NouraxApi\Service\AuditLog;
use OCA\NouraxApi\Service\HealthService;
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

	public function __construct(
		IRequest $request,
		RateLimiter $limiter,
		AuditLog $audit,
		LoggerInterface $logger,
		private ApiKeyAuth $auth,
		private IThrottler $throttler,
		private HealthService $health,
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
				$response->throttle(['action' => self::BRUTE_FORCE_ACTION]);
			} else {
				$keyId = self::KEY_ID;
				// The right key: earlier misses from this address stop slowing it down.
				$this->throttler->resetDelay($this->request->getRemoteAddress(), self::BRUTE_FORCE_ACTION, []);
				$response = $this->limiter->hit($bucket) ? $handler() : $this->tooManyRequests();
			}
		} catch (\Throwable $e) {
			$response = $this->failed($e, $route);
		}

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
