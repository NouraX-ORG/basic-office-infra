<?php

declare(strict_types=1);

/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\NouraxBranding\Dav;

use OCA\NouraxBranding\AppInfo\Application;
use OCP\IURLGenerator;
use OCP\L10N\IFactory;
use Sabre\DAV\Server;
use Sabre\DAV\ServerPlugin;
use Sabre\HTTP\RequestInterface;
use Sabre\HTTP\ResponseInterface;

/**
 * The text people see when they open the WebDAV address (/remote.php/dav, /remote.php/webdav, a
 * folder below them) in a web browser.
 *
 * Nextcloud 35 answers such a GET with DummyGetResponsePlugin (priority 200), whose fixed English
 * text names the upstream desktop client. This plugin answers just before it, at 199: after
 * everything that serves real content on a GET (the files themselves and zip downloads in Sabre's
 * CorePlugin and ZipFolderPlugin at 100, contact photos, calendar exports and view-only checks at
 * 90). So it only answers what the upstream text would have answered: folders and other
 * collections. Added through the dav app's SabrePluginAddEvent (Listener\SabrePluginListener).
 */
final class BrandedGetPlugin extends ServerPlugin {
	public const PRIORITY = 199;

	public function __construct(
		private IFactory $l10nFactory,
		private IURLGenerator $urlGenerator,
	) {
	}

	#[\Override]
	public function initialize(Server $server): void {
		$server->on('method:GET', [$this, 'httpGet'], self::PRIORITY);
	}

	#[\Override]
	public function getPluginName(): string {
		return 'nourax-branded-get';
	}

	/**
	 * A small HTML page in the person's language, with its language and direction set, so Arabic
	 * reads right to left (as plain text it ran left to right; found by the browser audit).
	 *
	 * @return false, so that no later handler answers too
	 */
	public function httpGet(RequestInterface $request, ResponseInterface $response): bool {
		$l = $this->l10nFactory->get(Application::APP_ID);
		$code = $l->getLanguageCode();
		$url = $this->urlGenerator->getAbsoluteURL('/');
		$h = static fn (string $s): string => htmlspecialchars($s, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
		$intro = $l->t('This is the WebDAV address of NoDrive. Open it in a WebDAV client, such as a file manager or a sync app, not in a web browser.');
		$go = $h($l->t('To see your files in a web browser, go to %s', [$url]));
		$go = str_replace($h($url), '<a href="' . $h($url) . '">' . $h($url) . '</a>', $go);
		$html = "<!DOCTYPE html>\n"
			. '<html lang="' . $h(str_replace('_', '-', $code)) . '" dir="' . $h($this->l10nFactory->getLanguageDirection($code)) . "\">\n"
			. "<head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><title>NoDrive</title></head>\n"
			. '<body><p>' . $h($intro) . '</p><p>' . $go . "</p></body>\n</html>\n";
		$response->setStatus(200);
		$response->setHeader('Content-Type', 'text/html; charset=utf-8');
		$response->setBody($html);
		return false;
	}
}
