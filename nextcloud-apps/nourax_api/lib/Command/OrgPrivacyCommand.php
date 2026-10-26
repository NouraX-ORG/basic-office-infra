<?php

declare(strict_types=1);

/**
 * occ nourax_api:org-privacy status|on|off [--dry-run] [--by=NAME] - privacy between organisations
 * (docs/teams.md), as JSON. The list of settings and apps is OrgPrivacySwitch's, the same one the
 * admin page "Nourax Workspace" and scripts/configure.d/60-org-privacy.sh use.
 *
 * status prints where every setting and app stands: {state, step, sharing_limited, items, apps}.
 * on and off switch (only what differs) and print the same, plus {result, changed, dry_run}.
 * --dry-run only lists what would change. --by names who switched, for the audit row (default
 * "occ"; configure.sh passes "configure").
 * Exit 0 when done; 1 with {"error": ...} when it could not switch: busy (another switch is
 * running), app_needs_upgrade (run occ app:enable on the server first), or an error.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\NouraxApi\Command;

use OCA\NouraxApi\Service\ApiException;
use OCA\NouraxApi\Service\OrgPrivacySwitch;
use Symfony\Component\Console\Command\Command;
use Symfony\Component\Console\Input\InputArgument;
use Symfony\Component\Console\Input\InputInterface;
use Symfony\Component\Console\Input\InputOption;
use Symfony\Component\Console\Output\OutputInterface;

class OrgPrivacyCommand extends Command {
	public function __construct(
		private OrgPrivacySwitch $switch,
	) {
		parent::__construct();
	}

	protected function configure(): void {
		$this->setName('nourax_api:org-privacy')
			->setDescription('Show or switch privacy between organisations (status, on or off), as JSON')
			->addArgument('action', InputArgument::OPTIONAL, 'status, on or off', 'status')
			->addOption('dry-run', null, InputOption::VALUE_NONE, 'only list what on or off would change')
			->addOption('by', null, InputOption::VALUE_REQUIRED, 'who switched, for the audit row', 'occ');
	}

	protected function execute(InputInterface $input, OutputInterface $output): int {
		$action = $input->getArgument('action');
		$by = $input->getOption('by');
		if (!is_string($action) || !in_array($action, ['status', 'on', 'off'], true)) {
			return $this->fail($output, 'invalid_action', 'the action must be status, on or off');
		}
		if (!is_string($by) || preg_match('/^[A-Za-z0-9._@-]{1,64}$/', $by) !== 1) {
			return $this->fail($output, 'invalid_by', '--by must be 1 to 64 letters, digits or ._@-');
		}
		if ($action === 'status') {
			$this->print($output, $this->switch->status());
			return 0;
		}

		try {
			$done = $this->switch->apply($action, (bool)$input->getOption('dry-run'),
				['key_id' => 'occ', 'method' => 'CLI', 'who' => $by, 'ip' => '', 'http_status' => 0]);
		} catch (ApiException $e) {
			return $this->fail($output, $e->errorCode, match ($e->errorCode) {
				'busy' => 'another switch is running; try again in a minute',
				'app_needs_upgrade' => 'federation or circles is installed at another version than its code; run occ app:enable for it on the server first',
				default => $e->errorCode,
			});
		} catch (\Throwable $e) {
			return $this->fail($output, 'failed', get_class($e) . ': ' . $e->getMessage());
		}
		$this->print($output, $done + $this->switch->status());
		return 0;
	}

	private function print(OutputInterface $output, array $data): void {
		$output->writeln((string)json_encode($data, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
	}

	private function fail(OutputInterface $output, string $error, string $message): int {
		$this->print($output, ['error' => $error, 'message' => $message]);
		return 1;
	}
}
