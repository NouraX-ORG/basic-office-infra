<?php

declare(strict_types=1);

/**
 * occ nourax_branding:calendar-colours - lists the calendars and task lists of people that are in the
 * upstream blue (made before the nourax_branding app gave new ones the site's colour), and with
 * --apply gives them the site's colour. A person's calendars are their data, so it only lists unless
 * --apply is given, and only for the accounts named with --user, or everyone with --all.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\NouraxBranding\Command;

use OCA\NouraxBranding\Service\CalendarColours;
use Symfony\Component\Console\Command\Command;
use Symfony\Component\Console\Input\InputInterface;
use Symfony\Component\Console\Input\InputOption;
use Symfony\Component\Console\Output\OutputInterface;

class CalendarColoursCommand extends Command {
	public function __construct(
		private CalendarColours $colours,
	) {
		parent::__construct();
	}

	protected function configure(): void {
		$this->setName('nourax_branding:calendar-colours')
			->setDescription('List calendars and task lists in the upstream blue; with --apply give them the site colour')
			->addOption('user', null, InputOption::VALUE_REQUIRED | InputOption::VALUE_IS_ARRAY, 'Only the calendars of this account; give it more than once for more')
			->addOption('all', null, InputOption::VALUE_NONE, 'The calendars of every account')
			->addOption('apply', null, InputOption::VALUE_NONE, 'Change the colours (without it, nothing is changed)');
	}

	protected function execute(InputInterface $input, OutputInterface $output): int {
		$users = $input->getOption('user');
		$users = is_array($users) ? array_values(array_map('strval', $users)) : [];
		$all = (bool)$input->getOption('all');
		if ($all === ($users !== [])) {
			$output->writeln('<error>Give either --user UID (one or more) or --all</error>');
			return 2;
		}
		$apply = (bool)$input->getOption('apply');
		try {
			$found = $this->colours->find($all ? null : $users);
			$colour = $this->colours->colour();
			foreach ($found as $c) {
				$line = sprintf('calendar %d of %s (%s, "%s"): %s', $c['id'], $c['uid'], $c['uri'], $c['name'], $c['colour']);
				if ($apply) {
					$new = $this->colours->recolourById($c['id']);
					$output->writeln($line . ($new === null ? ', left as it is' : " -> $new"));
				} else {
					$output->writeln($line . " (would become $colour)");
				}
			}
		} catch (\Throwable $e) {
			$output->writeln('<error>' . $e->getMessage() . '</error>');
			return 1;
		}
		$output->writeln(sprintf('%d calendar(s) in the upstream blue%s.', count($found),
			$found === [] ? '' : ($apply ? ', changed to the site colour' : '; nothing changed (add --apply to change them)')));
		return 0;
	}
}
