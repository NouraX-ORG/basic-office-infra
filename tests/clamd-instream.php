<?php

declare(strict_types=1);

/**
 * Checks the INSTREAM exchange of POST /v1/scan (ClamdClient::instream and ::verdict) against a
 * fake clamd: a forked child on a socket pair, so no network and no real virus is needed.
 * It runs inside the app container, where nextcloud-apps/ is mounted at /var/www/html/nourax_apps:
 *   sudo docker compose exec -T app php < tests/clamd-instream.php
 * tests/api-scan.sh runs it first.
 *
 * The fake clamd checks the framing ("zINSTREAM\0", 4-byte big-endian lengths, a zero length at
 * the end) and answers "stream: <sha256>-<pieces>-<largest> FOUND", so the "virus name" the
 * client reads back proves that every byte arrived once, in order, in 1 MiB pieces.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace NouraxTests;

use OCA\NouraxApi\Service\ClamdClient as C;
use OCA\NouraxApi\Service\ScanResult as R;

$lib = getenv('NOURAX_API_LIB') ?: '/var/www/html/nourax_apps/nourax_api/lib';
require $lib . '/Service/ScanResult.php';
require $lib . '/Service/ClamdClient.php';

$fails = 0;
function expect(string $name, bool $ok, string $got = ''): void {
	global $fails;
	echo ($ok ? 'PASS ' : 'FAIL ') . $name . ($ok || $got === '' ? '' : ' (got ' . $got . ')') . "\n";
	if (!$ok) {
		$fails++;
	}
}

function show(R $r): string {
	return $r->verdict . '/' . $r->bytes . '/' . ($r->signature ?? '-') . '/' . $r->detail;
}

/** Reads exactly $n bytes, or fewer when the other side closes. */
function readExact($s, int $n): string {
	$data = '';
	while (strlen($data) < $n) {
		$chunk = fread($s, $n - strlen($data));
		if ($chunk === false || $chunk === '') {
			break;
		}
		$data .= $chunk;
	}
	return $data;
}

/**
 * The fake clamd's side of one exchange. Modes:
 *   summary  read it all, answer "stream: <sha256>-<pieces>-<largest> FOUND"
 *   ok       read it all, answer "stream: OK"
 *   limit    after the command, answer clamd's size-limit error at once and close
 *   garbage  read it all, answer something that is not a scan result
 *   silent   read it all and never answer (until the client hangs up)
 *   close    after the command, close without a word
 */
function fakeClamd($s, string $mode): void {
	if (readExact($s, 10) !== "zINSTREAM\0") {
		fwrite($s, "UNKNOWN COMMAND\0");
		return;
	}
	if ($mode === 'limit') {
		fwrite($s, "INSTREAM size limit exceeded. ERROR\0");
		return;
	}
	if ($mode === 'close') {
		return;
	}
	$hash = hash_init('sha256');
	$pieces = 0;
	$largest = 0;
	while (true) {
		$head = readExact($s, 4);
		if (strlen($head) !== 4) {
			return; // the client stopped part-way: no zero length came
		}
		$length = unpack('N', $head)[1];
		if ($length === 0) {
			break;
		}
		$data = readExact($s, $length);
		if (strlen($data) !== $length) {
			return;
		}
		hash_update($hash, $data);
		$pieces++;
		$largest = max($largest, $length);
	}
	switch ($mode) {
		case 'summary':
			fwrite($s, 'stream: ' . hash_final($hash) . '-' . $pieces . '-' . $largest . " FOUND\0");
			break;
		case 'ok':
			fwrite($s, "stream: OK\0");
			break;
		case 'garbage':
			fwrite($s, "UNKNOWN COMMAND\0");
			break;
		case 'silent':
			// say nothing until the client hangs up
			while (!feof($s) && fread($s, 1024) !== false) {
			}
			break;
	}
}

/** Runs ClamdClient::instream for $body against a fake clamd in $mode. */
function exchange(string $mode, string $body, int $max = C::MAX_SCAN_BYTES, float $ioTimeout = 5.0): R {
	$pair = stream_socket_pair(STREAM_PF_UNIX, STREAM_SOCK_STREAM, STREAM_IPPROTO_IP);
	$pid = pcntl_fork();
	if ($pid === -1) {
		throw new \RuntimeException('fork failed');
	}
	if ($pid === 0) {
		fclose($pair[0]);
		fakeClamd($pair[1], $mode);
		fclose($pair[1]);
		exit(0);
	}
	fclose($pair[1]);
	$input = fopen('php://temp', 'w+b');
	fwrite($input, $body);
	rewind($input);
	try {
		return C::instream($pair[0], $input, $max, microtime(true) + 20.0, C::SCAN_CHUNK, $ioTimeout);
	} finally {
		fclose($pair[0]);
		fclose($input);
		pcntl_waitpid($pid, $status);
	}
}

// --- clamd's answers -------------------------------------------------------------------------
expect('stream: OK is clean', show(C::verdict('stream: OK', 5)) === 'clean/5/-/');
$r = C::verdict('stream: Eicar-Test-Signature FOUND', 68);
expect('FOUND is infected with the name', $r->verdict === R::INFECTED && $r->signature === 'Eicar-Test-Signature', show($r));
$r = C::verdict('stream: Win.Test.EICAR_HDB-1 FOUND', 68);
expect('a dotted name is kept as it is', $r->signature === 'Win.Test.EICAR_HDB-1', show($r));
$r = C::verdict('stream: ' . str_repeat('A', 300) . ' FOUND', 1);
expect('a long name is cut to 200 characters', $r->verdict === R::INFECTED && strlen((string)$r->signature) === 200, show($r));
$r = C::verdict("stream: Bad\x01Name\x7f FOUND", 1);
expect('control characters in a name become spaces', $r->signature === 'Bad Name', show($r));
$r = C::verdict("stream: \xff\xfe FOUND", 1);
expect('a name that is not UTF-8 still makes valid JSON', json_encode(['s' => $r->signature]) !== false, show($r));
expect('the size limit error is too_large', C::verdict('INSTREAM size limit exceeded. ERROR', 9)->verdict === R::TOO_LARGE);
$r = C::verdict("stream: Can't allocate memory ERROR", 9);
expect('any other ERROR is failed', $r->verdict === R::FAILED && str_contains($r->detail, 'allocate memory'), show($r));
expect('an empty answer is failed', C::verdict('', 0)->verdict === R::FAILED);
expect('a bare OK is failed', C::verdict('OK', 0)->verdict === R::FAILED);
expect('a path answer is failed (INSTREAM always says stream:)', C::verdict('/tmp/x: OK', 0)->verdict === R::FAILED);
expect('the signature date still parses', C::signatureDate('ClamAV 1.5.4/28163/Sat Oct 24 06:26:10 2026') === '2026-10-24');

// --- The exchange, against the fake clamd ----------------------------------------------------
$mib = 1048576;
$body = random_bytes(2 * $mib + $mib / 2 + 7);
$r = exchange('summary', $body);
$want = hash('sha256', $body) . '-3-' . $mib;
expect('2.5 MiB arrive whole, in order, in three pieces of at most 1 MiB', $r->signature === $want && $r->bytes === strlen($body), show($r));

$r = exchange('summary', '');
expect('an empty body is sent as just the zero length', $r->signature === hash('sha256', '') . '-0-0' && $r->bytes === 0, show($r));

$r = exchange('ok', random_bytes(1000));
expect('a clean answer gives clean with the byte count', show($r) === 'clean/1000/-/', show($r));

$body = random_bytes($mib);
$r = exchange('summary', $body, $mib);
expect('a body of exactly the limit is scanned', $r->verdict === R::INFECTED && $r->signature === hash('sha256', $body) . '-1-' . $mib, show($r));

$r = exchange('summary', random_bytes($mib + 1), $mib);
expect('one byte over the limit is too_large, and the extra piece is never sent', $r->verdict === R::TOO_LARGE && $r->bytes === $mib + 1, show($r));

$r = exchange('limit', random_bytes(3 * $mib));
expect("clamd's own size limit (it stops reading) is too_large", $r->verdict === R::TOO_LARGE, show($r));

$r = exchange('garbage', random_bytes(100));
expect('an answer that is not a scan result is failed', $r->verdict === R::FAILED && str_contains($r->detail, 'UNKNOWN COMMAND'), show($r));

$r = exchange('close', random_bytes(3 * $mib));
expect('clamd closing part-way is failed', $r->verdict === R::FAILED, show($r));

$started = microtime(true);
$r = exchange('silent', random_bytes(100), C::MAX_SCAN_BYTES, 1.0);
$took = microtime(true) - $started;
expect('a silent clamd is failed after the wait time', $r->verdict === R::FAILED && str_contains($r->detail, 'in time') && $took < 2.5,
	show($r) . ' in ' . round($took, 2) . ' s');

echo $fails === 0 ? "all clamd-instream checks passed\n" : $fails . " check(s) failed\n";
exit($fails === 0 ? 0 : 1);
