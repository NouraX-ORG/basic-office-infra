<?php

declare(strict_types=1);

/**
 * Every other path or method under /v1/ (a trailing slash, dot segments, a typo, an unknown
 * method): 404 {"error":"not_found"} as JSON, instead of the web server's HTML page. Nothing is
 * read, changed or audited, and no key is checked, so the answer tells a caller nothing.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\NouraxApi\Controller;

use OCP\AppFramework\Http\Attribute\NoCSRFRequired;
use OCP\AppFramework\Http\Attribute\PublicPage;
use OCP\AppFramework\Http\JSONResponse;

class FallbackController extends JsonController {
	#[PublicPage]
	#[NoCSRFRequired]
	public function notFound(): JSONResponse {
		return $this->error('not_found', 404);
	}
}
