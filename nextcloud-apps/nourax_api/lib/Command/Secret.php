<?php

declare(strict_types=1);

/**
 * occ nourax_api:secret api_key|admin_key [--check] < secret-file
 *
 * Reads a key from stdin (piped from the server's secret file, so it is never on a command line)
 * and stores it: for api_key only its SHA-256, for admin_key the value as a sensitive app setting
 * (encrypted in the database). --check only says whether stdin matches what is stored.
 * Prints lengths, never values.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\NouraxApi\Command;

use OCA\NouraxApi\Http\ApiKeyAuth;
use OCA\NouraxApi\Settings;
use Symfony\Component\Console\Command\Command;
use Symfony\Component\Console\Input\InputArgument;
use Symfony\Component\Console\Input\InputInterface;
use Symfony\Component\Console\Input\InputOption;
use Symfony\Component\Console\Output\OutputInterface;

class Secret extends Command {
	private const KINDS = ['api_key', 'admin_key'];

	public function __construct(
		private ApiKeyAuth $auth,
		private Settings $settings,
	) {
		parent::__construct();
	}

	protected function configure(): void {
		$this->setName('nourax_api:secret')
			->setDescription('Store the NoMail API key (api_key) or the admin API key (admin_key), read from stdin')
			->addArgument('kind', InputArgument::REQUIRED, 'api_key or admin_key')
			->addOption('check', null, InputOption::VALUE_NONE, 'only check whether stdin matches the stored key');
	}

	protected function execute(InputInterface $input, OutputInterface $output): int {
		$kind = (string)$input->getArgument('kind');
		if (!in_array($kind, self::KINDS, true)) {
			$output->writeln('<error>kind must be api_key or admin_key</error>');
			return 2;
		}
		if (stream_isatty(STDIN)) {
			$output->writeln('<error>pipe the key in, e.g. occ nourax_api:secret ' . $kind . ' < "$(secret_path ...)"</error>');
			return 2;
		}
		$key = trim((string)stream_get_contents(STDIN, ApiKeyAuth::MAX_LENGTH + 2));
		if (!ApiKeyAuth::acceptable($key)) {
			$output->writeln('<error>' . $kind . ' not accepted: it must be ' . ApiKeyAuth::MIN_LENGTH . ' to ' . ApiKeyAuth::MAX_LENGTH . ' visible characters (got ' . strlen($key) . ')</error>');
			return 1;
		}

		if ($input->getOption('check')) {
			$matches = $kind === 'api_key'
				? $this->auth->verify($key)
				: ($this->settings->adminKey() !== '' && hash_equals($this->settings->adminKey(), $key));
			$output->writeln($kind . ($matches ? ' matches' : ' does NOT match') . ' the stored key');
			return $matches ? 0 : 1;
		}

		if ($kind === 'api_key') {
			$this->auth->store($key);
		} else {
			$this->settings->setAdminKey($key);
		}
		$output->writeln($kind . ' saved (' . strlen($key) . ' characters)');
		return 0;
	}
}
