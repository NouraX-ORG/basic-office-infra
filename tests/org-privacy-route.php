<?php

declare(strict_types=1);

/**
 * The guards in front of the privacy switch's route (PrivacySettingsController), inside the app
 * container as www-data, without an admin account and without switching anything:
 *   sudo docker compose exec -T -u www-data app php < tests/org-privacy-route.php
 * tests/org-privacy-switch.sh runs it. (Started as root, it first becomes the owner of config.php.)
 *
 * It runs the server's own security check (the installed SecurityMiddleware, the one that runs
 * before every app controller) on real requests, then the controller itself:
 * - "an admin": the check's cached answer to "is this an admin?" is set to yes on this one
 *   check object, so no account is added to the admin group and nobody becomes an admin;
 * - the controller gets a stand-in switch that only notes each call. Its lock refuses, so even
 *   the real switching code could not run behind it.
 * Checks:
 * - the address: the server's router sends GET and POST /apps/nourax_api/settings/org-privacy to
 *   the controller's status and setState, the page's link is that address, and the old address
 *   /apps/nourax_api/admin/org-privacy (main 726a196 and older) matches no route;
 * - the route's method has no NoAdminRequired, NoCSRFRequired, PublicPage, SubAdminRequired or
 *   AuthorizedAdminSetting, has PasswordConfirmationRequired, and the controller is no
 *   OCSController;
 * - a normal person with the page's token: 403 (the admin check comes first);
 * - an admin's browser request without the token: 412 from the server's CSRF check;
 * - an admin's request without the token but with "OCS-APIRequest: true" (or any value): the
 *   server's CSRF check lets it through (Request::passesCSRFCheck), and the controller answers
 *   412 csrf_check_failed, for the POST and the GET, without calling the switch;
 * - an admin's request with the page's token: through, and the POST reaches the switch once,
 *   with the state and the audit details (key id admin-page, method POST, route
 *   settings/org-privacy, the client address);
 * - nothing changed: every setting, the apps, the stored step and the audit rows.
 * (The password confirmation is another check of the server's, after this one; a live admin
 * session is needed for it, see tests/org-privacy-page.sh admin.)
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace NouraxTests;

use OC\AppFramework\Http\Request;
use OC\AppFramework\Middleware\Security\Exceptions\CrossSiteRequestForgeryException;
use OC\AppFramework\Middleware\Security\Exceptions\NotAdminException;
use OC\AppFramework\Middleware\Security\SecurityMiddleware;
use OC\AppFramework\Utility\ControllerMethodReflector;
use OC\Route\Router;
use OC\Security\CSRF\CsrfTokenManager;
use OC\Settings\AuthorizedGroupMapper;
use OCA\NouraxApi\Controller\PrivacySettingsController;
use OCA\NouraxApi\Service\AuditLog;
use OCA\NouraxApi\Service\ObjectLock;
use OCA\NouraxApi\Service\OrgPrivacy;
use OCA\NouraxApi\Service\OrgPrivacySwitch;
use OCP\App\IAppManager;
use OCP\AppFramework\Http\Attribute\AuthorizedAdminSetting;
use OCP\AppFramework\Http\Attribute\NoAdminRequired;
use OCP\AppFramework\Http\Attribute\NoCSRFRequired;
use OCP\AppFramework\Http\Attribute\PasswordConfirmationRequired;
use OCP\AppFramework\Http\Attribute\PublicPage;
use OCP\AppFramework\Http\Attribute\SubAdminRequired;
use OCP\AppFramework\OCSController;
use OCP\DB\QueryBuilder\IQueryBuilder;
use OCP\Group\ISubAdmin;
use OCP\IAppConfig;
use OCP\ICacheFactory;
use OCP\IConfig;
use OCP\IDBConnection;
use OCP\IGroupManager;
use OCP\INavigationManager;
use OCP\IRequestId;
use OCP\IURLGenerator;
use OCP\IUserSession;
use OCP\L10N\IFactory;
use OCP\Security\Ip\IRemoteAddress;
use OCP\Server;
use Psr\Log\LoggerInterface;
use Symfony\Component\Routing\RequestContext;

// Piped in as root (docker compose exec without -u www-data): become the owner of config.php
// first, as occ asks, so nothing the server writes belongs to root.
if (function_exists('posix_getuid') && posix_getuid() === 0) {
	$owner = fileowner('/var/www/html/config/config.php');
	$account = $owner === false ? false : posix_getpwuid($owner);
	if ($account === false || $owner === 0 || !posix_setgid($account['gid'])
		|| !posix_initgroups($account['name'], $account['gid']) || !posix_setuid($owner)) {
		echo "FAIL could not become the owner of config.php; run it with -u www-data\n";
		exit(1);
	}
	echo 'started as root, now running as ' . $account['name'] . ", the owner of config.php\n";
	unset($owner, $account);
}
require_once '/var/www/html/lib/base.php';
Server::get(IAppManager::class)->loadApp('nourax_api');

$fails = 0;
// The server's error handler ends the script with exit status 0 on an uncaught error, so a test
// that stops half-way says so here and exits 1.
$finished = false;
register_shutdown_function(function (): void {
	global $finished;
	if (!$finished) {
		echo "FAIL the test stopped before its end (see the server log)\n";
		exit(1);
	}
});
function check(string $name, mixed $expected, mixed $actual): void {
	global $fails;
	if ($expected === $actual) {
		echo "PASS $name\n";
		return;
	}
	echo 'FAIL ' . $name . ': expected ' . json_encode($expected, JSON_UNESCAPED_SLASHES)
		. ', got ' . json_encode($actual, JSON_UNESCAPED_SLASHES) . "\n";
	$fails++;
}

/** Every value the switch writes, the apps, the stored step and the number of its audit rows. */
function snapshot(): array {
	$status = Server::get(OrgPrivacySwitch::class)->status();
	$values = ['state' => $status['state'], 'step' => $status['step']];
	foreach ($status['items'] as $item) {
		$values[$item['id']] = $item['value'];
	}
	foreach ($status['apps'] as $app => $info) {
		$values['app/' . $app] = $info['enabled'];
	}
	$qb = Server::get(IDBConnection::class)->getQueryBuilder();
	$qb->select($qb->func()->count('*', 'n'))->from('nourax_api_audit')
		->where($qb->expr()->in('route', $qb->createNamedParameter(OrgPrivacySwitch::AUDIT_ROUTES, IQueryBuilder::PARAM_STR_ARRAY)));
	$values['audit_rows'] = (int)$qb->executeQuery()->fetchOne();
	return $values;
}
$before = snapshot();
check('privacy is on before the test', 'on', Server::get(OrgPrivacySwitch::class)->status()['state']);

// A lock that never lets the switching code run, and a switch that only notes its calls.
$refusingLock = new class(Server::get(ICacheFactory::class)) extends ObjectLock {
	public function with(string $name, callable $work, int $ttl = self::TTL): mixed {
		throw new \LogicException('the route test never switches');
	}
};
$standIn = new class(Server::get(IConfig::class), Server::get(IAppConfig::class), Server::get(IAppManager::class),
	Server::get(OrgPrivacy::class), $refusingLock, Server::get(AuditLog::class)) extends OrgPrivacySwitch {
	public array $calls = [];
	public function apply(string $state, bool $dryRun, array $actor): array {
		$this->calls[] = ['state' => $state, 'dry_run' => $dryRun, 'key_id' => $actor['key_id'],
			'method' => $actor['method'], 'route' => $actor['route'] ?? null, 'ip' => $actor['ip']];
		return ['result' => 'stand_in', 'changed' => [], 'dry_run' => $dryRun];
	}
};

// --- The address ---------------------------------------------------------------------------------
// The router reads appinfo/routes.php here (this process has its own, empty route cache).
check('the page\'s link to the switch is /apps/nourax_api/settings/org-privacy', true,
	str_ends_with(Server::get(IURLGenerator::class)->linkToRoute('nourax_api.privacy_settings.setState'), '/apps/nourax_api/settings/org-privacy'));
$router = Server::get(Router::class);
/** The route the server's router picks for a method and path, or the exception's name. */
function routeOf(Router $router, string $method, string $path): string {
	$router->setContext(new RequestContext('', $method));
	try {
		return (string)($router->findMatchingRoute($path)['_route'] ?? 'none');
	} catch (\Exception $e) {
		return (new \ReflectionClass($e))->getShortName();
	}
}
check('GET /apps/nourax_api/settings/org-privacy -> privacy_settings.status', 'nourax_api.privacy_settings.status',
	routeOf($router, 'GET', '/apps/nourax_api/settings/org-privacy'));
check('POST /apps/nourax_api/settings/org-privacy -> privacy_settings.setState', 'nourax_api.privacy_settings.setState',
	routeOf($router, 'POST', '/apps/nourax_api/settings/org-privacy'));
check('the old address /apps/nourax_api/admin/org-privacy matches no route (GET, POST)',
	'ResourceNotFoundException ResourceNotFoundException',
	routeOf($router, 'GET', '/apps/nourax_api/admin/org-privacy') . ' ' . routeOf($router, 'POST', '/apps/nourax_api/admin/org-privacy'));
$router->setContext(new RequestContext('', 'GET'));

// --- The route's attributes ----------------------------------------------------------------------
$probe = new PrivacySettingsController(Server::get(\OCP\IRequest::class), $standIn,
	Server::get(IUserSession::class), Server::get(LoggerInterface::class));
$reflector = new ControllerMethodReflector(Server::get(LoggerInterface::class));
$reflector->reflect($probe, 'setState');
$has = fn (string $name, string $class) => $reflector->hasAnnotationOrAttribute($name, $class) ? 'yes' : 'no';
check('setState: admins only, CSRF checked, not public, not delegable; password confirmation',
	'NoAdminRequired no, NoCSRFRequired no, PublicPage no, SubAdminRequired no, AuthorizedAdminSetting no, PasswordConfirmationRequired yes',
	'NoAdminRequired ' . $has('NoAdminRequired', NoAdminRequired::class)
	. ', NoCSRFRequired ' . $has('NoCSRFRequired', NoCSRFRequired::class)
	. ', PublicPage ' . $has('PublicPage', PublicPage::class)
	. ', SubAdminRequired ' . $has('SubAdminRequired', SubAdminRequired::class)
	. ', AuthorizedAdminSetting ' . $has('AuthorizedAdminSetting', AuthorizedAdminSetting::class)
	. ', PasswordConfirmationRequired ' . $has('PasswordConfirmationRequired', PasswordConfirmationRequired::class));
$reflector->reflect($probe, 'status');
check('status: admins only, CSRF checked, not public', 'no no no',
	$has('NoAdminRequired', NoAdminRequired::class) . ' ' . $has('NoCSRFRequired', NoCSRFRequired::class) . ' ' . $has('PublicPage', PublicPage::class));
check('the controller is no OCSController (the server excuses only those from the token)', false, $probe instanceof OCSController);

// --- Requests ------------------------------------------------------------------------------------
$csrf = Server::get(CsrfTokenManager::class);
/**
 * A request to the route as the browser (or a script) sends it: the session cookie and the
 * same-site cookies of a signed-in browser, the given headers, and the page's token if asked.
 */
function request(string $method, array $headers, bool $withToken): Request {
	$server = [
		'REQUEST_METHOD' => $method,
		'REQUEST_URI' => '/apps/nourax_api/settings/org-privacy',
		'REMOTE_ADDR' => '203.0.113.7',
		'HTTP_ACCEPT' => 'application/json',
	];
	foreach ($headers as $name => $value) {
		$server['HTTP_' . strtoupper(str_replace('-', '_', $name))] = $value;
	}
	if ($withToken) {
		$server['HTTP_REQUESTTOKEN'] = Server::get(CsrfTokenManager::class)->getToken()->getEncryptedValue();
	}
	$cookies = [session_name() => 'test-session'];
	foreach (['nc_sameSiteCookiestrict', 'nc_sameSiteCookielax'] as $cookie) {
		$cookies[$cookie] = 'true';
		$cookies['__Host-' . $cookie] = 'true';
	}
	return new Request(['server' => $server, 'cookies' => $cookies, 'method' => $method],
		Server::get(IRequestId::class), Server::get(IConfig::class), Server::get(CsrfTokenManager::class), 'php://memory');
}
/** The server's security check for one request; $admin is its answer to "is this an admin?". */
function guard(Request $request, bool $admin): SecurityMiddleware {
	$middleware = new SecurityMiddleware($request, new ControllerMethodReflector(Server::get(LoggerInterface::class)), Server::get(INavigationManager::class),
		Server::get(IURLGenerator::class), Server::get(LoggerInterface::class), 'nourax_api', true,
		Server::get(IGroupManager::class), Server::get(ISubAdmin::class), Server::get(IAppManager::class),
		Server::get(IFactory::class)->get('nourax_api'), Server::get(AuthorizedGroupMapper::class),
		Server::get(IUserSession::class), Server::get(IRemoteAddress::class));
	(new \ReflectionProperty(SecurityMiddleware::class, 'isAdminUser'))->setValue($middleware, $admin);
	return $middleware;
}
/**
 * One request through the security check and then the controller method, as the server runs
 * them. Returns "<status> <error or result>", and "<status> <exception>" when the check refuses.
 */
function run(string $method, string $action, array $headers, bool $withToken, bool $admin, OrgPrivacySwitch $switch): string {
	$request = request($method, $headers, $withToken);
	$controller = new PrivacySettingsController($request, $switch, Server::get(IUserSession::class), Server::get(LoggerInterface::class));
	$middleware = guard($request, $admin);
	$reflector = new \ReflectionProperty(SecurityMiddleware::class, 'reflector');
	$reflector->getValue($middleware)->reflect($controller, $action);
	try {
		$middleware->beforeController($controller, $action);
	} catch (\Exception $e) {
		return $e->getCode() . ' ' . (new \ReflectionClass($e))->getShortName();
	}
	$response = $action === 'setState' ? $controller->setState('off') : $controller->status();
	$data = $response->getData();
	return $response->getStatus() . ' ' . ($data['error'] ?? $data['result'] ?? 'view');
}

// --- A normal person, and an admin ------------------------------------------------------------
check('a normal person, POST off with the page token -> 403 from the admin check',
	'403 ' . (new \ReflectionClass(NotAdminException::class))->getShortName(),
	run('POST', 'setState', ['Content-Type' => 'application/json'], true, false, $standIn));
check('an admin, POST off without the token (browser) -> 412 from the CSRF check',
	'412 ' . (new \ReflectionClass(CrossSiteRequestForgeryException::class))->getShortName(),
	run('POST', 'setState', ['Content-Type' => 'application/json'], false, true, $standIn));
check('an admin, POST off without the token, with OCS-APIRequest: true -> 412 csrf_check_failed',
	'412 csrf_check_failed', run('POST', 'setState', ['Content-Type' => 'application/json', 'OCS-APIRequest' => 'true'], false, true, $standIn));
check('an admin, POST off without the token, with OCS-APIRequest: 1 -> 412 csrf_check_failed',
	'412 csrf_check_failed', run('POST', 'setState', ['Content-Type' => 'application/json', 'OCS-APIRequest' => '1'], false, true, $standIn));
check('an admin, POST off with the token and OCS-APIRequest: true -> 412 csrf_check_failed',
	'412 csrf_check_failed', run('POST', 'setState', ['Content-Type' => 'application/json', 'OCS-APIRequest' => 'true'], true, true, $standIn));
check('an admin, GET without the token, with OCS-APIRequest: true -> 412 csrf_check_failed',
	'412 csrf_check_failed', run('GET', 'status', ['OCS-APIRequest' => 'true'], false, true, $standIn));
check('none of the refused requests reached the switch', [], $standIn->calls);
check('an admin, GET with the token -> 200, the view', '200 view', run('GET', 'status', [], true, true, $standIn));
check('an admin, POST off with the token -> through to the switch', '200 stand_in',
	run('POST', 'setState', ['Content-Type' => 'application/json'], true, true, $standIn));
check('the switch got one call: off, not a dry run, key admin-page, POST, route settings/org-privacy, the client address',
	[['state' => 'off', 'dry_run' => false, 'key_id' => 'admin-page', 'method' => 'POST', 'route' => 'settings/org-privacy',
		'ip' => '203.0.113.7']], $standIn->calls);

check('nothing changed: settings, apps, step, audit rows', $before, snapshot());
check('privacy is on after the test', 'on', Server::get(OrgPrivacySwitch::class)->status()['state']);

$finished = true;
if ($fails > 0) {
	echo "$fails check(s) failed\n";
	exit(1);
}
echo "all org-privacy-route checks passed\n";
