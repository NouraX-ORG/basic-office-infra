<?php

declare(strict_types=1);

/**
 * occ nourax_api:service-account [--check] - makes sure the hidden service account
 * "nourax-teams" is in place (ServiceAccountService): a local account in no group, quota 0 B,
 * with one app password "nourax-api-loopback" kept as a sensitive app setting. Safe to run again.
 * --check also signs in with that app password over the compose network (http://app), as the
 * team board calls do. Prints what it changed, never the password.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\NouraxApi\Command;

use OCA\NouraxApi\Service\ServiceAccountService;
use OCA\NouraxApi\Service\Steps;
use Symfony\Component\Console\Command\Command;
use Symfony\Component\Console\Input\InputInterface;
use Symfony\Component\Console\Input\InputOption;
use Symfony\Component\Console\Output\OutputInterface;

class ServiceAccount extends Command {
	public function __construct(
		private ServiceAccountService $account,
	) {
		parent::__construct();
	}

	protected function configure(): void {
		$this->setName('nourax_api:service-account')
			->setDescription('Make sure the hidden service account for team address books, calendars and boards exists')
			->addOption('check', null, InputOption::VALUE_NONE, 'also sign in with its app password over the compose network');
	}

	protected function execute(InputInterface $input, OutputInterface $output): int {
		try {
			$changes = $this->account->ensure();
		} catch (\Throwable $e) {
			$output->writeln('<error>service account: ' . Steps::describe($e) . '</error>');
			return 1;
		}
		$output->writeln('service account ' . ServiceAccountService::UID . ':');
		foreach ($changes as $what => $result) {
			$output->writeln('  ' . $what . ': ' . $result);
		}

		if ($input->getOption('check')) {
			try {
				$status = $this->account->checkLoopback();
			} catch (\Throwable $e) {
				$output->writeln('<error>  loopback sign-in: ' . Steps::describe($e) . '</error>');
				return 1;
			}
			$output->writeln('  loopback sign-in: HTTP ' . $status . ($status === 200 ? ' (works)' : ' (does NOT work)'));
			return $status === 200 ? 0 : 1;
		}
		return 0;
	}
}
