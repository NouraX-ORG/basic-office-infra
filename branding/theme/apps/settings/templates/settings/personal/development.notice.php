<?php
/**
 * Nourax Workspace: the notice at the end of Personal settings > Profile and contact. It takes the
 * place of the upstream's notice (the settings app's templates/settings/personal/development.notice.php,
 * with the upstream's community, social media, blog and newsletter links and its "Reasons to use"
 * PDF): Nextcloud 35 looks for app templates in the theme folder first. scripts/branding-sweep.sh
 * copies branding/theme into themes/nourax; see docs/branding.md.
 *
 * It offers the source code, as the GNU AGPL (section 13) asks of software that people use over a
 * network. The texts are the nourax_branding app's, so they are translated with that app.
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/** @var \OCP\Defaults $theme */
$nouraxL10n = \OCP\Server::get(\OCP\L10N\IFactory::class)->get('nourax_branding');
?>
<div class="section development-notice">
	<p>
		<?php print_unescaped(str_replace(
			['{sourceopen}', '{licenseopen}', '{linkclose}'],
			[
				'<a href="https://github.com/NouraX-ORG/basic-office-infra" target="_blank" rel="noreferrer noopener">',
				'<a href="https://www.gnu.org/licenses/agpl-3.0.html" target="_blank" rel="noreferrer noopener">',
				'</a>',
			],
			\OCP\Util::sanitizeHTML($nouraxL10n->t('%s is open-source software: get its {sourceopen}source code{linkclose}, licensed under the {licenseopen}GNU AGPL{linkclose}.', [$theme->getName()]))
		)); ?>
	</p>
</div>
