<?php

declare(strict_types=1);

/**
 * occ nourax_api:service-account - sets up the hidden service account that owns the team
 * address books (feature T6-3). Until that feature lands it only says so, and succeeds, so
 * scripts may already call it.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\NouraxApi\Command;

use Symfony\Component\Console\Command\Command;
use Symfony\Component\Console\Input\InputInterface;
use Symfony\Component\Console\Output\OutputInterface;

class ServiceAccount extends Command {
	protected function configure(): void {
		$this->setName('nourax_api:service-account')
			->setDescription('Make sure the hidden service account for team address books exists');
	}

	protected function execute(InputInterface $input, OutputInterface $output): int {
		$output->writeln('service account: not part of this version yet (the teams API adds it)');
		return 0;
	}
}
