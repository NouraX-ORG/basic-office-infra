<?php

declare(strict_types=1);

/**
 * occ nourax_branding:sweep - rewrite the upstream name in the translations of core, lib and every
 * enabled app (see Service\SweepRunner and docs/branding.md). Safe to run again: the second run
 * writes nothing.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\NouraxBranding\Command;

use OCA\NouraxBranding\Service\SweepRunner;
use Symfony\Component\Console\Command\Command;
use Symfony\Component\Console\Input\InputInterface;
use Symfony\Component\Console\Input\InputOption;
use Symfony\Component\Console\Output\OutputInterface;

class Sweep extends Command {
	public function __construct(
		private SweepRunner $runner,
	) {
		parent::__construct();
	}

	protected function configure(): void {
		$this->setName('nourax_branding:sweep')
			->setDescription('Rewrite the upstream name in all translations (theme overrides); safe to run again')
			->addOption('app', null, InputOption::VALUE_REQUIRED | InputOption::VALUE_IS_ARRAY, 'Sweep only this app (core and lib are names too); give it more than once for more')
			->addOption('if-needed', null, InputOption::VALUE_NONE, 'Sweep only what changed since the last sweep (what the background job does)')
			->addOption('report', null, InputOption::VALUE_NONE, 'Also list every folder, the notes, translations that leave the name out or spell it in a way the rules do not know, and spellings found by their likeness to the name')
			->addOption('dry-run', null, InputOption::VALUE_NONE, 'Work everything out but write nothing')
			->addOption('bump', null, InputOption::VALUE_NONE, 'Raise the theming cache buster even when no file changed (browsers fetch the theme files again)');
	}

	protected function execute(InputInterface $input, OutputInterface $output): int {
		try {
			$apps = $input->getOption('app');
			$apps = is_array($apps) && $apps !== [] ? array_values(array_map('strval', $apps)) : null;
			if ($input->getOption('if-needed')) {
				$need = $this->runner->needed();
				if ($need === null) {
					$output->writeln('The sweep is up to date (sweep-state.json matches what is installed).');
					return 0;
				}
				$apps = $need['full'] ? null : $need['apps'];
			}
			$dryRun = (bool)$input->getOption('dry-run');
			$r = $this->runner->run($apps, $dryRun, (bool)$input->getOption('bump'));
		} catch (\Throwable $e) {
			$output->writeln('<error>' . $e->getMessage() . '</error>');
			return 1;
		}

		$report = (bool)$input->getOption('report');
		$unknown = 0;
		$guessed = 0;
		foreach ($r['folders'] as $id => $f) {
			$unknown += count($f['unknown']);
			$guessed += count($f['guessed']);
			if ($report || $f['left'] !== []) {
				$output->writeln(sprintf('%-22s %3d languages, %5d texts changed, %5d filled in, %4d files written, %4d already right',
					$id, $f['langs'], $f['changed'], $f['filled'], $f['written'], $f['same']));
			}
			foreach ($f['left'] as [$lang, $key]) {
				$output->writeln("  STILL NAMED $lang: " . SweepRunner::short($key));
			}
			if ($report) {
				foreach ($f['notes'] as $note) {
					$output->writeln("  note: $note");
				}
				foreach ($f['unknown'] as [$lang, $key]) {
					$output->writeln("  no known spelling in $lang: " . SweepRunner::short($key));
				}
				foreach ($f['guessed'] as $word) {
					$output->writeln("  guessed spelling (near_name), replaced: $word; add it to latin-misspelt in sweep/rules.json");
				}
			}
		}
		foreach ($r['notes'] as $note) {
			$output->writeln("<comment>$note</comment>");
		}
		$output->writeln(sprintf('%s%d folders swept into %s: %d files written, %d already right; %d texts changed, %d filled in; %d still named.',
			$dryRun ? 'Dry run, nothing written. ' : '', count($r['folders']), $r['theme'], $r['written'], $r['same'], $r['changed'], $r['filled'], $r['left']));
		if (!$report && $unknown > 0) {
			$output->writeln("$unknown translations leave the name out or spell it in a way the rules do not know: see --report.");
		}
		if (!$report && $guessed > 0) {
			$output->writeln("$guessed spellings of the name that no pattern lists were found by their likeness and replaced: see --report.");
		}
		return $r['left'] > 0 || $r['notes'] !== [] ? 1 : 0;
	}
}
