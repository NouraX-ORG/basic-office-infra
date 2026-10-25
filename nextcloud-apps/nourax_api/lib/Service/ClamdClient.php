<?php

declare(strict_types=1);

/**
 * A small client for clamd's TCP protocol (service "clamav", port 3310, inside the compose
 * network). Commands use the recommended NUL framing: "zPING\0" is answered with "PONG\0".
 * Scans use INSTREAM: the bytes go to clamd in pieces, each with a 4-byte big-endian length,
 * ended by a zero length. See https://docs.clamav.net/manual/Usage/ClamdProtocol.html
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\NouraxApi\Service;

use OCA\NouraxApi\Settings;

class ClamdClient {
	/** Health checks give up after this many seconds, for connecting and answering together. */
	public const HEALTH_TIMEOUT = 3.0;
	/**
	 * The largest file a scan takes: NoMail's MAX_SCAN_BYTES, 95 MiB (Cloudflare refuses request
	 * bodies over 100 MB). clamd's own StreamMaxLength must stay above it (it is 110M).
	 */
	public const MAX_SCAN_BYTES = 99_614_720;
	/** Connecting to clamd for a scan gives up after this many seconds (then 503). */
	public const SCAN_CONNECT_TIMEOUT = 5.0;
	/** Each wait on clamd during a scan, one write or the answer, gives up after this many seconds. */
	public const SCAN_IO_TIMEOUT = 60.0;
	/** A whole scan, from connecting to clamd's answer, gives up after this many seconds. */
	public const SCAN_DEADLINE = 90.0;
	/** The request body goes to clamd in pieces of this size. */
	public const SCAN_CHUNK = 1_048_576;
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

	/**
	 * Scans everything $input gives (the request body) with INSTREAM. Nothing is stored: each
	 * piece goes from the stream straight to clamd. Throws ClamdUnavailableException when clamd
	 * cannot be reached (the caller answers 503); any trouble after that is a FAILED result.
	 *
	 * @param resource $input
	 */
	public function scan($input, int $maxBytes = self::MAX_SCAN_BYTES): ScanResult {
		$started = microtime(true);
		$socket = $this->connect($started + self::SCAN_CONNECT_TIMEOUT);
		try {
			return self::instream($socket, $input, $maxBytes, $started + self::SCAN_DEADLINE);
		} finally {
			fclose($socket);
		}
	}

	/**
	 * The INSTREAM exchange on an open connection to clamd: "zINSTREAM\0", then each piece of
	 * $input as a 4-byte big-endian length and its bytes, then a zero length, then the answer up
	 * to its NUL. More than $maxBytes from $input ends it as TOO_LARGE before the extra bytes
	 * reach clamd. Public and static so tests/clamd-instream.php can run it against a fake clamd.
	 *
	 * @param resource $socket
	 * @param resource $input
	 */
	public static function instream($socket, $input, int $maxBytes, float $deadline,
		int $chunkSize = self::SCAN_CHUNK, float $ioTimeout = self::SCAN_IO_TIMEOUT): ScanResult {
		$bytes = 0;
		if (!self::writeAll($socket, "zINSTREAM\0", $deadline, $ioTimeout)) {
			return self::afterBrokenWrite($socket, $bytes, $deadline, $ioTimeout);
		}
		while (true) {
			$data = stream_get_contents($input, $chunkSize);
			if ($data === false) {
				return ScanResult::failed($bytes, 'the request body could not be read');
			}
			if ($data === '') {
				break;
			}
			$bytes += strlen($data);
			if ($bytes > $maxBytes) {
				return ScanResult::tooLarge($bytes, 'the body is over ' . $maxBytes . ' bytes');
			}
			if (!self::writeAll($socket, pack('N', strlen($data)) . $data, $deadline, $ioTimeout)) {
				return self::afterBrokenWrite($socket, $bytes, $deadline, $ioTimeout);
			}
		}
		if (!self::writeAll($socket, pack('N', 0), $deadline, $ioTimeout)) {
			return self::afterBrokenWrite($socket, $bytes, $deadline, $ioTimeout);
		}
		$reply = self::readReply($socket, $deadline, $ioTimeout);
		return $reply === null
			? ScanResult::failed($bytes, 'clamd did not answer in time')
			: self::verdict($reply, $bytes);
	}

	/** Reads clamd's answer to INSTREAM: "stream: OK", "stream: <name> FOUND" or "... ERROR". */
	public static function verdict(string $reply, int $bytes): ScanResult {
		if ($reply === 'stream: OK') {
			return ScanResult::clean($bytes);
		}
		if (preg_match('/^stream: (.+) FOUND$/s', $reply, $m) === 1) {
			return ScanResult::infected($bytes, $m[1]);
		}
		if (stripos($reply, 'size limit exceeded') !== false) {
			return ScanResult::tooLarge($bytes, 'clamd: ' . self::shortReply($reply));
		}
		if ($reply === '') {
			return ScanResult::failed($bytes, 'clamd closed the connection without an answer');
		}
		return ScanResult::failed($bytes, 'clamd answered: ' . self::shortReply($reply));
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
			if (!self::writeAll($socket, 'z' . $command . "\0", $deadline, self::HEALTH_TIMEOUT)) {
				throw new ClamdUnavailableException('clamd closed the connection');
			}
			$reply = self::readReply($socket, $deadline, self::HEALTH_TIMEOUT);
		} finally {
			fclose($socket);
		}
		if ($reply === null) {
			throw new ClamdUnavailableException('clamd did not answer in time');
		}
		return $reply;
	}

	/**
	 * clamd stopped taking bytes part-way. It may have said why (its size limit) before closing;
	 * anything else means the scan did not happen.
	 */
	private static function afterBrokenWrite($socket, int $bytes, float $deadline, float $ioTimeout): ScanResult {
		$reply = self::readReply($socket, min($deadline, microtime(true) + 5.0), $ioTimeout);
		if ($reply !== null && $reply !== '') {
			$result = self::verdict($reply, $bytes);
			if ($result->verdict === ScanResult::TOO_LARGE) {
				return $result;
			}
			return ScanResult::failed($bytes, 'clamd stopped reading and answered: ' . self::shortReply($reply));
		}
		return ScanResult::failed($bytes, 'clamd stopped reading after ' . $bytes . ' bytes');
	}

	/** Writes all of $data, waiting at most $ioTimeout each time clamd is slow to take more. */
	private static function writeAll($socket, string $data, float $deadline, float $ioTimeout): bool {
		$length = strlen($data);
		$written = 0;
		while ($written < $length) {
			$left = $deadline - microtime(true);
			if ($left <= 0) {
				return false;
			}
			self::setTimeout($socket, min($left, $ioTimeout));
			$n = @fwrite($socket, $written === 0 ? $data : substr($data, $written));
			if ($n === false || $n === 0) {
				return false;
			}
			$written += $n;
		}
		return true;
	}

	/**
	 * Reads one NUL-ended answer and returns it without the NUL, trimmed. Null when clamd stays
	 * silent past $deadline or for $ioTimeout; what came before a closed connection otherwise.
	 */
	private static function readReply($socket, float $deadline, float $ioTimeout): ?string {
		$reply = '';
		while (!str_contains($reply, "\0") && strlen($reply) < self::MAX_REPLY) {
			$left = $deadline - microtime(true);
			if ($left <= 0) {
				return null;
			}
			self::setTimeout($socket, min($left, $ioTimeout));
			$chunk = @fread($socket, 1024);
			if ($chunk === false || $chunk === '') {
				// PHP 8.5 gives false (older versions '') when the wait ran out: timed_out tells.
				if (stream_get_meta_data($socket)['timed_out']) {
					return null;
				}
				if ($chunk === false || feof($socket)) {
					break;
				}
				continue;
			}
			$reply .= $chunk;
		}
		$end = strpos($reply, "\0");
		return trim($end === false ? $reply : substr($reply, 0, $end));
	}

	private static function setTimeout($socket, float $seconds): void {
		$seconds = max(0.001, $seconds);
		stream_set_timeout($socket, (int)$seconds, (int)(($seconds - (int)$seconds) * 1_000_000));
	}

	/** A clamd answer for the server log: no control characters, 120 characters at most. */
	private static function shortReply(string $reply): string {
		return mb_scrub(substr(trim((string)preg_replace('/[\x00-\x1f\x7f]+/', ' ', $reply)), 0, 120), 'UTF-8');
	}
}
