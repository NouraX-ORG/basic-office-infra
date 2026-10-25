<?php

declare(strict_types=1);

/**
 * Checks nourax_api's org privacy rule (OrgPrivacy: who may share a calendar, an address book
 * or a board with whom) with the real QA accounts and groups, without a web request and without
 * switching anything on: the rule is asked as if sharing were limited to group members.
 * It runs inside the app container as www-data, after tests/privacy.sh has put the QA people in
 * their organisations (privacy.sh runs it):
 *   sudo docker compose exec -T -u www-data app php < tests/org-privacy-rules.php
 *
 *   org A: qa-t6-1 (team A2), qa-t6-2 (team A1)    org B: qa-t6-3 (team B1)
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace NouraxTests;

use OC\AppFramework\DependencyInjection\DIContainer;
use OC\AppFramework\Http\Request;
use OCA\DAV\DAV\Sharing\IShareable;
use OCA\DAV\DAV\Sharing\Xml\ShareRequest;
use OCA\NouraxApi\Dav\OrgSharePlugin;
use OCA\NouraxApi\Middleware\OrgShareMiddleware;
use OCA\NouraxApi\Service\MentionNames;
use OCA\NouraxApi\Service\OrgPrivacy;
use OCP\App\IAppManager;
use OCP\AppFramework\Controller;
use OCP\IConfig;
use OCP\IGroupManager;
use OCP\IRequest;
use OCP\IRequestId;
use OCP\IUser;
use OCP\IUserManager;
use OCP\IUserSession;
use OCP\Server;
use OCP\Share\IManager as IShareManager;
use Sabre\DAV\Exception\Forbidden;
use Sabre\DAV\Node as DavNode;
use Sabre\DAV\Server as DavServer;
use Sabre\DAV\SimpleCollection;
use Sabre\HTTP\Request as DavRequest;
use Sabre\HTTP\Response as DavResponse;

require_once '/var/www/html/lib/base.php';
Server::get(IAppManager::class)->loadApp('dav');
Server::get(IAppManager::class)->loadApp('nourax_api');

$fails = 0;
function expect(string $name, bool $ok): void {
	global $fails;
	echo ($ok ? 'PASS ' : 'FAIL ') . $name . "\n";
	if (!$ok) {
		$fails++;
	}
}
function user(string $uid): IUser {
	$user = Server::get(IUserManager::class)->get($uid);
	if ($user === null) {
		echo "FAIL account $uid is missing\n";
		exit(1);
	}
	return $user;
}

/** The rule as it is while sharing is limited to group members, with a chosen excluded list. */
final class OnPrivacy extends OrgPrivacy {
	public array $excluded = ['admin'];

	public function isOn(): bool {
		return true;
	}

	protected function excludedGroups(): array {
		return $this->excluded;
	}
}

$args = [Server::get(IShareManager::class), Server::get(IGroupManager::class), Server::get(IUserManager::class)];
$on = new OnPrivacy(...$args);
$a1 = user('qa-t6-1');
$teams = user('nourax-teams');
$person = OrgPrivacy::REFUSED_PERSON;
$group = OrgPrivacy::REFUSED_GROUP;
$other = OrgPrivacy::REFUSED_OTHER;

// People
expect('same organisation: qa-t6-1 -> qa-t6-2 allowed', $on->checkPerson($a1, 'qa-t6-2') === null);
expect('other organisation: qa-t6-1 -> qa-t6-3 refused', $on->checkPerson($a1, 'qa-t6-3') === $person);
expect('oneself allowed', $on->checkPerson($a1, 'qa-t6-1') === null);
expect('an unknown account is left to the app', $on->checkPerson($a1, 'qa-t6-nobody') === null);
expect('the service account is never limited', $on->checkPerson($teams, 'qa-t6-3') === null);
// An excluded group never counts as in common: qa-t6-1 and qa-t6-2 share only org A.
$on->excluded = ['admin', 'org:qa-t6-org-a'];
expect('an excluded group does not count', $on->checkPerson($a1, 'qa-t6-2') === $person);
$on->excluded = ['admin'];

// Groups
expect('own organisation group allowed', $on->checkGroup($a1, 'org:qa-t6-org-a') === null);
expect('own team group allowed', $on->checkGroup($a1, 'team:qa-t6-team-a2') === null);
expect('a team of one\'s organisation one is not in: refused', $on->checkGroup($a1, 'team:qa-t6-team-a1') === $group);
expect('other organisation group refused', $on->checkGroup($a1, 'org:qa-t6-org-b') === $group);
expect('the admin group refused (excluded)', $on->checkGroup($a1, 'admin') === $group);
expect('the service account shares with any team', $on->checkGroup($teams, 'team:qa-t6-team-b1') === null);

// CalDAV and CardDAV share targets
$hrefs = [
	'principal:principals/users/qa-t6-2' => null,
	'principal:principals/users/qa-t6-3' => $person,
	'principal:principals/users/qa-t6-3/' => $person,
	'principal:principals/users/qa%2Dt6%2D3' => $person,
	// Without "principal:" the server shares with nobody; refused here all the same.
	'/principals/users/qa-t6-3' => $person,
	'mailto:qa-t6-3@example.invalid' => $person,
	'MAILTO:qa-t6-2@example.invalid' => null,
	'mailto:nobody@example.invalid' => null,
	'principal:principals/groups/org%3Aqa-t6-org-b' => $group,
	'principal:principals/groups/org:qa-t6-org-b' => $group,
	'principal:principals/groups/org%3Aqa-t6-org-a' => null,
	'principal:principals/circles/abc' => $other,
	'principal:principals/remote-users/cWEtdDYtM0BleGFtcGxlLmludmFsaWQ=' => $other,
	'principal:principals/system/system' => null,
	'not a principal' => null,
];
foreach ($hrefs as $href => $want) {
	expect('dav ' . $href . ' -> ' . ($want ?? 'allowed'), $on->checkDavHref($a1, $href) === $want);
}

// Deck board shares (type 0 user, 1 group, 6 remote, 7 circle)
expect('deck: user of org A allowed', $on->checkDeckAcl($a1, 0, 'qa-t6-2') === null);
expect('deck: user of org B refused', $on->checkDeckAcl($a1, 0, 'qa-t6-3') === $person);
expect('deck: group of org B refused', $on->checkDeckAcl($a1, 1, 'org:qa-t6-org-b') === $group);
expect('deck: own team allowed', $on->checkDeckAcl($a1, 1, 'team:qa-t6-team-a2') === null);
expect('deck: remote refused', $on->checkDeckAcl($a1, 6, 'qa@example.invalid') === $other);
expect('deck: circle refused', $on->checkDeckAcl($a1, 7, 'abc') === $other);
expect('deck: the service account shares the team board', $on->checkDeckAcl($teams, 1, 'team:qa-t6-team-b1') === null);

// Handing something to one named account (NoGantt, NoForms, NoBoard owners, transfers, rules):
// an id that does not exist gets the same refusal as another organisation's account.
expect('reach: same organisation allowed', $on->checkReach($a1, 'qa-t6-2') === null);
expect('reach: other organisation refused', $on->checkReach($a1, 'qa-t6-3') === $person);
expect('reach: an unknown id refused the same way', $on->checkReach($a1, 'qa-t6-nobody') === $person);
expect('reach: oneself allowed', $on->checkReach($a1, 'qa-t6-1') === null);
expect('reach: the service account is never limited', $on->checkReach($teams, 'qa-t6-3') === null);
// Who may see a name (DAV addresses, the ONLYOFFICE editor, comments)
expect('see: same organisation', $on->canSeeUser($a1, 'qa-t6-2'));
expect('see: not the other organisation', !$on->canSeeUser($a1, 'qa-t6-3'));
expect('see: the service account stays visible', $on->canSeeUser($a1, 'nourax-teams'));
expect('see: own groups only', $on->canSeeGroup($a1, 'org:qa-t6-org-a') && !$on->canSeeGroup($a1, 'org:qa-t6-org-b'));
// Board imports (Deck JSON exports and uidRelation)
$import = fn (array $acl, array $extra = []): mixed => json_decode((string)json_encode(['boards' => [array_merge(['title' => 'x', 'owner' => 'someone-else', 'acl' => $acl, 'stacks' => []], $extra)]]));
$aclOf = fn (int $type, string $who): array => [['type' => $type, 'participant' => ['primaryKey' => $who, 'uid' => $who]]];
expect('import: a share with org A allowed', $on->checkDeckImport($a1, null, $import($aclOf(0, 'qa-t6-2'))) === null);
expect('import: a share with qa-t6-3 refused', $on->checkDeckImport($a1, null, $import($aclOf(0, 'qa-t6-3'))) === $person);
expect('import: a plain-string participant refused too', $on->checkDeckImport($a1, null, $import([['type' => 0, 'participant' => 'qa-t6-3']])) === $person);
expect('import: org B group refused', $on->checkDeckImport($a1, null, $import($aclOf(1, 'org:qa-t6-org-b'))) === $group);
expect('import: the owner named in the export becomes the importer', $on->checkDeckImport($a1, null, $import($aclOf(0, 'someone-else'))) === null);
expect('import: an account that is not here is skipped', $on->checkDeckImport($a1, null, $import($aclOf(0, 'qa-t6-nobody'))) === null);
expect('import: a card assigned to qa-t6-3 refused', $on->checkDeckImport($a1, null, $import([], ['stacks' => [['cards' => [['assignedUsers' => [['participant' => ['uid' => 'qa-t6-3', 'type' => 0]]]]]]]])) === $person);
expect('import: a comment by qa-t6-3 refused', $on->checkDeckImport($a1, null, $import([], ['stacks' => [['cards' => [['comments' => [['actorId' => 'qa-t6-3']]]]]]])) === $person);
expect('import: uidRelation to qa-t6-3 refused', $on->checkDeckImport($a1, json_decode('{"uidRelation":{"x":"qa-t6-3"}}'), null) === $person);
expect('import: uidRelation to qa-t6-2 allowed, its source id is not checked again', $on->checkDeckImport($a1, json_decode('{"uidRelation":{"qa-t6-3":"qa-t6-2"}}'), $import($aclOf(0, 'qa-t6-3'))) === null);
expect('import: the old format (a map of boards) is read too', $on->checkDeckImport($a1, null, json_decode((string)json_encode(['5' => ['acl' => $aclOf(0, 'qa-t6-3')]]))) === $person);
// Each field is read the way Deck 1.19.1 reads it (DeckJsonService).
$card = fn (array $fields): array => ['stacks' => [['title' => 's', 'cards' => [array_merge(['id' => 1, 'title' => 'c'], $fields)]]]];
expect('import: a share reads participant.primaryKey (qa-t6-2), not uid', $on->checkDeckImport($a1, null, $import([['type' => 0, 'participant' => ['primaryKey' => 'qa-t6-2', 'uid' => 'qa-t6-3']]])) === null);
expect('import: a card person reads participant.uid (qa-t6-3), not primaryKey', $on->checkDeckImport($a1, null, $import([], $card(['assignedUsers' => [['participant' => ['primaryKey' => 'qa-t6-2', 'uid' => 'qa-t6-3', 'type' => 0]]]]))) === $person);
expect('import: an owner without primaryKey is not mapped, so a share with it is checked', $on->checkDeckImport($a1, null, $import([['type' => 0, 'participant' => 'qa-t6-3']], ['owner' => ['uid' => 'qa-t6-3']])) === $person);
expect('import: a comment by the export\'s owner keeps that author (never mapped)', $on->checkDeckImport($a1, null, $import([], array_merge(['owner' => 'qa-t6-3'], $card(['comments' => [['id' => 1, 'actorId' => 'qa-t6-3']]])))) === $person);
expect('import: a comment by a bot is not an account', $on->checkDeckImport($a1, null, $import([], $card(['comments' => [['id' => 1, 'actorType' => 'bots', 'actorId' => 'qa-t6-3']]]))) === null);
expect('import: a card\'s last editor qa-t6-3 refused', $on->checkDeckImport($a1, null, $import([], $card(['lastEditor' => 'qa-t6-3']))) === $person);
expect('import: an attachment by qa-t6-3 refused', $on->checkDeckImport($a1, null, $import([], $card(['attachments' => [['type' => 'file', 'data' => 'a.txt', 'contentBase64' => 'YQ==', 'createdBy' => 'qa-t6-3']]]))) === $person);
expect('import: an attachment Deck skips (no content) is not checked', $on->checkDeckImport($a1, null, $import([], $card(['attachments' => [['type' => 'file', 'data' => 'a.txt', 'createdBy' => 'qa-t6-3']]]))) === null);
expect('import: a share type that is not a number refused', $on->checkDeckImport($a1, null, $import([['type' => 'abc', 'participant' => 'qa-t6-2']])) === $person);
expect('import: a share without a type is skipped, as by Deck', $on->checkDeckImport($a1, null, $import([['participant' => 'qa-t6-3']])) === null);
expect('import: same-organisation people everywhere allowed', $on->checkDeckImport($a1, null, $import($aclOf(0, 'qa-t6-2'), $card(['lastEditor' => 'qa-t6-2', 'assignedUsers' => [['participant' => ['uid' => 'qa-t6-2', 'type' => 0]]], 'comments' => [['id' => 1, 'actorId' => 'qa-t6-2']]]))) === null);

// --- The DAV plugin, on a small DAV server with one shareable collection, as if privacy were on --
\OC::$server->registerService(OrgPrivacy::class, fn () => $on);
$session = Server::get(IUserSession::class);
$session->setUser($a1);
$shareable = new class extends DavNode implements IShareable {
	public int $updates = 0;
	public function getName() {
		return 'qa-calendar';
	}
	public function updateShares(array $add, array $remove): void {
		$this->updates++;
	}
	public function getShares(): array {
		return [];
	}
	public function getResourceId(): int {
		return 1;
	}
	public function getOwner() {
		return 'principals/users/qa-t6-1';
	}
};
$dav = new DavServer(new SimpleCollection('root', [$shareable]));
$dav->xml->elementMap['{http://owncloud.org/ns}share'] = ShareRequest::class;
$plugin = new OrgSharePlugin();
$dav->addPlugin($plugin);
/** The plugin's answer to a share POST: "refused: <message>" or "passed" (body still readable). */
function davShare(OrgSharePlugin $plugin, string $href, string $contentType = 'application/xml; charset=utf-8'): string {
	$body = '<?xml version="1.0" encoding="utf-8"?><o:share xmlns:d="DAV:" xmlns:o="http://owncloud.org/ns">'
		. '<o:set><d:href>' . htmlspecialchars($href, ENT_XML1) . '</d:href><o:read-write/></o:set></o:share>';
	$request = new DavRequest('POST', '/qa-calendar', ['Content-Type' => $contentType], $body);
	try {
		$plugin->httpPost($request, new DavResponse());
	} catch (Forbidden $e) {
		return 'refused: ' . $e->getMessage();
	}
	return $request->getBodyAsString() === $body ? 'passed' : 'passed, but the body was lost';
}
expect('dav plugin: share with qa-t6-3 refused (403)', davShare($plugin, 'principal:principals/users/qa-t6-3') === 'refused: ' . $person);
expect('dav plugin: share with org B group refused', davShare($plugin, 'principal:principals/groups/org%3Aqa-t6-org-b') === 'refused: ' . $group);
expect('dav plugin: share with qa-t6-2 passes, body kept for the sharing plugin', davShare($plugin, 'principal:principals/users/qa-t6-2') === 'passed');
expect('dav plugin: not XML is left alone', davShare($plugin, 'principal:principals/users/qa-t6-3', 'text/plain') === 'passed');
expect('dav plugin: nothing was shared by the plugin itself', $shareable->updates === 0);

// --- The Deck middleware, as if privacy were on ------------------------------------------------
$deckController = Server::get(IAppManager::class)->isEnabledForAnyone('deck')
	? (new DIContainer('deck'))->get('OCA\\Deck\\Controller\\BoardApiController')
	: null;
/** The middleware's answer to an addAcl call: "refused 403: <message>" or "passed". */
function deckAcl(?Controller $controller, string $method, int $type, string $participant, OrgPrivacy $privacy): string {
	$request = new Request(['post' => ['type' => $type, 'participant' => $participant], 'method' => 'POST'],
		Server::get(IRequestId::class), Server::get(IConfig::class));
	$middleware = new OrgShareMiddleware($request, Server::get(IUserSession::class), $privacy, Server::get(IConfig::class), Server::get(IUserManager::class));
	try {
		$middleware->beforeController($controller, $method);
	} catch (\Exception $e) {
		$response = $middleware->afterException($controller, $method, $e);
		return 'refused ' . $response->getStatus() . ': ' . ($response->getData()['message'] ?? '');
	}
	return 'passed';
}
if ($deckController === null) {
	expect('deck is enabled (for the middleware checks)', false);
} else {
	expect('deck middleware: board share with qa-t6-3 refused (403)', deckAcl($deckController, 'addAcl', 0, 'qa-t6-3', $on) === 'refused 403: ' . $person);
	expect('deck middleware: board share with org B refused (403)', deckAcl($deckController, 'addAcl', 1, 'org:qa-t6-org-b', $on) === 'refused 403: ' . $group);
	expect('deck middleware: board share with qa-t6-2 passes', deckAcl($deckController, 'addAcl', 0, 'qa-t6-2', $on) === 'passed');
	expect('deck middleware: other actions pass', deckAcl($deckController, 'updateAcl', 0, 'qa-t6-3', $on) === 'passed');
	// Any other app's controller, even with an action of the same name.
	$otherController = new class('files_sharing', Server::get(IRequest::class)) extends Controller {
	};
	expect('deck middleware: other controllers pass', deckAcl($otherController, 'addAcl', 0, 'qa-t6-3', $on) === 'passed');
	$session->setUser($teams);
	expect('deck middleware: the service account passes', deckAcl($deckController, 'addAcl', 0, 'qa-t6-3', $on) === 'passed');
	$session->setUser($a1);
}
// Every app's controllers get the middleware from their own container: it must build there.
foreach (['deck', 'files', 'files_sharing', 'calendar', 'dav', 'user_status', 'core', 'nourax_api'] as $app) {
	try {
		$built = (new DIContainer($app))->get(OrgShareMiddleware::class) instanceof OrgShareMiddleware;
	} catch (\Throwable $e) {
		$built = false;
		echo 'INFO ' . $app . ': ' . get_class($e) . ' ' . $e->getMessage() . "\n";
	}
	expect('the middleware builds in the ' . $app . ' container', $built);
}
$session->setUser(null);

// NoBoard card comments (MentionNames): a hidden person's name becomes the id, in Deck's JSON
// and XML answers, and nothing else changes.
$visible = fn (string $uid): bool => $uid !== 'qa-t6-3';
$mention = fn (string $id, string $name, string $type = 'user'): array => ['mentionId' => $id, 'mentionType' => $type, 'mentionDisplayName' => $name];
$comments = ['ocs' => ['meta' => ['status' => 'ok', 'statuscode' => 200, 'message' => 'OK'], 'data' => [
	['id' => 1, 'message' => '@qa-t6-3 @qa-t6-2 <b>', 'actorDisplayName' => 'QA t6 1', 'extra' => new \stdClass(),
		'mentions' => [$mention('qa-t6-3', 'QA t6 3'), $mention('qa-t6-2', 'QA t6 2')],
		'replyTo' => ['id' => 0, 'mentions' => [$mention('qa-t6-3', 'QA t6 3')]]],
	['id' => 2, 'message' => 'none', 'mentions' => [$mention('qa-t6-3', 'QA t6 3', 'guest')]],
]]];
$hidden = MentionNames::hide((string)json_encode($comments, JSON_HEX_TAG), $visible);
$back = json_decode((string)$hidden, true);
expect('card comments (JSON): the hidden name becomes the id, in replies too',
	($back['ocs']['data'][0]['mentions'][0]['mentionDisplayName'] ?? '') === 'qa-t6-3'
	&& ($back['ocs']['data'][0]['replyTo']['mentions'][0]['mentionDisplayName'] ?? '') === 'qa-t6-3');
expect('card comments (JSON): a visible name and a guest mention stay',
	($back['ocs']['data'][0]['mentions'][1]['mentionDisplayName'] ?? '') === 'QA t6 2'
	&& ($back['ocs']['data'][1]['mentions'][0]['mentionDisplayName'] ?? '') === 'QA t6 3');
expect('card comments (JSON): the rest is as it was (objects stay objects, tags escaped)',
	str_contains((string)$hidden, '"extra":{}') && str_contains((string)$hidden, '<b>')
	&& ($back['ocs']['data'][0]['message'] ?? '') === '@qa-t6-3 @qa-t6-2 <b>');
expect('card comments (JSON): nothing to hide gives null (the answer is left as it is)',
	MentionNames::hide((string)json_encode($comments), fn (string $uid): bool => true) === null);
$xml = '<?xml version="1.0"?>' . "\n" . '<ocs><meta><statuscode>200</statuscode></meta><data><element><id>1</id><mentions>'
	. '<element><mentionId>qa-t6-3</mentionId><mentionType>user</mentionType><mentionDisplayName>QA t6 3</mentionDisplayName></element>'
	. '<element><mentionId>qa-t6-2</mentionId><mentionType>user</mentionType><mentionDisplayName>QA t6 2</mentionDisplayName></element>'
	. '</mentions></element></data></ocs>' . "\n";
$hiddenXml = (string)MentionNames::hide($xml, $visible);
expect('card comments (XML): the hidden name becomes the id, the visible one stays',
	str_contains($hiddenXml, '<mentionDisplayName>qa-t6-3</mentionDisplayName>') && !str_contains($hiddenXml, 'QA t6 3')
	&& str_contains($hiddenXml, '<mentionDisplayName>QA t6 2</mentionDisplayName>'));
expect('card comments: an answer that is neither JSON nor XML is left as it is', MentionNames::hide('', $visible) === null);

// The real rule follows the server's setting: while it is off, nothing is refused.
$real = new OrgPrivacy(...$args);
$setting = Server::get(IShareManager::class)->shareWithGroupMembersOnly();
expect('the real rule is on exactly when sharing is limited to group members', $real->isOn() === $setting);
if (!$setting) {
	expect('while it is off, nothing is refused', $real->checkPerson($a1, 'qa-t6-3') === null
		&& $real->checkDavHref($a1, 'principal:principals/users/qa-t6-3') === null
		&& $real->checkDeckAcl($a1, 1, 'org:qa-t6-org-b') === null);
} else {
	expect('while it is on, org B is refused', $real->checkPerson($a1, 'qa-t6-3') === $person);
}

echo $fails === 0 ? "all org privacy rule checks passed\n" : "$fails org privacy rule check(s) failed\n";
exit($fails === 0 ? 0 : 1);
