<?php

declare(strict_types=1);

/**
 * A step of an admin call that could not do its work; the message is the step's "detail" in the
 * answer, so it is plain and holds no secret.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\NouraxApi\Service;

class StepFailed extends \RuntimeException {
}
