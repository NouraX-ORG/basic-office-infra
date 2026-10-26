<?php

declare(strict_types=1);

/**
 * "Privacy between organisations: On / Off" on the admin page "Nourax Workspace"
 * (templates/admin-privacy.php, js/admin-privacy.js, css/admin-privacy.css).
 *
 * It shows what On changes in plain English, the state now, every setting of the switch with its
 * value, and the last five switches (who, when, on or off, from the audit). The buttons ask for a
 * confirmation first, then POST to PrivacySettingsController, which is admin-only and checks the
 * CSRF token and a recent password confirmation. Everything it shows comes from OrgPrivacySwitch,
 * the list occ nourax_api:org-privacy and scripts/configure.d/60-org-privacy.sh use too.
 *
 * It is an ISettings, not an IDelegatedSettings, so it is never delegated to non-admins.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\NouraxApi\AdminSettings;

use OCA\NouraxApi\AppInfo\Application;
use OCA\NouraxApi\Service\OrgPrivacySwitch;
use OCP\AppFramework\Http\TemplateResponse;
use OCP\AppFramework\Services\IInitialState;
use OCP\IURLGenerator;
use OCP\Settings\ISettings;
use OCP\Util;

class PrivacySettings implements ISettings {
	public function __construct(
		private OrgPrivacySwitch $switch,
		private IInitialState $initialState,
		private IURLGenerator $urlGenerator,
	) {
	}

	public function getForm(): TemplateResponse {
		$view = self::view($this->switch);
		$this->initialState->provideInitialState('org-privacy', [
			'url' => $this->urlGenerator->linkToRoute(Application::APP_ID . '.privacy_settings.setState'),
			'state' => $view['status']['state'],
		]);
		Util::addScript(Application::APP_ID, 'admin-privacy');
		Util::addStyle(Application::APP_ID, 'admin-privacy');
		return new TemplateResponse(Application::APP_ID, 'admin-privacy', $view, '');
	}

	public function getSection(): string {
		return WorkspaceSection::ID;
	}

	public function getPriority(): int {
		return 10;
	}

	/**
	 * What the page shows, also the answer of the switch's routes: the status, the effects of On
	 * that apply here (the NoForms one only while NoForms is enabled), what Off means, and the
	 * last switches with a readable time and sentence.
	 *
	 * @return array{status: array<string, mixed>, effects: list<string>, on_note: string, off_warning: string, history: list<array<string, string>>}
	 */
	public static function view(OrgPrivacySwitch $switch): array {
		$status = $switch->status();
		$used = [];
		foreach ($status['items'] as $item) {
			if ($item['now'] !== 'not_used') {
				$used[$item['effect']] = true;
			}
		}
		$used['apps'] = true;
		$effects = [];
		foreach (OrgPrivacySwitch::EFFECTS as $id => $text) {
			if (isset($used[$id])) {
				$effects[] = $text;
			}
		}
		$history = [];
		foreach ($switch->history(5) as $row) {
			$what = match ($row['result']) {
				'switched_on' => 'Switched on',
				'switched_off' => 'Switched off',
				default => 'A switch stopped with an error',
			};
			$time = strtotime($row['at']);
			$history[] = [
				'at' => $row['at'],
				'when' => $time === false ? $row['at'] : gmdate('j M Y, H:i', $time) . ' UTC',
				'text' => $what . ' by ' . ($row['who'] === '' ? 'unknown' : $row['who']) . ' (' . $row['how'] . ')',
			];
		}
		return [
			'status' => $status,
			'effects' => $effects,
			'on_note' => OrgPrivacySwitch::ON_NOTE,
			'off_warning' => OrgPrivacySwitch::OFF_WARNING,
			'history' => $history,
		];
	}
}
