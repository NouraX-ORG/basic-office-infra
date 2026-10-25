<?php

declare(strict_types=1);

/**
 * The steps of one admin call and their results. Every step is an "ensure": it makes things the
 * way they should be and says what it did, so running the same call again finishes a half-done
 * one and reports "unchanged" for what was already right.
 *
 * Answer: {"ok","applied","version","steps":[{"step","result","detail"}]}, result one of
 * created | updated | unchanged | failed. A failed step does not stop the others; ok is false
 * and the controller answers 502, so NoMail sends the call again later. A step may add its own
 * fields next to these (for example "team_id" and "counts" on a "leave" step).
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\NouraxApi\Service;

use OCA\NouraxApi\AppInfo\Application;
use Psr\Log\LoggerInterface;

final class Steps {
	public const CREATED = 'created';
	public const UPDATED = 'updated';
	public const UNCHANGED = 'unchanged';
	public const FAILED = 'failed';

	/** @var list<array<string, mixed>> {step, result, detail} plus a step's own fields */
	private array $steps = [];
	private bool $failed = false;

	public function __construct(
		private LoggerInterface $logger,
		private string $context,
	) {
	}

	/**
	 * Runs one step. $step returns [result, detail] or [result, detail, extra fields]; a
	 * StepFailed or any other exception makes it "failed" (the detail of an unexpected exception
	 * is its class and message, also logged). $fields are added to the step whatever happens.
	 *
	 * @param callable(): array{0: string, 1?: ?string, 2?: array<string, mixed>} $step
	 * @param array<string, mixed> $fields
	 * @return bool whether the step worked
	 */
	public function run(string $name, callable $step, array $fields = []): bool {
		$extra = [];
		try {
			$outcome = $step();
			$result = $outcome[0];
			$detail = $outcome[1] ?? null;
			$extra = is_array($outcome[2] ?? null) ? $outcome[2] : [];
		} catch (StepFailed $e) {
			$result = self::FAILED;
			$detail = $e->getMessage();
		} catch (\Throwable $e) {
			$result = self::FAILED;
			$detail = self::describe($e);
			$this->logger->warning('nourax_api admin ' . $this->context . ' step ' . $name . ' failed: ' . get_class($e) . ': ' . $e->getMessage(), ['app' => Application::APP_ID]);
		}
		if ($result === self::FAILED) {
			$this->failed = true;
		}
		$this->steps[] = ['step' => $name, 'result' => $result, 'detail' => $detail] + $fields + $extra;
		return $result !== self::FAILED;
	}

	/** Records a step that could not run because an earlier one failed. */
	public function skip(string $name, string $why, array $fields = []): void {
		$this->failed = true;
		$this->steps[] = ['step' => $name, 'result' => self::FAILED, 'detail' => $why] + $fields;
	}

	/** @return list<array<string, mixed>> the steps so far */
	public function all(): array {
		return $this->steps;
	}

	public function failed(): bool {
		return $this->failed;
	}

	/** @return array{ok: bool, applied: bool, version: int, steps: list<array<string, mixed>>} */
	public function answer(int $version, array $extra = []): array {
		return ['ok' => !$this->failed, 'applied' => true, 'version' => $version] + $extra + ['steps' => $this->steps];
	}

	/**
	 * The answer to a call older than what is stored: nothing is changed. "version" is the
	 * version the call sent (as in every other answer), "current_version" the stored one.
	 */
	public static function stale(int $sentVersion, int $currentVersion, array $extra = []): array {
		return ['ok' => true, 'applied' => false, 'reason' => 'stale_version', 'version' => $sentVersion,
			'current_version' => $currentVersion] + $extra + ['steps' => []];
	}

	/** Short class name and message, at most 200 characters. */
	public static function describe(\Throwable $e): string {
		$class = substr((string)strrchr('\\' . get_class($e), '\\'), 1);
		return mb_substr($class . ': ' . $e->getMessage(), 0, 200);
	}
}
