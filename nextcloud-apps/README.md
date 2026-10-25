# Nourax's own Nextcloud apps

Each folder here is one small app (AGPL-3.0-or-later) written for Nourax Workspace.

- `compose.yaml` mounts this folder read-only at `/var/www/html/nourax_apps` in the `app` and `cron`
  containers.
- `config/nextcloud/zz-nourax.config.php` adds that folder to `apps_paths`, so Nextcloud finds the apps.
- An app is switched on by its `scripts/configure.d/NN-*.sh` step (`occ app:enable <id>`).

Changing an app: edit it here, commit, `git pull` on the server. PHP code is read on the next request;
run `occ upgrade` when the version in `appinfo/info.xml` goes up.
