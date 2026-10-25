<?php

declare(strict_types=1);

/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\NouraxBranding\Service;

use OCA\NouraxBranding\AppInfo\Application;
use OCP\IAppConfig;
use Psr\Log\LoggerInterface;

/**
 * Where the NoMail entry of the app menu goes. It is https://mail.nourax.org/ unless the app setting
 * nomail_url holds another https address (set from NOMAIL_URL in .env by scripts/configure.d/20-branding.sh).
 */
class NomailLink {
	public const DEFAULT_URL = 'https://mail.nourax.org/';

	public function __construct(
		private IAppConfig $appConfig,
		private LoggerInterface $logger,
	) {
	}

	public function url(): string {
		try {
			$url = trim($this->appConfig->getValueString(Application::APP_ID, 'nomail_url', ''));
		} catch (\Throwable $e) {
			// For example a value stored with another type: the menu entry must still work.
			$this->logger->warning('nomail_url could not be read, using ' . self::DEFAULT_URL, [
				'app' => Application::APP_ID,
				'exception' => $e,
			]);
			return self::DEFAULT_URL;
		}
		if ($url === '') {
			return self::DEFAULT_URL;
		}
		$parts = parse_url($url);
		if (!is_array($parts) || ($parts['scheme'] ?? '') !== 'https' || ($parts['host'] ?? '') === ''
			|| isset($parts['user']) || isset($parts['pass'])) {
			$this->logger->warning('nomail_url is not a plain https address, using ' . self::DEFAULT_URL, [
				'app' => Application::APP_ID,
			]);
			return self::DEFAULT_URL;
		}
		return $url;
	}
}
