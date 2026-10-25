/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * NoMail in the app menu opens in a new tab.
 *
 * The app menu of Nextcloud 35 has no "new tab" setting for an entry (only its own app store link
 * gets one), and NoMail must not be framed. So, just before the browser follows a click on any link
 * to the NoMail address, this marks the link target="_blank" rel="noopener noreferrer" and the
 * browser opens it in a new tab itself: no window.open, nothing a pop-up blocker could stop. The
 * mark is set again on every click because the menu redraws its links. Ctrl, Shift, Alt or Cmd
 * clicks and the middle button are left to the browser. Without this script the link still works,
 * in the same tab.
 *
 * The address comes from the page's initial state (nourax_branding / nomail_url), which
 * lib/Listener/PageScriptListener.php puts on every page of a signed-in person.
 */
(function () {
	'use strict'

	function nomailOrigin() {
		var input = document.getElementById('initial-state-nourax_branding-nomail_url')
		if (!input) {
			return null
		}
		try {
			return new URL(JSON.parse(atob(input.value))).origin
		} catch (e) {
			return null
		}
	}

	function onClick(event) {
		if (event.button !== 0 || event.ctrlKey || event.shiftKey || event.altKey || event.metaKey) {
			return
		}
		var start = event.target
		if (start && start.nodeType !== 1) {
			start = start.parentElement
		}
		var link = start && start.closest ? start.closest('a[href]') : null
		if (!link) {
			return
		}
		var origin = nomailOrigin()
		if (origin === null) {
			return
		}
		var target
		try {
			target = new URL(link.href, document.baseURI)
		} catch (e) {
			return
		}
		if (target.origin !== origin) {
			return
		}
		link.setAttribute('target', '_blank')
		link.setAttribute('rel', 'noopener noreferrer')
	}

	// Capture phase: this runs before any handler of the page itself.
	document.addEventListener('click', onClick, true)
})()
