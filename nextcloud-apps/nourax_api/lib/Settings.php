<?php

declare(strict_types=1);

/**
 * The app's settings (occ config:app:set nourax_api <key> --value=...; no --type needed).
 * The two keys are only set by `occ nourax_api:secret`, from the server's secret files.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\NouraxApi;

use OCA\NouraxApi\AppInfo\Application;
use OCP\IAppConfig;

class Settings {
	/** SHA-256 (hex) of NODRIVE_API_KEY; the key itself is never stored. Sensitive, lazy. */
	public const API_KEY_HASH = 'api_key_sha256';
	/** The admin API's HMAC key (it must be readable to check signatures). Sensitive, lazy. */
	public const ADMIN_KEY = 'admin_key';

	public const CLAMAV_HOST = 'clamav_host';
	public const CLAMAV_PORT = 'clamav_port';
	/** The user_oidc provider that "Log in with Nourax" uses; accounts are created for it. */
	public const OIDC_PROVIDER = 'oidc_provider';
	/** "yes" switches on the daily deletion of people who left 30+ days ago. Off until the owner says yes. */
	public const LEAVER_DELETION = 'leaver_deletion_enabled';
	/** The service account's app password for calls back into this server (Deck). Sensitive, lazy. */
	public const LOOPBACK_PASSWORD = 'loopback_app_password';
	/** How this server reaches itself from inside the compose network (the app service). */
	public const LOOPBACK_URL = 'loopback_url';

	/** Calls per minute for each bucket, over all callers together (rate_limit_<bucket>). */
	public const RATE_LIMITS = [
		'health' => 120,
		'provision' => 60,
		'scan' => 60,
		'admin' => 120,
	];
	/** Scans that may run at the same time. */
	public const SCAN_CONCURRENCY = 'scan_concurrency';

	public function __construct(
		private IAppConfig $appConfig,
	) {
	}

	public function clamavHost(): string {
		return $this->appConfig->getValueString(Application::APP_ID, self::CLAMAV_HOST, 'clamav');
	}

	public function clamavPort(): int {
		return $this->appConfig->getValueInt(Application::APP_ID, self::CLAMAV_PORT, 3310);
	}

	public function oidcProvider(): string {
		return $this->appConfig->getValueString(Application::APP_ID, self::OIDC_PROVIDER, 'Nourax');
	}

	public function leaverDeletionEnabled(): bool {
		return $this->appConfig->getValueString(Application::APP_ID, self::LEAVER_DELETION, 'no') === 'yes';
	}

	/** Calls per minute for a bucket; 0 or less means no limit. */
	public function rateLimit(string $bucket): int {
		$default = self::RATE_LIMITS[$bucket] ?? 60;
		return $this->appConfig->getValueInt(Application::APP_ID, 'rate_limit_' . $bucket, $default);
	}

	public function scanConcurrency(): int {
		return max(1, $this->appConfig->getValueInt(Application::APP_ID, self::SCAN_CONCURRENCY, 2));
	}

	public function apiKeyHash(): string {
		return $this->appConfig->getValueString(Application::APP_ID, self::API_KEY_HASH, '', true);
	}

	public function setApiKeyHash(string $hash): void {
		$this->appConfig->setValueString(Application::APP_ID, self::API_KEY_HASH, $hash, true, true);
	}

	public function adminKey(): string {
		return $this->appConfig->getValueString(Application::APP_ID, self::ADMIN_KEY, '', true);
	}

	public function setAdminKey(#[\SensitiveParameter] string $key): void {
		$this->appConfig->setValueString(Application::APP_ID, self::ADMIN_KEY, $key, true, true);
	}

	/**
	 * The admin API's keys by key id (header X-Nourax-Key-Id). Today there is one, "admin-1";
	 * the id is in every request so a second key can be added later and the first one retired.
	 *
	 * @return array<string, string>
	 */
	public function adminKeys(): array {
		$key = $this->adminKey();
		return $key === '' ? [] : ['admin-1' => $key];
	}

	public function loopbackPassword(): string {
		return $this->appConfig->getValueString(Application::APP_ID, self::LOOPBACK_PASSWORD, '', true);
	}

	public function setLoopbackPassword(#[\SensitiveParameter] string $password): void {
		$this->appConfig->setValueString(Application::APP_ID, self::LOOPBACK_PASSWORD, $password, true, true);
	}

	/** Without a trailing slash, e.g. http://app */
	public function loopbackUrl(): string {
		return rtrim($this->appConfig->getValueString(Application::APP_ID, self::LOOPBACK_URL, 'http://app'), '/');
	}
}
