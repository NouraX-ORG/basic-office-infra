<?php

declare(strict_types=1);

/**
 * occ nourax_api:reconcile [org_id] [--dry-run] - what the DriftReconcile job does, now: puts the
 * org:* and team:* groups back the way the stored desired state has them, and prints the drift
 * found, fixed and left per organisation as JSON. --dry-run only reports.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\NouraxApi\Command;

use OCA\NouraxApi\Service\AdminRequest;
use OCA\NouraxApi\Service\ReconcileService;
use Symfony\Component\Console\Command\Command;
use Symfony\Component\Console\Input\InputArgument;
use Symfony\Component\Console\Input\InputInterface;
use Symfony\Component\Console\Input\InputOption;
use Symfony\Component\Console\Output\OutputInterface;

class Reconcile extends Command {
	public function __construct(
		private ReconcileService $reconciler,
	) {
		parent::__construct();
	}

	protected function configure(): void {
		$this->setName('nourax_api:reconcile')
			->setDescription('Put the organisation and team groups back the way the stored desired state has them')
			->addArgument('org_id', InputArgument::OPTIONAL, 'only this organisation')
			->addOption('dry-run', null, InputOption::VALUE_NONE, 'only report the drift');
	}

	protected function execute(InputInterface $input, OutputInterface $output): int {
		$orgId = $input->getArgument('org_id');
		if ($orgId !== null && (!is_string($orgId) || !AdminRequest::validId($orgId))) {
			$output->writeln('<error>not an organisation id</error>');
			return 1;
		}
		$dryRun = (bool)$input->getOption('dry-run');
		$report = $this->reconciler->fixStored($orgId, $dryRun);
		$output->writeln((string)json_encode($report, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
		foreach ($report['orgs'] as $org) {
			if (!$dryRun && ($org['left'] ?? []) !== []) {
				return 1;
			}
		}
		return 0;
	}
}
