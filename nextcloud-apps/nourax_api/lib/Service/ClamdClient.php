<?php

declare(strict_types=1);

/**
 * A small client for clamd's TCP protocol (service "clamav", port 3310, inside the compose
 * network). Commands use the recommended NUL framing: "zPING\0" is answered with "PONG\0".
 * See https://docs.clamav.net/manual/Usage/ClamdProtocol.html
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\NouraxApi\Service;

use OCA\NouraxApi\Settings;

class ClamdClient {
	/** Health checks give up after this many seconds, for connecting and answering together. */
	public const HEALTH_TIMEOUT = 3.0;
	private const MAX_REPLY = 4096;

	public function __construct(
		private Settings $settings,
	) {
	}

	/** True when clamd answers PING with PONG within the time left before $deadline. */
	public function ping(float $deadline): bool {
		return $this->command('PING', $deadline) === 'PONG';
	}

	/** clamd's VERSION answer, e.g. "ClamAV 1.4.3/27800/Sat Oct 25 07:42:01 2026". */
	public function version(float $deadline): string {
		return $this->command('VERSION', $deadline);
	}

	/**
	 * The date of the newest signatures, from a VERSION answer ("ClamAV <engine>/<db>/<date>"),
	 * as YYYY-MM-DD. Null when the answer carries no date (no database loaded yet).
	 */
	public static function signatureDate(string $version): ?string {
		$parts = explode('/', $version, 3);
		if (count($parts) < 3 || !str_starts_with($parts[0], 'ClamAV ')) {
			return null;
		}
		// "Sat Oct 25 07:42:01 2026": the weekday is dropped, because PHP would move the date to
		// the next such weekday if the two disagreed.
		$text = (string)preg_replace('/\s+/', ' ', trim($parts[2]));
		if (preg_match('/^[A-Za-z]{3} ([A-Za-z]{3} \d{1,2} \d{2}:\d{2}:\d{2} \d{4})$/', $text, $m) !== 1) {
			return null;
		}
		$date = \DateTimeImmutable::createFromFormat('!M j H:i:s Y', $m[1], new \DateTimeZone('UTC'));
		return $date === false ? null : $date->format('Y-m-d');
	}

	/** Opens a connection to clamd. Throws ClamdUnavailableException when it is not there. */
	public function connect(float $deadline) {
		$timeout = $deadline - microtime(true);
		if ($timeout <= 0) {
			throw new ClamdUnavailableException('no time left to reach clamd');
		}
		$address = 'tcp://' . $this->settings->clamavHost() . ':' . $this->settings->clamavPort();
		$errno = 0;
		$errstr = '';
		$socket = @stream_socket_client($address, $errno, $errstr, $timeout);
		if ($socket === false) {
			throw new ClamdUnavailableException('cannot reach clamd (' . $errno . ')');
		}
		return $socket;
	}

	/** Sends one NUL-framed command and returns the answer without its NUL. */
	private function command(string $command, float $deadline): string {
		$socket = $this->connect($deadline);
		try {
			if (@fwrite($socket, 'z' . $command . "\0") === false) {
				throw new ClamdUnavailableException('clamd closed the connection');
			}
			$reply = '';
			while (!str_contains($reply, "\0") && strlen($reply) < self::MAX_REPLY) {
				$left = $deadline - microtime(true);
				if ($left <= 0) {
					throw new ClamdUnavailableException('clamd did not answer in time');
				}
				stream_set_timeout($socket, (int)$left, (int)(($left - (int)$left) * 1_000_000));
				$chunk = @fread($socket, 1024);
				if ($chunk === false || ($chunk === '' && feof($socket))) {
					break;
				}
				if ($chunk === '' && stream_get_meta_data($socket)['timed_out']) {
					throw new ClamdUnavailableException('clamd did not answer in time');
				}
				$reply .= $chunk;
			}
		} finally {
			fclose($socket);
		}
		$end = strpos($reply, "\0");
		return trim($end === false ? $reply : substr($reply, 0, $end));
	}
}
