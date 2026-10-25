#!/usr/bin/env bash
# Check that a person using Nourax Workspace sees no Nextcloud name, link, logo or blue.
#   scripts/check-branding.sh CREDENTIALS_FILE [--base https://drive.nourax.org] [--langs en_GB,en,de,ar]
#       [--only pages,l10n,theming,share,dav,errors,config,mail,css] [--server] [--limit 25]
#
# CREDENTIALS_FILE belongs to a normal QA user (never an admin) and holds either one netrc line,
#   machine drive.nourax.org login qa-t3-1 password <app password>
# or "login:app-password" on the first line. The secret reaches curl only through --netrc-file or a
# curl config read from stdin, never the command line, and it is never printed.
#
# Areas (all but css by default):
#   pages    signed-in pages and the login page: visible text, title, attributes, meta tags, every
#            link, the page settings (var _theme ...) and the initial-state data
#   l10n     every /l10n/*.js file those pages load, in each --langs language
#   theming  manifests, theme CSS, custom CSS, favicon, touch and mask icons
#   share    a test folder, file and four public links of the QA user, opened signed out
#   dav      the text shown when /remote.php/dav is opened in a browser
#   errors   404, 403, missing share, unsupported browser, status.php
#   config   (--server) theme, customclient_* and the apps that must be off
#   mail     (--server) a sample e-mail rendered on the server, never sent
#   css      every other stylesheet the pages link, for hard-coded blues
# --server (sudo, on the server, read only) adds config and mail, and makes l10n also merge every
# enabled app's translation files with the theme's, for every language including en, and compare
# sweep-state.json with the installed versions.
#
# Output: "FAIL <area> <url> <where>: <snippet>" for each hit, then a summary per area. Exit code 0
# when clean, 1 on any hit, 2 when the check could not run. The rules are shared with the sweep and
# the browser audit: nextcloud-apps/nourax_branding/sweep/rules.json (see docs/branding.md).
# Cloudflare lets only the owner's IP open /login, /settings and the user API, so run it from the
# owner's PC; on the server those pages show as SKIP.
# SPDX-License-Identifier: AGPL-3.0-or-later

caller_dir="$PWD"
# shellcheck source=scripts/lib.sh
. "$(dirname "$0")/lib.sh"

usage() {
	sed -n '2,/^# SPDX/p' "$REPO_DIR/scripts/check-branding.sh" | sed -e '$d' -e 's/^# \{0,1\}//'
	exit "${1:-2}"
}
bad_usage() { log "ERROR: $*" >&2; exit 2; }
need_value() {
	if [ "$#" -lt 2 ] || [ -z "$2" ]; then
		bad_usage "$1 needs a value (see --help)"
	fi
}

creds="" base="https://drive.nourax.org" langs="en_GB,en,de,ar" only="" server=0 limit=25
while [ "$#" -gt 0 ]; do
	case "$1" in
		--base) need_value "$@"; base="$2"; shift 2 ;;
		--base=*) base="${1#*=}"; shift ;;
		--langs) need_value "$@"; langs="$2"; shift 2 ;;
		--langs=*) langs="${1#*=}"; shift ;;
		--only) need_value "$@"; only="$2"; shift 2 ;;
		--only=*) only="${1#*=}"; shift ;;
		--limit) need_value "$@"; limit="$2"; shift 2 ;;
		--limit=*) limit="${1#*=}"; shift ;;
		--server) server=1; shift ;;
		-h | --help) usage 0 ;;
		-*) bad_usage "unknown option $1 (see --help)" ;;
		*)
			[ -z "$creds" ] || bad_usage "give only one credentials file"
			creds="$1"
			shift
			;;
	esac
done

[[ "$base" =~ ^https?://[A-Za-z0-9.-]+(:[0-9]+)?/?$ ]] || bad_usage "--base must look like https://drive.nourax.org"
[[ "$langs" =~ ^[a-z]{2,3}(_[A-Za-z0-9]+)?(,[a-z]{2,3}(_[A-Za-z0-9]+)?)*$ ]] || bad_usage "--langs must look like en_GB,en,de,ar"
[[ "$only" =~ ^([a-z0-9]+(,[a-z0-9]+)*)?$ ]] || bad_usage "--only must look like pages,l10n"
[[ "$limit" =~ ^[0-9]+$ ]] || bad_usage "--limit must be a number (0 shows every hit)"

# Only the server-side areas can run without a QA user.
if [ -z "$creds" ]; then
	http_areas="$(printf '%s\n' "${only//,/$'\n'}" | grep -vxE 'config|mail' || true)"
	if [ -z "$only" ] || [ -n "$http_areas" ]; then
		bad_usage "give the credentials file of a QA user (see --help)"
	fi
else
	case "$creds" in
		/* | [A-Za-z]:[/\\]*) ;;
		*) creds="$caller_dir/$creds" ;;
	esac
	[ -r "$creds" ] || bad_usage "cannot read the credentials file $creds"
fi

if [ "$server" = 1 ]; then
	need_root
	command -v docker >/dev/null 2>&1 || bad_usage "--server runs on the server, next to docker compose"
fi
command -v curl >/dev/null 2>&1 || bad_usage "curl is needed"

# Python 3 does the parsing: neither jq nor php is on every machine that runs this.
py=""
for cand in python3 python; do
	if command -v "$cand" >/dev/null 2>&1 \
		&& "$cand" -I -c 'import sys; sys.exit(sys.version_info < (3, 8))' >/dev/null 2>&1; then
		py="$cand"
		break
	fi
done
[ -n "$py" ] || bad_usage "Python 3.8 or newer is needed (python3 or python)"

# On Windows (Git Bash) Python needs C:/... paths; paths go through the environment so that Git Bash
# does not rewrite any argument.
native_path() {
	if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s' "$1"; fi
}
rules="$REPO_DIR/nextcloud-apps/nourax_branding/sweep/rules.json"
[ -r "$rules" ] || bad_usage "rules file missing: $rules"
NBC_RULES="$(native_path "$rules")"
NBC_REPO="$(native_path "$REPO_DIR")"
NBC_CREDS=""
[ -z "$creds" ] || NBC_CREDS="$(native_path "$creds")"
NBC_BASE="${base%/}"
NBC_LANGS="$langs"
NBC_ONLY="$only"
NBC_SERVER="$server"
NBC_LIMIT="$limit"
export NBC_RULES NBC_REPO NBC_CREDS NBC_BASE NBC_LANGS NBC_ONLY NBC_SERVER NBC_LIMIT
export MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*'

exec "$py" -I -X utf8 - <<'PY'
import base64
import hashlib
import json
import os
import re
import secrets
import shutil
import subprocess
import sys
import tempfile
import time
from html.parser import HTMLParser
from urllib.parse import quote, unquote, urljoin, urlsplit

E = os.environ
BASE = E['NBC_BASE']
BASE_HOST = (urlsplit(BASE).hostname or '').lower()
LANGS = E['NBC_LANGS'].split(',')
LIMIT = int(E['NBC_LIMIT'])
SERVER = E['NBC_SERVER'] == '1'
REPO = E['NBC_REPO']
CREDS = E['NBC_CREDS']
DEFAULT_AREAS = ['pages', 'l10n', 'theming', 'share', 'dav', 'errors', 'config', 'mail']
ALL_AREAS = DEFAULT_AREAS + ['css']
HTTP_AREAS = {'pages', 'l10n', 'theming', 'share', 'dav', 'errors', 'css'}
UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 nourax-check-branding/1'
OLD_UA = 'Mozilla/5.0 (Windows NT 6.1; Trident/7.0; rv:11.0) like Gecko'
SHARE_LABEL = 'branding-check '
L10N_REF = 'en_GB'

only = [a for a in E['NBC_ONLY'].split(',') if a] or DEFAULT_AREAS
unknown = [a for a in only if a not in ALL_AREAS]
if unknown:
	print('ERROR: unknown area ' + ', '.join(unknown) + ' (known: ' + ', '.join(ALL_AREAS) + ')', file=sys.stderr)
	sys.exit(2)
AREAS = set(only)


def stop(msg):
	print('ERROR: ' + msg, file=sys.stderr, flush=True)
	sys.exit(2)


# ---- rules -------------------------------------------------------------------------------------

with open(E['NBC_RULES'], encoding='utf-8') as f:
	RULES = json.load(f)


def compile_rules(key):
	out = []
	for r in RULES.get(key, []):
		if '~' in r['re']:
			stop('rules.json: %s %s uses ~, which the PHP check uses as delimiter' % (key, r['id']))
		out.append((r['id'], re.compile(r['re'])))
	return out


NAME = compile_rules('name_patterns')
LINK = compile_rules('link_patterns')
ASSET = compile_rules('asset_patterns')
BLUE = compile_rules('blue_patterns')
ALLOW = []
for a in RULES.get('allow', []):
	ALLOW.append({k: (v if k == 'area' else re.compile(v)) for k, v in a.items() if k in ('area', 'url', 'where', 'snippet')})


# ---- output ------------------------------------------------------------------------------------

class Report:
	def __init__(self):
		self.stats = {a: {'checked': 0, 'fail': 0, 'skip': 0} for a in ALL_AREAS}
		self.shown = {}
		self.hidden = {}
		self.seen = set()
		self.first = {}
		self.repeat = {}
		self.redact = []

	def clean(self, s, width=0):
		s = str(s)
		for secret in self.redact:
			if secret:
				s = s.replace(secret, '[secret]')
		s = re.sub(r'[\s\x00-\x1f]+', ' ', s).strip()
		if width and len(s) > width:
			s = s[:width - 1] + '…'
		return s

	def say(self, line):
		print(self.clean(line), flush=True)

	def checked(self, area, n=1):
		self.stats[area]['checked'] += n

	def allowed(self, area, url, where, snippet):
		for a in ALLOW:
			if a.get('area', area) != area:
				continue
			if all(a[k].search(v) for k, v in (('url', url), ('where', where), ('snippet', snippet)) if k in a):
				return True
		return False

	def fail(self, area, url, where, snippet):
		where = self.clean(where, 90)
		snippet = self.clean(snippet, 120)
		if self.allowed(area, url, where, snippet) or (area, url, where, snippet) in self.seen:
			return
		self.seen.add((area, url, where, snippet))
		self.stats[area]['fail'] += 1
		# The same hit on many pages (the page settings, the meta tags) is shown once, then counted.
		same = (area, where, snippet)
		if LIMIT and same in self.first:
			self.repeat[area] = self.repeat.get(area, 0) + 1
			return
		self.first.setdefault(same, url)
		key = (area, url)
		if LIMIT and self.shown.get(key, 0) >= LIMIT:
			self.hidden[key] = self.hidden.get(key, 0) + 1
			return
		self.shown[key] = self.shown.get(key, 0) + 1
		self.say('FAIL %s %s %s: %s' % (area, url, where, snippet))

	def more(self, area, url, n):
		# Hits the server side counted but did not send.
		if n > 0:
			self.stats[area]['fail'] += n
			self.hidden[(area, url)] = self.hidden.get((area, url), 0) + n

	def skip(self, area, url, why):
		self.stats[area]['skip'] += 1
		self.say('SKIP %s %s: %s' % (area, url, why))

	def info(self, text):
		self.say('INFO ' + text)

	def finish(self):
		for area, n in sorted(self.repeat.items()):
			self.say('SAME %s: %d more hits repeat a hit listed above on other pages or languages (--limit 0 lists all)' % (area, n))
		for (area, url), n in sorted(self.hidden.items()):
			self.say('MORE %s %s: %d more hits not shown (--limit 0 shows all)' % (area, url, n))
		total = 0
		for area in ALL_AREAS:
			if area not in AREAS:
				continue
			st = self.stats[area]
			total += st['fail']
			self.say('SUMMARY %-8s %4d checked, %4d FAIL, %3d SKIP' % (area, st['checked'], st['fail'], st['skip']))
		self.say('RESULT %s (%d hits)' % ('FAIL' if total else 'PASS', total))
		return 1 if total else 0


rep = Report()


def label(url):
	# Short form of a URL for the output: the path on our site, or the full outside URL.
	p = urlsplit(url)
	if (p.hostname or '').lower() == BASE_HOST:
		return (p.path or '/') + ('?' + p.query if p.query else '')
	return url


def around(s, a, b):
	start = max(0, a - 45)
	end = min(len(s), b + 70)
	return ('…' if start else '') + s[start:end] + ('…' if end < len(s) else '')


def name_hits(s):
	hits = []
	for pid, rx in NAME:
		for m in rx.finditer(s):
			hits.append((m.start(), m.end(), pid))
	return sorted(hits)


def scan_names(area, url, where, s, first_only=False):
	if not s:
		return 0
	hits = name_hits(s)
	for a, b, _pid in (hits[:1] if first_only else hits):
		rep.fail(area, url, where, around(s, a, b))
	return len(hits)


def scan_blues(area, url, where, s, ignore_fallbacks=False):
	if not s:
		return
	for pid, rx in BLUE:
		for m in rx.finditer(s):
			if ignore_fallbacks and re.search(r'var\(\s*--[\w-]+\s*,\s*$', s[max(0, m.start() - 80):m.start()]):
				continue
			rep.fail(area, url, '%s %s' % (where, pid), around(s, m.start(), m.end()))


URL_IN_TEXT = re.compile(r'''(?i)\b(?:https?|ftp|mailto):[^\s"'<>\\)\]]+|\bwww\.[a-z0-9-]+\.[^\s"'<>\\)\]]+''')


def url_problem(raw, page_url):
	u = (raw or '').strip()
	if not u or u.startswith('#') or u.lower().startswith(('data:', 'blob:', 'javascript:', 'about:')):
		return None
	if u.lower().startswith('www.'):
		u = 'https://' + u
	try:
		absu = urljoin(page_url, u)
		p = urlsplit(absu)
		host = (p.hostname or '').lower()
	except ValueError:
		return None
	for pid, rx in LINK:
		if rx.search(absu):
			return 'upstream link (%s)' % pid
	if host and host != BASE_HOST:
		decoded = unquote(absu)
		for pid, rx in NAME:
			if rx.search(decoded):
				return 'outside link with the name (%s)' % pid
	elif host == BASE_HOST:
		for pid, rx in ASSET:
			if rx.search(p.path):
				return 'upstream asset (%s)' % pid
	return None


def scan_url(area, url, where, raw, page_url):
	prob = url_problem(raw, page_url)
	if prob:
		rep.fail(area, url, '%s %s' % (where, prob), raw)
	return prob


def walk(obj, path=''):
	if isinstance(obj, dict):
		for k, v in obj.items():
			if str(k).startswith('$'):   # "$comment" and similar notes are never shown
				continue
			yield from walk(v, '%s.%s' % (path, k) if path else str(k))
	elif isinstance(obj, list):
		for i, v in enumerate(obj):
			yield from walk(v, '%s[%d]' % (path, i))
	elif isinstance(obj, str):
		yield path, obj


def scan_json(area, url, where, obj, names=False):
	for path, s in walk(obj):
		w = '%s.%s' % (where, path) if path else where
		for m in URL_IN_TEXT.finditer(s):
			scan_url(area, url, w, m.group(0), BASE + '/')
		if s.startswith('/') and not s.startswith('//') and ' ' not in s and len(s) < 400:
			scan_url(area, url, w, s, BASE + '/')
		if names:
			# Links were checked above with the link rules; the name check looks at the words.
			scan_names(area, url, w, URL_IN_TEXT.sub(' ', s), first_only=True)


# ---- HTML --------------------------------------------------------------------------------------

TEXT_ATTRS = ('title', 'alt', 'aria-label', 'aria-description', 'placeholder', 'label')
URL_ATTRS = ('href', 'src', 'srcset', 'action', 'formaction', 'poster', 'data', 'xlink:href', 'background')
COLOUR_ATTRS = ('bgcolor', 'color', 'fill', 'stroke', 'stop-color')
VAR_RE = re.compile(r'^\s*var\s+([A-Za-z_$][\w$]*)\s*=\s*(.*?)\s*;?\s*$')


class Page(HTMLParser):
	def __init__(self):
		super().__init__(convert_charrefs=True)
		self.text, self.title, self.attrs, self.urls = [], [], [], []
		self.metas, self.links, self.scripts, self.inline, self.styles = [], [], [], [], []
		self.states = {}
		self.html_attrs = {}
		self._in = None
		self._buf = []

	def handle_starttag(self, tag, attrs):
		a = {}
		for k, v in attrs:
			a[k.lower()] = v or ''
		if tag == 'html':
			self.html_attrs = a
		if tag in ('script', 'style', 'title'):
			self._in, self._buf = tag, []
			self._src = a.get('src', '')
		if tag == 'script' and a.get('src'):
			self.scripts.append(a['src'])
		if tag == 'meta':
			self.metas.append(a)
			if a.get('http-equiv', '').lower() == 'refresh' and 'url=' in a.get('content', '').lower():
				self.urls.append((tag, 'refresh', a['content'].split('=', 1)[1]))
		if tag == 'link':
			self.links.append(a)
		if tag == 'input' and a.get('type') == 'hidden' and a.get('id', '').startswith('initial-state-'):
			self.states[a['id'][len('initial-state-'):]] = a.get('value', '')
		for k in TEXT_ATTRS:
			if a.get(k):
				self.attrs.append((tag, k, a[k]))
		if tag == 'input' and a.get('type', '').lower() in ('submit', 'button', 'reset') and a.get('value'):
			self.attrs.append((tag, 'value', a['value']))
		where = 'link[rel=%s]' % a.get('rel', '') if tag == 'link' else tag
		for k in URL_ATTRS:
			if a.get(k):
				self.urls.append((where, k, a[k]))
		if a.get('style'):
			self.styles.append(('%s[style]' % tag, a['style']))
		for k in COLOUR_ATTRS:
			if a.get(k):
				self.styles.append(('%s[%s]' % (tag, k), a[k]))

	def handle_endtag(self, tag):
		if self._in == tag:
			content = ''.join(self._buf)
			if tag == 'script' and not self._src:
				self.inline.append(content)
			elif tag == 'style':
				self.styles.append(('<style>', content))
			elif tag == 'title':
				self.title.append(content)
			self._in = None

	def handle_data(self, data):
		if self._in:
			self._buf.append(data)
		else:
			self.text.append(data)


def check_html(area, url, page_url, body, names_in_states=True):
	p = Page()
	try:
		p.feed(body)
		p.close()
	except Exception as e:  # noqa: BLE001 - report and carry on
		rep.fail(area, url, 'html', 'could not be read: %s' % e)
		return p
	rep.checked(area)
	scan_names(area, url, 'title', ' '.join(p.title))
	scan_names(area, url, 'text', re.sub(r'\s+', ' ', ' '.join(p.text)))
	for tag, k, v in p.attrs:
		scan_names(area, url, '%s[%s]' % (tag, k), v)
	for m in p.metas:
		name = (m.get('name') or m.get('property') or m.get('http-equiv') or '').lower()
		content = m.get('content', '')
		if name == 'apple-itunes-app':
			rep.fail(area, url, 'meta apple-itunes-app', '<meta name="apple-itunes-app" content="%s"> (the upstream iOS app banner)' % content)
			continue
		if name in ('csp-nonce', 'viewport') or not content:
			continue
		scan_names(area, url, 'meta %s' % name, content)
		for u in URL_IN_TEXT.finditer(content):
			scan_url(area, url, 'meta %s' % name, u.group(0), page_url)
		if name in ('theme-color', 'msapplication-tilecolor'):
			scan_blues(area, url, 'meta %s' % name, content)
	for tag, k, v in p.urls:
		values = [x.strip().split()[0] for x in v.split(',') if x.strip()] if k == 'srcset' else [v]
		for one in values:
			scan_url(area, url, '%s[%s]' % (tag, k), one, page_url)
	for content in p.inline:
		stripped = content.strip()
		if stripped.startswith('{'):
			try:
				scan_json(area, url, 'inline JSON', json.loads(stripped))
			except ValueError:
				pass
			continue
		for line in content.splitlines():
			m = VAR_RE.match(line)
			if not m:
				continue
			try:
				value = json.loads(m.group(2))
			except ValueError:
				value = m.group(2)
			scan_json(area, url, 'var %s' % m.group(1), value, names=m.group(1) in ('_theme', 'oc_defaults'))
	for sid, raw in p.states.items():
		try:
			value = json.loads(base64.b64decode(raw).decode('utf-8'))
		except ValueError:
			continue
		scan_json(area, url, 'initial-state %s' % sid, value, names=names_in_states)
	for where, css in p.styles:
		scan_blues(area, url, where, css)
	return p


def state(page, sid):
	try:
		return json.loads(base64.b64decode(page.states[sid]).decode('utf-8'))
	except (KeyError, ValueError):
		return None


# ---- HTTP through curl -------------------------------------------------------------------------

def cq(s):
	return '"' + str(s).replace('\\', '\\\\').replace('"', '\\"') + '"'


class Resp:
	def __init__(self):
		self.status, self.exit, self.url, self.error = 0, 0, '', ''
		self.headers, self.body = {}, b''

	@property
	def text(self):
		return self.body.decode('utf-8', 'replace')

	@property
	def blocked(self):
		# A Cloudflare firewall answer: Nextcloud always sends its own request id.
		return self.status == 403 and 'x-request-id' not in self.headers and 'cloudflare' in self.headers.get('server', '').lower()


class Http:
	def __init__(self, tmp, cred):
		self.tmp, self.cred, self.n = tmp, cred, 0

	def run(self, reqs, retry=True):
		if not reqs:
			return []
		cfg = ['parallel', 'parallel-max = 4', 'silent']
		files = []
		for i, r in enumerate(reqs):
			self.n += 1
			body = os.path.join(self.tmp, 'r%d.body' % self.n)
			head = os.path.join(self.tmp, 'r%d.head' % self.n)
			files.append((body, head))
			if i:
				cfg.append('next')
			cfg += ['url = ' + cq(r['url']), 'output = ' + cq(body), 'dump-header = ' + cq(head),
				'write-out = ' + cq('NBC\t%d\t%%{http_code}\t%%{exitcode}\t%%{url_effective}\t%%{errormsg}\\n' % i),
				'globoff', 'compressed', 'max-time = 90', 'connect-timeout = 20',
				'user-agent = ' + cq(r.get('ua', UA))]
			if r.get('follow', True):
				cfg.append('location')
			if r.get('method'):
				cfg.append('request = ' + cq(r['method']))
			for h in r.get('headers', ()):
				cfg.append('header = ' + cq(h))
			for d in r.get('data', ()):
				cfg.append('data-urlencode = ' + cq(d))
			if r.get('upload'):
				cfg.append('upload-file = ' + cq(r['upload']))
			if r.get('auth'):
				if self.cred['kind'] == 'netrc':
					cfg.append('netrc-file = ' + cq(self.cred['path']))
				else:
					cfg.append('user = ' + cq(self.cred['login'] + ':' + self.cred['secret']))
		cfg_text = '\n'.join(cfg) + '\n'
		try:
			proc = subprocess.run(['curl', '-K', '-'], input=cfg_text.encode('utf-8'),
				stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=120 + 30 * len(reqs))
		except subprocess.TimeoutExpired:
			stop('curl did not finish in time')
		out = [Resp() for _ in reqs]
		for line in proc.stdout.decode('utf-8', 'replace').splitlines():
			parts = line.split('\t')
			if len(parts) >= 5 and parts[0] == 'NBC':
				r = out[int(parts[1])]
				r.status, r.exit, r.url = int(parts[2] or 0), int(parts[3] or 0), parts[4]
				r.error = parts[5] if len(parts) > 5 else ''
		for r, (body, head) in zip(out, files):
			if os.path.exists(body):
				with open(body, 'rb') as f:
					r.body = f.read()
				os.remove(body)
			if os.path.exists(head):
				with open(head, 'rb') as f:
					r.headers = parse_headers(f.read().decode('latin-1'))
				os.remove(head)
		again = [i for i, r in enumerate(out) if r.status in (0, 502, 503, 504)]
		if retry and again:
			rep.info('%d requests failed (HTTP 502/503/504 or no answer); waiting 60 s, then trying them once more' % len(again))
			time.sleep(60)
			for i, r in zip(again, self.run([reqs[i] for i in again], retry=False)):
				out[i] = r
		return out

	def one(self, req):
		return self.run([req])[0]


def parse_headers(raw):
	blocks = [b for b in re.split(r'\r?\n\r?\n', raw) if b.strip().startswith('HTTP/')]
	headers = {}
	if blocks:
		for line in blocks[-1].splitlines()[1:]:
			if ':' in line:
				k, v = line.split(':', 1)
				headers[k.strip().lower()] = v.strip()
	return headers


def with_lang(url, lang):
	return url + ('&' if '?' in url else '?') + 'forceLanguage=' + lang


def lang_header(lang):
	return 'Accept-Language: ' + lang.replace('_', '-')


def read_creds(path):
	with open(path, encoding='utf-8') as f:
		lines = [line.strip() for line in f if line.strip() and not line.lstrip().startswith('#')]
	if not lines:
		stop('the credentials file is empty')
	tokens = ' '.join(lines).split()
	if tokens[0] in ('machine', 'default'):
		entries, cur, i = [], None, 0
		while i < len(tokens):
			t = tokens[i]
			if t == 'machine':
				cur = {'machine': tokens[i + 1] if i + 1 < len(tokens) else ''}
				entries.append(cur)
				i += 2
			elif t == 'default':
				cur = {'machine': ''}
				entries.append(cur)
				i += 1
			elif t in ('login', 'password', 'account') and cur is not None and i + 1 < len(tokens):
				cur[t] = tokens[i + 1]
				i += 2
			else:
				i += 1
		match = [e for e in entries if e['machine'].lower() == BASE_HOST] or [e for e in entries if e['machine'] == '']
		if not match or not match[0].get('login') or not match[0].get('password'):
			stop('the netrc file has no login and password for %s' % BASE_HOST)
		return {'kind': 'netrc', 'path': path, 'login': match[0]['login'], 'secret': match[0]['password']}
	if ':' not in lines[0]:
		stop('the credentials file must be a netrc line or login:app-password')
	login, secret = lines[0].split(':', 1)
	return {'kind': 'user', 'login': login.strip(), 'secret': secret.strip()}


def ocs(url, **kw):
	sep = '&' if '?' in url else '?'
	r = dict(url=BASE + url + sep + 'format=json', auth=True, headers=['OCS-APIRequest: true', 'Accept: application/json'])
	r.update(kw)
	return r


def ocs_data(resp):
	try:
		return json.loads(resp.text)['ocs']['data']
	except (ValueError, KeyError, TypeError):
		return None


# ---- the checks --------------------------------------------------------------------------------

SIGNED_IN = ['/apps/files/', '/apps/calendar/', '/apps/contacts/', '/apps/deck/', '/apps/activity/',
	'/apps/photos/', '/settings/user', '/settings/user/security', '/settings/user/sharing',
	'/settings/user/notifications', '/settings/user/theming', '/settings/user/availability',
	'/settings/help', '/settings/user/sync-clients']


def page_req(path, lang, auth, **kw):
	r = dict(url=with_lang(BASE + path, lang), auth=auth,
		headers=[lang_header(lang), 'Accept: text/html,application/xhtml+xml'])
	r.update(kw)
	return r


def setup_share(http, uid):
	# The QA user's own test folder, file and links; found again by their labels on later runs.
	dav = '%s/remote.php/dav/files/%s/branding-check' % (BASE, quote(uid))
	r = http.one(dict(url=dav, auth=True, method='PROPFIND', headers=['Depth: 0']))
	if r.status == 404:
		r = http.one(dict(url=dav, auth=True, method='MKCOL'))
		if r.status not in (201, 405):
			rep.fail('share', label(dav), 'MKCOL', 'could not create the test folder: HTTP %d' % r.status)
			return {}
	probe = dav + '/probe.txt'
	r = http.one(dict(url=probe, auth=True, method='PROPFIND', headers=['Depth: 0']))
	if r.status == 404:
		path = os.path.join(http.tmp, 'probe.txt')
		with open(path, 'w', encoding='utf-8') as f:
			f.write('A test file for scripts/check-branding.sh.\n')
		r = http.one(dict(url=probe, auth=True, upload=path))
		if r.status not in (201, 204):
			rep.fail('share', label(probe), 'PUT', 'could not upload the test file: HTTP %d' % r.status)
			return {}
	want = [('file', '/branding-check/probe.txt', '1', False), ('folder', '/branding-check', '1', False),
		('password', '/branding-check', '1', True), ('drop', '/branding-check', '4', False)]
	have, found = {}, {}
	for p in ('/branding-check', '/branding-check/probe.txt'):
		data = ocs_data(http.one(ocs('/ocs/v2.php/apps/files_sharing/api/v1/shares?path=' + quote(p))))
		for s in data or []:
			lab = s.get('label') or ''
			if str(s.get('share_type')) == '3' and lab.startswith(SHARE_LABEL) and s.get('token'):
				kind = lab[len(SHARE_LABEL):]
				if kind not in have:
					have[kind] = s['token']
					found[kind] = s
	created = 0
	for kind, path, perms, with_password in want:
		if kind in have:
			# Read 1, file drop 4 (the share bit 16 is added by the server). Repair a link that drifted.
			s = found[kind]
			if int(s.get('permissions') or 0) & 15 != int(perms):
				r = http.one(ocs('/ocs/v2.php/apps/files_sharing/api/v1/shares/%s' % s['id'], method='PUT', data=['permissions=' + perms]))
				rep.info('test link "%s" had permissions %s; set to %s (HTTP %d)' % (kind, s.get('permissions'), perms, r.status))
			continue
		# No publicUpload: in Nextcloud 35 it turns a link into an editable folder.
		data = ['path=' + path, 'shareType=3', 'permissions=' + perms, 'label=' + SHARE_LABEL + kind]
		if with_password:
			# A fresh random password, kept in memory only: nobody needs to open this link.
			password = secrets.token_urlsafe(24) + 'aA1-'
			rep.redact.append(password)
			data.append('password=' + password)
		r = http.one(ocs('/ocs/v2.php/apps/files_sharing/api/v1/shares', method='POST', data=data))
		got = ocs_data(r)
		if r.status == 200 and isinstance(got, dict) and got.get('token'):
			have[kind] = got['token']
			created += 1
		else:
			rep.fail('share', '/ocs/v2.php/apps/files_sharing/api/v1/shares', 'create %s link' % kind,
				'HTTP %d %s' % (r.status, (json.loads(r.text).get('ocs', {}).get('meta', {}).get('message', '') if r.text.startswith('{') else '')))
	rep.info('test links of %s in /branding-check: %d found, %d created (%s)' % (uid, len(have) - created, created, ', '.join(sorted(have))))
	return have


def check_l10n(results, union_sources):
	# results: lang -> list of (url, app, translations); every app seen in any language must be
	# translated in every language, because a missing translation shows the English source text.
	keys = {}
	for lang, files in results.items():
		for url, app, tr in files:
			keys.setdefault(app, set()).update(tr.keys())
	for app in union_sources:
		keys.setdefault(app, set())
	for lang in LANGS:
		merged, where = {}, {}
		for url, app, tr in results.get(lang, []):
			merged.setdefault(app, {}).update(tr)
			where.setdefault(app, url)
			for k, v in tr.items():
				for s in (v if isinstance(v, list) else [v]):
					if isinstance(s, str) and scan_names('l10n', url, '"%s"' % k[:60], s, first_only=True):
						break
		for app, ks in sorted(keys.items()):
			have = merged.get(app, {})
			url = where.get(app, '%s/%s (no file loaded)' % (app, lang))
			for k in sorted(ks):
				if k not in have and name_hits(k):
					rep.fail('l10n', url, '"%s"' % k[:60], 'no %s translation, so the English text with the name is shown' % lang)


L10N_RE = re.compile(r'OC\.L10N\.register\(\s*("(?:[^"\\]|\\.)*")\s*,\s*(\{.*\})\s*,\s*("(?:[^"\\]|\\.)*")\s*\)\s*;?\s*$', re.S)


def parse_l10n(text):
	m = L10N_RE.search(text)
	if not m:
		return None, None
	return json.loads(m.group(1)), json.loads(m.group(2))


def check_css(area, url, css, blues=True, ignore_fallbacks=False):
	rep.checked(area)
	if blues:
		scan_blues(area, url, 'css', css, ignore_fallbacks=ignore_fallbacks)
	for m in re.finditer(r'''content\s*:\s*(["'])(.*?)\1''', css):
		scan_names(area, url, 'css content', m.group(2))
	for m in re.finditer(r'''url\(\s*["']?([^"')]+)''', css):
		scan_url(area, url, 'css url()', m.group(1), BASE + '/')


def check_manifest(area, url, text, icons):
	rep.checked(area)
	try:
		man = json.loads(text)
	except ValueError:
		rep.fail(area, url, 'manifest', 'not valid JSON')
		return
	scan_json(area, url, 'manifest', man, names=True)
	for k in ('theme_color', 'background_color'):
		scan_blues(area, url, 'manifest %s' % k, str(man.get(k, '')))
	for icon in man.get('icons', []) if isinstance(man.get('icons'), list) else []:
		if isinstance(icon, dict) and icon.get('src'):
			icons.setdefault(urljoin(BASE + url if url.startswith('/') else url, icon['src']), 'manifest icon of %s' % url)


def run_http(http, cred):
	r = http.one(ocs('/ocs/v2.php/cloud/user'))
	me = ocs_data(r)
	if r.status != 200 or not isinstance(me, dict) or not me.get('id'):
		stop('could not sign in as %s at %s (HTTP %d): check the credentials file and --base' % (cred['login'], BASE, r.status))
	uid = me['id']
	if 'admin' in (me.get('groups') or []):
		stop('%s is an admin; use a normal QA user, the check is about what people see' % uid)
	rep.info('signed in as %s; languages %s; areas %s' % (uid, ','.join(LANGS), ','.join(a for a in ALL_AREAS if a in AREAS)))

	upstream = {}
	if 'theming' in AREAS:
		files = RULES.get('upstream_files', [])
		for path, resp in zip(files, http.run([dict(url=BASE + p) for p in files])):
			if resp.status == 200 and resp.body:
				upstream[hashlib.sha256(resp.body).hexdigest()] = path

	# The app menu of the Files page adds every app a person can open (also apps added later).
	first = http.one(page_req('/apps/files/', LANGS[0], True))
	menu = []
	if first.status == 200:
		p0 = Page()
		p0.feed(first.text)
		apps = state(p0, 'core-apps') or []
		for entry in (apps.values() if isinstance(apps, dict) else apps):
			href = entry.get('href', '') if isinstance(entry, dict) else ''
			if href.startswith(BASE):
				href = href[len(BASE):]
			if href.startswith('/') and not href.startswith('//'):
				menu.append(href)
	signed_in = list(dict.fromkeys(SIGNED_IN + ['/u/%s' % quote(uid)] + [m for m in menu if m.rstrip('/') not in {s.rstrip('/') for s in SIGNED_IN}]))

	tokens = setup_share(http, uid) if ('share' in AREAS or 'errors' in AREAS) else {}

	jobs = []   # (area, req, kind)
	# English has no translation files, so the l10n check needs another language to know which
	# texts exist; en_GB pages are read for that when it is not asked for, and not reported.
	ref = [L10N_REF] if 'l10n' in AREAS and L10N_REF not in LANGS else []
	for lang in ref:
		for path in signed_in + ['/login'] + ['/index.php/s/%s' % t for t in tokens.values()]:
			jobs.append(('pages', page_req(path, lang, path.startswith(('/apps/', '/settings/', '/u/')), ref=True), 'page'))
	for lang in LANGS:
		for path in signed_in:
			jobs.append(('pages', page_req(path, lang, True), 'sync' if path.endswith('/sync-clients') else 'page'))
		jobs.append(('pages', page_req('/login', lang, False), 'page'))
		jobs.append(('errors', page_req('/index.php/apps/doesnotexist', lang, False), 'page'))
		jobs.append(('errors', page_req('/index.php/apps/doesnotexist', lang, True), 'page'))
		jobs.append(('errors', page_req('/settings/admin/overview', lang, True), 'page'))
		jobs.append(('errors', page_req('/index.php/unsupported', lang, False), 'page'))
		if 'file' in tokens:
			# Same page as an expired or deleted link, without counting as a guessed link: a path
			# inside a file link is "not found" after the link itself was accepted.
			jobs.append(('errors', page_req('/index.php/s/%s?path=/missing' % tokens['file'], lang, False), 'page'))
		for kind, token in sorted(tokens.items()):
			jobs.append(('share', page_req('/index.php/s/%s' % token, lang, False), 'page'))
	jobs.append(('pages', page_req('/login', LANGS[0], False, ua=OLD_UA), 'page'))
	jobs.append(('errors', dict(url=BASE + '/status.php'), 'status'))
	for kind in ('file', 'folder'):
		if kind in tokens:
			jobs.append(('share', dict(url='%s/index.php/s/%s/download' % (BASE, tokens[kind])), 'download'))
	for path, auth in (('/remote.php/dav/', True), ('/remote.php/webdav/', True), ('/remote.php/dav/files/%s/' % quote(uid), True), ('/remote.php/dav/', False)):
		jobs.append(('dav', dict(url=BASE + path, auth=auth, headers=['Accept: text/html']), 'dav'))
	if not tokens and 'share' in AREAS:
		rep.skip('share', '/branding-check', 'no test links, so no public page was checked')

	l10n_urls = {lang: [] for lang in ref + LANGS}
	icons, manifests, themecss, sheets = {}, {}, {}, {}
	l10n_apps = set()
	for (area, req, kind), resp in zip(jobs, http.run([j[1] for j in jobs])):
		url = label(req['url']) + (' [old browser]' if req.get('ua') == OLD_UA else '') + (' [signed in]' if req.get('auth') and area == 'errors' else '')
		report = area in AREAS and not req.get('ref')
		if resp.blocked:
			if report:
				rep.skip(area, url, 'blocked by the Cloudflare firewall for this IP (run from the owner\'s PC)')
			continue
		if resp.status == 0:
			if report:
				rep.fail(area, url, 'request', 'no answer: %s' % resp.error)
			continue
		if kind == 'status':
			if report:
				rep.checked(area)
				try:
					st = json.loads(resp.text)
				except ValueError:
					st = {}
				if st.get('productname') != 'Nourax Workspace':
					rep.fail(area, url, 'productname', 'is %r, must be exactly "Nourax Workspace"' % st.get('productname'))
				scan_json(area, url, 'status', st, names=True)
			continue
		if kind == 'download':
			if report:
				rep.checked(area)
				if resp.status != 200:
					rep.fail(area, url, 'HTTP', 'download answered HTTP %d' % resp.status)
				for k, v in resp.headers.items():
					if k not in ('set-cookie', 'content-security-policy', 'report-to', 'nel'):
						scan_names(area, url, 'header %s' % k, v)
			continue
		if kind == 'dav':
			if report:
				rep.checked(area)
				body = resp.text
				shown = re.sub(r'<[^>]+>', ' ', body) if '<' in body else body
				scan_names(area, url, 'body (HTTP %d)' % resp.status, re.sub(r'\s+', ' ', shown))
			continue
		lang = re.search(r'forceLanguage=([A-Za-z_]+)', req['url']).group(1)
		if report and resp.status >= 400 and area == 'pages':
			rep.info('%s answered HTTP %d; its content is checked anyway' % (url, resp.status))
		if report:
			page = check_html(area, url, resp.url or req['url'], resp.text)
		else:
			page = Page()   # only read, for the l10n and theming areas
			page.feed(resp.text)
		if kind == 'sync' and report:
			sections = state(page, 'settings-sections') or {}
			for s in sections.get('personal', []) if isinstance(sections, dict) else []:
				if isinstance(s, dict) and s.get('id') == 'sync-clients':
					rep.fail(area, url, 'settings section', 'the "%s" section is shown; it must stay hidden until the NoDrive clients ship' % s.get('name'))
		for src in page.scripts:
			p = urlsplit(urljoin(resp.url or req['url'], src))
			if '/l10n/' in p.path and p.path.endswith('.js') and (p.hostname or '').lower() == BASE_HOST:
				# Fetched with the page's own ?v= (what browsers get, also from Cloudflare's cache),
				# once per path: the cache buster changes whenever the theming settings are saved.
				l10n_urls[lang].append(p.geturl())
		for l in page.links:
			rel = l.get('rel', '').lower()
			href = l.get('href', '')
			if not href:
				continue
			absu = urljoin(resp.url or req['url'], href)
			if 'icon' in rel:
				icons.setdefault(absu, '%s on %s' % (rel, url.split('?')[0]))
			elif rel == 'manifest':
				manifests.setdefault(absu, req.get('auth', False))
			elif rel == 'stylesheet' and (urlsplit(absu).hostname or '').lower() == BASE_HOST:
				if '/apps/theming/theme/' in absu or '/apps/theming_customcss/' in absu:
					themecss.setdefault(absu, req.get('auth', False))
				else:
					sheets.setdefault(absu, req.get('auth', False))

	if 'l10n' in AREAS:
		by_path = {}
		for urls in l10n_urls.values():
			for u in urls:
				by_path.setdefault(urlsplit(u).path, u)
		todo = sorted(by_path)
		bundles = {}
		for path, resp in zip(todo, http.run([dict(url=by_path[p], auth=True) for p in todo])):
			if resp.status != 200:
				rep.fail('l10n', path, 'HTTP', 'the page loads it, but it answers HTTP %d' % resp.status)
				continue
			try:
				app, tr = parse_l10n(resp.text)
			except ValueError:
				app, tr = None, None
			if app is None:
				rep.fail('l10n', path, 'format', 'not an OC.L10N.register(...) file')
				continue
			bundles[path] = (app, tr)
			rep.checked('l10n')
		results = {}
		for lang, urls in l10n_urls.items():
			for path in dict.fromkeys(urlsplit(u).path for u in urls):
				if path in bundles:
					results.setdefault(lang, []).append((path, bundles[path][0], bundles[path][1]))
					l10n_apps.add(bundles[path][0])
		check_l10n(results, l10n_apps)

	if 'theming' in AREAS:
		for app in ('core', 'files', 'calendar', 'contacts', 'deck'):
			manifests.setdefault('%s/apps/theming/manifest/%s' % (BASE, app), True)
		for name in ('default', 'light', 'dark', 'light-highcontrast', 'dark-highcontrast'):
			themecss.setdefault('%s/apps/theming/theme/%s.css?plain=1' % (BASE, name), True)
		themecss.setdefault(BASE + '/apps/theming_customcss/styles', True)
		mlist, clist = sorted(manifests), sorted(themecss)
		resps = http.run([dict(url=u, auth=manifests[u]) for u in mlist] + [dict(url=u, auth=themecss[u]) for u in clist])
		for u, resp in zip(mlist, resps[:len(mlist)]):
			if resp.status != 200:
				rep.fail('theming', label(u), 'HTTP', 'answers HTTP %d' % resp.status)
				continue
			check_manifest('theming', label(u), resp.text, icons)
		for u, resp in zip(clist, resps[len(mlist):]):
			if resp.status != 200:
				rep.fail('theming', label(u), 'HTTP', 'answers HTTP %d' % resp.status)
				continue
			check_css('theming', label(u), resp.text)
		ilist = sorted(icons)
		for u, resp in zip(ilist, http.run([dict(url=u, auth=True) for u in ilist])):
			rep.checked('theming')
			if resp.status != 200:
				rep.fail('theming', label(u), icons[u], 'answers HTTP %d' % resp.status)
				continue
			same = upstream.get(hashlib.sha256(resp.body).hexdigest())
			if same:
				rep.fail('theming', label(u), icons[u], 'is the same file as the upstream %s' % same)
			if resp.body[:5].lstrip().startswith(b'<'):
				svg = resp.text
				scan_names('theming', label(u), icons[u] + ' svg', svg)
				scan_blues('theming', label(u), icons[u] + ' svg', svg)

	if 'css' in AREAS:
		slist = sorted(sheets)
		for u, resp in zip(slist, http.run([dict(url=u, auth=sheets[u]) for u in slist])):
			if resp.status == 200:
				check_css('css', label(u), resp.text, ignore_fallbacks=True)
	return upstream


# ---- server side (--server) --------------------------------------------------------------------

PHP = r'''<?php
// Read-only checks for scripts/check-branding.sh --server. One JSON object per output line.
require_once '/var/www/html/lib/base.php';
$in = json_decode(base64_decode('@INPUT@'), true);
function out(array $o): void {
	echo "NBC\t", json_encode($o, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE), "\n";
}
function nbc_name(string $s, array $pats): ?array {
	foreach ($pats as $p) {
		if (preg_match('~' . $p . '~u', $s, $m, PREG_OFFSET_CAPTURE)) {
			return $m[0];
		}
	}
	return null;
}
$root = \OC::$SERVERROOT;
$config = \OCP\Server::get(\OCP\IConfig::class);
$apps = \OCP\Server::get(\OCP\App\IAppManager::class);
$theme = $config->getSystemValueString('theme', '');
$enabled = $apps->getEnabledApps();
sort($enabled);
$versions = [];
foreach ($enabled as $app) {
	$versions[$app] = $apps->getAppVersion($app);
}
$sv = \OCP\Server::get(\OCP\ServerVersion::class);
out(['kind' => 'info', 'theme' => $theme, 'server' => implode('.', $sv->getVersion()), 'apps' => $versions]);

if ($in['config']) {
	$cc = [];
	foreach ($in['customclient_keys'] as $k) {
		$cc[$k] = $config->getSystemValue($k, null);
	}
	$d = \OCP\Server::get(\OCP\Defaults::class);
	$eff = [];
	foreach (['getName', 'getTitle', 'getEntity', 'getProductName', 'getSlogan', 'getBaseUrl', 'getDocBaseUrl',
		'getSyncClientUrl', 'getiOSClientUrl', 'getiTunesAppId', 'getAndroidClientUrl', 'getFDroidClientUrl'] as $m) {
		if (method_exists($d, $m)) {
			try {
				$eff[$m] = (string)$d->$m();
			} catch (\Throwable $e) {
				$eff[$m] = '(error: ' . get_class($e) . ')';
			}
		}
	}
	out(['kind' => 'config', 'customclient' => $cc, 'defaults' => $eff, 'enabled' => $enabled]);
}

if ($in['l10n']) {
	$state = $theme !== '' ? "$root/themes/$theme/sweep-state.json" : '';
	out(['kind' => 'sweep_state', 'path' => $state, 'content' => ($state !== '' && is_file($state)) ? file_get_contents($state) : null]);
	$dirs = ['core' => "$root/core/l10n", 'lib' => "$root/lib/l10n"];
	foreach ($enabled as $app) {
		try {
			$p = $apps->getAppPath($app);
		} catch (\Throwable $e) {
			continue;
		}
		if (is_dir("$p/l10n")) {
			$dirs[$app] = "$p/l10n";
		}
	}
	foreach ($dirs as $app => $dir) {
		$rel = substr($dir, strlen($root) + 1);
		$read = function (string $f) use ($rel): ?array {
			$j = json_decode((string)file_get_contents($f), true);
			if (!is_array($j) || !isset($j['translations']) || !is_array($j['translations'])) {
				out(['kind' => 'note', 'text' => "$rel/" . basename($f) . ' is not a translation file (skipped, as Nextcloud does)']);
				return null;
			}
			return $j['translations'];
		};
		$orig = [];
		foreach (glob("$dir/*.json") ?: [] as $f) {
			$t = $read($f);
			if ($t !== null) {
				$orig[basename($f, '.json')] = $t;
			}
		}
		$themed = [];
		if ($theme !== '' && is_dir("$root/themes/$theme/$rel")) {
			foreach (glob("$root/themes/$theme/$rel/*.json") ?: [] as $f) {
				$t = $read($f);
				if ($t !== null) {
					$themed[basename($f, '.json')] = $t;
				}
			}
		}
		$keys = [];
		foreach ($orig as $t) {
			foreach ($t as $k => $v) {
				$keys[(string)$k] = true;
			}
		}
		$langs = array_unique(array_merge(array_keys($orig), array_keys($themed), ['en']));
		sort($langs);
		$nameKeys = [];
		foreach (array_keys($keys) as $k) {
			if (nbc_name($k, $in['names']) !== null) {
				$nameKeys[] = $k;
			}
		}
		$sent = 0;
		$values = 0;
		$missing = 0;
		foreach ($langs as $lang) {
			// The same merge as OC\L10N\L10N::load: the theme file on top of the app's own file.
			$merged = array_merge($orig[$lang] ?? [], $themed[$lang] ?? []);
			foreach ($merged as $k => $v) {
				foreach ((array)$v as $s) {
					if (!is_string($s)) {
						continue;
					}
					$m = nbc_name($s, $in['names']);
					if ($m !== null) {
						$values++;
						if ($in['limit'] === 0 || $sent < $in['limit']) {
							$sent++;
							out(['kind' => 'l10n', 'dir' => $rel, 'lang' => $lang, 'key' => (string)$k, 'value' => $s, 'at' => $m[1]]);
						}
						break;
					}
				}
			}
			foreach ($nameKeys as $k) {
				if (!array_key_exists($k, $merged)) {
					$missing++;
					if ($in['limit'] === 0 || $sent < $in['limit']) {
						$sent++;
						out(['kind' => 'l10n', 'dir' => $rel, 'lang' => $lang, 'key' => $k, 'value' => null]);
					}
				}
			}
		}
		out(['kind' => 'l10n_count', 'dir' => $rel, 'langs' => count($langs), 'values' => $values, 'missing' => $missing, 'sent' => $sent]);
	}
}

if ($in['mail']) {
	$mailer = \OCP\Server::get(\OCP\Mail\IMailer::class);
	$urls = \OCP\Server::get(\OCP\IURLGenerator::class);
	foreach ($in['langs'] as $lang) {
		$t = $mailer->createEMailTemplate('nourax.brandingcheck', []);
		$t->setSubject('Branding check');
		$t->addHeader();
		$t->addHeading('Branding check');
		$t->addBodyText('A sample message rendered by the branding check. It is never sent.');
		$t->addBodyButton('Open NoDrive', $urls->getAbsoluteURL('/'));
		$t->addFooter('', $lang);
		out(['kind' => 'mail', 'lang' => $lang, 'html' => $t->renderHtml(), 'text' => $t->renderText()]);
	}
}
out(['kind' => 'done']);
'''


def run_server(http, upstream):
	want = {'config': 'config' in AREAS, 'l10n': 'l10n' in AREAS, 'mail': 'mail' in AREAS}
	if not any(want.values()):
		return
	inp = dict(want, names=[r['re'] for r in RULES['name_patterns']], langs=LANGS, limit=LIMIT,
		customclient_keys=RULES.get('customclient_keys', []))
	script = PHP.replace('@INPUT@', base64.b64encode(json.dumps(inp).encode('utf-8')).decode('ascii'))
	cmd = ['docker', 'compose', '--project-directory', REPO, 'exec', '-T', '-u', 'www-data', 'app', 'php']
	try:
		proc = subprocess.run(cmd, input=script.encode('utf-8'), stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=900)
	except (OSError, subprocess.TimeoutExpired) as e:
		stop('the server check could not run: %s' % e)
	got, done = [], False
	for line in proc.stdout.decode('utf-8', 'replace').splitlines():
		if line.startswith('NBC\t'):
			o = json.loads(line[4:])
			done = done or o['kind'] == 'done'
			got.append(o)
		elif line.strip():
			rep.info('php: ' + line[:200])
	if proc.returncode != 0 or not done:
		err = proc.stderr.decode('utf-8', 'replace').strip().splitlines()
		stop('the server check stopped (exit %d): %s' % (proc.returncode, err[-1][:300] if err else 'no output'))
	info = next(o for o in got if o['kind'] == 'info')
	for o in got:
		k = o['kind']
		if k == 'note':
			rep.info(o['text'])
		elif k == 'config':
			check_config(o, info)
		elif k == 'sweep_state':
			check_sweep_state(o, info)
		elif k == 'l10n':
			url = o['dir']
			where = '%s "%s"' % (o['lang'], o['key'][:60])
			if o['value'] is None:
				rep.fail('l10n', url, where, 'no %s translation, so the English text with the name is shown' % o['lang'])
			else:
				v = o['value']
				hits = name_hits(v)
				a, b = (hits[0][0], hits[0][1]) if hits else (0, 0)
				rep.fail('l10n', url, where, around(v, a, b))
		elif k == 'l10n_count':
			rep.checked('l10n', o['langs'])
			rep.more('l10n', o['dir'], o['values'] + o['missing'] - o['sent'])
		elif k == 'mail':
			url = 'mail/%s' % o['lang']
			page = check_html('mail', url, BASE + '/', o['html'], names_in_states=True)
			scan_names('mail', url, 'plain text', o['text'])
			for m in URL_IN_TEXT.finditer(o['text']):
				scan_url('mail', url, 'plain text', m.group(0), BASE + '/')
			if http is not None and upstream:
				imgs = [urljoin(BASE + '/', v) for tag, a, v in page.urls if tag == 'img' and a == 'src']
				for u, resp in zip(imgs, http.run([dict(url=u) for u in imgs])):
					if resp.status == 200 and hashlib.sha256(resp.body).hexdigest() in upstream:
						rep.fail('mail', url, 'img', '%s is the upstream %s' % (label(u), upstream[hashlib.sha256(resp.body).hexdigest()]))


def check_config(o, info):
	area = 'config'
	rep.checked(area)
	if info['theme'] != 'nourax':
		rep.fail(area, 'config.php', 'theme', 'is %r, must be "nourax" (the theme folder holds the overrides)' % info['theme'])
	for k, v in o['customclient'].items():
		if v is None:
			rep.fail(area, 'config.php', k, 'not set, so the upstream default is used (set it to "" until our own clients ship)')
		elif k == 'customclient_ios_appid' and str(v) == RULES.get('upstream_ios_appid'):
			rep.fail(area, 'config.php', k, 'is the upstream iOS app')
		elif isinstance(v, str) and v:
			scan_url(area, 'config.php', k, v, BASE + '/')
	for m, v in o['defaults'].items():
		if m in ('getName', 'getTitle', 'getEntity', 'getProductName', 'getSlogan'):
			scan_names(area, 'theming', m, v)
		elif m == 'getiTunesAppId' and v == RULES.get('upstream_ios_appid'):
			rep.fail(area, 'theming', m, 'is the upstream iOS app %s' % v)
		elif v:
			scan_url(area, 'theming', m, v, BASE + '/')
	for app, why in RULES.get('apps_off', {}).items():
		if app in o['enabled']:
			rep.fail(area, 'apps', app, 'is enabled; it must be off (%s)' % why)


def check_sweep_state(o, info):
	area = 'l10n'
	url = o['path'] or 'themes/<theme>/sweep-state.json'
	rep.checked(area)
	if not o['path']:
		rep.fail(area, url, 'sweep', 'no theme is set, so the sweep has not run')
		return
	if o['content'] is None:
		rep.fail(area, url, 'sweep', 'missing: the sweep has not run yet')
		return
	try:
		st = json.loads(o['content'])
	except ValueError:
		rep.fail(area, url, 'sweep', 'not valid JSON')
		return
	if str(st.get('server')) != info['server']:
		rep.fail(area, url, 'server', 'swept for %s, installed %s: run the sweep again' % (st.get('server'), info['server']))
	have = st.get('apps') if isinstance(st.get('apps'), dict) else {}
	for app, ver in sorted(info['apps'].items()):
		if app not in have:
			rep.fail(area, url, 'apps.' + app, 'enabled (%s) but not swept: run the sweep again' % ver)
		elif str(have[app]) != str(ver):
			rep.fail(area, url, 'apps.' + app, 'swept at %s, installed %s: run the sweep again' % (have[app], ver))


# ---- main --------------------------------------------------------------------------------------

def main():
	http_wanted = bool(AREAS & HTTP_AREAS)
	if not SERVER:
		for a in ('config', 'mail'):
			if a in AREAS:
				rep.skip(a, '-', 'needs --server (run on the server with sudo)')
	tmp = tempfile.mkdtemp(prefix='check-branding-')
	try:
		http, upstream = None, {}
		if CREDS:
			cred = read_creds(CREDS)
			rep.redact.append(cred['secret'])
			http = Http(tmp, cred)
		if http_wanted:
			if http is None:
				stop('the HTTP checks need the credentials file of a QA user')
			upstream = run_http(http, cred)
		elif http is not None and 'mail' in AREAS:
			files = RULES.get('upstream_files', [])
			for path, resp in zip(files, http.run([dict(url=BASE + p) for p in files])):
				if resp.status == 200 and resp.body:
					upstream[hashlib.sha256(resp.body).hexdigest()] = path
		if SERVER:
			run_server(http, upstream)
	finally:
		shutil.rmtree(tmp, ignore_errors=True)
	return rep.finish()


sys.exit(main())
PY
