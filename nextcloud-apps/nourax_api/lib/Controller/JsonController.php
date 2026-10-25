<?php

declare(strict_types=1);

/**
 * What every endpoint of this app shares: JSON answers that are never cached, error answers of
 * the form {"error":"<code>"}, and exceptions logged as class and message only (no bodies, no
 * keys, no stack traces with arguments).
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\NouraxApi\Controller;

use OCA\NouraxApi\AppInfo\Application;
use OCA\NouraxApi\Http\RateLimiter;
use OCA\NouraxApi\Service\AuditLog;
use OCP\AppFramework\Controller;
use OCP\AppFramework\Http\JSONResponse;
use OCP\IRequest;
use Psr\Log\LoggerInterface;

abstract class JsonController extends Controller {
	public function __construct(
		IRequest $request,
		protected RateLimiter $limiter,
		protected AuditLog $audit,
		protected LoggerInterface $logger,
	) {
		parent::__construct(Application::APP_ID, $request);
	}

	protected function json(array $data, int $status = 200, array $headers = []): JSONResponse {
		$response = new JSONResponse($data, $status);
		$response->addHeader('Cache-Control', 'no-store');
		foreach ($headers as $name => $value) {
			$response->addHeader($name, $value);
		}
		return $response;
	}

	protected function error(string $code, int $status, array $headers = []): JSONResponse {
		return $this->json(['error' => $code], $status, $headers);
	}

	protected function tooManyRequests(): JSONResponse {
		return $this->error('rate_limited', 429, ['Retry-After' => (string)RateLimiter::RETRY_AFTER]);
	}

	protected function failed(\Throwable $e, string $route): JSONResponse {
		$this->logger->warning('nourax_api ' . $route . ' failed: ' . get_class($e) . ': ' . $e->getMessage(), ['app' => Application::APP_ID]);
		return $this->error('internal_error', 500);
	}

	/** Milliseconds since $started (a microtime(true) value). */
	protected static function since(float $started): int {
		return (int)round((microtime(true) - $started) * 1000);
	}
}
