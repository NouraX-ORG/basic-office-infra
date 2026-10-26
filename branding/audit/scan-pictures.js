// SPDX-License-Identifier: AGPL-3.0-or-later
// Browser audit: looks inside the pictures a page draws (docs/branding.md, "Browser audit"). Read only.
//
// branding/audit/scan-page.js lists the pictures (their addresses); a picture can show the upstream
// logo or blue without its address or alt text saying so, as the theme previews of the theming app
// did. The file is one async function expression. run-audit.mjs calls it in the page's frame:
//   await frame.evaluate(`(${src})(${JSON.stringify(urls)}, {})`)
// For each address (same origin as the frame, or a data: address) it fetches the picture the way the
// page does, with the page's cookies, and returns {url, status, type, bytes, sha256, svg, width,
// height, pixels, opaque, blue}: `sha256` of the bytes (run-audit.mjs compares it with the upstream
// files in rules.json), and `blue`, the number of pixels within `tolerance` (distance in RGB) of an
// upstream blue among the `opaque` ones (alpha 128 or more), on a copy at most `maxSide` pixels wide
// or high. A picture that cannot be read gets `error`.
async function nouraxScanPictures(urls, options) {
	'use strict';
	const opts = Object.assign({ tolerance: 28, maxSide: 512, timeout: 15000, blues: [[0, 130, 201], [0, 103, 158]] }, options || {});
	const tol2 = opts.tolerance * opts.tolerance;
	const hex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
	// A decoded picture that a canvas can draw.
	const decode = async (blob, svg) => {
		if (!svg && typeof createImageBitmap === 'function') {
			try {
				const bmp = await createImageBitmap(blob);
				return { source: bmp, width: bmp.width, height: bmp.height, done: () => bmp.close() };
			} catch (e) {
				// Some formats only an <img> can decode; try that below.
			}
		}
		const address = URL.createObjectURL(blob);
		const img = new Image();
		img.src = address;
		try {
			await img.decode();
		} catch (e) {
			URL.revokeObjectURL(address);
			throw e;
		}
		// An SVG without a size of its own is drawn at 256x256.
		return { source: img, width: img.naturalWidth || 256, height: img.naturalHeight || 256, done: () => URL.revokeObjectURL(address) };
	};
	const out = [];
	for (const url of urls) {
		const r = { url };
		try {
			const stop = new AbortController();
			const timer = setTimeout(() => stop.abort(), opts.timeout);
			let resp;
			try {
				resp = await fetch(url, { credentials: 'same-origin', signal: stop.signal });
			} finally {
				clearTimeout(timer);
			}
			r.status = resp.status;
			if (!resp.ok) {
				out.push(r);
				continue;
			}
			const buf = await resp.arrayBuffer();
			r.type = resp.headers.get('content-type') || '';
			r.bytes = buf.byteLength;
			r.sha256 = hex(await crypto.subtle.digest('SHA-256', buf));
			const head = new TextDecoder().decode(new Uint8Array(buf, 0, Math.min(buf.byteLength, 1024)));
			r.svg = /svg/i.test(r.type) || /<svg[\s>]/i.test(head);
			const pic = await decode(new Blob([buf], { type: r.svg ? 'image/svg+xml' : (r.type || 'application/octet-stream') }), r.svg);
			try {
				r.width = pic.width;
				r.height = pic.height;
				const scale = Math.min(1, opts.maxSide / Math.max(pic.width, pic.height, 1));
				const w = Math.max(1, Math.round(pic.width * scale));
				const h = Math.max(1, Math.round(pic.height * scale));
				const canvas = document.createElement('canvas');
				canvas.width = w;
				canvas.height = h;
				const ctx = canvas.getContext('2d', { willReadFrequently: true });
				ctx.drawImage(pic.source, 0, 0, w, h);
				const data = ctx.getImageData(0, 0, w, h).data;
				let opaque = 0;
				let blue = 0;
				for (let i = 0; i < data.length; i += 4) {
					if (data[i + 3] < 128) continue;
					opaque += 1;
					for (const [br, bg, bb] of opts.blues) {
						const dr = data[i] - br;
						const dg = data[i + 1] - bg;
						const db = data[i + 2] - bb;
						if (dr * dr + dg * dg + db * db <= tol2) {
							blue += 1;
							break;
						}
					}
				}
				r.pixels = w * h;
				r.opaque = opaque;
				r.blue = blue;
			} finally {
				pic.done();
			}
		} catch (e) {
			r.error = String((e && e.message) || e).slice(0, 200);
		}
		out.push(r);
	}
	return out;
}
