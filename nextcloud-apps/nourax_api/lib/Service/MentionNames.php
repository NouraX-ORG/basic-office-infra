<?php

declare(strict_types=1);

/**
 * The names in a NoBoard (Deck) card comment's mentions (docs/teams.md "Every place people meet").
 *
 * Deck answers each comment with its mentions, [{mentionId, mentionType, mentionDisplayName}],
 * and fills mentionDisplayName with the server's name for that account, whoever wrote "@<id>"
 * (Deck 1.19.1 CommentService::formatComment). OrgShareMiddleware rewrites Deck's rendered OCS
 * answer (JSON or XML) with this class: for a person the reader may not see, the name becomes the
 * id, which is what the comment's author typed. Nothing else in the answer changes.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\NouraxApi\Service;

final class MentionNames {
	/** The mention type of an account (OCP\Comments\IComment::getMentions). */
	private const USER = 'user';

	/**
	 * @param string $output Deck's rendered OCS answer
	 * @param callable(string): bool $visible whether the reader may see the account with this id
	 * @return ?string the answer with the hidden names replaced, or null when nothing changes
	 */
	public static function hide(string $output, callable $visible): ?string {
		$start = ltrim($output);
		if (str_starts_with($start, '{')) {
			return self::hideJson($output, $visible);
		}
		if (str_starts_with($start, '<')) {
			return self::hideXml($output, $visible);
		}
		return null;
	}

	/** JSON as the server renders OCS answers (json_encode with JSON_HEX_TAG), objects kept as objects. */
	private static function hideJson(string $output, callable $visible): ?string {
		$data = json_decode($output);
		if (!is_object($data)) {
			return null;
		}
		$changed = false;
		self::walk($data, $visible, $changed);
		return $changed ? (string)json_encode($data, JSON_HEX_TAG) : null;
	}

	private static function walk(mixed &$node, callable $visible, bool &$changed): void {
		if (is_object($node)) {
			if (isset($node->mentionId, $node->mentionType) && property_exists($node, 'mentionDisplayName')
				&& $node->mentionType === self::USER && is_scalar($node->mentionId)
				&& !$visible((string)$node->mentionId) && $node->mentionDisplayName !== (string)$node->mentionId) {
				$node->mentionDisplayName = (string)$node->mentionId;
				$changed = true;
			}
			foreach ($node as &$child) {
				self::walk($child, $visible, $changed);
			}
		} elseif (is_array($node)) {
			foreach ($node as &$child) {
				self::walk($child, $visible, $changed);
			}
		}
	}

	/** XML as the server renders OCS answers: <mentions><element><mentionId>... per mention. */
	private static function hideXml(string $output, callable $visible): ?string {
		$doc = new \DOMDocument();
		if (!@$doc->loadXML($output, LIBXML_NONET)) {
			return null;
		}
		$changed = false;
		foreach ((new \DOMXPath($doc))->query('//element[mentionId and mentionType and mentionDisplayName]') ?: [] as $mention) {
			$fields = [];
			foreach ($mention->childNodes as $child) {
				if ($child instanceof \DOMElement) {
					$fields[$child->nodeName] ??= $child;
				}
			}
			$id = $fields['mentionId']->textContent;
			if ($fields['mentionType']->textContent === self::USER && !$visible($id)
				&& $fields['mentionDisplayName']->textContent !== $id) {
				$fields['mentionDisplayName']->textContent = $id;
				$changed = true;
			}
		}
		return $changed ? (string)$doc->saveXML() : null;
	}
}
