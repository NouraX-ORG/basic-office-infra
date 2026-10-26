<?php

declare(strict_types=1);

/**
 * The admin settings section "Nourax Workspace" (/settings/admin/nourax-workspace). Only admins
 * see it: its one form, PrivacySettings, is not delegated to anyone else.
 *
 * Its icon is a white mark on a cobalt tile (img/nourax-workspace.svg): the settings menu draws
 * section icons as pictures, and a white-only icon would vanish on the light menu.
 * css/settings-nav.css keeps the menu's dark-theme filter off it (SettingsStyleListener).
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\NouraxApi\AdminSettings;

use OCA\NouraxApi\AppInfo\Application;
use OCP\IL10N;
use OCP\IURLGenerator;
use OCP\Settings\IIconSection;

class WorkspaceSection implements IIconSection {
	public const ID = 'nourax-workspace';
	public const ICON = 'nourax-workspace.svg';

	public function __construct(
		private IL10N $l,
		private IURLGenerator $urlGenerator,
	) {
	}

	public function getID(): string {
		return self::ID;
	}

	public function getName(): string {
		return $this->l->t('Nourax Workspace');
	}

	public function getPriority(): int {
		return 3;
	}

	public function getIcon(): string {
		return $this->urlGenerator->imagePath(Application::APP_ID, self::ICON);
	}
}
