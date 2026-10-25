<?php

declare(strict_types=1);

/**
 * The hidden service account "nourax-teams" that owns the organisation directories, the team
 * address books, the team calendars and the team boards, so none of them belongs to a person
 * who may leave.
 *
 * - A local account, display name "Nourax Teams", quota 0 B, in no group, so nobody shares with
 *   it and it stores no files. Its login password is random and thrown away at once.
 * - One app password, "nourax-api-loopback", kept only as a sensitive app setting. The API uses
 *   it for Deck's REST API over the compose network (http://app), as Deck has no PHP API that
 *   works without a signed-in user.
 * - Deck's welcome board is switched off for it (deck firstRun = no).
 *
 * ensure() is safe to run again; `occ nourax_api:service-account` runs it, and so does every
 * admin call that needs the account.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\NouraxApi\Service;

use OC\Authentication\Token\IProvider as TokenGenerator;
use OCA\NouraxApi\Settings;
use OCP\Authentication\Exceptions\InvalidTokenException;
use OCP\Authentication\Token\IProvider as TokenProvider;
use OCP\Authentication\Token\IToken;
use OCP\Http\Client\IClientService;
use OCP\IConfig;
use OCP\IGroupManager;
use OCP\IUser;
use OCP\IUserManager;
use OCP\Security\ISecureRandom;

class ServiceAccountService {
	public const UID = 'nourax-teams';
	public const DISPLAY_NAME = 'Nourax Teams';
	public const TOKEN_NAME = 'nourax-api-loopback';
	public const QUOTA = '0 B';

	private const LOCAL_BACKEND = 'Database';
	private const PASSWORD_CHARS = ISecureRandom::CHAR_UPPER . ISecureRandom::CHAR_LOWER . ISecureRandom::CHAR_DIGITS;

	/** ensure() ran in this process, so later calls only need the stored password. */
	private bool $ensured = false;

	public function __construct(
		private IUserManager $userManager,
		private IGroupManager $groupManager,
		private IConfig $config,
		private ISecureRandom $random,
		private TokenProvider $tokens,
		private TokenGenerator $tokenGenerator,
		private IClientService $clients,
		private Settings $settings,
	) {
	}

	public static function principal(): string {
		return 'principals/users/' . self::UID;
	}

	/**
	 * Makes sure the account and its app password are in place.
	 *
	 * @return array<string, string> what was checked => created | updated | unchanged
	 */
	public function ensure(): array {
		$changes = [];
		$user = $this->userManager->get(self::UID);
		if ($user === null) {
			// Letters and digits plus one of each class, so any password policy accepts it.
			$password = $this->random->generate(64, self::PASSWORD_CHARS) . 'aZ7!';
			$user = $this->userManager->createUser(self::UID, $password);
			unset($password);
			if (!($user instanceof IUser)) {
				throw new StepFailed('the service account could not be made');
			}
			$changes['account'] = Steps::CREATED;
		} elseif ($user->getBackendClassName() !== self::LOCAL_BACKEND) {
			throw new StepFailed('the account ' . self::UID . ' exists but is not a local account');
		} else {
			$changes['account'] = Steps::UNCHANGED;
		}

		$changes['enabled'] = Steps::UNCHANGED;
		if (!$user->isEnabled()) {
			$user->setEnabled(true);
			$changes['enabled'] = Steps::UPDATED;
		}
		$changes['display_name'] = Steps::UNCHANGED;
		if ($user->getDisplayName() !== self::DISPLAY_NAME) {
			$user->setDisplayName(self::DISPLAY_NAME);
			$changes['display_name'] = Steps::UPDATED;
		}
		$changes['quota'] = Steps::UNCHANGED;
		if ($user->getQuota() !== self::QUOTA) {
			$user->setQuota(self::QUOTA);
			$changes['quota'] = Steps::UPDATED;
		}
		$changes['groups'] = Steps::UNCHANGED;
		foreach ($this->groupManager->getUserGroups($user) as $group) {
			DriftGuard::run(fn () => $group->removeUser($user));
			$changes['groups'] = Steps::UPDATED;
		}
		$changes['deck_welcome_board'] = Steps::UNCHANGED;
		if ($this->config->getUserValue(self::UID, 'deck', 'firstRun', 'yes') !== 'no') {
			$this->config->setUserValue(self::UID, 'deck', 'firstRun', 'no');
			$changes['deck_welcome_board'] = Steps::UPDATED;
		}

		$changes['app_password'] = Steps::UNCHANGED;
		if (!$this->appPasswordWorks($this->settings->loopbackPassword())) {
			$this->tokens->invalidateTokensOfUser(self::UID, self::TOKEN_NAME);
			$password = $this->random->generate(72, self::PASSWORD_CHARS);
			$this->tokenGenerator->generateToken($password, self::UID, self::UID, null, self::TOKEN_NAME,
				IToken::PERMANENT_TOKEN, IToken::DO_NOT_REMEMBER);
			$this->settings->setLoopbackPassword($password);
			unset($password);
			$changes['app_password'] = $changes['account'] === Steps::CREATED ? Steps::CREATED : Steps::UPDATED;
		}

		$this->ensured = true;
		return $changes;
	}

	/**
	 * Login and app password for Basic auth over the loopback, making them first if needed.
	 *
	 * @return array{0: string, 1: string}
	 */
	public function credentials(): array {
		if (!$this->ensured) {
			$this->ensure();
		}
		return [self::UID, $this->settings->loopbackPassword()];
	}

	public function user(): IUser {
		if (!$this->ensured) {
			$this->ensure();
		}
		$user = $this->userManager->get(self::UID);
		if ($user === null) {
			throw new StepFailed('the service account is missing');
		}
		return $user;
	}

	/**
	 * Signs in over the loopback (GET /ocs/v2.php/cloud/user) to prove the app password works
	 * from inside the compose network. Returns the HTTP status (200 when it works).
	 */
	public function checkLoopback(): int {
		[$uid, $password] = $this->credentials();
		$response = $this->clients->newClient()->get($this->settings->loopbackUrl() . '/ocs/v2.php/cloud/user?format=json', [
			'auth' => [$uid, $password],
			'headers' => ['OCS-APIRequest' => 'true', 'Accept' => 'application/json'],
			'timeout' => 15,
			'connect_timeout' => 5,
			'http_errors' => false,
			'nextcloud' => ['allow_local_address' => true],
		]);
		return $response->getStatusCode();
	}

	private function appPasswordWorks(#[\SensitiveParameter] string $password): bool {
		if ($password === '') {
			return false;
		}
		try {
			$token = $this->tokenGenerator->getToken($password);
		} catch (InvalidTokenException) {
			return false;
		}
		return $token->getUID() === self::UID && $token->getName() === self::TOKEN_NAME;
	}
}
