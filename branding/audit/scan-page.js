// SPDX-License-Identifier: AGPL-3.0-or-later
// Browser audit scanner: finds the upstream name, links, logo and blue on the page that is open, the
// way a person sees it (rendered text, computed colours, pseudo-element labels). Read only.
//
// The file is one function expression. A runner (branding/audit/run-audit.mjs, Playwright) calls it as
//   const src = fs.readFileSync('branding/audit/scan-page.js', 'utf8');
//   const rules = JSON.parse(fs.readFileSync('nextcloud-apps/nourax_branding/sweep/rules.json', 'utf8'));
//   const result = await page.evaluate(`(${src})(${JSON.stringify(rules)}, {})`);
// options: {expectRtl: true|false (default: from <html lang>), maxFindings: 500}.
// It returns {url, title, lang, dir, rtlOk, elements, counts, findings: [{kind, where, snippet}],
// hidden: [...], pictures: [...]}; kind is name, link, blue, meta or rtl. Same rules as
// scripts/check-branding.sh. `pictures` lists every picture the page draws ({url, where, width,
// height, mask}: an <img>, an SVG <image>, a poster, a CSS background, border or list picture, and
// CSS masks, whose own colours are not drawn); run-audit.mjs then looks inside each one
// (branding/audit/scan-pictures.js): its pixels for the upstream blue, its bytes for an upstream file.
// An element of the page body that is not drawn at all (display: none on it or around it, so no box)
// cannot be seen, clicked or read out by a screen reader: what its attributes hold goes to `hidden`,
// not to `findings` (for example an upstream link that branding/custom.css hides). The <head> always
// counts: its icons, manifest and meta tags reach people through the browser.
function nouraxScanPage(rules, options) {
	'use strict';
	const opts = Object.assign({ expectRtl: null, maxFindings: 500 }, options || {});
	// rules.json patterns are written for Python and PCRE; JavaScript has no leading (?i).
	const toRegExp = (re, extra) => {
		let source = re;
		let flags = 'u' + (extra || '');
		if (source.startsWith('(?i)')) {
			source = source.slice(4);
			flags += 'i';
		}
		return new RegExp(source, flags);
	};
	const compile = (key, extra) => (rules[key] || []).map((p) => [p.id, toRegExp(p.re, extra)]);
	const NAME = compile('name_patterns', 'g');
	const LINK = compile('link_patterns');
	const ASSET = compile('asset_patterns');
	const BLUE = compile('blue_patterns', 'g');
	const ALLOW = (rules.allow || []).filter((a) => !a.area || a.area === 'audit').map((a) => {
		const out = {};
		for (const k of ['url', 'where', 'snippet']) {
			if (a[k]) out[k] = toRegExp(a[k]);
		}
		return out;
	});
	const host = location.hostname.toLowerCase();
	const findings = [];
	const hidden = [];
	// Drawn pictures by address; the biggest place each one is drawn in.
	const pictures = new Map();
	const picture = (where, raw, rect, mask) => {
		const u = String(raw || '').trim();
		if (!u || u.startsWith('#') || /^(javascript|about):/i.test(u)) return;
		let abs;
		try {
			abs = u.startsWith('data:') ? u : new URL(u, location.href).href;
		} catch (e) {
			return;
		}
		const next = { url: abs, where: String(where).slice(0, 120), width: Math.round(rect ? rect.width : 0), height: Math.round(rect ? rect.height : 0), mask: Boolean(mask) };
		const known = pictures.get(abs);
		if (known) {
			// A mask only while it is never drawn as a picture itself; the biggest place is kept.
			next.mask = known.mask && next.mask;
			if (known.width * known.height >= next.width * next.height) Object.assign(next, { where: known.where, width: known.width, height: known.height });
		}
		pictures.set(abs, next);
	};
	const counts = { name: 0, link: 0, blue: 0, meta: 0, rtl: 0 };
	const seen = new Set();
	// True while the attributes of an element that is not drawn are looked at.
	let notDrawn = false;

	const add = (kind, where, snippet) => {
		const s = String(snippet).replace(/\s+/g, ' ').trim().slice(0, 160);
		const w = String(where).slice(0, 120);
		const key = (notDrawn ? 'hidden|' : '') + kind + '|' + w + '|' + s;
		if (seen.has(key)) return;
		if (ALLOW.some((a) => (!a.url || a.url.test(location.href)) && (!a.where || a.where.test(w)) && (!a.snippet || a.snippet.test(s)))) return;
		seen.add(key);
		if (notDrawn) {
			if (hidden.length < opts.maxFindings) hidden.push({ kind, where: w, snippet: s });
			return;
		}
		counts[kind] += 1;
		if (findings.length < opts.maxFindings) findings.push({ kind, where: w, snippet: s });
	};
	const around = (s, i, j) => (i > 45 ? '…' : '') + s.slice(Math.max(0, i - 45), j + 70) + (j + 70 < s.length ? '…' : '');
	const scan = (kind, patterns, where, value) => {
		const s = String(value || '');
		if (!s) return;
		for (const [id, rx] of patterns) {
			rx.lastIndex = 0;
			let m;
			while ((m = rx.exec(s)) !== null) {
				add(kind, where + ' (' + id + ')', around(s, m.index, m.index + m[0].length));
				if (m[0].length === 0) rx.lastIndex += 1;
			}
		}
	};
	// near_name: spellings no pattern lists, found by their likeness to the name (the same check as
	// the sweep and scripts/check-branding.sh): a beginning of a Latin word that is at most max_distance
	// letters added, dropped, changed or swapped away from the word.
	const near = (() => {
		const n = rules.near_name;
		if (!n || !n.word) return null;
		const chars = Array.from(String(n.word).toLowerCase());
		const pairs = [...new Set(chars.slice(1).map((c, i) => chars[i] + c))];
		const distance = Math.max(0, n.max_distance ?? 2);
		const min = Math.max(1, n.min_length ?? chars.length - distance);
		return {
			chars, pairs, distance, min,
			need: Math.max(1, pairs.length - 3 * distance),
			max: Math.max(min, n.max_length ?? chars.length + distance),
			word: new RegExp('(?<!\\p{L})[A-Za-z\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u024F]{' + min + ',}', 'gu'),
		};
	})();
	const nearLength = (word) => {
		const lower = word.toLowerCase();
		if (near.pairs.filter((p) => lower.includes(p)).length < near.need) return 0;
		const a = Array.from(word).map((c) => c.toLowerCase());
		const t = near.chars;
		const tn = t.length;
		let prev2 = [];
		let prev = Array.from({ length: tn + 1 }, (_, j) => j);
		let best = Infinity;
		let bestLen = 0;
		for (let i = 1; i <= Math.min(a.length, near.max); i++) {
			const cur = [i];
			for (let j = 1; j <= tn; j++) {
				let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === t[j - 1] ? 0 : 1));
				if (i > 1 && j > 1 && a[i - 1] === t[j - 2] && a[i - 2] === t[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
				cur.push(v);
			}
			if (i >= near.min && cur[tn] <= best) {
				best = cur[tn];
				bestLen = i;
			}
			prev2 = prev;
			prev = cur;
		}
		return best <= near.distance ? bestLen : 0;
	};
	const nearHits = (s) => {
		if (!near) return [];
		const hits = [];
		near.word.lastIndex = 0;
		let m;
		while ((m = near.word.exec(s)) !== null) {
			const n = nearLength(m[0]);
			if (n) hits.push([m.index, m.index + Array.from(m[0]).slice(0, n).join('').length]);
		}
		return hits;
	};
	const names = (where, value) => {
		const s = String(value || '');
		scan('name', NAME, where, s);
		// Words a pattern found are reported once.
		const found = [];
		for (const [, rx] of NAME) {
			rx.lastIndex = 0;
			let m;
			while ((m = rx.exec(s)) !== null) {
				found.push([m.index, m.index + m[0].length]);
				if (m[0].length === 0) rx.lastIndex += 1;
			}
		}
		for (const [i, j] of nearHits(s)) {
			if (!found.some(([a, b]) => i < b && a < j)) add('name', where + ' (near_name)', around(s, i, j));
		}
	};
	const blues = (where, value) => scan('blue', BLUE, where, value);
	const urlProblem = (raw) => {
		const u = String(raw || '').trim();
		if (!u || u.startsWith('#') || /^(data|blob|javascript|about):/i.test(u)) return null;
		let abs;
		try {
			abs = new URL(/^www\./i.test(u) ? 'https://' + u : u, location.href);
		} catch (e) {
			return null;
		}
		for (const [id, rx] of LINK) {
			if (rx.test(abs.href)) return 'upstream link (' + id + ')';
		}
		const h = (abs.hostname || '').toLowerCase();
		if (h && h !== host) {
			let decoded = abs.href;
			try {
				decoded = decodeURIComponent(abs.href);
			} catch (e) {
				// keep the encoded form
			}
			for (const [id, rx] of NAME) {
				rx.lastIndex = 0;
				if (rx.test(decoded)) return 'outside link with the name (' + id + ')';
			}
			if (nearHits(decoded).length) return 'outside link with the name (near_name)';
		} else if (h === host) {
			for (const [id, rx] of ASSET) {
				if (rx.test(abs.pathname)) return 'upstream asset (' + id + ')';
			}
		}
		return null;
	};
	const link = (where, raw) => {
		const problem = urlProblem(raw);
		if (problem) add('link', where + ' ' + problem, raw);
	};
	const describe = (el) => {
		let d = el.tagName.toLowerCase();
		if (el.id) d += '#' + el.id;
		else if (el.classList && el.classList.length) d += '.' + Array.from(el.classList).slice(0, 2).join('.');
		return d;
	};

	// Every element, also inside open shadow roots.
	const all = [];
	const collect = (root) => {
		for (const el of root.querySelectorAll('*')) {
			all.push(el);
			if (el.shadowRoot) collect(el.shadowRoot);
		}
	};
	collect(document);

	names('title', document.title);
	names('text', document.body ? document.body.innerText : '');

	const TEXT_ATTRS = ['title', 'alt', 'aria-label', 'aria-description', 'placeholder', 'label'];
	const URL_ATTRS = ['href', 'src', 'srcset', 'action', 'formaction', 'poster', 'data'];
	const COLOUR_ATTRS = ['fill', 'stroke', 'stop-color', 'color', 'bgcolor', 'style'];
	const COLOUR_PROPS = ['color', 'background-color', 'border-top-color', 'border-right-color', 'border-bottom-color',
		'border-left-color', 'outline-color', 'fill', 'stroke', 'text-decoration-color', 'accent-color'];
	const IMAGE_PROPS = ['background-image', 'border-image-source', 'mask-image', '-webkit-mask-image', 'list-style-image'];

	const head = document.head;
	// SVG paint servers and the like (a gradient's <stop>, a pattern, a mask) never have a box of their
	// own: they are drawn wherever their <svg> is drawn.
	const PAINT = 'defs, linearGradient, radialGradient, pattern, mask, clipPath, marker, symbol, filter';
	const drawn = (el) => {
		if (el instanceof SVGElement && el.closest(PAINT)) {
			const svg = el.ownerSVGElement || el.closest('svg');
			return Boolean(svg) && svg.getClientRects().length > 0;
		}
		return el.getClientRects().length > 0;
	};
	for (const el of all) {
		const tag = describe(el);
		// Inside <body>: an element with no box at all is not drawn (see the top of this file).
		notDrawn = !(head && head.contains(el)) && el !== document.documentElement && el !== document.body
			&& !drawn(el);
		for (const a of TEXT_ATTRS) {
			const v = el.getAttribute(a);
			if (v) names(tag + '[' + a + ']', v);
		}
		if (el.tagName === 'INPUT' && /^(submit|button|reset)$/i.test(el.type || '') && el.value) names(tag + '[value]', el.value);
		for (const a of URL_ATTRS) {
			const v = el.getAttribute(a);
			if (!v) continue;
			if (a === 'srcset') {
				for (const part of v.split(',')) link(tag + '[srcset]', part.trim().split(/\s+/)[0]);
			} else {
				link(tag + '[' + a + ']', v);
			}
		}
		const xlink = el.getAttributeNS ? el.getAttributeNS('http://www.w3.org/1999/xlink', 'href') : null;
		if (xlink) link(tag + '[xlink:href]', xlink);
		if (el.tagName === 'META') {
			const n = (el.getAttribute('name') || el.getAttribute('property') || '').toLowerCase();
			if (n === 'apple-itunes-app') {
				add('meta', 'meta apple-itunes-app', el.outerHTML);
			} else if (n && n !== 'csp-nonce' && n !== 'viewport') {
				names('meta ' + n, el.getAttribute('content'));
				if (n === 'theme-color') blues('meta theme-color', el.getAttribute('content'));
			}
		}
		if (el.tagName === 'LINK' && el.getAttribute('color')) blues(tag + '[color]', el.getAttribute('color'));
		for (const a of COLOUR_ATTRS) {
			const v = el.getAttribute(a);
			if (!v) continue;
			// On SVG, fill, stroke and stop-color are presentation attributes: any CSS rule wins over
			// them, so what is drawn is the computed value (for example after branding/custom.css).
			if (el instanceof SVGElement && (a === 'fill' || a === 'stroke' || a === 'stop-color')) {
				let c = '';
				try {
					c = getComputedStyle(el).getPropertyValue(a);
				} catch (e) {
					c = '';
				}
				blues(tag + '[' + a + ']', c || v);
			} else {
				blues(tag + '[' + a + ']', v);
			}
		}
		notDrawn = false;
		let cs;
		try {
			cs = getComputedStyle(el);
		} catch (e) {
			continue;
		}
		// What is not drawn cannot be seen; a colour counts only where it is drawn.
		if (!cs || cs.display === 'none' || cs.visibility === 'hidden' || el.getClientRects().length === 0) continue;
		const hasText = Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.textContent.trim() !== '');
		for (const p of COLOUR_PROPS) {
			let drawn;
			if (p === 'color') drawn = hasText;
			else if (p === 'background-color') drawn = true;
			else if (p.startsWith('border-')) {
				const side = p.split('-')[1];
				drawn = cs.getPropertyValue('border-' + side + '-style') !== 'none' && parseFloat(cs.getPropertyValue('border-' + side + '-width')) > 0;
			} else if (p === 'outline-color') drawn = cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0;
			else if (p === 'text-decoration-color') drawn = hasText && !/^none/.test(cs.getPropertyValue('text-decoration-line'));
			else if (p === 'fill' || p === 'stroke') drawn = el instanceof SVGElement && cs.getPropertyValue(p) !== 'none';
			else if (p === 'accent-color') drawn = /^(INPUT|PROGRESS|METER)$/.test(el.tagName);
			else drawn = false;
			if (drawn) blues(tag + ' ' + p, cs.getPropertyValue(p));
		}
		const rect = el.getBoundingClientRect();
		for (const p of IMAGE_PROPS) {
			const v = cs.getPropertyValue(p);
			if (!v || v === 'none') continue;
			blues(tag + ' ' + p, v);
			for (const m of v.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)) {
				link(tag + ' ' + p, m[1]);
				picture(tag + ' ' + p, m[1], rect, p.includes('mask'));
			}
		}
		// The pictures themselves (their pixels are looked at by run-audit.mjs).
		if (el.tagName === 'IMG') picture(tag, el.currentSrc || el.getAttribute('src'), rect, false);
		else if (el.tagName === 'INPUT' && /^image$/i.test(el.type || '')) picture(tag, el.getAttribute('src'), rect, false);
		else if (el.tagName === 'VIDEO' && el.getAttribute('poster')) picture(tag + '[poster]', el.getAttribute('poster'), rect, false);
		else if (el instanceof SVGElement && el.tagName.toLowerCase() === 'image') {
			picture(tag, el.getAttribute('href') || (el.getAttributeNS ? el.getAttributeNS('http://www.w3.org/1999/xlink', 'href') : ''), rect, false);
		}
		// Labels drawn by CSS, such as the product names in the app menu.
		for (const pseudo of ['::before', '::after']) {
			let v;
			try {
				v = getComputedStyle(el, pseudo).getPropertyValue('content');
			} catch (e) {
				continue;
			}
			if (v && v !== 'none' && v !== 'normal') names(tag + pseudo, v);
		}
	}

	const html = document.documentElement;
	const lang = html.getAttribute('lang') || '';
	// The direction the content gets: a dir on <html> or <body>, else what CSS computes for <body>.
	const body = document.body || html;
	const dir = (html.getAttribute('dir') || body.getAttribute('dir') || getComputedStyle(body).direction || '').toLowerCase();
	const expectRtl = opts.expectRtl === null ? /^(ar|fa|he|ur|ug|ps|ckb|sd|yi)\b/i.test(lang) : Boolean(opts.expectRtl);
	const rtlOk = !expectRtl || dir === 'rtl';
	if (!rtlOk) add('rtl', 'html[dir]', 'lang="' + lang + '" but the page direction is ' + (dir || 'unset') + ', not rtl');

	return { url: location.href, title: document.title, lang, dir, rtlOk, elements: all.length, counts, findings, hidden, pictures: Array.from(pictures.values()).slice(0, 400) };
}
