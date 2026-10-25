<?php

declare(strict_types=1);

/**
 * GET /v1/health: {"status":"ok","clamav":"ok"|"unavailable","signatures":"YYYY-MM-DD"|null}.
 * ClamAV being down never changes "status": NoMail's account set-up needs only status=ok, and
 * its scanner waits for clamav=ok by itself.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\NouraxApi\Service;

class HealthService {
	public function __construct(
		private ClamdClient $clamd,
	) {
	}

	/** @return array{status: string, clamav: string, signatures: ?string} */
	public function report(): array {
		$deadline = microtime(true) + ClamdClient::HEALTH_TIMEOUT;
		$clamav = 'unavailable';
		$signatures = null;
		try {
			if ($this->clamd->ping($deadline)) {
				$clamav = 'ok';
				$signatures = ClamdClient::signatureDate($this->clamd->version($deadline));
			}
		} catch (ClamdUnavailableException) {
			// clamav stays "unavailable" when PING fails; a failed VERSION after PONG keeps "ok"
		}
		return ['status' => 'ok', 'clamav' => $clamav, 'signatures' => $signatures];
	}
}
