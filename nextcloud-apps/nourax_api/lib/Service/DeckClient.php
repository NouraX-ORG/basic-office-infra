<?php

declare(strict_types=1);

/**
 * The team board (NoBoard, the Deck app): "Team: <name>", Nourax cobalt, owned by the service
 * account and shared with the team's group (members may edit cards, not share or manage).
 *
 * Deck's PHP services work only for a signed-in user, so this talks to Deck's REST API
 * (/index.php/apps/deck/api/v1.0) on this same server over the compose network (http://app),
 * signed in as the service account with its app password (Basic auth, OCS-APIRequest: true).
 * Nothing leaves the server.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\NouraxApi\Service;

use OCA\NouraxApi\Settings;
use OCP\Http\Client\IClientService;

class DeckClient {
	public const COLOR = '2563EB';
	/** Deck allows board titles of at most 100 characters. */
	public const MAX_TITLE = 100;
	/** Deck's ACL type for a group. */
	public const ACL_GROUP = 1;

	private const API = '/index.php/apps/deck/api/v1.0';

	public function __construct(
		private IClientService $clients,
		private ServiceAccountService $account,
		private Settings $settings,
	) {
	}

	public static function title(string $title): string {
		return mb_substr($title, 0, self::MAX_TITLE);
	}

	/**
	 * Makes sure the board exists with this title, colour, not archived. A board that is gone
	 * (deleted outside the API) is made again.
	 *
	 * @return array{0: int, 1: string, 2: string, 3: array} [board id, result, detail, board]
	 */
	public function ensureBoard(?int $boardId, string $title, bool $archived = false): array {
		$title = self::title($title);
		$board = $boardId === null ? null : $this->board($boardId);
		if ($board === null) {
			[$status, $board] = $this->call('POST', '/boards', ['title' => $title, 'color' => self::COLOR]);
			if ($status !== 200 || !is_int($board['id'] ?? null)) {
				throw new StepFailed('Deck did not make the board (HTTP ' . $status . ')');
			}
			if ($archived) {
				$this->update($board['id'], $title, true);
			}
			return [$board['id'], Steps::CREATED, 'board ' . $board['id'], $board];
		}

		if ((string)($board['title'] ?? '') === $title
			&& strcasecmp((string)($board['color'] ?? ''), self::COLOR) === 0
			&& (bool)($board['archived'] ?? false) === $archived) {
			return [(int)$board['id'], Steps::UNCHANGED, 'board ' . $board['id'], $board];
		}
		$this->update((int)$board['id'], $title, $archived);
		return [(int)$board['id'], Steps::UPDATED, 'board ' . $board['id'] . ' renamed', $board];
	}

	/**
	 * Makes sure the board is shared with the group: may edit, may not share or manage.
	 *
	 * @param array $board the board as Deck returns it (with its "acl" list)
	 * @return array{0: string, 1: string} [result, detail]
	 */
	public function ensureGroupAcl(array $board, string $groupId): array {
		$boardId = (int)$board['id'];
		$wanted = ['permissionEdit' => true, 'permissionShare' => false, 'permissionManage' => false];
		$acl = self::groupAcl($board, $groupId);
		if ($acl === null) {
			[$status] = $this->call('POST', '/boards/' . $boardId . '/acl',
				['type' => self::ACL_GROUP, 'participant' => $groupId] + $wanted);
			if ($status !== 200) {
				throw new StepFailed('Deck did not share the board (HTTP ' . $status . ')');
			}
			return [Steps::CREATED, 'edit for ' . $groupId];
		}
		foreach ($wanted as $key => $value) {
			if ((bool)($acl[$key] ?? false) !== $value) {
				[$status] = $this->call('PUT', '/boards/' . $boardId . '/acl/' . (int)$acl['id'], $wanted);
				if ($status !== 200) {
					throw new StepFailed('Deck did not change the board share (HTTP ' . $status . ')');
				}
				return [Steps::UPDATED, 'edit for ' . $groupId];
			}
		}
		return [Steps::UNCHANGED, 'edit for ' . $groupId];
	}

	/** The board, or null when it is gone. */
	public function board(int $boardId): ?array {
		[$status, $board] = $this->call('GET', '/boards/' . $boardId);
		if ($status === 200 && is_int($board['id'] ?? null) && empty($board['deletedAt'])) {
			return $board;
		}
		if ($status === 200 || $status === 403 || $status === 404) {
			return null;
		}
		throw new StepFailed('Deck answered HTTP ' . $status);
	}

	/** @return array{id: ?int, exists: bool, title?: string, archived?: bool, shared_edit?: bool} */
	public function describe(?int $boardId, string $groupId): array {
		$board = $boardId === null ? null : $this->board($boardId);
		if ($board === null) {
			return ['id' => $boardId, 'exists' => false];
		}
		$acl = self::groupAcl($board, $groupId);
		return [
			'id' => $boardId,
			'exists' => true,
			'title' => (string)($board['title'] ?? ''),
			'archived' => (bool)($board['archived'] ?? false),
			'shared_edit' => $acl !== null && (bool)($acl['permissionEdit'] ?? false),
		];
	}

	private function update(int $boardId, string $title, bool $archived): void {
		[$status] = $this->call('PUT', '/boards/' . $boardId, ['title' => $title, 'color' => self::COLOR, 'archived' => $archived]);
		if ($status !== 200) {
			throw new StepFailed('Deck did not change the board (HTTP ' . $status . ')');
		}
	}

	/** The board's ACL entry for the group, if any. */
	private static function groupAcl(array $board, string $groupId): ?array {
		foreach (($board['acl'] ?? []) as $acl) {
			if (!is_array($acl) || (int)($acl['type'] ?? -1) !== self::ACL_GROUP) {
				continue;
			}
			$participant = $acl['participant'] ?? null;
			$id = is_array($participant) ? ($participant['primaryKey'] ?? $participant['uid'] ?? null) : $participant;
			if ($id === $groupId) {
				return $acl;
			}
		}
		return null;
	}

	/**
	 * One call to Deck's REST API. Never throws for an HTTP error status; the caller decides.
	 *
	 * @return array{0: int, 1: array} [HTTP status, decoded JSON body or []]
	 */
	private function call(string $method, string $path, ?array $json = null): array {
		[$uid, $password] = $this->account->credentials();
		$options = [
			'auth' => [$uid, $password],
			'headers' => ['OCS-APIRequest' => 'true', 'Accept' => 'application/json'],
			'timeout' => 20,
			'connect_timeout' => 5,
			'http_errors' => false,
			'nextcloud' => ['allow_local_address' => true],
		];
		if ($json !== null) {
			$options['json'] = $json;
		}
		$url = $this->settings->loopbackUrl() . self::API . $path;
		$client = $this->clients->newClient();
		$response = match ($method) {
			'GET' => $client->get($url, $options),
			'POST' => $client->post($url, $options),
			'PUT' => $client->put($url, $options),
		};
		$data = json_decode((string)$response->getBody(), true);
		return [$response->getStatusCode(), is_array($data) ? $data : []];
	}
}
