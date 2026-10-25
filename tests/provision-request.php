<?php

declare(strict_types=1);

/**
 * Checks the input rules of POST /v1/provision (ProvisionRequest) without a web request.
 * It runs inside the app container, where nextcloud-apps/ is mounted at /var/www/html/nourax_apps:
 *   sudo docker compose exec -T app php < tests/provision-request.php
 * tests/api-provision.sh runs it first.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace NouraxTests;

use OCA\NouraxApi\Service\ApiException;
use OCA\NouraxApi\Service\ProvisionRequest as R;

$lib = getenv('NOURAX_API_LIB') ?: '/var/www/html/nourax_apps/nourax_api/lib';
require $lib . '/Service/ApiException.php';
require $lib . '/Service/ProvisionRequest.php';

$fails = 0;
function expect(string $name, bool $ok): void {
	global $fails;
	echo ($ok ? 'PASS ' : 'FAIL ') . $name . "\n";
	if (!$ok) {
		$fails++;
	}
}
/** The refusal for a body, as "<code>/<status>", or "none". */
function refusal(string $body): string {
	try {
		R::fromJson($body);
		return 'none';
	} catch (ApiException $e) {
		return $e->errorCode . '/' . $e->httpStatus;
	}
}
$r = R::fromJson('{"user_id":"0d6f6c1e-5b8a-4a3e-9c2d-1f2e3d4c5b6a","email":"  Ana@Nourax.org ","display_name":" Ana\u0000 Silva\n"}');
expect('uuid accepted', $r->userId === '0d6f6c1e-5b8a-4a3e-9c2d-1f2e3d4c5b6a');
expect('email trimmed', $r->email === 'Ana@Nourax.org');
expect('display name cleaned', $r->displayName === 'Ana  Silva');
expect('qa id accepted', R::fromJson('{"user_id":"qa-t6-1","email":"","display_name":""}')->userId === 'qa-t6-1');
expect('nodrive refused', refusal('{"user_id":"nodrive","email":"a@b.c","display_name":"x"}') === 'invalid_request/400');
expect('admin refused', refusal('{"user_id":"admin","email":"a@b.c","display_name":"x"}') === 'invalid_request/400');
expect('uppercase refused', refusal('{"user_id":"0D6F6C1E-5B8A-4A3E-9C2D-1F2E3D4C5B6A","email":"a@b.c","display_name":"x"}') === 'invalid_request/400');
expect('trailing newline refused', refusal('{"user_id":"qa-t6-1\n","email":"a@b.c","display_name":"x"}') === 'invalid_request/400');
expect('qa-t6-1000 refused', refusal('{"user_id":"qa-t6-1000","email":"a@b.c","display_name":"x"}') === 'invalid_request/400');
expect('missing email refused', refusal('{"user_id":"qa-t6-1","display_name":"x"}') === 'invalid_request/400');
expect('missing display_name refused', refusal('{"user_id":"qa-t6-1","email":"a@b.c"}') === 'invalid_request/400');
expect('number email refused', refusal('{"user_id":"qa-t6-1","email":5,"display_name":"x"}') === 'invalid_request/400');
expect('email with newline refused', refusal('{"user_id":"qa-t6-1","email":"a@b.c\nBcc: x","display_name":"x"}') === 'invalid_request/400');
expect('long email refused', refusal(json_encode(['user_id' => 'qa-t6-1', 'email' => str_repeat('a', 321), 'display_name' => 'x'])) === 'invalid_request/400');
expect('list refused', refusal('["qa-t6-1"]') === 'invalid_request/400');
expect('empty object refused', refusal('{}') === 'invalid_request/400');
expect('not json refused', refusal('user_id=qa-t6-1') === 'invalid_request/400');
expect('empty body refused', refusal('') === 'invalid_request/400');
expect('deep nesting refused', refusal('{"user_id":"qa-t6-1","email":"a@b.c","display_name":{"a":{"b":{"c":1}}}}') === 'invalid_request/400');
expect('too large', refusal(str_repeat(' ', 16385)) === 'too_large/413');
$long = R::fromJson(json_encode(['user_id' => 'qa-t6-1', 'email' => '', 'display_name' => str_repeat('é', 300)]));
expect('display name cut to 255 characters', mb_strlen($long->displayName) === 255);
echo $fails === 0 ? "all request checks passed\n" : "$fails request check(s) failed\n";
exit($fails === 0 ? 0 : 1);
