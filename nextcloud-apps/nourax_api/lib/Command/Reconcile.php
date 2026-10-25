<?php

declare(strict_types=1);

/**
 * occ nourax_api:reconcile [org_id] - puts groups, team folders and shares back the way the
 * stored desired state has them (the admin API feature fills this in). Until then there is
 * nothing to reconcile, so it only says so and succeeds.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\NouraxApi\Command;

use Symfony\Component\Console\Command\Command;
use Symfony\Component\Console\Input\InputArgument;
use Symfony\Component\Console\Input\InputInterface;
use Symfony\Component\Console\Output\OutputInterface;

class Reconcile extends Command {
	protected function configure(): void {
		$this->setName('nourax_api:reconcile')
			->setDescription('Fix drift between the stored organisations and teams and the live groups')
			->addArgument('org_id', InputArgument::OPTIONAL, 'only this organisation');
	}

	protected function execute(InputInterface $input, OutputInterface $output): int {
		$output->writeln('reconcile: nothing to do yet (the admin API is not part of this version)');
		return 0;
	}
}
