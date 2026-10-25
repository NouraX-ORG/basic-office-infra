<?php
/**
 * Nourax Workspace settings, layered on top of the config files shipped by the Nextcloud image.
 *
 * Nextcloud merges config.php and then every *.config.php in natural sort order
 * (array_replace_recursive), so this file wins over s3.config.php and redis.config.php.
 * It is mounted read-only at /opt/nourax/config and copied into place by config/hooks/10-nourax-config.sh
 * on every container start: change it here, commit, pull on the server, then `docker compose up -d`.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
$CONFIG = [
	// Cloudflare R2 as primary object storage. The basic keys (host, bucket, keys, region "auto",
	// path style) come from OBJECTSTORE_S3_* in compose.yaml; these are the extras R2 needs.
	'objectstore' => [
		'arguments' => [
			// The bucket is created in Cloudflare beforehand; the token is scoped to that one bucket.
			'verify_bucket_exists' => false,
			// Server-side multipart uploads use equal 100 MiB parts (R2 needs equal-size parts).
			'uploadPartSize' => 104857600,
			'concurrency' => 3,
			'retriesMaxAttempts' => 5,
			// Already the default since Nextcloud 32; kept explicit for S3-compatible stores.
			'request_checksum_calculation' => 'when_required',
			'response_checksum_validation' => 'when_required',
		],
	],

	// Cloudflare refuses request bodies over 100 MB on the Free plan. 50 MiB chunks stay under it,
	// and both the web uploader and the desktop app read this value. Each chunk becomes one R2 part.
	'files.chunked_upload.max_size' => 52428800,

	// Apps and API clients must use app passwords or session tokens, never the login password.
	'token_auth_enforced' => true,
	'auth.bruteforce.protection.enabled' => true,
	'ratelimit.protection.enabled' => true,
	// NoMail creates share links on behalf of the owner; the default is 20 per 10 minutes.
	'ratelimit_overwrite' => [
		'files_sharing.shareapi.createshare' => ['user' => ['limit' => 120, 'period' => 600]],
	],

	// No "get your own free account" advert on public share pages.
	'simpleSignUpLink.shown' => false,

	// Open NoDrive after login (the Dashboard app is switched off).
	'defaultapp' => 'files',

	// Smaller thumbnails: less CPU to make them and less R2 space to keep them (default 4096).
	'preview_max_x' => 2048,
	'preview_max_y' => 2048,

	// White label: no help links to the upstream manual, and no update checks or lookups at the
	// upstream project's servers. Updates come as new Docker images (scripts/update.sh).
	'knowledgebaseenabled' => false,
	'updatechecker' => false,
	'upgrade.disable-web' => true,
	'lookup_server' => '',

	// New accounts start with the Nourax welcome files instead of the stock sample files.
	'skeletondirectory' => '/opt/nourax/branding/skeleton',
	'templatedirectory' => '',

	'default_language' => 'en_GB',
	'default_locale' => 'en_GB',
	'default_phone_region' => 'GB',
	'default_timezone' => 'Europe/London',
	'logtimezone' => 'Europe/London',
	'loglevel' => 2,

	// Heavy daily background jobs run between 01:00 and 05:00 UTC.
	'maintenance_window_start' => 1,

	// Nourax's own apps (nextcloud-apps/ in this repo), mounted read-only by compose.yaml. Entries 0 and
	// 1 (apps, custom_apps) come from the image's apps.config.php; the configs merge by index.
	'apps_paths' => [
		2 => [
			'path' => '/var/www/html/nourax_apps',
			'url' => '/nourax_apps',
			'writable' => false,
		],
	],

	// The ONLYOFFICE connector talks to the editor over the Docker network (http://onlyoffice/);
	// since connector 10.2.0 the admin page refuses such a local address without this.
	'onlyoffice' => [
		'allow_local_address' => true,
	],
];
