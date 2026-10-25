<?php

declare(strict_types=1);

/**
 * Ends a person's open ONLYOFFICE editing sessions on given documents: the command service's
 * "drop" command, {"c":"drop","key":<document key>,"users":[<editor user id>]}.
 *
 * - Sent from inside the compose network to the onlyoffice app's internal address
 *   (DocumentServerInternalUrl, here http://onlyoffice/) + coauthoring/CommandService.ashx, the
 *   same address and path the onlyoffice app itself uses. The public host is never used.
 * - Signed like the onlyoffice app signs its own commands: HS256 with its jwt_secret, as a body
 *   field "token" and as the header named by its jwt_header ("Bearer <token>", payload wrapped in
 *   {"payload": ...}). The secret is read from the onlyoffice app's settings and never logged.
 * - The editor user id is "<instanceid>_<uid>", as the onlyoffice app builds it.
 *
 * The answer's "error" is counted per code: 0 done (ONLYOFFICE Docs 10 also answers 0 when nobody
 * has the document open), 1 no such document key, 6 a bad token (a setup fault). A failure to connect stops the run, so a
 * stopped document server does not hold up a leave.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\NouraxApi\Service;

use OCP\Http\Client\IClientService;
use OCP\IAppConfig;
use OCP\IConfig;

class OnlyofficeCommand {
	/** At most this many documents per call, so one leave stays short. */
	public const MAX_KEYS = 200;

	private const APP = 'onlyoffice';
	private const PATH = 'coauthoring/CommandService.ashx';
	/** Seconds a signed command stays valid, as the onlyoffice app's default. */
	private const JWT_MINUTES = 5;

	public function __construct(
		private IClientService $clients,
		private IAppConfig $appConfig,
		private IConfig $config,
	) {
	}

	/** The editor user id ONLYOFFICE knows a person by. */
	public function editorUserId(string $uid): string {
		return $this->config->getSystemValueString('instanceid', '') . '_' . $uid;
	}

	/**
	 * Sends "drop" for each document key.
	 *
	 * @param list<string> $keys
	 * @return array{sent: int, codes: array<string, int>, not_sent: int}
	 */
	public function drop(array $keys, string $uid): array {
		$keys = array_slice(array_values(array_unique($keys)), 0, self::MAX_KEYS);
		$report = ['sent' => 0, 'codes' => [], 'not_sent' => 0];
		if ($keys === []) {
			return $report;
		}
		$base = rtrim($this->appConfig->getValueString(self::APP, 'DocumentServerInternalUrl', ''), '/');
		if ($base === '') {
			$base = rtrim($this->appConfig->getValueString(self::APP, 'DocumentServerUrl', ''), '/');
		}
		if ($base === '') {
			$report['not_sent'] = count($keys);
			return $report;
		}
		$user = $this->editorUserId($uid);
		$client = $this->clients->newClient();
		foreach ($keys as $i => $key) {
			$data = ['c' => 'drop', 'key' => $key, 'users' => [$user]];
			try {
				$response = $client->post($base . '/' . self::PATH, $this->signed($data) + [
					'timeout' => 10,
					'connect_timeout' => 3,
					'http_errors' => false,
					'nextcloud' => ['allow_local_address' => true],
				]);
			} catch (\Throwable) {
				// The document server is not reachable: stop here, the rest count as not sent.
				$report['not_sent'] = count($keys) - $i;
				break;
			}
			$report['sent']++;
			$answer = json_decode((string)$response->getBody(), true);
			$code = is_array($answer) && isset($answer['error']) ? (string)(int)$answer['error'] : 'http_' . $response->getStatusCode();
			$report['codes'][$code] = ($report['codes'][$code] ?? 0) + 1;
		}
		ksort($report['codes'], SORT_STRING);
		return $report;
	}

	/**
	 * The request options for one command: the JSON body and, when a secret is set, the token
	 * in the body and in the header, as the onlyoffice app sends them.
	 *
	 * @return array{headers: array<string, string>, body: string}
	 */
	private function signed(array $data): array {
		$headers = ['Content-Type' => 'application/json'];
		$secret = $this->secret();
		if ($secret !== '') {
			$now = time();
			$times = ['iat' => $now, 'exp' => $now + self::JWT_MINUTES * 60];
			$header = $this->appConfig->getValueString(self::APP, 'jwt_header', '');
			$headers[$header === '' ? 'Authorization' : $header] = 'Bearer ' . self::jwt(['payload' => $data] + $times, $secret);
			$data += $times;
			$data['token'] = self::jwt($data, $secret);
		}
		return ['headers' => $headers, 'body' => (string)json_encode($data, JSON_UNESCAPED_SLASHES)];
	}

	/** The onlyoffice app's JWT secret: its app setting, or its block in config.php. */
	private function secret(): string {
		$secret = $this->appConfig->getValueString(self::APP, 'jwt_secret', '');
		if ($secret === '') {
			$system = $this->config->getSystemValue(self::APP, []);
			$secret = is_array($system) && is_string($system['jwt_secret'] ?? null) ? $system['jwt_secret'] : '';
		}
		return $secret;
	}

	/** A compact HS256 JSON Web Token. */
	private static function jwt(array $claims, #[\SensitiveParameter] string $secret): string {
		$part = static fn (string $bytes): string => rtrim(strtr(base64_encode($bytes), '+/', '-_'), '=');
		$signing = $part((string)json_encode(['alg' => 'HS256', 'typ' => 'JWT'])) . '.' . $part((string)json_encode($claims, JSON_UNESCAPED_SLASHES));
		return $signing . '.' . $part(hash_hmac('sha256', $signing, $secret, true));
	}
}
