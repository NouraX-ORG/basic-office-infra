<?php

declare(strict_types=1);

/**
 * occ nourax_api:status - what the app knows, as JSON: whether the keys are set (never their
 * values), ClamAV, the sign-in provider, the leaver-deletion switch and the table counts.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\NouraxApi\Command;

use OCA\NouraxApi\AppInfo\Application;
use OCA\NouraxApi\Http\ApiKeyAuth;
use OCA\NouraxApi\Service\HealthService;
use OCA\NouraxApi\Settings;
use OCP\App\IAppManager;
use OCP\IDBConnection;
use Symfony\Component\Console\Command\Command;
use Symfony\Component\Console\Input\InputInterface;
use Symfony\Component\Console\Output\OutputInterface;

class Status extends Command {
	private const TABLES = ['orgs', 'teams', 'people', 'members', 'nonces', 'drift', 'audit'];

	public function __construct(
		private ApiKeyAuth $auth,
		private Settings $settings,
		private HealthService $health,
		private IAppManager $appManager,
		private IDBConnection $db,
	) {
		parent::__construct();
	}

	protected function configure(): void {
		$this->setName('nourax_api:status')
			->setDescription('Show the Nourax API state as JSON (keys set or missing, ClamAV, counts)');
	}

	protected function execute(InputInterface $input, OutputInterface $output): int {
		$health = $this->health->report();
		$counts = [];
		foreach (self::TABLES as $table) {
			$qb = $this->db->getQueryBuilder();
			$qb->select($qb->func()->count('*', 'n'))->from('nourax_api_' . $table);
			$counts[$table] = (int)$qb->executeQuery()->fetchOne();
		}
		$state = [
			'version' => $this->appManager->getAppVersion(Application::APP_ID),
			'api_key' => $this->auth->isConfigured() ? 'set' : 'missing',
			'admin_key' => $this->settings->adminKey() !== '' ? 'set' : 'missing',
			'clamav' => $health['clamav'],
			'clamav_address' => $this->settings->clamavHost() . ':' . $this->settings->clamavPort(),
			'signatures' => $health['signatures'],
			'oidc_provider' => $this->settings->oidcProvider(),
			'leaver_deletion' => $this->settings->leaverDeletionEnabled() ? 'on' : 'off',
			'rate_limits' => array_combine(
				array_keys(Settings::RATE_LIMITS),
				array_map(fn (string $bucket): int => $this->settings->rateLimit($bucket), array_keys(Settings::RATE_LIMITS)),
			),
			'scan_concurrency' => $this->settings->scanConcurrency(),
			'rows' => $counts,
		];
		$output->writeln((string)json_encode($state, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
		return 0;
	}
}
