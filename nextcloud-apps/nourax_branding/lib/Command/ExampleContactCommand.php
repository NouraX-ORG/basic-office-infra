<?php

declare(strict_types=1);

/**
 * occ nourax_branding:example-contact - puts the Nourax example contact in place, the card every new
 * account finds in NoContacts (see Service\ExampleContact). Safe to run again.
 *   --check     only says what new accounts get; exit 1 when that card names the upstream
 *   --existing  lists example cards that accounts got before (--user UID or --all); with --apply it
 *               changes them. They are people's data, so nothing changes without --apply.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\NouraxBranding\Command;

use OCA\NouraxBranding\Service\ExampleContact;
use Symfony\Component\Console\Command\Command;
use Symfony\Component\Console\Input\InputInterface;
use Symfony\Component\Console\Input\InputOption;
use Symfony\Component\Console\Output\OutputInterface;

class ExampleContactCommand extends Command {
	public function __construct(
		private ExampleContact $example,
	) {
		parent::__construct();
	}

	protected function configure(): void {
		$this->setName('nourax_branding:example-contact')
			->setDescription('Put the Nourax example contact in place for new accounts; safe to run again')
			->addOption('check', null, InputOption::VALUE_NONE, 'Change nothing; exit 1 when new accounts would get a card that names the upstream')
			->addOption('existing', null, InputOption::VALUE_NONE, 'Example cards that accounts already have: list them (with --user or --all)')
			->addOption('user', null, InputOption::VALUE_REQUIRED | InputOption::VALUE_IS_ARRAY, 'With --existing: only this account; give it more than once for more')
			->addOption('all', null, InputOption::VALUE_NONE, 'With --existing: every account')
			->addOption('apply', null, InputOption::VALUE_NONE, 'With --existing: change the cards (without it, nothing is changed)');
	}

	protected function execute(InputInterface $input, OutputInterface $output): int {
		try {
			if ($input->getOption('existing')) {
				return $this->existing($input, $output);
			}
			if ($input->getOption('check')) {
				$now = $this->example->current();
				$output->writeln(sprintf('Example contact for new accounts: %s; %s; %s.',
					$now['enabled'] ? 'on' : 'off',
					$now['ours'] ? 'the Nourax card' : ($now['custom'] ? 'a card an admin chose' : 'the upstream card'),
					$now['names_upstream'] ? 'it NAMES THE UPSTREAM' : 'no upstream name or address in it'));
				return $now['enabled'] && $now['names_upstream'] ? 1 : 0;
			}
			$made = $this->example->build();
			$result = $this->example->install();
			$output->writeln(match ($result) {
				'written' => 'Example contact for new accounts: the Nourax card is now in place (' . implode(', ', $made['changed'] ?: ['nothing to change']) . ').',
				'unchanged' => 'Example contact for new accounts: the Nourax card is already in place.',
				default => 'Example contact for new accounts: kept the card an admin chose (it does not name the upstream).',
			});
		} catch (\Throwable $e) {
			$output->writeln('<error>' . $e->getMessage() . '</error>');
			return 1;
		}
		return 0;
	}

	private function existing(InputInterface $input, OutputInterface $output): int {
		$users = $input->getOption('user');
		$users = is_array($users) ? array_values(array_map('strval', $users)) : [];
		$all = (bool)$input->getOption('all');
		if ($all === ($users !== [])) {
			$output->writeln('<error>With --existing, give either --user UID (one or more) or --all</error>');
			return 2;
		}
		$apply = (bool)$input->getOption('apply');
		$found = $this->example->findExisting($all ? null : $users);
		foreach ($found as $item) {
			if ($apply) {
				$this->example->fixExisting($item);
			}
			$output->writeln(sprintf('%s, address book %s, card %s: %s%s', $item['uid'], $item['book'], $item['uri'],
				implode(', ', $item['changed']), $apply ? ' (changed)' : ' (would change)'));
		}
		$output->writeln(sprintf('%d example card(s) made from the upstream card%s.', count($found),
			$found === [] ? '' : ($apply ? ', changed' : '; nothing changed (add --apply to change them)')));
		return 0;
	}
}
