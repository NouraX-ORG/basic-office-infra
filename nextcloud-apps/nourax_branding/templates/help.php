<?php
/**
 * The help page (Controller\HelpController), shown in the guest layout.
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/** @var array $_ */
/** @var \OCP\IL10N $l */
/** @var \OCP\Defaults $theme */
\OCP\Util::addStyle('nourax_branding', 'help');
?>
<div class="guest-box nourax-help">
	<h2><?php p($l->t('Help')); ?></h2>
	<p><?php p($l->t('Help pages for %s are on their way.', [$theme->getName()])); ?></p>
	<p><?php p($l->t('Until then, please ask the person who looks after your account.')); ?></p>
	<p class="nourax-help__back">
		<a class="button primary" href="<?php p($_['backUrl']); ?>"><?php p($l->t('Back to NoDrive')); ?></a>
	</p>
</div>
