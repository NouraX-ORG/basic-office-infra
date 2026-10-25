<?php

declare(strict_types=1);

/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\NouraxBranding\Middleware;

use OCA\NouraxBranding\AppInfo\Application;
use OCA\NouraxBranding\Service\UpstreamAssets;
use OCP\AppFramework\Controller;
use OCP\AppFramework\Middleware;
use OCP\L10N\IFactory;
use Psr\Log\LoggerInterface;

/**
 * Signed-out pages in a right-to-left language (Arabic, Persian, Hebrew, ...) run right to left:
 * Nextcloud 35 sets dir="rtl" only on signed-in pages, so the login page, public share pages and the
 * other guest pages ran left to right (found by the browser audit, branding/audit). It sets the same
 * dir on their <body> that signed-in pages get (Service\UpstreamAssets::pageDirection). Global, so it
 * runs for core's and every app's pages. When something goes wrong, the page goes out as it is.
 */
final class PageDirectionMiddleware extends Middleware {
	public function __construct(
		private IFactory $l10nFactory,
		private LoggerInterface $logger,
	) {
	}

	#[\Override]
	public function beforeOutput(Controller $controller, string $methodName, string $output): string {
		if (!str_contains($output, '<body')) {
			return $output;
		}
		try {
			return UpstreamAssets::pageDirection($output, fn (string $lang): string => $this->l10nFactory->getLanguageDirection($lang));
		} catch (\Throwable $e) {
			$this->logger->warning('Could not set the page direction', ['app' => Application::APP_ID, 'exception' => $e]);
			return $output;
		}
	}
}
