<?php

declare(strict_types=1);

/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\NouraxBranding\Middleware;

use OCA\NouraxBranding\AppInfo\Application;
use OCA\NouraxBranding\Service\UpstreamAssets;
use OCP\AppFramework\Controller;
use OCP\AppFramework\Http;
use OCP\AppFramework\Http\DataDisplayResponse;
use OCP\AppFramework\Http\FileDisplayResponse;
use OCP\AppFramework\Http\Response;
use OCP\AppFramework\Middleware;
use OCP\Color;
use OCP\IAvatar;
use OCP\IAvatarManager;
use OCP\ICacheFactory;
use OCP\IRequest;
use Psr\Log\LoggerInterface;

/**
 * Letter avatars in the site's colour instead of the upstream blue.
 *
 * A person without a picture of their own gets a letter avatar: their initials in one colour on a
 * light (or, in the dark theme, dark) tint of it. Nextcloud 35 picks the colour from the display name
 * out of 18, and one of them is the upstream blue #0082C9 itself (lib/private/Avatar/Avatar.php,
 * avatarBackgroundColor), so one name in 18 got the upstream blue. This redraws exactly those
 * avatars in Nourax cobalt #2563EB, letters and tint alike, as core's avatar addresses answer them
 * (/avatar/<user>/<size>, .../dark, and the guest avatars /avatar/guest/<name>/<size>). Every other
 * avatar, and every picture people chose themselves, goes out as core made it. The redrawn picture is
 * kept in the cache for a day.
 *
 * Global, so that it runs for core's controllers. When something goes wrong, core's answer goes out.
 */
final class AvatarColourMiddleware extends Middleware {
	private const AVATAR = 'OC\Core\Controller\AvatarController';
	private const GUEST = 'OC\Core\Controller\GuestAvatarController';
	private const COBALT = [0x25, 0x63, 0xEB];

	public function __construct(
		private IRequest $request,
		private IAvatarManager $avatarManager,
		private ICacheFactory $cacheFactory,
		private LoggerInterface $logger,
	) {
	}

	#[\Override]
	public function afterController(Controller $controller, string $methodName, Response $response): Response {
		$class = $controller::class;
		if (($class !== self::AVATAR && $class !== self::GUEST) || ($methodName !== 'getAvatar' && $methodName !== 'getAvatarDark')) {
			return $response;
		}
		try {
			return $this->recolour($response, $class === self::GUEST, $methodName === 'getAvatarDark');
		} catch (\Throwable $e) {
			$this->logger->warning('Could not redraw a letter avatar in the site colour, sending it as it is', [
				'app' => Application::APP_ID,
				'exception' => $e,
			]);
			return $response;
		}
	}

	private function recolour(Response $response, bool $guest, bool $dark): Response {
		if (!($response instanceof FileDisplayResponse)
			|| !in_array($response->getStatus(), [Http::STATUS_OK, Http::STATUS_CREATED], true)) {
			return $response;
		}
		$headers = $response->getHeaders();
		if ((string)($headers['X-NC-IsCustomAvatar'] ?? '1') !== '0') {
			return $response;
		}
		$avatar = $this->avatar($guest);
		if ($avatar === null || $avatar->isCustomAvatar() || !method_exists($avatar, 'getDisplayName')) {
			return $response;
		}
		$fg = $avatar->avatarBackgroundColor((string)$avatar->getDisplayName());
		if (!UpstreamAssets::isUpstreamBlue($fg->red(), $fg->green(), $fg->blue())) {
			return $response;
		}
		$dark = $dark || ($guest && filter_var($this->request->getParam('darkTheme', false), FILTER_VALIDATE_BOOLEAN));
		$size = (int)$this->request->getParam('size', 64) <= 64 ? 64 : 512;
		$png = $avatar->getFile($size, $dark)->getContent();

		$cache = $this->cacheFactory->createDistributed(Application::APP_ID . '-avatar');
		$key = sha1($png);
		$cached = $cache->get($key);
		$out = is_string($cached) ? base64_decode($cached, true) : false;
		if (!is_string($out) || $out === '') {
			// The tint as core makes it (Avatar::generateAvatar): the colour at 10% over white or black.
			$base = $dark ? new Color(0, 0, 0) : new Color(255, 255, 255);
			$bg = $fg->alphaBlending(0.1, $base);
			$to = new Color(...self::COBALT);
			$toBg = $to->alphaBlending(0.1, $base);
			$out = UpstreamAssets::recolourAvatar($png,
				[$fg->red(), $fg->green(), $fg->blue()], [$bg->red(), $bg->green(), $bg->blue()],
				self::COBALT, [$toBg->red(), $toBg->green(), $toBg->blue()]);
			if ($out === null) {
				return $response;
			}
			$cache->set($key, base64_encode($out), 86400);
		}

		$redrawn = new DataDisplayResponse($out, $response->getStatus(), [
			'Content-Type' => 'image/png',
			'X-NC-IsCustomAvatar' => '0',
		]);
		// Cached by browsers like core's answer (a day for people, 30 minutes for guests).
		$redrawn->cacheFor($guest ? 1800 : 86400, false, true);
		$redrawn->setETag(sha1($out));
		return $redrawn;
	}

	private function avatar(bool $guest): ?IAvatar {
		if ($guest) {
			return $this->avatarManager->getGuestAvatar((string)$this->request->getParam('guestName'));
		}
		$uid = (string)$this->request->getParam('userId');
		try {
			return $this->avatarManager->getAvatar($uid);
		} catch (\Throwable $e) {
			// Not an account: core answered with the guest avatar of that name (guestFallback).
			return filter_var($this->request->getParam('guestFallback', false), FILTER_VALIDATE_BOOLEAN)
				? $this->avatarManager->getGuestAvatar($uid)
				: null;
		}
	}
}
