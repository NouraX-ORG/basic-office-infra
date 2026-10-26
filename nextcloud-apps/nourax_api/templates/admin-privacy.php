<?php
/**
 * "Privacy between organisations" on the admin page "Nourax Workspace" (AdminSettings/
 * PrivacySettings). What it says about the settings comes from OrgPrivacySwitch, the same list
 * occ and configure.sh switch. js/admin-privacy.js runs the buttons and redraws the page from the
 * switch's answer; without it the page still shows the state.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/** @var array $_ */
/** @var \OCP\IL10N $l */
$status = $_['status'];
$state = $status['state'];
$labels = [
	'on' => $l->t('On'),
	'off' => $l->t('Off'),
	'mixed' => $l->t('Some settings differ'),
];
$appLabel = static fn (bool $enabled): string => $enabled ? 'enabled' : 'disabled';
?>
<div id="nourax-org-privacy" class="section nourax-privacy" data-state="<?php p($state); ?>">
	<h2><?php p($l->t('Privacy between organisations')); ?></h2>
	<p class="nourax-privacy__lead"><?php p($l->t('When this is On, people find, autocomplete and share only with people of their own organisation and teams. The organisations and teams are the ones NoMail manages.')); ?></p>

	<p class="nourax-privacy__now">
		<span><?php p($l->t('Now:')); ?></span>
		<strong id="nourax-privacy-pill" class="nourax-privacy__pill nourax-privacy__pill--<?php p($state); ?>"
			data-label-on="<?php p($labels['on']); ?>" data-label-off="<?php p($labels['off']); ?>"
			data-label-mixed="<?php p($labels['mixed']); ?>"><?php p($labels[$state]); ?></strong>
	</p>
	<p id="nourax-privacy-mixed" class="nourax-privacy__note"<?php if ($state !== 'mixed') { ?> hidden<?php } ?>>
		<?php p($l->t('Some settings below are neither where On nor where Off puts them, for example after a change by hand. Switching on or off sets all of them.')); ?>
	</p>

	<h3><?php p($l->t('When this is On')); ?></h3>
	<ul class="nourax-privacy__effects">
		<?php foreach ($_['effects'] as $text) { ?>
		<li><?php p($text); ?></li>
		<?php } ?>
	</ul>
	<p class="nourax-privacy__note"><?php p($_['on_note']); ?></p>

	<h3><?php p($l->t('When this is Off')); ?></h3>
	<p class="nourax-privacy__warning"><?php p($_['off_warning']); ?></p>

	<div class="nourax-privacy__buttons">
		<button type="button" id="nourax-privacy-on" class="primary" data-target="on"<?php if ($state === 'on') { ?> hidden<?php } ?>><?php p($l->t('Switch on')); ?></button>
		<button type="button" id="nourax-privacy-off" data-target="off"<?php if ($state === 'off') { ?> hidden<?php } ?>><?php p($l->t('Switch off')); ?></button>
	</div>
	<p id="nourax-privacy-message" class="nourax-privacy__message" role="status" aria-live="polite"></p>

	<details class="nourax-privacy__details">
		<summary><?php p($l->t('The settings this switch changes')); ?></summary>
		<div class="nourax-privacy__table">
			<table>
				<thead>
					<tr>
						<th scope="col"><?php p($l->t('Setting')); ?></th>
						<th scope="col"><?php p($l->t('On')); ?></th>
						<th scope="col"><?php p($l->t('Off')); ?></th>
						<th scope="col"><?php p($l->t('Now')); ?></th>
					</tr>
				</thead>
				<tbody>
					<?php foreach ($status['items'] as $item) { ?>
					<tr data-item="<?php p($item['id']); ?>">
						<td><code><?php p($item['app'] . ' ' . $item['key']); ?></code></td>
						<td><code><?php p($item['on']); ?></code></td>
						<td><code><?php p($item['off']); ?></code></td>
						<td class="nourax-privacy__value nourax-privacy__value--<?php p($item['now']); ?>"><code><?php p($item['now'] === 'not_used' ? 'app not enabled' : ($item['value'] ?? 'not set')); ?></code></td>
					</tr>
					<?php } ?>
					<?php foreach ($status['apps'] as $app => $info) { ?>
					<tr data-app="<?php p($app); ?>">
						<td><?php p($l->t('app')); ?> <code><?php p($app); ?></code></td>
						<td><code>disabled</code></td>
						<td><code>enabled</code></td>
						<td class="nourax-privacy__value"><code><?php p($appLabel((bool)$info['enabled'])); ?></code></td>
					</tr>
					<?php } ?>
				</tbody>
			</table>
		</div>
		<p class="nourax-privacy__note"><?php p($l->t('The server\'s setup script (scripts/configure.sh) and the command occ nourax_api:org-privacy switch this same list, and every setup run keeps the state chosen here.')); ?></p>
	</details>

	<h3><?php p($l->t('Recent changes')); ?></h3>
	<ul id="nourax-privacy-history" class="nourax-privacy__history" data-empty="<?php p($l->t('No changes recorded yet.')); ?>">
		<?php if ($_['history'] === []) { ?>
		<li class="nourax-privacy__empty"><?php p($l->t('No changes recorded yet.')); ?></li>
		<?php } ?>
		<?php foreach ($_['history'] as $row) { ?>
		<li><time datetime="<?php p($row['at']); ?>"><?php p($row['when']); ?></time> <?php p($row['text']); ?></li>
		<?php } ?>
	</ul>

	<dialog id="nourax-privacy-dialog" class="nourax-privacy__dialog">
		<form method="dialog">
			<div data-for="on" hidden>
				<h3 id="nourax-privacy-dialog-on"><?php p($l->t('Switch on privacy between organisations?')); ?></h3>
				<ul class="nourax-privacy__effects">
					<?php foreach ($_['effects'] as $text) { ?>
					<li><?php p($text); ?></li>
					<?php } ?>
				</ul>
				<p><?php p($_['on_note']); ?></p>
			</div>
			<div data-for="off" hidden>
				<h3 id="nourax-privacy-dialog-off"><?php p($l->t('Switch off privacy between organisations?')); ?></h3>
				<p class="nourax-privacy__warning"><?php p($_['off_warning']); ?></p>
			</div>
			<div class="nourax-privacy__dialog-buttons">
				<button type="submit" value="cancel"><?php p($l->t('Cancel')); ?></button>
				<button type="submit" value="confirm" id="nourax-privacy-confirm"
					data-label-on="<?php p($l->t('Switch on')); ?>" data-label-off="<?php p($l->t('Switch off')); ?>"><?php p($l->t('Switch on')); ?></button>
			</div>
		</form>
	</dialog>
</div>
