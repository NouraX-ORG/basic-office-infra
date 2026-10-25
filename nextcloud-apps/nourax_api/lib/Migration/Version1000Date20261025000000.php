<?php

declare(strict_types=1);

/**
 * All of the app's tables, created at once in version 1.0.0 so later features need no schema
 * change. Times are Unix seconds. Ids are NoMail's ids (NoMail is the source of truth).
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\NouraxApi\Migration;

use Closure;
use OCP\DB\ISchemaWrapper;
use OCP\DB\Types;
use OCP\Migration\IOutput;
use OCP\Migration\SimpleMigrationStep;

class Version1000Date20261025000000 extends SimpleMigrationStep {
	public function changeSchema(IOutput $output, Closure $schemaClosure, array $options): ?ISchemaWrapper {
		/** @var ISchemaWrapper $schema */
		$schema = $schemaClosure();

		// An organisation: group "org:{org_id}" and its directory address book.
		if (!$schema->hasTable('nourax_api_orgs')) {
			$table = $schema->createTable('nourax_api_orgs');
			$table->addColumn('org_id', Types::STRING, ['notnull' => true, 'length' => 64]);
			$table->addColumn('name', Types::STRING, ['notnull' => true, 'length' => 255]);
			$table->addColumn('group_id', Types::STRING, ['notnull' => true, 'length' => 64]);
			$table->addColumn('addressbook_id', Types::BIGINT, ['notnull' => false]);
			$table->addColumn('version', Types::BIGINT, ['notnull' => true]);
			$table->addColumn('created_at', Types::BIGINT, ['notnull' => true]);
			$table->addColumn('updated_at', Types::BIGINT, ['notnull' => true]);
			$table->setPrimaryKey(['org_id']);
			$table->addUniqueIndex(['group_id'], 'nxapi_orgs_group');
		}

		// A team: locked group "team:{team_id}", its Team Folder, address book, calendar and board.
		if (!$schema->hasTable('nourax_api_teams')) {
			$table = $schema->createTable('nourax_api_teams');
			$table->addColumn('team_id', Types::STRING, ['notnull' => true, 'length' => 64]);
			$table->addColumn('org_id', Types::STRING, ['notnull' => true, 'length' => 64]);
			$table->addColumn('name', Types::STRING, ['notnull' => true, 'length' => 255]);
			$table->addColumn('group_id', Types::STRING, ['notnull' => true, 'length' => 64]);
			$table->addColumn('folder_id', Types::BIGINT, ['notnull' => false]);
			$table->addColumn('addressbook_id', Types::BIGINT, ['notnull' => false]);
			$table->addColumn('calendar_id', Types::BIGINT, ['notnull' => false]);
			$table->addColumn('board_id', Types::BIGINT, ['notnull' => false]);
			$table->addColumn('archived', Types::SMALLINT, ['notnull' => true, 'default' => 0]);
			$table->addColumn('version', Types::BIGINT, ['notnull' => true]);
			$table->addColumn('created_at', Types::BIGINT, ['notnull' => true]);
			$table->addColumn('updated_at', Types::BIGINT, ['notnull' => true]);
			$table->setPrimaryKey(['team_id']);
			$table->addIndex(['org_id'], 'nxapi_teams_org');
			$table->addUniqueIndex(['group_id'], 'nxapi_teams_group');
		}

		// A person's desired state; user_id is the account's uid (the Supabase user id).
		if (!$schema->hasTable('nourax_api_people')) {
			$table = $schema->createTable('nourax_api_people');
			$table->addColumn('user_id', Types::STRING, ['notnull' => true, 'length' => 64]);
			$table->addColumn('org_id', Types::STRING, ['notnull' => false, 'length' => 64]);
			$table->addColumn('email', Types::STRING, ['notnull' => false, 'length' => 320]);
			$table->addColumn('display_name', Types::STRING, ['notnull' => false, 'length' => 255]);
			$table->addColumn('active', Types::SMALLINT, ['notnull' => true, 'default' => 1]);
			$table->addColumn('version', Types::BIGINT, ['notnull' => true]);
			$table->addColumn('disabled_at', Types::BIGINT, ['notnull' => false]);
			$table->addColumn('delete_after', Types::BIGINT, ['notnull' => false]);
			// 1 = keep the account even after delete_after (e.g. an admin asked for a transfer first).
			$table->addColumn('hold', Types::SMALLINT, ['notnull' => true, 'default' => 0]);
			$table->addColumn('created_at', Types::BIGINT, ['notnull' => true]);
			$table->addColumn('updated_at', Types::BIGINT, ['notnull' => true]);
			$table->setPrimaryKey(['user_id']);
			$table->addIndex(['org_id'], 'nxapi_people_org');
			$table->addIndex(['delete_after'], 'nxapi_people_delete');
		}

		// Team membership: role "member" or "lead".
		if (!$schema->hasTable('nourax_api_members')) {
			$table = $schema->createTable('nourax_api_members');
			$table->addColumn('team_id', Types::STRING, ['notnull' => true, 'length' => 64]);
			$table->addColumn('user_id', Types::STRING, ['notnull' => true, 'length' => 64]);
			$table->addColumn('role', Types::STRING, ['notnull' => true, 'length' => 16]);
			$table->addColumn('joined_at', Types::BIGINT, ['notnull' => true]);
			$table->setPrimaryKey(['team_id', 'user_id']);
			$table->addIndex(['user_id'], 'nxapi_members_user');
		}

		// Admin API nonces, remembered for 10 minutes so a signed request cannot be replayed.
		if (!$schema->hasTable('nourax_api_nonces')) {
			$table = $schema->createTable('nourax_api_nonces');
			$table->addColumn('nonce', Types::STRING, ['notnull' => true, 'length' => 128]);
			$table->addColumn('expires_at', Types::BIGINT, ['notnull' => true]);
			$table->setPrimaryKey(['nonce']);
			$table->addIndex(['expires_at'], 'nxapi_nonces_expires');
		}

		// Group changes made outside this API (GroupDriftListener), until reconcile fixes them.
		if (!$schema->hasTable('nourax_api_drift')) {
			$table = $schema->createTable('nourax_api_drift');
			$table->addColumn('id', Types::BIGINT, ['autoincrement' => true, 'notnull' => true, 'unsigned' => true]);
			$table->addColumn('at', Types::BIGINT, ['notnull' => true]);
			$table->addColumn('kind', Types::STRING, ['notnull' => true, 'length' => 32]);
			$table->addColumn('group_id', Types::STRING, ['notnull' => true, 'length' => 64]);
			$table->addColumn('user_id', Types::STRING, ['notnull' => false, 'length' => 64]);
			$table->addColumn('fixed_at', Types::BIGINT, ['notnull' => false]);
			$table->setPrimaryKey(['id']);
			$table->addIndex(['fixed_at'], 'nxapi_drift_fixed');
		}

		// One row per API call. Never a body, never a key.
		if (!$schema->hasTable('nourax_api_audit')) {
			$table = $schema->createTable('nourax_api_audit');
			$table->addColumn('id', Types::BIGINT, ['autoincrement' => true, 'notnull' => true, 'unsigned' => true]);
			$table->addColumn('at', Types::BIGINT, ['notnull' => true]);
			$table->addColumn('key_id', Types::STRING, ['notnull' => true, 'length' => 16]);
			$table->addColumn('method', Types::STRING, ['notnull' => true, 'length' => 8]);
			$table->addColumn('route', Types::STRING, ['notnull' => true, 'length' => 128]);
			$table->addColumn('target', Types::STRING, ['notnull' => false, 'length' => 128]);
			$table->addColumn('http_status', Types::INTEGER, ['notnull' => true]);
			$table->addColumn('result', Types::STRING, ['notnull' => false, 'length' => 32]);
			$table->addColumn('remote_ip', Types::STRING, ['notnull' => true, 'length' => 64]);
			$table->addColumn('duration_ms', Types::INTEGER, ['notnull' => true]);
			$table->setPrimaryKey(['id']);
			$table->addIndex(['at'], 'nxapi_audit_at');
			$table->addIndex(['target'], 'nxapi_audit_target');
		}

		return $schema;
	}
}
