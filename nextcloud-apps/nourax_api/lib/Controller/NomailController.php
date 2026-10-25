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
 * (logged as class and message only). /v1/scan adds its own answers (see scan()).
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\NouraxApi\Controller;

use OCA\NouraxApi\AppInfo\Application;
use OCA\NouraxApi\Http\ApiKeyAuth;
use OCA\NouraxApi\Http\RateLimiter;
use OCA\NouraxApi\Service\ApiException;
use OCA\NouraxApi\Service\AuditLog;
use OCA\NouraxApi\Service\ClamdClient;
use OCA\NouraxApi\Service\ClamdUnavailableException;
use OCA\NouraxApi\Service\HealthService;
use OCA\NouraxApi\Service\ProvisionRequest;
use OCA\NouraxApi\Service\ProvisionService;
use OCA\NouraxApi\Service\ScanResult;
use OCA\NouraxApi\Settings;
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
	/**
	 * A scan slot frees itself after this many seconds if its PHP process dies without giving
	 * it back: longer than a scan can take (5 s to connect, 90 s in all; Cloudflare gives up
	 * after 100 s).
	 */
	public const SCAN_SLOT_TTL = 150;

	/** The id an endpoint is acting on (e.g. the uid), for its audit row. Never a body. */
	private ?string $auditTarget = null;
	/** The audit row's result for a 2xx answer, when "ok" says too little (scan: clean, infected). */
	private ?string $auditResult = null;

	public function __construct(
		IRequest $request,
		RateLimiter $limiter,
		AuditLog $audit,
		LoggerInterface $logger,
		private ApiKeyAuth $auth,
		private IThrottler $throttler,
		private HealthService $health,
		private ProvisionService $provisioner,
		private ClamdClient $clamd,
		private Settings $settings,
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
	 * POST /v1/scan: the raw file bytes (Content-Type: application/octet-stream), at most
	 * 99,614,720 bytes (95 MiB, NoMail's MAX_SCAN_BYTES); X-File-Name only for the debug log.
	 * -> 200 {"status":"clean"} | {"status":"infected","signature":"<ClamAV name>"};
	 * 413 {"error":"too_large","max_bytes":99614720}; 429 scanner_busy (Retry-After: 30) while
	 * scan_concurrency scans run; 503 scanner_unavailable when clamd cannot be reached; 422
	 * scan_error when clamd failed part-way (NoMail tries that file again later).
	 *
	 * The bytes go from the request straight to clamd (INSTREAM) in 1 MiB pieces. This app never
	 * writes them anywhere: no file, no log, no database. (PHP itself keeps a request body over
	 * 16 KB in a temporary file until the request ends, and clamd keeps one while it scans; both
	 * delete theirs at once.)
	 */
	#[PublicPage]
	#[NoCSRFRequired]
	#[BruteForceProtection(action: self::BRUTE_FORCE_ACTION)]
	public function scan(): JSONResponse {
		return $this->guarded('scan', 'POST /v1/scan', function (): JSONResponse {
			$max = ClamdClient::MAX_SCAN_BYTES;
			// A body that says it is too large is refused before clamd is asked. A chunked body
			// (no Content-Length) is counted while it streams instead.
			$length = $this->request->getHeader('Content-Length');
			if (ctype_digit($length) && (strlen($length) > 15 || (int)$length > $max)) {
				return $this->scanTooLarge($max);
			}
			$slot = $this->limiter->acquireSlot('scan', $this->settings->scanConcurrency(), self::SCAN_SLOT_TTL);
			if ($slot === null) {
				return $this->error('scanner_busy', 429, ['Retry-After' => (string)RateLimiter::RETRY_AFTER]);
			}
			$input = false;
			try {
				// PHP's own limit counts CPU time; a scan mostly waits, but it must never cut one short.
				if (function_exists('set_time_limit')) {
					@set_time_limit((int)ClamdClient::SCAN_DEADLINE + 30);
				}
				$input = fopen('php://input', 'rb');
				if ($input === false) {
					throw new \RuntimeException('the request body could not be opened');
				}
				$result = $this->clamd->scan($input, $max);
			} catch (ClamdUnavailableException $e) {
				$this->logger->warning('nourax_api POST /v1/scan: ' . $e->getMessage(), ['app' => Application::APP_ID]);
				return $this->error('scanner_unavailable', 503, ['Retry-After' => '60']);
			} finally {
				if (is_resource($input)) {
					fclose($input);
				}
				$this->limiter->releaseSlot($slot);
			}
			$this->logScan($result);
			switch ($result->verdict) {
				case ScanResult::CLEAN:
					$this->auditResult = 'clean';
					return $this->json(['status' => 'clean']);
				case ScanResult::INFECTED:
					$this->auditResult = 'infected';
					return $this->json(['status' => 'infected', 'signature' => $result->signature]);
				case ScanResult::TOO_LARGE:
					return $this->scanTooLarge($max);
				default:
					return $this->error('scan_error', 422);
			}
		});
	}

	private function scanTooLarge(int $max): JSONResponse {
		return $this->json(['error' => 'too_large', 'max_bytes' => $max], 413);
	}

	/**
	 * The verdict, size and file name at debug level only (names can be personal); a failed
	 * scan's reason at warning level, without the name. Never any of the file's bytes.
	 */
	private function logScan(ScanResult $result): void {
		if ($result->verdict === ScanResult::FAILED) {
			$this->logger->warning('nourax_api POST /v1/scan failed after ' . $result->bytes . ' bytes: ' . $result->detail,
				['app' => Application::APP_ID]);
		}
		$this->logger->debug('nourax_api scan of "' . self::fileName($this->request->getHeader('X-File-Name')) . '": '
			. $result->verdict . ($result->signature === null ? '' : ' (' . $result->signature . ')')
			. ', ' . $result->bytes . ' bytes' . ($result->detail === '' ? '' : ': ' . $result->detail),
			['app' => Application::APP_ID]);
	}

	/** X-File-Name as NoMail sends it (URL-encoded): decoded, without control characters, 200 at most. */
	private static function fileName(string $header): string {
		$name = trim((string)preg_replace('/[\x00-\x1f\x7f]+/', ' ', rawurldecode($header)));
		return mb_substr(mb_scrub($name, 'UTF-8'), 0, 200);
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
			$result = $status < 300 ? ($this->auditResult ?? 'ok') : (is_array($data) && is_string($data['error'] ?? null) ? $data['error'] : 'error');
			$this->audit->record($keyId, $this->request->getMethod(), $route, $target, $status, $result,
				$this->request->getRemoteAddress(), self::since($started));
		}
		return $response;
	}
}
