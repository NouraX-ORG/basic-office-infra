/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Personal settings > Appearance and accessibility: the Nourax theme previews.
 *
 * The theming app (Nextcloud 35) draws one picture per theme, <img src="/apps/theming/img/<id>.jpg">,
 * the address built in the browser from the theme's id. The upstream pictures show the upstream logo
 * and its blue header. This gives every such picture the Nourax preview of the same theme
 * (img/theme-previews/<id>.png, drawn by branding/theme-previews/make-previews.py) before the browser
 * has fetched the upstream one, so it never shows. A preview of a theme the app has no picture for
 * yet (one a later version adds) is hidden instead, keeping its place on the page.
 *
 * The addresses come from the page's initial state (nourax_branding / theme_previews: theme id =>
 * address), which lib/Middleware/UpstreamPagesMiddleware.php puts on this page only, together with
 * this script.
 */
(function () {
	'use strict'

	var input = document.getElementById('initial-state-nourax_branding-theme_previews')
	if (!input) {
		return
	}
	var previews
	try {
		previews = JSON.parse(atob(input.value))
	} catch (e) {
		return
	}
	if (!previews || typeof previews !== 'object') {
		return
	}

	// /apps/theming/img/light.jpg, also behind a web root and with ?v=...
	var UPSTREAM = /\/apps\/theming\/img\/([a-z0-9-]+)\.(?:jpe?g|png|webp)(?:[?#].*)?$/i

	function fix(img) {
		var match = UPSTREAM.exec(img.getAttribute('src') || '')
		if (!match) {
			return
		}
		var ours = Object.prototype.hasOwnProperty.call(previews, match[1]) ? previews[match[1]] : null
		if (typeof ours === 'string' && ours !== '') {
			img.setAttribute('src', ours)
		} else {
			img.style.setProperty('visibility', 'hidden', 'important')
		}
	}

	function scan(node) {
		if (node.nodeType !== 1) {
			return
		}
		if (node.tagName === 'IMG') {
			fix(node)
		}
		var imgs = node.getElementsByTagName('img')
		for (var i = 0; i < imgs.length; i++) {
			fix(imgs[i])
		}
	}

	// The settings page draws the previews with its own script, before or after this one runs.
	scan(document.documentElement)
	new MutationObserver(function (records) {
		for (var i = 0; i < records.length; i++) {
			var r = records[i]
			if (r.type === 'attributes') {
				if (r.target.tagName === 'IMG') {
					fix(r.target)
				}
			} else {
				for (var j = 0; j < r.addedNodes.length; j++) {
					scan(r.addedNodes[j])
				}
			}
		}
	}).observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['src'] })
})()
