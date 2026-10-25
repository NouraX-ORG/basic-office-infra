<?php

declare(strict_types=1);

/**
 * occ nourax_antivirus:skip-internal - enters version, trash, editor and upload entries of the
 * object store as not for the stored-file virus scan (Service\InternalFiles). The cron job does
 * the same every 5 minutes; nourax-virus-scan.service runs this before each scan.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\NouraxAntivirus\Command;

use OCA\NouraxAntivirus\Service\InternalFiles;
use Symfony\Component\Console\Command\Command;
use Symfony\Component\Console\Input\InputInterface;
use Symfony\Component\Console\Output\OutputInterface;

class SkipInternal extends Command {
	public function __construct(
		private readonly InternalFiles $internalFiles,
	) {
		parent::__construct();
	}

	protected function configure(): void {
		$this->setName('nourax_antivirus:skip-internal')
			->setDescription('Enter version, trash, editor and upload entries as not for the stored-file virus scan');
	}

	protected function execute(InputInterface $input, OutputInterface $output): int {
		if (!$this->internalFiles->antivirusEnabled()) {
			$output->writeln('files_antivirus is not enabled, nothing to do');
			return 0;
		}
		$entered = $this->internalFiles->skipInternal();
		$output->writeln("entered $entered internal entries as not for the stored-file scan");
		return 0;
	}
}
