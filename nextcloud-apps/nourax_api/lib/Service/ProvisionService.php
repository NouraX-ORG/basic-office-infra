<?php

declare(strict_types=1);

/**
 * POST /v1/provision (NoMail's handoff, section 2b): make sure a person has a Drive account and,
 * for NoMail, give it one fresh app password named "NoMail".
 *
 * 1. The account is a "Log in with Nourax" account (user_oidc, provider Nourax) whose uid is the
 *    Supabase user id, made the same way user_oidc's own API does it (OcsApiController::createUser),
 *    so a later sign-in lands in the same account.
 * 2. An existing account that is not a user_oidc account (409 uid_not_oidc) or that is disabled
 *    (409 account_disabled) is never changed. 409, because NoMail reads 401/403/404/429/5xx as
 *    "the API is down" and would never stop asking.
 * 3. The display name and email follow NoMail when they change; the uid never does.
 * 4. /NoMail, /NoMail/Sent, /NoMail/Received and /NoMail/Images exist afterwards.
 * 5. Older app passwords named "NoMail" are revoked, then a new one is made the way core's
 *    `occ user:auth-tokens:add` does (72 letters and digits, permanent, no login password).
 *
 * One run per account at a time: a Redis lock per uid (60 s). A second call meanwhile gets
 * 409 busy, which NoMail retries. The app password is returned once and never logged.
 *
 * The admin API's people calls use the parts on their own: ensureAccount() (the account and
 * folders, under the same lock) and updateProfile() (display name and email).
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\NouraxApi\Service;

use OC\Authentication\Events\AppPasswordCreatedEvent;
use OC\Authentication\Token\IProvider as TokenGenerator;
use OCA\NouraxApi\Settings;
use OCA\UserOIDC\Db\ProviderMapper;
use OCA\UserOIDC\Db\UserMapper;
use OCA\UserOIDC\Service\LocalIdService;
use OCP\App\IAppManager;
use OCP\AppFramework\Db\IMapperException;
use OCP\Authentication\Token\IProvider as TokenProvider;
use OCP\Authentication\Token\IToken;
use OCP\EventDispatcher\IEventDispatcher;
use OCP\Files\Folder;
use OCP\Files\IRootFolder;
use OCP\Files\NotPermittedException;
use OCP\ICacheFactory;
use OCP\IMemcache;
use OCP\IUser;
use OCP\IUserManager;
use OCP\Mail\IMailer;
use OCP\Security\ISecureRandom;
use OCP\User\Events\UserChangedEvent;
use Psr\Container\ContainerInterface;

class ProvisionService {
	public const APP_PASSWORD_NAME = 'NoMail';
	public const APP_PASSWORD_LENGTH = 72;
	/** Made in this order, so each parent exists before its children. */
	public const FOLDERS = ['NoMail', 'NoMail/Sent', 'NoMail/Received', 'NoMail/Images'];
	/** Seconds a provision run may hold its account's lock. */
	public const LOCK_TTL = 60;

	private const OIDC_APP = 'user_oidc';
	/** user_oidc's backend name, as `occ user:info` shows it. */
	private const OIDC_BACKEND = 'user_oidc';

	private ?IMemcache $locks = null;

	public function __construct(
		private IAppManager $appManager,
		private ContainerInterface $container,
		private IUserManager $userManager,
		private IRootFolder $rootFolder,
		private TokenProvider $tokens,
		private TokenGenerator $tokenGenerator,
		private ISecureRandom $random,
		private IEventDispatcher $dispatcher,
		private IMailer $mailer,
		private Settings $settings,
		ICacheFactory $cacheFactory,
	) {
		if ($cacheFactory->isAvailable()) {
			$cache = $cacheFactory->createDistributed('nourax_api');
			$this->locks = $cache instanceof IMemcache ? $cache : null;
		}
	}

	/**
	 * @return array{uid: string, login: string, app_password?: string, created: bool}
	 * @throws ApiException for the refusals the caller should see
	 */
	public function provision(ProvisionRequest $request, bool $issuePassword = true): array {
		if ($request->email !== '' && !$this->mailer->validateMailAddress($request->email)) {
			throw new ApiException('invalid_request', 400);
		}

		$lock = 'provision-lock/' . $request->userId;
		if ($this->locks !== null && !$this->locks->add($lock, 1, self::LOCK_TTL)) {
			throw new ApiException('busy', 409);
		}
		try {
			[$user, $created] = $this->account($request->userId);
			$this->updateProfile($user, $request->displayName, $request->email);
			$this->ensureFolders($user->getUID());
			$answer = ['uid' => $user->getUID(), 'login' => $user->getUID(), 'created' => $created];
			if ($issuePassword) {
				$answer['app_password'] = $this->newAppPassword($user->getUID());
			}
			return $answer;
		} finally {
			$this->locks?->remove($lock);
		}
	}

	/**
	 * For the admin API: the account and its /NoMail folders, without a profile change and
	 * without an app password. The same refusals and the same per-account lock as provision().
	 *
	 * @return array{0: IUser, 1: bool} the account and whether it was made now
	 * @throws ApiException 409 busy | uid_not_oidc | account_disabled | folder_conflict, 503
	 */
	public function ensureAccount(string $uid): array {
		$lock = 'provision-lock/' . $uid;
		if ($this->locks !== null && !$this->locks->add($lock, 1, self::LOCK_TTL)) {
			throw new ApiException('busy', 409);
		}
		try {
			$account = $this->account($uid);
			$this->ensureFolders($uid);
			return $account;
		} finally {
			$this->locks?->remove($lock);
		}
	}

	/**
	 * Display name and email follow NoMail ("" leaves a value as it is); the uid never changes.
	 *
	 * @return list<string> what changed: "display_name", "email"
	 * @throws ApiException 400 invalid_request for an email that is no address
	 */
	public function updateProfile(IUser $user, string $displayName, string $email): array {
		if ($email !== '' && !$this->mailer->validateMailAddress($email)) {
			throw new ApiException('invalid_request', 400);
		}
		$this->providerId();
		/** @var UserMapper $oidcUsers */
		$oidcUsers = $this->container->get(UserMapper::class);
		$changed = [];
		if ($this->updateDisplayName($oidcUsers, $user, $displayName)) {
			$changed[] = 'display_name';
		}
		if ($email !== '' && $user->getSystemEMailAddress() !== mb_strtolower($email)) {
			$user->setSystemEMailAddress($email);
			$changed[] = 'email';
		}
		return $changed;
	}

	/** @return array{0: IUser, 1: bool} the account and whether it was made now */
	private function account(string $uid): array {
		$providerId = $this->providerId();
		/** @var UserMapper $oidcUsers */
		$oidcUsers = $this->container->get(UserMapper::class);

		$user = $this->userManager->get($uid);
		$created = false;
		if ($user !== null) {
			if ($user->getBackendClassName() !== self::OIDC_BACKEND) {
				throw new ApiException('uid_not_oidc', 409);
			}
			if (!$user->isEnabled()) {
				throw new ApiException('account_disabled', 409);
			}
		} else {
			// The provider must map uid = sub as it is (no hashing, no prefix), or a later sign-in
			// would land in a different account than the one made here.
			/** @var LocalIdService $ids */
			$ids = $this->container->get(LocalIdService::class);
			if ($ids->getId($providerId, $uid) !== $uid) {
				throw new ApiException('oidc_uid_mapping', 503);
			}
			$oidcUsers->getOrCreate($providerId, $uid);
			$user = $this->userManager->get($uid);
			if ($user === null || $user->getUID() !== $uid) {
				throw new \RuntimeException('the account just made could not be loaded');
			}
			$created = true;
		}

		if ($created) {
			// The Nourax welcome files (skeletondirectory), as user_oidc's createUser does.
			try {
				\OC_Util::copySkeleton($uid, $this->rootFolder->getUserFolder($uid));
			} catch (NotPermittedException) {
				// a read-only home: the folders below report it
			}
		}
		return [$user, $created];
	}

	/** The user_oidc provider id of "Log in with Nourax" (setting oidc_provider). 503 when missing. */
	private function providerId(): int {
		if (!$this->appManager->isEnabledForAnyone(self::OIDC_APP)) {
			throw new ApiException('oidc_unavailable', 503);
		}
		$this->appManager->loadApp(self::OIDC_APP);
		try {
			/** @var ProviderMapper $providers */
			$providers = $this->container->get(ProviderMapper::class);
			return $providers->findProviderByIdentifier($this->settings->oidcProvider())->getId();
		} catch (IMapperException) {
			throw new ApiException('oidc_provider_missing', 503);
		}
	}

	/**
	 * user_oidc's backend cannot set display names itself, so like user_oidc's own provisioning the
	 * name is written to its table and a UserChangedEvent updates the account (search, sharing).
	 *
	 * @return bool whether the name changed
	 */
	private function updateDisplayName(UserMapper $oidcUsers, IUser $user, string $displayName): bool {
		if ($displayName === '') {
			return false;
		}
		$backendUser = $oidcUsers->getUser($user->getUID());
		$old = (string)$backendUser->getDisplayName();
		if ($displayName !== $old) {
			$backendUser->setDisplayName($displayName);
			$oidcUsers->update($backendUser);
		}
		if ($displayName !== $old || $displayName !== $user->getDisplayName()) {
			$this->dispatcher->dispatchTyped(new UserChangedEvent($user, 'displayName', $displayName, $old));
			return true;
		}
		return false;
	}

	private function ensureFolders(string $uid): void {
		$home = $this->rootFolder->getUserFolder($uid);
		foreach (self::FOLDERS as $path) {
			if (!$home->nodeExists($path)) {
				$home->newFolder($path);
			} elseif (!($home->get($path) instanceof Folder)) {
				// a file sits where a NoMail folder belongs; it is left alone
				throw new ApiException('folder_conflict', 409);
			}
		}
	}

	/** Revokes older "NoMail" app passwords, then makes and returns a new one. */
	private function newAppPassword(string $uid): string {
		$this->tokens->invalidateTokensOfUser($uid, self::APP_PASSWORD_NAME);

		$password = $this->random->generate(self::APP_PASSWORD_LENGTH,
			ISecureRandom::CHAR_UPPER . ISecureRandom::CHAR_LOWER . ISecureRandom::CHAR_DIGITS);
		$token = $this->createToken($uid, $password);
		$this->dispatcher->dispatchTyped(new AppPasswordCreatedEvent($token));
		return $password;
	}

	/** As `occ user:auth-tokens:add`: login name = uid, no login password, permanent. */
	private function createToken(string $uid, #[\SensitiveParameter] string $password): IToken {
		return $this->tokenGenerator->generateToken(
			$password,
			$uid,
			$uid,
			null,
			self::APP_PASSWORD_NAME,
			IToken::PERMANENT_TOKEN,
			IToken::DO_NOT_REMEMBER,
		);
	}
}
