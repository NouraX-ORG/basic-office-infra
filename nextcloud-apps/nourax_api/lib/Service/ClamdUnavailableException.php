<?php

declare(strict_types=1);

/**
 * clamd is not reachable or did not answer: the API answers 503 for scans, and health reports
 * "clamav":"unavailable" (health itself stays "ok").
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\NouraxApi\Service;

class ClamdUnavailableException extends \RuntimeException {
}
