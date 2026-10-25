<?php

declare(strict_types=1);

/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\NouraxBranding\AppInfo;

use OCA\NouraxBranding\Listener\AppChangeListener;
use OCA\NouraxBranding\Listener\LanguageListListener;
use OCA\NouraxBranding\Listener\NavigationListener;
use OCA\NouraxBranding\Listener\PageScriptListener;
use OCA\NouraxBranding\Middleware\EmptySettingsPageMiddleware;
use OCP\App\Events\AppEnableEvent;
use OCP\App\Events\AppUpdateEvent;
use OCP\AppFramework\App;
use OCP\AppFramework\Bootstrap\IBootContext;
use OCP\AppFramework\Bootstrap\IBootstrap;
use OCP\AppFramework\Bootstrap\IRegistrationContext;
use OCP\AppFramework\Http\Events\BeforeTemplateRenderedEvent;
use OCP\Navigation\Events\LoadAdditionalEntriesEvent;

class Application extends App implements IBootstrap {
	public const APP_ID = 'nourax_branding';

	public function __construct(array $urlParams = []) {
		parent::__construct(self::APP_ID, $urlParams);
	}

	public function register(IRegistrationContext $context): void {
		// NoMail in the app menu: the entry itself, and the small script that opens it in a new tab.
		$context->registerEventListener(LoadAdditionalEntriesEvent::class, NavigationListener::class);
		$context->registerEventListener(BeforeTemplateRenderedEvent::class, PageScriptListener::class);
		// Personal settings addresses with nothing on them, such as the switched-off Privacy page, go to
		// the first Personal settings page. Global, so that it runs for the settings app's controller.
		$context->registerMiddleware(EmptySettingsPageMiddleware::class, true);
		// Text sweep: an app that is switched on or updated gets its translations swept at once
		// (Service\SweepRunner; the RefreshSweep background job catches anything this misses).
		$context->registerEventListener(AppEnableEvent::class, AppChangeListener::class);
		$context->registerEventListener(AppUpdateEvent::class, AppChangeListener::class);
		// The theme's core translations would list each language twice in the language menus.
		$context->registerEventListener(BeforeTemplateRenderedEvent::class, LanguageListListener::class);
	}

	public function boot(IBootContext $context): void {
	}
}
