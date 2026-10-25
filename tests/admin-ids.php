<?php

declare(strict_types=1);

/**
 * Checks the id rules of the admin API (AdminRequest, PersonRequest) and of /v1/provision
 * (ProvisionRequest) without a web request: lowercase UUIDs, QA ids and the demo ids of the
 * owner's kept demo data (^demo-[a-z0-9-]{1,40}$, tests/demo-accounts.sh). It runs inside the app
 * container, where nextcloud-apps/ is mounted at /var/www/html/nourax_apps:
 *   sudo docker compose exec -T app php < tests/admin-ids.php
 * tests/demo-accounts.sh runs it first.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace NouraxTests;

use OCA\NouraxApi\Service\AdminRequest as A;
use OCA\NouraxApi\Service\ApiException;
use OCA\NouraxApi\Service\PersonRequest as P;
use OCA\NouraxApi\Service\ProvisionRequest as R;

$lib = getenv('NOURAX_API_LIB') ?: '/var/www/html/nourax_apps/nourax_api/lib';
require $lib . '/Service/ApiException.php';
require $lib . '/Service/AdminStore.php';
require $lib . '/Service/AdminRequest.php';
require $lib . '/Service/ProvisionRequest.php';
require $lib . '/Service/PersonRequest.php';

$fails = 0;
function expect(string $name, bool $ok): void {
	global $fails;
	echo ($ok ? 'PASS ' : 'FAIL ') . $name . "\n";
	if (!$ok) {
		$fails++;
	}
}
/** The refusal of a call, as "<code>/<status>", or "none". */
function refusal(callable $call): string {
	try {
		$call();
		return 'none';
	} catch (ApiException $e) {
		return $e->errorCode . '/' . $e->httpStatus;
	}
}
/** A person body (PUT /v1/admin/people/{user_id}) for one organisation and its teams. */
function person(string $orgId, array $teams = []): array {
	return ['email' => '', 'display_name' => '', 'org_id' => $orgId,
		'teams' => array_map(static fn (string $t): array => ['team_id' => $t, 'role' => 'member'], $teams),
		'active' => true, 'version' => 1];
}

const UUID = '0d6f6c1e-5b8a-4a3e-9c2d-1f2e3d4c5b6a';
const UUID2 = '7b1e2c3d-4f5a-4b6c-8d7e-9f0a1b2c3d4e';
$longest = 'demo-' . str_repeat('a', 40);
$tooLong = 'demo-' . str_repeat('a', 41);

// Accepted: the demo ids of tests/demo-accounts.sh, as organisation, team and person.
foreach (['demo-alpha', 'demo-alpha-sales', 'demo-a01', $longest] as $id) {
	expect("organisation or team id $id accepted", A::validId($id) && A::id($id) === $id);
}
expect('demo team of a demo organisation accepted', A::teamIds('demo-alpha', 'demo-alpha-sales') === ['demo-alpha', 'demo-alpha-sales']);
expect('person demo-a01 accepted', R::validPersonId('demo-a01'));
$p = P::fromArray('demo-a01', ['email' => 'demo-a01@demo-alpha.invalid', 'display_name' => 'Amina (Sales)', 'org_id' => 'demo-alpha',
	'teams' => [['team_id' => 'demo-alpha-sales', 'role' => 'lead'], ['team_id' => 'demo-alpha-engineering', 'role' => 'member']],
	'active' => true, 'version' => 1]);
expect('person body of demo-a01 in demo-alpha accepted', $p->userId === 'demo-a01' && $p->orgId === 'demo-alpha'
	&& $p->teams === ['demo-alpha-engineering' => 'member', 'demo-alpha-sales' => 'lead']);
expect('person demo-' . str_repeat('a', 40) . ' accepted', R::validPersonId($longest));

// Refused: anything that is not exactly ^demo-[a-z0-9-]{1,40}$.
$bad = ['demo-' => 'demo-', 'demo-A01' => 'demo-A01', 'demo-a01 + newline' => "demo-a01\n", 'demo_a01' => 'demo_a01',
	'xdemo-a01' => 'xdemo-a01', 'demo-a01 with a space' => 'demo-a01 ', 'demo- + 41 characters' => $tooLong,
	'Demo-a01' => 'Demo-a01', 'demo-a/01' => 'demo-a/01'];
foreach ($bad as $label => $id) {
	expect("organisation or team id '$label' refused", !A::validId($id) && refusal(fn () => A::id($id)) === 'invalid_request/400');
	expect("person '$label' refused", !R::validPersonId($id)
		&& refusal(fn () => P::fromArray($id, person('demo-alpha'))) === 'invalid_request/400');
}

// /v1/provision and the scheduled delete never take a demo id (validUserId).
expect('demo-a01 is no provision uid', !R::validUserId('demo-a01'));
expect('POST /v1/provision with demo-a01 refused', refusal(fn () => R::fromJson('{"user_id":"demo-a01","email":"","display_name":""}')) === 'invalid_request/400');

// Demo data never mixes with other data.
expect('demo team in a UUID organisation refused', refusal(fn () => A::teamIds(UUID, 'demo-alpha-sales')) === 'invalid_request/400');
expect('UUID team in a demo organisation refused', refusal(fn () => A::teamIds('demo-alpha', UUID)) === 'invalid_request/400');
expect('demo team in a QA organisation refused', refusal(fn () => A::teamIds('qa-t6b-org', 'demo-alpha-sales')) === 'invalid_request/400');
expect('demo person in a UUID organisation refused', refusal(fn () => P::fromArray('demo-a01', person(UUID))) === 'invalid_request/400');
expect('demo person in a QA organisation refused', refusal(fn () => P::fromArray('demo-a01', person('qa-t6b-org'))) === 'invalid_request/400');
expect('UUID person in a demo organisation refused', refusal(fn () => P::fromArray(UUID, person('demo-alpha'))) === 'invalid_request/400');
expect('QA person in a demo organisation refused', refusal(fn () => P::fromArray('qa-t6-1', person('demo-alpha'))) === 'invalid_request/400');

// The old rules still hold.
expect('UUID organisation and team accepted', A::teamIds(UUID, UUID2) === [UUID, UUID2]);
expect('QA organisation and team accepted', A::teamIds('qa-t6-org-a', 'qa-t6-team-a') === ['qa-t6-org-a', 'qa-t6-team-a']);
expect('UUID team in a QA organisation accepted', A::teamIds('qa-t6-org-a', UUID) === ['qa-t6-org-a', UUID]);
expect('uppercase UUID refused', !A::validId(strtoupper(UUID)) && !R::validPersonId(strtoupper(UUID)));
expect('nodrive refused', !A::validId('nodrive') && !R::validPersonId('nodrive'));
expect('UUID person accepted', R::validUserId(UUID) && R::validPersonId(UUID) && P::fromArray(UUID, person(UUID2))->userId === UUID);
expect('QA person accepted', R::validUserId('qa-t6-1') && P::fromArray('qa-t6-1', person('qa-t6-org-a'))->orgId === 'qa-t6-org-a');
expect('QA person in a UUID organisation accepted', P::fromArray('qa-t6-1', person(UUID))->orgId === UUID);
expect('qa-t6-1000 person refused', !R::validPersonId('qa-t6-1000'));
expect('qa-t6b-1 person accepted (a task with a letter)', R::validUserId('qa-t6b-1') && P::fromArray('qa-t6b-1', person('qa-t6b-org-a'))->orgId === 'qa-t6b-org-a');
expect('qa-t6bb-1 and qa-t6B-1 refused', !R::validPersonId('qa-t6bb-1') && !R::validPersonId('qa-t6B-1'));
expect('POST /v1/provision with qa-t6-1 accepted', R::fromJson('{"user_id":"qa-t6-1","email":"","display_name":""}')->userId === 'qa-t6-1');

echo $fails === 0 ? "all id checks passed\n" : "$fails id check(s) failed\n";
exit($fails === 0 ? 0 : 1);
