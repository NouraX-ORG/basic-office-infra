<?php

declare(strict_types=1);

/**
 * Daily: the scheduled delete of people who left their organisation (PUT person "active": false
 * disables the account and sets delete_after to 30 days later).
 *
 * SWITCHED OFF. It deletes nothing until the owner says yes and someone runs
 *   occ config:app:set nourax_api scheduled_delete --value=on
 * While it is off (anything but "on") it only counts the accounts it would delete, logs
 * "would delete N" and keeps that in the app setting leaver_deletion_last_run.
 *
 * When on, it deletes an account only if all of these hold: its person row says it left
 * (active 0), delete_after has passed, it is not on hold (an admin may ask for a transfer
 * first), the account is still disabled and is a "Log in with Nourax" account. Files in team
 * folders stay (the Team Folders app owns them); the person's own files go with the account.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\NouraxApi\BackgroundJob;

use OCA\NouraxApi\Service\AdminStore;
use OCA\NouraxApi\Service\ProvisionRequest;
use OCA\NouraxApi\Settings;
use OCP\AppFramework\Utility\ITimeFactory;
use OCP\BackgroundJob\TimedJob;
use OCP\IUserManager;
use Psr\Log\LoggerInterface;

class LeaverDeletion extends TimedJob {
	private const OIDC_BACKEND = 'user_oidc';

	public function __construct(
		ITimeFactory $time,
		private Settings $settings,
		private AdminStore $store,
		private IUserManager $userManager,
		private LoggerInterface $logger,
	) {
		parent::__construct($time);
		$this->setInterval(86400);
		$this->setTimeSensitivity(self::TIME_INSENSITIVE);
	}

	protected function run($argument): void {
		$now = $this->time->getTime();
		$due = [];
		foreach ($this->store->leaversDue($now) as $row) {
			$user = $this->userManager->get($row['user_id']);
			if ($user !== null && !$user->isEnabled() && $user->getBackendClassName() === self::OIDC_BACKEND
				&& ProvisionRequest::validUserId($user->getUID())) {
				$due[] = $user;
			}
		}

		$on = $this->settings->leaverDeletionEnabled();
		$deleted = 0;
		if (!$on) {
			$this->logger->info('nourax_api scheduled delete is off: would delete ' . count($due) . ' account(s)', ['app' => 'nourax_api']);
		} else {
			foreach ($due as $user) {
				if ($user->delete()) {
					$deleted++;
					$this->logger->warning('nourax_api scheduled delete: deleted ' . $user->getUID() . ' (left more than 30 days ago)', ['app' => 'nourax_api']);
				}
			}
		}
		$this->settings->setLeaverDeletionLastRun([
			'at' => gmdate('c', $now),
			'mode' => $on ? 'on' : 'off',
			'due' => count($due),
			'deleted' => $deleted,
		]);
	}
}
