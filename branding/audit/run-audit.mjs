#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Browser audit of the branding: what a normal user sees, page by page (docs/branding.md, "Browser
// audit"). It signs in as a QA account through the normal login form, opens every page and menu a
// normal user can reach, in each language and in the light and dark theme, and runs
// branding/audit/scan-page.js on each of them (text, page title, links, pictures, labels, colours, page
// direction). It also watches every request the browser makes: none may go to an upstream host, and a
// translation file fetched as /l10n/<lang>.json (which skips the theme overrides) must not hold the
// upstream name. Admin pages are not part of it.
//
// Usage, from this folder after `npm ci` (Google Chrome must be installed; see audit.config.example.json):
//   node run-audit.mjs CONFIG.json [--langs en_GB,en,de,ar] [--themes light,dark]
//        [--pages id,id,...] [--passes user,public,extras] [--no-setup]
// Writes into the config's "out" folder: one screenshot per page, language and theme
// (<lang>-<theme>-<page>.png), findings.json (what a person could see; empty when all is well),
// hidden.json (hits in elements that are not drawn at all, for reference), network.json,
// problems.json (pages or menus that could not be opened), index.json and index.html.
// Exit code 0 when findings.json and problems.json are empty, 1 when not, 2 when it could not run.
//
// Secrets: passwords are read from the files the config names and typed into the login form or
// sent as HTTP basic auth; they are never printed (every line of output is masked).

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const SCANNER = fs.readFileSync(path.join(HERE, 'scan-page.js'), 'utf8');
const RULES = JSON.parse(fs.readFileSync(path.join(REPO, 'nextcloud-apps', 'nourax_branding', 'sweep', 'rules.json'), 'utf8'));

// Browser locale (Accept-Language) per Nextcloud language code.
const LOCALES = { en_GB: 'en-GB', en: 'en-US', de: 'de-DE', ar: 'ar' };
const RTL = /^(ar|fa|he|ur|ug|ps|ckb|sd|yi)\b/i;
// The fixtures the audit makes in the main QA account's own test folder (also used by
// scripts/check-branding.sh, which made its four test links there).
const FOLDER = '/branding-check';
const LINK_LABEL = 'branding-check ';
const FILES = { image: 'Audit picture.png', md: 'Audit notes.md', pdf: 'Audit report.pdf', docx: 'Audit letter.docx' };
const SHARED_FILE = 'From QA t3 2.txt';
const BOARD = 'QA t3 audit board';
const EVENT_UID = 'qa-t3-audit-event';
const EVENT_TITLE = 'QA t3 audit meeting';

// --- Arguments, config, secrets ------------------------------------------------------------------

function parseArgs(argv) {
	const out = { config: null, setup: true };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		const list = () => String(argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
		if (a === '--langs') out.langs = list();
		else if (a === '--themes') out.themes = list();
		else if (a === '--pages') out.pages = list();
		else if (a === '--passes') out.passes = list();
		else if (a === '--no-setup') out.setup = false;
		else if (!a.startsWith('--') && !out.config) out.config = a;
		else throw new Error('unknown argument ' + a);
	}
	if (!out.config) throw new Error('usage: node run-audit.mjs CONFIG.json [--langs ..] [--themes ..] [--pages ..] [--passes user,public,extras] [--no-setup]');
	return out;
}

const SECRETS = [];
const redact = (s) => {
	let t = String(s);
	for (const v of SECRETS) t = t.split(v).join('***');
	return t;
};
const log = (...a) => console.log(redact(a.join(' ')));

function secretFile(file) {
	const v = fs.readFileSync(file, 'utf8').trim();
	if (!v) throw new Error('empty secret file ' + file);
	SECRETS.push(v);
	return v;
}

// One line "machine HOST login USER password TOKEN".
function netrc(file) {
	const w = fs.readFileSync(file, 'utf8').split(/\s+/).filter(Boolean);
	const login = w[w.indexOf('login') + 1];
	const password = w[w.indexOf('password') + 1];
	if (w.indexOf('login') < 0 || w.indexOf('password') < 0 || !login || !password) throw new Error('no login and password in ' + file);
	SECRETS.push(password);
	return { login, password };
}

// The audit signs in only as QA accounts (qa-...), never as the emergency admin or a real person.
function account(spec, role) {
	if (!spec) return null;
	if (!/^qa-[a-z0-9-]+$/.test(spec.login || '')) throw new Error(`${role}: "${spec.login}" is not a QA account (qa-...); the audit never signs in as anyone else`);
	const acc = { login: spec.login, role };
	if (spec.password_file) acc.password = secretFile(spec.password_file);
	if (spec.netrc) {
		const n = netrc(spec.netrc);
		if (n.login !== spec.login) throw new Error(`${role}: ${spec.netrc} is for ${n.login}, not ${spec.login}`);
		acc.app = n.password;
	}
	return acc;
}

// --- HTTP as a QA account (app password) ---------------------------------------------------------

let BASE = '';

async function api(acc, method, url, { headers = {}, body } = {}) {
	if (!acc.app) throw new Error(acc.login + ' has no app password (netrc) in the config');
	const r = await fetch(url.startsWith('http') ? url : BASE + url, {
		method,
		headers: { Authorization: 'Basic ' + Buffer.from(acc.login + ':' + acc.app).toString('base64'), 'OCS-APIRequest': 'true', ...headers },
		body,
		redirect: 'manual',
	});
	return { status: r.status, text: await r.text() };
}

function ocsData(r) {
	try {
		return JSON.parse(r.text).ocs.data;
	} catch (e) {
		return null;
	}
}

const dav = (acc, p) => `/remote.php/dav/files/${encodeURIComponent(acc.login)}${p.split('/').map(encodeURIComponent).join('/')}`;
const form = (o) => ({ headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(o).toString() });
const jsonBody = (o) => ({ headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(o) });

// --- Small test files, made here so the audit needs nothing else --------------------------------

const CRC = (() => {
	const t = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		t[n] = c >>> 0;
	}
	return t;
})();
function crc32(buf) {
	let c = 0xffffffff;
	for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

// A 480x270 picture: a gradient from Nourax cobalt to the accent orange.
function makePng(w = 480, h = 270) {
	const row = w * 3 + 1;
	const raw = Buffer.alloc(row * h);
	const from = [0x25, 0x63, 0xeb];
	const to = [0xf9, 0x73, 0x16];
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			const t = (x / w + y / h) / 2;
			for (let k = 0; k < 3; k++) raw[y * row + 1 + x * 3 + k] = Math.round(from[k] + (to[k] - from[k]) * t);
		}
	}
	const chunk = (type, data) => {
		const len = Buffer.alloc(4);
		len.writeUInt32BE(data.length);
		const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
		const crc = Buffer.alloc(4);
		crc.writeUInt32BE(crc32(td));
		return Buffer.concat([len, td, crc]);
	};
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(w, 0);
	ihdr.writeUInt32BE(h, 4);
	ihdr.set([8, 2, 0, 0, 0], 8);
	return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

function makePdf() {
	const text = 'BT /F1 24 Tf 72 760 Td (Branding audit report) Tj 0 -36 Td /F1 12 Tf (A test file of the Nourax Workspace browser audit.) Tj ET';
	const objs = [
		'<< /Type /Catalog /Pages 2 0 R >>',
		'<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
		'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
		`<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
		'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
	];
	let out = '%PDF-1.4\n';
	const offsets = [];
	objs.forEach((o, i) => {
		offsets.push(out.length);
		out += `${i + 1} 0 obj\n${o}\nendobj\n`;
	});
	const xref = out.length;
	out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offsets.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('');
	out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
	return Buffer.from(out, 'latin1');
}

// A stored (uncompressed) zip, enough for a one-paragraph .docx.
function makeZip(entries) {
	const locals = [];
	const centrals = [];
	let offset = 0;
	for (const [name, content] of entries) {
		const data = Buffer.from(content, 'utf8');
		const n = Buffer.from(name, 'utf8');
		const crc = crc32(data);
		const lh = Buffer.alloc(30);
		lh.writeUInt32LE(0x04034b50, 0);
		lh.writeUInt16LE(20, 4);
		lh.writeUInt16LE(0, 6);
		lh.writeUInt16LE(0, 8);
		lh.writeUInt16LE(0, 10);
		lh.writeUInt16LE(0x5b59, 12);
		lh.writeUInt32LE(crc, 14);
		lh.writeUInt32LE(data.length, 18);
		lh.writeUInt32LE(data.length, 22);
		lh.writeUInt16LE(n.length, 26);
		lh.writeUInt16LE(0, 28);
		const ch = Buffer.alloc(46);
		ch.writeUInt32LE(0x02014b50, 0);
		ch.writeUInt16LE(20, 4);
		ch.writeUInt16LE(20, 6);
		ch.writeUInt16LE(0, 8);
		ch.writeUInt16LE(0, 10);
		ch.writeUInt16LE(0, 12);
		ch.writeUInt16LE(0x5b59, 14);
		ch.writeUInt32LE(crc, 16);
		ch.writeUInt32LE(data.length, 20);
		ch.writeUInt32LE(data.length, 24);
		ch.writeUInt16LE(n.length, 28);
		ch.writeUInt32LE(offset, 42);
		locals.push(lh, n, data);
		centrals.push(ch, n);
		offset += lh.length + n.length + data.length;
	}
	const cd = Buffer.concat(centrals);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(entries.length, 8);
	end.writeUInt16LE(entries.length, 10);
	end.writeUInt32LE(cd.length, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...locals, cd, end]);
}

function makeDocx() {
	const x = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
	return makeZip([
		['[Content_Types].xml', x + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'],
		['_rels/.rels', x + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'],
		['word/document.xml', x + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>A test letter of the Nourax Workspace browser audit.</w:t></w:r></w:p></w:body></w:document>'],
	]);
}

// --- Fixtures: made once, found again on later runs ------------------------------------------------

async function ensureFile(acc, p, content, type) {
	const r = await api(acc, 'PROPFIND', dav(acc, p), { headers: { Depth: '0' } });
	if (r.status === 207) return 'kept';
	const put = await api(acc, 'PUT', dav(acc, p), { headers: { 'Content-Type': type }, body: content });
	if (put.status !== 201 && put.status !== 204) throw new Error(`upload ${p}: HTTP ${put.status}`);
	return 'uploaded';
}

async function fileIds(acc, folder) {
	const body = '<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns"><d:prop><oc:fileid/></d:prop></d:propfind>';
	const r = await api(acc, 'PROPFIND', dav(acc, folder), { headers: { Depth: '1', 'Content-Type': 'application/xml' }, body });
	const ids = {};
	for (const block of r.text.split(/<d:response>/).slice(1)) {
		const href = (block.match(/<d:href>([^<]+)<\/d:href>/) || [])[1];
		const id = (block.match(/<oc:fileid>(\d+)<\/oc:fileid>/) || [])[1];
		if (href && id) ids[decodeURIComponent(href.replace(/\/$/, '').split('/').pop())] = id;
	}
	return ids;
}

async function ensureLinks(acc) {
	const want = [['file', FOLDER + '/probe.txt', '1', false], ['folder', FOLDER, '1', false], ['password', FOLDER, '1', true], ['drop', FOLDER, '4', false]];
	const have = {};
	for (const p of [FOLDER, FOLDER + '/probe.txt']) {
		const data = ocsData(await api(acc, 'GET', '/ocs/v2.php/apps/files_sharing/api/v1/shares?format=json&path=' + encodeURIComponent(p))) || [];
		for (const s of data) {
			const lab = s.label || '';
			if (String(s.share_type) === '3' && lab.startsWith(LINK_LABEL) && s.token && !have[lab.slice(LINK_LABEL.length)]) {
				have[lab.slice(LINK_LABEL.length)] = s.token;
				SECRETS.push(s.token);
			}
		}
	}
	for (const [kind, p, perms, withPassword] of want) {
		if (have[kind]) continue;
		const data = { path: p, shareType: '3', permissions: perms, label: LINK_LABEL + kind };
		if (withPassword) {
			// Nobody needs to open this link: a random password, kept in memory only.
			data.password = Buffer.from(crypto.getRandomValues(new Uint8Array(18))).toString('base64url') + 'aA1-';
			SECRETS.push(data.password);
		}
		const got = ocsData(await api(acc, 'POST', '/ocs/v2.php/apps/files_sharing/api/v1/shares?format=json', form(data)));
		if (!got || !got.token) throw new Error('could not create the test link ' + kind);
		have[kind] = got.token;
		SECRETS.push(got.token);
	}
	return have;
}

async function ensureUserShare(from, to) {
	await ensureFile(from, '/' + SHARED_FILE, `A file ${from.login} shares with ${to.login} for the branding audit.\n`, 'text/plain');
	const data = ocsData(await api(from, 'GET', '/ocs/v2.php/apps/files_sharing/api/v1/shares?format=json&path=' + encodeURIComponent('/' + SHARED_FILE))) || [];
	if (data.some((s) => String(s.share_type) === '0' && s.share_with === to.login)) return 'kept';
	const r = await api(from, 'POST', '/ocs/v2.php/apps/files_sharing/api/v1/shares?format=json', form({ path: '/' + SHARED_FILE, shareType: '0', shareWith: to.login, permissions: '1' }));
	const got = ocsData(r);
	if (!got || !got.id) throw new Error(`share from ${from.login} to ${to.login}: HTTP ${r.status} ${redact(r.text).slice(0, 200)}`);
	return 'shared';
}

// A comment of the sharer on the shared file that mentions the receiver: a notification for them.
async function ensureMention(from, to) {
	const ids = await fileIds(from, '/');
	const id = ids[SHARED_FILE];
	if (!id) return 'no file id';
	const list = await api(from, 'PROPFIND', `/remote.php/dav/comments/files/${id}`, { headers: { Depth: '1' } });
	if (list.text.includes(`@${to.login} a test comment of the branding audit`)) return 'kept';
	const r = await api(from, 'POST', `/remote.php/dav/comments/files/${id}`, jsonBody({ actorType: 'users', verb: 'comment', message: `@${to.login} a test comment of the branding audit.` }));
	return r.status === 201 ? 'made' : `HTTP ${r.status}`;
}

async function ensureBoard(acc) {
	const j = (r) => {
		try {
			return JSON.parse(r.text);
		} catch (e) {
			throw new Error('Deck answered HTTP ' + r.status);
		}
	};
	const base = '/apps/deck/api/v1.0/boards';
	let board = j(await api(acc, 'GET', base, { headers: { Accept: 'application/json' } })).find((b) => b.title === BOARD && !b.deletedAt && !b.archived);
	if (!board) board = j(await api(acc, 'POST', base, jsonBody({ title: BOARD, color: '2563eb' })));
	let stack = j(await api(acc, 'GET', `${base}/${board.id}/stacks`, { headers: { Accept: 'application/json' } })).find((s) => s.title === 'To do');
	if (!stack) stack = j(await api(acc, 'POST', `${base}/${board.id}/stacks`, jsonBody({ title: 'To do', order: 1 })));
	let card = (stack.cards || []).find((c) => c.title === 'Check the branding');
	if (!card) card = j(await api(acc, 'POST', `${base}/${board.id}/stacks/${stack.id}/cards`, jsonBody({ title: 'Check the branding', type: 'plain', order: 1, description: 'A card of the browser audit.' })));
	return { board: board.id, card: card.id };
}

// An event tomorrow 10:00 to 11:00 UTC in the personal calendar, moved to tomorrow on every run.
async function ensureEvent(acc) {
	const url = `/remote.php/dav/calendars/${encodeURIComponent(acc.login)}/personal/${EVENT_UID}.ics`;
	const day = new Date(Date.now() + 86400000);
	const d = day.toISOString().slice(0, 10).replace(/-/g, '');
	const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
	const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Nourax//Branding audit//EN', 'BEGIN:VEVENT', `UID:${EVENT_UID}`, `DTSTAMP:${stamp}`,
		`DTSTART:${d}T100000Z`, `DTEND:${d}T110000Z`, `SUMMARY:${EVENT_TITLE}`, 'DESCRIPTION:An event of the browser audit.', 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n');
	const r = await api(acc, 'PUT', url, { headers: { 'Content-Type': 'text/calendar; charset=utf-8' }, body: ics });
	if (r.status !== 201 && r.status !== 204) return `not made (HTTP ${r.status}; no personal calendar yet?)`;
	return day.toISOString().slice(0, 10);
}

async function ensureContact(acc) {
	const url = `/remote.php/dav/addressbooks/users/${encodeURIComponent(acc.login)}/contacts/qa-t3-audit.vcf`;
	const vcf = ['BEGIN:VCARD', 'VERSION:3.0', 'UID:qa-t3-audit-contact', 'FN:Audit Contact', 'N:Contact;Audit;;;', 'EMAIL;TYPE=WORK:audit.contact@example.org', 'END:VCARD', ''].join('\r\n');
	const r = await api(acc, 'PUT', url, { headers: { 'Content-Type': 'text/vcard; charset=utf-8' }, body: vcf });
	return r.status === 201 || r.status === 204 ? 'ok' : `not made (HTTP ${r.status})`;
}

// The apps of the app menu and the sections of the Personal settings, as the server lists them for
// this person, so that an app added later is part of the audit without a change here.
async function discover(acc) {
	const nav = ocsData(await api(acc, 'GET', '/ocs/v2.php/core/navigation/apps?format=json')) || [];
	const apps = nav.map((e) => ({ id: String(e.id), href: String(e.href || '') }));
	// The settings page draws its section list from the initial state "settings-sections".
	const r = await api(acc, 'GET', '/settings/user', { headers: { Accept: 'text/html' } });
	let sections = [];
	const state = r.text.match(/id="initial-state-settings-sections" value="([^"]+)"/);
	try {
		sections = (JSON.parse(Buffer.from(state[1], 'base64').toString('utf8')).personal || []).map((s) => String(s.id)).filter((s) => /^[A-Za-z0-9_-]+$/.test(s));
	} catch (e) {
		sections = [];
	}
	return { apps, sections };
}

async function getLanguage(acc) {
	const d = ocsData(await api(acc, 'GET', `/ocs/v2.php/cloud/users/${encodeURIComponent(acc.login)}?format=json`));
	return d ? d.language : null;
}

// The person's own change of their language, the request the Personal settings page sends, from their
// browser session. (With an app password the server asks for a password confirmation first; a session
// that has just signed in has one.)
async function setLanguage(page, acc, lang) {
	const r = await page.evaluate(async ({ uid, value }) => {
		const token = (window.OC && window.OC.requestToken) || document.head.getAttribute('data-requesttoken');
		const res = await fetch(`/ocs/v2.php/cloud/users/${encodeURIComponent(uid)}?format=json`, {
			method: 'PUT',
			headers: { 'OCS-APIRequest': 'true', requesttoken: token, 'Content-Type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({ key: 'language', value }).toString(),
		});
		return { status: res.status, text: (await res.text()).slice(0, 200) };
	}, { uid: acc.login, value: lang });
	if (r.status !== 200) throw new Error(`set language ${lang} for ${acc.login}: HTTP ${r.status} ${r.text}`);
}

// --- Findings ------------------------------------------------------------------------------------

const toRegExp = (re, extra) => {
	let source = re;
	let flags = 'u' + (extra || '');
	if (source.startsWith('(?i)')) {
		source = source.slice(4);
		flags += 'i';
	}
	return new RegExp(source, flags);
};
const NAME_RX = (RULES.name_patterns || []).map((p) => [p.id, toRegExp(p.re, 'g')]);
function nameHits(s) {
	const out = [];
	for (const [id, rx] of NAME_RX) {
		rx.lastIndex = 0;
		let m;
		while ((m = rx.exec(s)) !== null && out.length < 5) {
			out.push(`${id}: …${s.slice(Math.max(0, m.index - 40), m.index + m[0].length + 40)}…`);
			if (m[0].length === 0) rx.lastIndex += 1;
		}
	}
	return out;
}

const FINDINGS = [];
const HIDDEN = [];
const PROBLEMS = [];
const NETWORK = [];
const INDEX = [];
const NOTES = [];

const at = (cx) => ({ pass: cx.pass, user: cx.user || '', lang: cx.lang, theme: cx.theme || '', page: cx.page || '' });
function finding(cx, f) {
	FINDINGS.push({ ...at(cx), ...f });
	log(`  FINDING ${cx.lang}/${cx.theme || '-'}/${cx.page}: ${f.kind} ${f.where}: ${f.snippet}`);
}
function problem(cx, what, err) {
	const msg = redact(String(err && err.message ? err.message : err)).split('\n')[0].slice(0, 300);
	PROBLEMS.push({ ...at(cx), what, error: msg });
	log(`  PROBLEM ${cx.lang}/${cx.page}: ${what}: ${msg}`);
}

// --- Browser ---------------------------------------------------------------------------------------

let OUT = '';
let THEMES = ['light', 'dark'];
let ONLY = null;

async function settle(page, extra = 800) {
	await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
	await page.waitForTimeout(extra);
}

async function openContext(browser, cx) {
	const ctx = await browser.newContext({ locale: LOCALES[cx.lang] || cx.lang, viewport: { width: 1366, height: 900 } });
	ctx.on('request', (req) => {
		const u = req.url();
		let host = '';
		try {
			host = new URL(u).hostname;
		} catch (e) {
			return;
		}
		if (/next\s*-?cloud/i.test(host)) {
			NETWORK.push({ ...at(cx), url: u, kind: 'upstream-host' });
			finding(cx, { kind: 'network', where: 'request to ' + host, snippet: u.slice(0, 160) });
		}
	});
	ctx.on('response', async (resp) => {
		const u = resp.url();
		if (!/\/l10n\/[^/?#]+\.json(?:[?#]|$)/.test(u)) return;
		let text = '';
		try {
			text = await resp.text();
		} catch (e) {
			text = '';
		}
		const hits = nameHits(text);
		NETWORK.push({ ...at(cx), url: u, kind: 'l10n-json', status: resp.status(), hits: hits.length });
		if (hits.length) finding(cx, { kind: 'l10n-json', where: 'translation file fetched past the theme: ' + new URL(u).pathname, snippet: hits[0] });
	});
	return ctx;
}

async function login(page, acc, cx) {
	if (!acc.password) throw new Error(acc.login + ' has no password_file in the config');
	await page.goto(BASE + '/login', { waitUntil: 'domcontentloaded', timeout: 45000 });
	await page.fill('#user', acc.login);
	await page.fill('#password', acc.password);
	await Promise.all([
		page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 45000 }),
		page.click('form.login-form button[type=submit]'),
	]);
	await settle(page);
	log(`  signed in as ${acc.login} through the login form (${cx.lang})`);
}

async function scanFrame(frame, expectRtl) {
	return frame.evaluate(`(${SCANNER})(${JSON.stringify(RULES)}, ${JSON.stringify({ expectRtl })})`);
}

// Scan every frame of the page in each theme and keep a screenshot of each.
async function capture(page, cx, def, status) {
	for (const theme of THEMES) {
		const tcx = { ...cx, theme };
		if (!def.fixedTheme) {
			await page.emulateMedia({ colorScheme: theme });
			await page.waitForTimeout(600);
		}
		const row = { ...at(tcx), url: page.url(), status, title: '', dir: '', htmlLang: '', frames: 0, findings: 0, hidden: 0, shot: '' };
		for (const frame of page.frames()) {
			const furl = frame.url();
			if (frame.isDetached() || !/^https?:/.test(furl)) continue;
			const main = frame === page.mainFrame();
			let res;
			try {
				// A plain-text answer (the WebDAV page) has no page direction to set.
				const html = /html/i.test(await frame.evaluate('document.contentType').catch(() => 'text/html'));
				res = await scanFrame(frame, main && html && RTL.test(cx.lang) ? true : null);
			} catch (e) {
				if (main) problem(tcx, 'scan', e);
				continue;
			}
			row.frames += 1;
			if (main) {
				row.title = res.title;
				row.dir = res.dir;
				row.htmlLang = res.lang;
			}
			const where = main ? '' : `frame ${new URL(furl).host}${new URL(furl).pathname.slice(0, 60)}: `;
			for (const f of res.findings) {
				finding(tcx, { kind: f.kind, where: where + f.where, snippet: f.snippet, url: res.url });
				row.findings += 1;
			}
			for (const f of res.hidden || []) {
				HIDDEN.push({ ...at(tcx), kind: f.kind, where: where + f.where, snippet: f.snippet, url: res.url });
				row.hidden += 1;
			}
		}
		const name = `${cx.lang}-${theme}-${def.id}.png`.replace(/[^A-Za-z0-9_.-]/g, '_');
		try {
			await page.screenshot({ path: path.join(OUT, name), timeout: 20000 });
			row.shot = name;
		} catch (e) {
			problem(tcx, 'screenshot', e);
		}
		INDEX.push(row);
	}
}

async function visit(page, cx, def) {
	const pcx = { ...cx, page: def.id };
	if (ONLY && !ONLY.some((p) => def.id === p || (p.endsWith('*') && def.id.startsWith(p.slice(0, -1))))) return;
	let status = null;
	if (def.path) {
		try {
			let r = await page.goto(BASE + def.path, { waitUntil: 'domcontentloaded', timeout: 60000 });
			status = r ? r.status() : null;
			// Another task may be restarting the server (docs: wait about a minute, then try once more).
			if (status === 502 || status === 503) {
				log(`  ${cx.lang} ${def.id}: HTTP ${status}, trying again in 60 s`);
				await page.waitForTimeout(60000);
				r = await page.goto(BASE + def.path, { waitUntil: 'domcontentloaded', timeout: 60000 });
				status = r ? r.status() : null;
			}
		} catch (e) {
			problem(pcx, 'open ' + def.path, e);
			return;
		}
		// 429: the brute-force protection stopped this IP; the page shown is not the one asked for.
		if (status === 429 || status >= 500) problem(pcx, 'open ' + def.path, `HTTP ${status}`);
		await settle(page, def.wait ?? 1200);
	}
	if (def.waitFor) {
		await page.waitForSelector(def.waitFor, { timeout: def.waitTimeout || 20000 }).catch((e) => problem(pcx, 'wait for ' + def.waitFor, e));
	}
	for (const step of [].concat(def.steps || [])) {
		try {
			await step(page, pcx);
		} catch (e) {
			problem(pcx, 'step', e);
		}
	}
	if (def.check) {
		try {
			await def.check(page, pcx);
		} catch (e) {
			problem(pcx, 'check', e);
		}
	}
	await capture(page, pcx, def, status);
	log(`  ${cx.lang} ${def.id}: ${status ?? '-'} ${page.url().replace(BASE, '')}`);
}

// Steps for pages.
const click = (sel, opts = {}) => async (page) => {
	const loc = opts.last ? page.locator(sel).last() : page.locator(sel).first();
	await loc.click({ timeout: opts.timeout || 10000 });
	await settle(page, opts.wait ?? 1200);
};
const press = (key, wait = 1200) => async (page) => {
	await page.keyboard.press(key);
	await page.waitForTimeout(wait);
};
const typeText = (text, wait = 2500) => async (page) => {
	await page.keyboard.type(text, { delay: 40 });
	await page.waitForTimeout(wait);
};
const scrollTo = (sel) => async (page) => {
	const found = await page.evaluate((q) => {
		const el = document.querySelector(q);
		if (el) el.scrollIntoView({ block: 'start' });
		return Boolean(el);
	}, sel);
	if (!found) throw new Error('nothing matches ' + sel);
	await page.waitForTimeout(800);
};
// The server's "Authentication required" dialog: the person types their password again.
const confirmPassword = (acc) => async (page) => {
	const input = page.locator('.modal-container input[type=password], [role=dialog] input[type=password]').first();
	if (!(await input.count())) return;
	await input.fill(acc.password);
	await page.keyboard.press('Enter');
	await settle(page, 2500);
};
const waitFor = (sel, timeout = 20000) => async (page) => {
	await page.waitForSelector(sel, { timeout, state: 'visible' });
};
// Waits until a frame from this host is there and has loaded, plus a few seconds for the editor.
const waitForFrame = (re, extra = 6000) => async (page) => {
	const end = Date.now() + 40000;
	while (Date.now() < end) {
		if (page.frames().some((f) => re.test(f.url()))) break;
		await page.waitForTimeout(500);
	}
	if (!page.frames().some((f) => re.test(f.url()))) throw new Error('no frame matching ' + re);
	await page.waitForTimeout(extra);
};

// --- The pages ----------------------------------------------------------------------------------

const USER_MENU = 'button[aria-controls="header-menu-user-menu"]';

function signedInPages(fx, acc) {
	const open = (id) => `/apps/files/files/${id}?dir=${encodeURIComponent(FOLDER)}&openfile=true`;
	const ids = fx.ids || {};
	const pages = [
		{ id: 'files', path: '/apps/files/files', waitFor: '.files-list' },
		{ id: 'app-menu', path: '/apps/files/files', steps: [click('button.app-menu__waffle')], check: checkNoMail },
		{ id: 'user-menu', path: '/apps/files/files', steps: [click(USER_MENU)] },
		// The QR code makes an app password, so the server asks for the password first, as it asks a person.
		{ id: 'mobile-login-qr', path: '/apps/files/files', steps: [click(USER_MENU), click('#header-menu-user-menu .list-item-content__extra-actions button', { wait: 2000 }), confirmPassword(acc)] },
		{ id: 'user-status', path: '/apps/files/files', steps: [click(USER_MENU), click('#header-menu-user-menu a.list-item__anchor[href="#"]:not(#profile)', { wait: 2000 })] },
		{ id: 'contacts-menu', path: '/apps/files/files', steps: [click('button[aria-controls="header-menu-contactsmenu"]')] },
		{ id: 'notifications', path: '/apps/files/files', steps: [click('#notifications button.header-menu__trigger', { wait: 2000 })] },
		{ id: 'unified-search', path: '/apps/files/files', steps: [press('Control+k'), typeText('audit', 3500)] },
		// Nourax AI (the Assistant): the button in the top bar opens its dialog; it also has a page.
		{ id: 'assistant-dialog', path: '/apps/files/files', steps: [click('#assistant button', { wait: 3000 })] },
		{ id: 'assistant-page', path: '/apps/assistant/', wait: 3000 },
		{ id: 'files-folder', path: `/apps/files/files?dir=${encodeURIComponent(FOLDER)}`, waitFor: '.files-list' },
		{ id: 'files-new-menu', path: `/apps/files/files?dir=${encodeURIComponent(FOLDER)}`, waitFor: '[data-cy-upload-picker]', steps: [click('[data-cy-upload-picker] button')] },
		// The "Actions" menu of a file (the last button of its row): open with, AI tasks and so on.
		{ id: 'files-actions-menu', path: `/apps/files/files?dir=${encodeURIComponent(FOLDER)}`, waitFor: '.files-list',
			steps: [click(`tr[data-cy-files-list-row-name="${FILES.docx}"] td.files-list__row-actions button`, { last: true, wait: 1500 })] },
		{ id: 'files-sharing-tab', path: `/apps/files/files/${ids['probe.txt'] || ''}?dir=${encodeURIComponent(FOLDER)}&opendetails=true`, steps: [waitFor('.app-sidebar'), async (p) => p.waitForTimeout(2500)] },
		{ id: 'files-settings', path: '/apps/files/files', steps: [click('[data-cy-files-navigation-settings-button] a', { wait: 2000 })] },
		{ id: 'files-settings-webdav', path: '/apps/files/files', steps: [click('[data-cy-files-navigation-settings-button] a', { wait: 2000 }), scrollTo('[id*="webdav" i], [data-cy-files-settings-webdav]')] },
		{ id: 'files-shared-with-you', path: '/apps/files/sharingin', waitFor: '.files-list' },
		{ id: 'files-shares', path: '/apps/files/shareoverview' },
		{ id: 'files-recent', path: '/apps/files/recent' },
		{ id: 'files-trash', path: '/apps/files/trashbin' },
		{ id: 'files-team-folders', path: '/apps/files/groupfolders' },
		{ id: 'viewer-image', path: open(ids[FILES.image]), steps: [waitFor('.viewer'), async (p) => p.waitForTimeout(2000)] },
		{ id: 'text-md', path: open(ids[FILES.md]), steps: [async (p) => p.waitForTimeout(4000)] },
		{ id: 'pdf-viewer', path: open(ids[FILES.pdf]), steps: [async (p) => p.waitForTimeout(6000)] },
		{ id: 'onlyoffice', path: open(ids[FILES.docx]), steps: [waitForFrame(/office\.nourax\.org/, 12000)] },
		{ id: 'photos', path: '/apps/photos/', wait: 3000 },
		{ id: 'activity', path: '/apps/activity/', wait: 3000 },
		{ id: 'calendar', path: '/apps/calendar/', wait: 3000 },
		{ id: 'calendar-event', path: fx.eventDay ? `/apps/calendar/dayGridMonth/${fx.eventDay}` : '/apps/calendar/', wait: 3000,
			steps: [click(`.fc-event:has-text("${EVENT_TITLE}")`, { wait: 2500 })] },
		{ id: 'calendar-settings', path: '/apps/calendar/', wait: 3000, steps: [click('.app-navigation li.app-navigation-entry--pinned a', { last: true, wait: 2000 })] },
		// The calendar's own "Edit and share calendar" button shows on hover. The personal calendar
		// comes after "Contact birthdays"; its dialog has the sharing part and the CalDAV link.
		{ id: 'calendar-edit-share', path: '/apps/calendar/', wait: 3000, steps: [async (page) => {
			const items = page.locator('.draggable-calendar-list-item');
			const item = (await items.count()) > 1 ? items.nth(1) : items.first();
			await item.hover();
			await item.locator('button').first().click({ timeout: 10000, force: true });
			await settle(page, 2500);
		}] },
		{ id: 'contacts', path: '/apps/contacts/', wait: 3000 },
		{ id: 'deck', path: '/apps/deck/', wait: 3000 },
		{ id: 'deck-board', path: fx.deck ? `/apps/deck/board/${fx.deck.board}` : '/apps/deck/', wait: 3000 },
		{ id: 'deck-card', path: fx.deck ? `/apps/deck/board/${fx.deck.board}/card/${fx.deck.card}` : '/apps/deck/', wait: 3500 },
		{ id: 'notes', path: '/apps/notes/', wait: 3000 },
		{ id: 'tasks', path: '/apps/tasks/', wait: 3000 },
		{ id: 'forms', path: '/apps/forms/', wait: 3000 },
		{ id: 'gantt', path: '/apps/nc_gantt/', wait: 3000 },
	];
	// Every app of the app menu that the list above leaves out (an app added later, for example).
	for (const app of fx.apps || []) {
		const href = app.href.replace(/^https?:\/\/[^/]+/i, '').replace(/^\/index\.php\//, '/');
		if (!href.startsWith('/') || app.href.startsWith('http') && !app.href.startsWith(BASE)) continue;
		if (pages.some((p) => p.path && p.path.startsWith(href.replace(/\/$/, '')))) continue;
		pages.push({ id: 'app-' + app.id, path: href, wait: 3000 });
	}
	// Every section of the Personal settings this person has, as the server lists them.
	const sections = fx.sections && fx.sections.length ? fx.sections
		: ['profile-contact', 'language-locale', 'security', 'notifications', 'theming', 'sharing', 'ai', 'availability', 'workflow', 'nc_gantt'];
	for (const s of sections) {
		pages.push({ id: 'settings-' + s, path: '/settings/user/' + s, wait: 2000 });
	}
	pages.push(
		{ id: 'settings-help', path: '/settings/help', wait: 1500 },
		{ id: 'settings-sync-clients', path: '/settings/user/sync-clients', wait: 1500 },
		{ id: 'profile', path: '/u/' + encodeURIComponent(acc.login), wait: 1500 },
		{ id: 'webdav-page', path: '/remote.php/dav', wait: 1000 },
		{ id: 'webdav-folder', path: `/remote.php/dav/files/${encodeURIComponent(acc.login)}${FOLDER}/`, wait: 1000 },
		{ id: 'not-found', path: '/index.php/apps/nourax-audit-missing-page', wait: 1000 },
		{ id: 'forbidden', path: '/settings/users', wait: 1500 },
	);
	return pages;
}

async function checkNoMail(page, cx) {
	const entries = await page.evaluate(() => Array.from(document.querySelectorAll('a.app-item, nav a[href]')).map((a) => [a.getAttribute('href'), a.getAttribute('target'), (a.innerText || '').trim()]));
	const nomail = entries.find(([href]) => /^https:\/\/mail\.nourax\.org\/?$/.test(href || ''));
	NOTES.push({ ...at(cx), note: 'app menu entries', entries: entries.map((e) => e[0]).filter(Boolean) });
	if (!nomail) problem(cx, 'app menu', 'no NoMail entry (https://mail.nourax.org/)');
}

function publicPages(tokens) {
	const s = (k) => (tokens[k] ? '/s/' + tokens[k] : null);
	const pages = [
		{ id: 'public-login', path: '/login', wait: 1500 },
		// The "Forgot password?" button is the last plain button of the login box.
		{ id: 'public-lost-password', path: '/login', wait: 1500, steps: [click('.login-box__wrapper button[type=button]', { last: true, wait: 1500 })] },
		{ id: 'public-device-login', path: '/login', wait: 1500, steps: [click('.login-box__wrapper button[type=button]:not(.input-field__trailing-button)', { wait: 1500 })] },
		{ id: 'public-share-file', path: s('file'), wait: 2500 },
		// A file link opens the file in the viewer; closed, the page shows its header menu.
		{ id: 'public-share-file-menu', path: s('file'), wait: 2500, steps: [press('Escape', 1500), click('header button[aria-haspopup="menu"], #header button.action-item__menutoggle, .header-end button', { wait: 1500 })] },
		{ id: 'public-share-folder', path: s('folder'), wait: 3000 },
		{ id: 'public-share-folder-menu', path: s('folder'), wait: 3000, steps: [click('header button[aria-haspopup="menu"], #header button.action-item__menutoggle, .header-end button', { wait: 1500 })] },
		{ id: 'public-share-drop', path: s('drop'), wait: 3000 },
		{ id: 'public-share-password', path: s('password'), wait: 1500 },
		{ id: 'public-share-password-wrong', path: s('password'), wait: 1500, steps: [async (page) => {
			await page.fill('input[type=password]', 'not-the-password-audit');
			await page.keyboard.press('Enter');
			await settle(page, 1500);
		}] },
		// The page of a missing, deleted or expired link ("This share does not exist or is no longer
		// available"). A made-up link would show the same page, but the server counts each one as a
		// guessed link: then every link page is slowed down for this IP for 12 hours, and refused
		// (HTTP 429) after more than ten in half an hour. A path that is not in a real link shows that
		// page and counts nothing.
		{ id: 'public-share-missing', path: tokens.file ? `/s/${tokens.file}?path=${encodeURIComponent('/missing')}` : null, wait: 1500 },
		{ id: 'public-not-found', path: '/index.php/apps/nourax-audit-missing-page', wait: 1000 },
		{ id: 'public-help', path: '/apps/nourax_branding/help', wait: 1000 },
	];
	return pages.filter((p) => p.path);
}

// --- Passes --------------------------------------------------------------------------------------

async function userPass(browser, acc, lang, fx, viaMenu) {
	const cx = { pass: 'user', user: acc.login, lang };
	const ctx = await openContext(browser, cx);
	const page = await ctx.newPage();
	try {
		await login(page, acc, cx);
		if (viaMenu) {
			// Once: the language is changed through the Personal settings language menu, as a person does.
			await menuLanguage(page, acc, lang, cx);
		} else {
			await setLanguage(page, acc, lang);
		}
		const got = await getLanguage(acc);
		if (got !== lang) {
			problem({ ...cx, page: 'language' }, 'language', `language is ${got}, not ${lang}`);
			await setLanguage(page, acc, lang);
		}
		for (const def of signedInPages(fx, acc)) await visit(page, cx, def);
		// Last: sign out through the user menu, and the page that follows.
		await visit(page, cx, { id: 'logout', path: '/apps/files/files', steps: [click(USER_MENU), async (p) => {
			await Promise.all([p.waitForURL(/\/login/, { timeout: 30000 }), p.locator('#logout').first().click()]);
			await settle(p, 1500);
		}] });
	} finally {
		await ctx.close();
	}
}

async function menuLanguage(page, acc, lang, cx) {
	const names = { de: 'Deutsch', en_GB: 'English (British English)', en: 'English (US)', ar: 'العربية' };
	const pcx = { ...cx, page: 'language-menu' };
	try {
		await page.goto(BASE + '/settings/user/language-locale', { waitUntil: 'domcontentloaded' });
		await settle(page, 1500);
		const saved = page.waitForResponse((r) => /\/ocs\/v2\.php\/cloud\/users\//.test(r.url()) && r.request().method() === 'PUT', { timeout: 20000 });
		await page.locator('#account-setting-language').click();
		await page.keyboard.type(names[lang] || lang, { delay: 30 });
		await page.waitForTimeout(800);
		await page.keyboard.press('Enter');
		const r = await saved;
		log(`  language changed to ${lang} through the language menu: HTTP ${r.status()}`);
		await settle(page, 2500);
		await capture(page, pcx, { id: 'language-menu' }, r.status());
	} catch (e) {
		problem(pcx, 'change the language through the menu', e);
		await setLanguage(page, acc, lang);
	}
}

async function publicPass(browser, lang, tokens) {
	const cx = { pass: 'public', user: '', lang };
	const ctx = await openContext(browser, cx);
	const page = await ctx.newPage();
	try {
		for (const def of publicPages(tokens)) await visit(page, cx, def);
	} finally {
		await ctx.close();
	}
}

// Once, in the first language: the Appearance page's own dark theme (not the system's), then back.
async function themePass(browser, acc, lang) {
	const cx = { pass: 'user-theme', user: acc.login, lang };
	const ctx = await openContext(browser, cx);
	const page = await ctx.newPage();
	const pick = async (value) => {
		await page.goto(BASE + '/settings/user/theming', { waitUntil: 'domcontentloaded' });
		await settle(page, 1500);
		const saved = page.waitForResponse((r) => /\/apps\/theming\/api\/v1\/theme\//.test(r.url()), { timeout: 15000 }).catch(() => null);
		await page.locator(`input[type=radio][value="${value}"]`).first().check({ force: true });
		const r = await saved;
		await settle(page, 1500);
		return r ? r.status() : null;
	};
	try {
		await login(page, acc, cx);
		await setLanguage(page, acc, lang);
		const st = await pick('dark');
		log(`  Appearance: dark theme chosen (HTTP ${st})`);
		// With the user's own dark theme, the system scheme is light: the page must still be dark.
		await page.emulateMedia({ colorScheme: 'light' });
		const saveThemes = THEMES;
		THEMES = ['light'];
		for (const [id, p] of [['usertheme-dark-files', '/apps/files/files'], ['usertheme-dark-calendar', '/apps/calendar/'], ['usertheme-dark-settings', '/settings/user/theming'], ['usertheme-dark-deck', '/apps/deck/']]) {
			await visit(page, cx, { id, path: p, wait: 2500, fixedTheme: true, check: async (pg, pcx) => {
				const dark = await pg.evaluate(() => document.body.matches('[data-theme-dark], [data-themes*="dark"]') || /dark/.test(document.body.getAttribute('data-themes') || ''));
				if (!dark) problem(pcx, 'dark theme', 'the page is not in the dark theme after choosing it on the Appearance page');
			} });
		}
		THEMES = saveThemes;
		const back = await pick('default');
		log(`  Appearance: back to the system default theme (HTTP ${back})`);
	} catch (e) {
		problem({ ...cx, page: 'usertheme' }, 'Appearance dark theme', e);
	} finally {
		await ctx.close();
	}
}

// A person's first sign-in (calendar example event, no NoBoard welcome board), and the share receiver.
async function freshPass(browser, acc, lang, label) {
	const cx = { pass: label, user: acc.login, lang };
	const ctx = await openContext(browser, cx);
	const page = await ctx.newPage();
	try {
		await login(page, acc, cx);
		// The welcome files a new account gets.
		await visit(page, cx, { id: label + '-files', path: '/apps/files/files', waitFor: '.files-list' });
		await visit(page, cx, { id: label + '-calendar', path: '/apps/calendar/', wait: 4000 });
		const events = await page.evaluate(async (uid) => {
			const token = (window.OC && window.OC.requestToken) || document.head.getAttribute('data-requesttoken');
			const home = `/remote.php/dav/calendars/${encodeURIComponent(uid)}/`;
			const list = await fetch(home, { method: 'PROPFIND', headers: { Depth: '1', requesttoken: token } }).then((r) => r.text());
			const cals = [...list.matchAll(/<d:href>([^<]+)<\/d:href>/g)].map((m) => m[1]).filter((h) => h !== home && !/\/(inbox|outbox|trashbin)\/$/.test(h));
			const out = [];
			for (const cal of cals) {
				const body = '<?xml version="1.0"?><c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><c:calendar-data/></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"/></c:comp-filter></c:filter></c:calendar-query>';
				const t = await fetch(cal, { method: 'REPORT', headers: { Depth: '1', 'Content-Type': 'application/xml', requesttoken: token }, body }).then((r) => r.text());
				for (const m of t.matchAll(/<cal:calendar-data[^>]*>([\s\S]*?)<\/cal:calendar-data>/g)) out.push({ cal, ics: m[1] });
			}
			return { cals, events: out };
		}, acc.login);
		const summaries = [];
		for (const ev of events.events) {
			const ics = ev.ics.replace(/&#13;|\r/g, '').replace(/\n[ \t]/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
			const summary = (ics.match(/^SUMMARY[^:]*:(.*)$/m) || [])[1] || '';
			summaries.push(summary);
			const shown = ics.split('\n').filter((l) => /^(SUMMARY|DESCRIPTION|LOCATION)[;:]/.test(l)).join('\n');
			for (const h of nameHits(shown)) finding({ ...cx, page: label + '-calendar-data', theme: '' }, { kind: 'name', where: 'event text in ' + ev.cal, snippet: h });
		}
		NOTES.push({ ...at(cx), note: 'calendars and events', calendars: events.cals, events: summaries });
		log(`  ${acc.login}: calendars ${events.cals.join(', ') || '(none)'}; events: ${summaries.join(' | ') || '(none)'}`);
		// Open the example event, where the calendar shows it.
		const example = events.events.find((e) => !/qa-t3-audit-event/.test(e.ics));
		if (example) {
			const start = (example.ics.match(/DTSTART[^:]*:(\d{8})/) || [])[1];
			const day = start ? `${start.slice(0, 4)}-${start.slice(4, 6)}-${start.slice(6, 8)}` : 'now';
			const summary = ((example.ics.match(/SUMMARY[^:]*:(.*)/) || [])[1] || '').trim().slice(0, 20);
			await visit(page, cx, { id: label + '-example-event', path: `/apps/calendar/dayGridMonth/${day}`, wait: 3500,
				steps: [click(`.fc-event:has-text(${JSON.stringify(summary)})`, { wait: 2000 }), async (p) => {
					// The popover's "More" opens the full editor with the description.
					const more = p.locator('.event-popover button:has-text("More"), .event-popover__buttons button').last();
					if (await more.count()) await more.click({ timeout: 5000 }).catch(() => {});
					await settle(p, 2500);
				}] });
		}
		await visit(page, cx, { id: label + '-deck', path: '/apps/deck/', wait: 4000 });
		const boards = await page.evaluate(async () => {
			const token = (window.OC && window.OC.requestToken) || document.head.getAttribute('data-requesttoken');
			const r = await fetch('/apps/deck/boards', { headers: { requesttoken: token, Accept: 'application/json' } });
			return r.ok ? (await r.json()).map((b) => b.title) : ['HTTP ' + r.status];
		});
		NOTES.push({ ...at(cx), note: 'NoBoard boards', boards });
		log(`  ${acc.login}: NoBoard boards: ${boards.join(' | ') || '(none)'}`);
		for (const b of boards) for (const h of nameHits(b)) finding({ ...cx, page: label + '-deck-data' }, { kind: 'name', where: 'board title', snippet: h });
	} catch (e) {
		problem({ ...cx, page: label }, label, e);
	} finally {
		await ctx.close();
	}
}

// --- Report ----------------------------------------------------------------------------------------

function writeReport(meta) {
	const w = (name, data) => fs.writeFileSync(path.join(OUT, name), JSON.stringify(data, null, 1) + '\n');
	w('findings.json', FINDINGS);
	w('hidden.json', HIDDEN);
	w('problems.json', PROBLEMS);
	w('network.json', NETWORK);
	w('notes.json', NOTES);
	w('index.json', { ...meta, pages: INDEX });
	const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
	const rows = INDEX.map((r) => `<tr class="${r.findings ? 'bad' : ''}"><td>${esc(r.pass)}</td><td>${esc(r.lang)}</td><td>${esc(r.theme)}</td><td>${esc(r.page)}</td><td>${esc(r.status)}</td><td>${esc(r.htmlLang)} ${esc(r.dir)}</td><td>${esc(r.title)}</td><td>${r.findings}</td><td>${r.hidden}</td><td>${r.shot ? `<a href="${esc(r.shot)}">${esc(r.shot)}</a>` : ''}</td></tr>`).join('\n');
	const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Branding audit</title>
<style>:root{color-scheme:light dark}body{font:14px system-ui,sans-serif;margin:16px}table{border-collapse:collapse;width:100%}td,th{border:1px solid #8884;padding:4px 6px;text-align:left;vertical-align:top}tr.bad{background:#f973162e}</style></head><body>
<h1>Branding audit</h1><p>${esc(meta.started)} to ${esc(meta.finished)}. Languages ${esc(meta.langs.join(', '))}; themes ${esc(meta.themes.join(', '))}. Pages scanned: ${INDEX.length}. Findings: ${FINDINGS.length}. Problems: ${PROBLEMS.length}. Hidden-element hits: ${HIDDEN.length}. Admin pages are not part of this audit.</p>
<table><tr><th>Pass</th><th>Language</th><th>Theme</th><th>Page</th><th>HTTP</th><th>lang / dir</th><th>Title</th><th>Findings</th><th>Hidden</th><th>Screenshot</th></tr>
${rows}</table></body></html>\n`;
	fs.writeFileSync(path.join(OUT, 'index.html'), html);
}

// --- Main ------------------------------------------------------------------------------------------

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const config = JSON.parse(fs.readFileSync(args.config, 'utf8'));
	BASE = String(config.base || 'https://drive.nourax.org').replace(/\/$/, '');
	OUT = config.out;
	fs.mkdirSync(OUT, { recursive: true });
	const langs = args.langs || config.langs || ['en_GB', 'en', 'de', 'ar'];
	THEMES = args.themes || config.themes || ['light', 'dark'];
	ONLY = args.pages || null;
	const passes = args.passes || config.passes || ['user', 'public', 'extras'];
	const main = account(config.accounts.main, 'main');
	const sharer = account(config.accounts.sharer, 'sharer');
	const fresh = (config.accounts.fresh || []).map((a, i) => account(a, 'fresh' + (i + 1)));
	const started = new Date().toISOString();
	log(`branding audit of ${BASE}: languages ${langs.join(',')}, themes ${THEMES.join(',')}, passes ${passes.join(',')}; screenshots in ${OUT}`);

	const fx = { ids: {}, tokens: {} };
	// Sign in through the form before anything else: the first sign-in of an account sets it up (its
	// calendar, address book and welcome files), but only when it is not made with an app password,
	// and the test data below is made with the app password.
	{
		const browser = await chromium.launch({ channel: (config.chrome && config.chrome.channel) || 'chrome', headless: config.headless !== false });
		for (const acc of [main, sharer].filter(Boolean)) {
			const ctx = await browser.newContext({ locale: 'en-GB' });
			await login(await ctx.newPage(), acc, { lang: 'en_GB' });
			await ctx.close();
		}
		await browser.close();
	}
	const startLang = await getLanguage(main);
	if (args.setup) {
		await api(main, 'MKCOL', dav(main, FOLDER));
		log('fixtures: ' + [
			await ensureFile(main, FOLDER + '/probe.txt', 'A test file for scripts/check-branding.sh.\n', 'text/plain'),
			await ensureFile(main, `${FOLDER}/${FILES.image}`, makePng(), 'image/png'),
			await ensureFile(main, `${FOLDER}/${FILES.md}`, '# Audit notes\n\nA test note of the browser audit.\n', 'text/markdown'),
			await ensureFile(main, `${FOLDER}/${FILES.pdf}`, makePdf(), 'application/pdf'),
			await ensureFile(main, `${FOLDER}/${FILES.docx}`, makeDocx(), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
		].join(', '));
		if (sharer) log(`share from ${sharer.login} to ${main.login}: ${await ensureUserShare(sharer, main)}; comment mentioning ${main.login}: ${await ensureMention(sharer, main)}`);
		fx.deck = await ensureBoard(main);
		fx.eventDay = await ensureEvent(main);
		log(`NoBoard board ${fx.deck.board}, card ${fx.deck.card}; calendar event on ${fx.eventDay}; contact ${await ensureContact(main)}`);
		if (!/^\d{4}-/.test(fx.eventDay)) fx.eventDay = null;
	} else {
		fx.deck = await ensureBoard(main).catch(() => null);
		fx.eventDay = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
	}
	fx.ids = await fileIds(main, FOLDER);
	fx.tokens = await ensureLinks(main);
	log(`test files: ${Object.keys(fx.ids).length - 1}; test links: ${Object.keys(fx.tokens).sort().join(', ')}`);
	Object.assign(fx, await discover(main));
	log(`app menu: ${fx.apps.map((a) => a.id).join(', ')}; Personal settings: ${fx.sections.join(', ')}`);

	const browser = await chromium.launch({ channel: (config.chrome && config.chrome.channel) || 'chrome', headless: config.headless !== false });
	log(`browser: ${browser.version()}`);
	try {
		if (passes.includes('user')) {
			for (const lang of langs) {
				log(`-- signed in as ${main.login}, language ${lang}`);
				await userPass(browser, main, lang, fx, lang === 'de' && config.language_menu !== false);
			}
		}
		if (passes.includes('public')) {
			for (const lang of langs) {
				log(`-- signed out, browser language ${LOCALES[lang] || lang}`);
				await publicPass(browser, lang, fx.tokens);
			}
		}
		if (passes.includes('extras')) {
			log('-- the Appearance page dark theme');
			await themePass(browser, main, langs[0]);
			if (sharer) {
				log(`-- ${sharer.login}: NoBoard and NoCalendar`);
				await freshPass(browser, sharer, 'en_GB', 'sharer');
			}
			for (const f of fresh) {
				log(`-- ${f.login}: first sign-in`);
				await freshPass(browser, f, 'en_GB', 'fresh');
			}
		}
		// Leave the account in the language it had.
		const ctx = await openContext(browser, { pass: 'restore', lang: startLang || 'en_GB' });
		const page = await ctx.newPage();
		await login(page, main, { lang: startLang || 'en_GB' });
		await setLanguage(page, main, startLang || 'en_GB');
		await ctx.close();
		log(`language of ${main.login} set back to ${startLang || 'en_GB'}`);
	} finally {
		await browser.close();
		writeReport({ base: BASE, started, finished: new Date().toISOString(), langs, themes: THEMES, passes, accounts: [main.login, sharer && sharer.login, ...fresh.map((f) => f.login)].filter(Boolean) });
	}
	log(`RESULT ${FINDINGS.length || PROBLEMS.length ? 'FAIL' : 'PASS'}: ${INDEX.length} page scans, ${FINDINGS.length} findings, ${PROBLEMS.length} problems, ${HIDDEN.length} hidden-element hits, ${NETWORK.filter((n) => n.kind === 'l10n-json').length} /l10n/*.json fetches; report ${path.join(OUT, 'index.html')}`);
	return FINDINGS.length || PROBLEMS.length ? 1 : 0;
}

main().then((code) => process.exit(code), (e) => {
	console.error(redact('audit could not run: ' + (e && e.stack ? e.stack : e)));
	process.exit(2);
});
