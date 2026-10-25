<?php

declare(strict_types=1);

/**
 * Thrown by OrgShareMiddleware when a new board share is outside the person's organisation;
 * the same middleware answers it with 403 and the message.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\NouraxApi\Middleware;

class OrgShareRefused extends \Exception {
}
