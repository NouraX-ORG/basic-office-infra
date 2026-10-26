/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The "Privacy between organisations" switch on the admin page "Nourax Workspace"
 * (templates/admin-privacy.php).
 *
 * Switch on / Switch off opens a confirmation that says what changes. "Switch ..." in it then asks
 * for the admin's password when the server wants a fresh confirmation (the server's own dialog;
 * signing in counts for 30 minutes), and sends POST /apps/nourax_api/settings/org-privacy with the
 * page's CSRF token. The answer redraws the state, the buttons, the settings table and the recent
 * changes. Every text it shows is in the template, except the short messages below.
 */
(function () {
	'use strict'

	var root, dialog, confirmButton, message, buttons
	var target = null
	var busy = false

	function tr(text) {
		return typeof window.t === 'function' ? window.t('nourax_api', text) : text
	}

	function config() {
		var input = document.getElementById('initial-state-nourax_api-org-privacy')
		if (!input) {
			return null
		}
		try {
			return JSON.parse(atob(input.value))
		} catch (e) {
			return null
		}
	}

	function requestToken() {
		if (window.OC && window.OC.requestToken) {
			return window.OC.requestToken
		}
		return document.head.getAttribute('data-requesttoken') || ''
	}

	function say(text, isError) {
		message.textContent = text
		message.classList.toggle('nourax-privacy__message--error', !!isError)
	}

	function setBusy(on) {
		busy = on
		buttons.forEach(function (button) {
			button.disabled = on
		})
	}

	function render(view) {
		var status = view && view.status
		if (!status) {
			return
		}
		var state = status.state
		root.setAttribute('data-state', state)

		var pill = document.getElementById('nourax-privacy-pill')
		pill.className = 'nourax-privacy__pill nourax-privacy__pill--' + state
		pill.textContent = pill.getAttribute('data-label-' + state) || state
		document.getElementById('nourax-privacy-mixed').hidden = state !== 'mixed'
		document.getElementById('nourax-privacy-on').hidden = state === 'on'
		document.getElementById('nourax-privacy-off').hidden = state === 'off'

		;(status.items || []).forEach(function (item) {
			var row = root.querySelector('tr[data-item="' + CSS.escape(item.id) + '"]')
			var cell = row && row.querySelector('.nourax-privacy__value')
			if (cell) {
				cell.className = 'nourax-privacy__value nourax-privacy__value--' + item.now
				cell.querySelector('code').textContent = item.now === 'not_used'
					? 'app not enabled'
					: (item.value === null ? 'not set' : item.value)
			}
		})
		Object.keys(status.apps || {}).forEach(function (app) {
			var row = root.querySelector('tr[data-app="' + CSS.escape(app) + '"]')
			var cell = row && row.querySelector('.nourax-privacy__value code')
			if (cell) {
				cell.textContent = status.apps[app].enabled ? 'enabled' : 'disabled'
			}
		})

		var list = document.getElementById('nourax-privacy-history')
		list.textContent = ''
		var history = view.history || []
		if (history.length === 0) {
			var empty = document.createElement('li')
			empty.className = 'nourax-privacy__empty'
			empty.textContent = list.getAttribute('data-empty')
			list.appendChild(empty)
		}
		history.forEach(function (row) {
			var li = document.createElement('li')
			var time = document.createElement('time')
			time.setAttribute('datetime', row.at)
			time.textContent = row.when
			li.appendChild(time)
			li.appendChild(document.createTextNode(' ' + row.text))
			list.appendChild(li)
		})
	}

	// The server's password confirmation, when it wants one (OC.PasswordConfirmation).
	function withPassword(force, go) {
		var pc = window.OC && window.OC.PasswordConfirmation
		if (!pc || (!force && !pc.requiresPasswordConfirmation())) {
			go()
			return
		}
		pc.requirePasswordConfirmation(go, {}, function () {
			setBusy(false)
			say(tr('The password was not confirmed, so nothing was changed.'), true)
		})
	}

	function send(state, retried) {
		var url = config() && config().url
		if (!url) {
			setBusy(false)
			say(tr('The page is missing its address; reload it and try again.'), true)
			return
		}
		fetch(url, {
			method: 'POST',
			credentials: 'same-origin',
			headers: {
				'Content-Type': 'application/json',
				Accept: 'application/json',
				requesttoken: requestToken(),
			},
			body: JSON.stringify({ state: state }),
		}).then(function (response) {
			return response.json().catch(function () {
				return {}
			}).then(function (body) {
				return { status: response.status, body: body }
			})
		}).then(function (answer) {
			var body = answer.body || {}
			if (answer.status === 403 && !retried && /password confirmation/i.test(body.message || '')) {
				withPassword(true, function () {
					send(state, true)
				})
				return
			}
			setBusy(false)
			if (answer.status === 200) {
				render(body)
				if (body.result === 'unchanged') {
					say(tr('Nothing needed changing: it was already in that state.'), false)
				} else {
					say(state === 'on'
						? tr('Privacy between organisations is now On.')
						: tr('Privacy between organisations is now Off.'), false)
				}
				return
			}
			if (body.status) {
				render(body)
			}
			say(body.message || (tr('The switch was refused (HTTP ') + answer.status + ').'), true)
		}).catch(function () {
			setBusy(false)
			say(tr('The server could not be reached. Reload the page to see the state now.'), true)
		})
	}

	function openDialog(state) {
		target = state
		dialog.querySelectorAll('[data-for]').forEach(function (part) {
			part.hidden = part.getAttribute('data-for') !== state
		})
		dialog.setAttribute('aria-labelledby', 'nourax-privacy-dialog-' + state)
		confirmButton.textContent = confirmButton.getAttribute('data-label-' + state)
		confirmButton.className = state === 'off' ? 'nourax-privacy__danger' : 'primary'
		dialog.returnValue = ''
		dialog.showModal()
	}

	function start() {
		root = document.getElementById('nourax-org-privacy')
		if (!root) {
			return
		}
		dialog = document.getElementById('nourax-privacy-dialog')
		confirmButton = document.getElementById('nourax-privacy-confirm')
		message = document.getElementById('nourax-privacy-message')
		buttons = Array.prototype.slice.call(root.querySelectorAll('button[data-target]'))

		buttons.forEach(function (button) {
			button.addEventListener('click', function () {
				if (!busy) {
					openDialog(button.getAttribute('data-target'))
				}
			})
		})
		dialog.addEventListener('close', function () {
			if (dialog.returnValue !== 'confirm' || (target !== 'on' && target !== 'off')) {
				return
			}
			var state = target
			setBusy(true)
			say(tr('Switching ...'), false)
			withPassword(false, function () {
				send(state, false)
			})
		})
	}

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', start)
	} else {
		start()
	}
})()
