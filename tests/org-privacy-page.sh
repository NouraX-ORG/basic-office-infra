#!/usr/bin/env bash
# The admin page's privacy switch (docs/teams.md#the-switch), for real, through Cloudflare. Run it
# on the owner's PC (Git Bash), from the repo: the sign-in and settings pages are open only to the
# owner's address, so the server cannot test them.
#
#   tests/org-privacy-page.sh normal CREDS-DIR   while qa-t6b-admin is NOT in the admin group
#   tests/org-privacy-page.sh admin  CREDS-DIR   while it is (only for this test)
#
# CREDS-DIR is a private folder (the scratchpad) with qa-t6b-admin.pass, the account's login
# password (copied from /etc/nourax/qa by piping ssh into the file, never shown). The normal step
# also sets up the account's second factor (TOTP), as any admin must have one here, and keeps
# its secret in CREDS-DIR/qa-t6b-admin.totp; the admin step signs in with password and code.
#
# normal: signs in with the sign-in form, then the admin page answers 403, and the switch's GET
#   and POST (with the page's CSRF token) answer 403: a normal person cannot see or switch it.
# admin: signs in (the second factor is asked for, as for every admin), then
#   - the page /settings/admin/nourax-workspace: the section, its title, the state On, what On
#     changes, what Off means, the menu entry "Nourax Workspace" with its icon, the page's script
#     and styles; no upstream name, link or blue in the section, its script, styles and icon
#     (nourax_branding's rules.json, as scripts/check-branding.sh reads them);
#   - the switch's GET: on; a POST without the CSRF token: 412 and still on; a wrong state: 400;
#   - Off, then straight back On through the POST, each answered with the new state (Off: both
#     apps enabled; On: both disabled), and the two switches at the top of "Recent changes",
#     by qa-t6b-admin. It prints how long privacy was off. If switching back on fails, it tries
#     again, and on any exit after Off it switches on again before it stops.
# Both sign out at the end. Nothing secret is printed; the password, the TOTP secret and codes
# reach curl only through files in CREDS-DIR and a private temporary folder.
# Exit 0 when every check passes.
# SPDX-License-Identifier: AGPL-3.0-or-later

# shellcheck source=../scripts/lib.sh
. "$(dirname "$0")/../scripts/lib.sh"

MODE="${1:-}"
CREDS="${2:-}"
QA_ADMIN=qa-t6b-admin
case "$MODE" in normal | admin) ;; *) die "usage: tests/org-privacy-page.sh normal|admin CREDS-DIR" ;; esac
[ -s "$CREDS/$QA_ADMIN.pass" ] || die "no $CREDS/$QA_ADMIN.pass"
DRIVE_HOST="${DRIVE_HOST:-drive.nourax.org}"
BASE="https://$DRIVE_HOST"
PAGE="$BASE/settings/admin/nourax-workspace"
ROUTE="$BASE/apps/nourax_api/admin/org-privacy"
RULES="$REPO_DIR/nextcloud-apps/nourax_branding/sweep/rules.json"
UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36'
PY="$(command -v python3 || command -v python || true)"
[ -n "$PY" ] || die "python3 (or python) is needed"

umask 077
T="$(mktemp -d)"
switched_off=0
cleanup() {
	if [ "$switched_off" = 1 ]; then
		log "privacy was left off - switching it back on"
		post_state on >/dev/null || true
		log "  after the retry: $(field "$T/post.json" status.state)"
	fi
	rm -rf "$T"
}
trap cleanup EXIT
if command -v cygpath >/dev/null 2>&1; then
	T="$(cygpath -m "$T")"
	CREDS="$(cygpath -m "$CREDS")"
fi

fails=0
check() { # name expected actual
	if [ "$2" = "$3" ]; then
		log "PASS $1"
	else
		log "FAIL $1: expected '$2', got '$3'"
		fails=$((fails + 1))
	fi
}
location() { tr -d '\r' < "$1" | awk 'tolower($1) == "location:" { print $2 }' | tail -n 1; }
token_of() { grep -o 'data-requesttoken="[^"]*"' "$1" | head -n 1 | sed 's/^data-requesttoken="//; s/"$//' || true; }
# A field of a JSON file by dotted path (none when missing).
field() {
	"$PY" -I - "$1" "$2" <<'PY'
import json, sys
try:
	value = json.load(open(sys.argv[1], encoding="utf-8"))
	for part in sys.argv[2].split("."):
		value = value[int(part)] if isinstance(value, list) else value[part]
	print(json.dumps(value) if isinstance(value, (dict, list, bool)) or value is None else value)
except Exception:
	print("none")
PY
}
# The current TOTP code of the account, written to a file (never printed). Waits for the next
# 30-second step when this one has less than 4 seconds left.
totp_code() { # out-file
	"$PY" -I - "$CREDS/$QA_ADMIN.totp" "$1" <<'PY'
import base64, hashlib, hmac, json, struct, sys, time
d = json.load(open(sys.argv[1], encoding="utf-8"))
if 30 - time.time() % 30 < 4:
	time.sleep(30 - time.time() % 30 + 0.5)
secret = d["secret"].upper()
key = base64.b32decode(secret + "=" * (-len(secret) % 8))
digest = {"SHA1": hashlib.sha1, "SHA256": hashlib.sha256, "SHA512": hashlib.sha512}[d.get("algorithm", "SHA1").upper()]
mac = hmac.new(key, struct.pack(">Q", int(time.time()) // 30), digest).digest()
at = mac[-1] & 0x0F
open(sys.argv[2], "w").write("%06d" % ((struct.unpack(">I", mac[at:at + 4])[0] & 0x7FFFFFFF) % 1000000))
PY
}
C() { curl -sS -A "$UA" -c "$T/jar" -b "$T/jar" "$@"; }
# A call of the switch's route with the session (and the page's CSRF token unless NO_TOKEN=1).
# Prints the HTTP status; the answer is left in the given file.
route() { # method out-file [curl options...]
	local method="$1" out="$2"
	shift 2
	local token=()
	[ "${NO_TOKEN:-0}" = 1 ] || token=(-H "requesttoken: $TOKEN")
	C -X "$method" -H 'Accept: application/json' -H "Origin: $BASE" "${token[@]}" -o "$out" -w '%{http_code}' "$@" "$ROUTE"
}
post_state() { route POST "$T/post.json" -H 'Content-Type: application/json' --data-binary "{\"state\":\"$1\"}"; }

# The sign-in form, as a browser sends it. Leaves the answer's headers in $T/h-login.
sign_in() {
	rm -f "$T/jar"
	C -o "$T/login.html" "$BASE/login"
	local token
	token="$(token_of "$T/login.html")"
	C -H "Origin: $BASE" -D "$T/h-login" -o /dev/null --data-urlencode "user=$QA_ADMIN" \
		--data-urlencode "password@$CREDS/$QA_ADMIN.pass" --data-urlencode "requesttoken=$token" \
		--data-urlencode timezone=Europe/London --data-urlencode timezone_offset=0 "$BASE/login"
}
# A signed-in page's CSRF token, from /apps/files/ (sets TOKEN).
page_token() {
	C -o "$T/files.html" "$BASE/apps/files/"
	TOKEN="$(token_of "$T/files.html")"
}
sign_out() {
	local link
	link="$("$PY" -I - "$T/files.html" <<'PY'
import base64, json, re, sys
text = open(sys.argv[1], encoding="utf-8").read()
for value in re.findall(r'id="initial-state-[^"]+" value="([^"]*)"', text):
	try:
		blob = json.dumps(json.loads(base64.b64decode(value)))
	except Exception:
		continue
	found = re.search(r'"href": "([^"]*(?:/logout)[^"]*)"', blob)
	if found:
		print(found.group(1))
		break
PY
)"
	[ -n "$link" ] && C -o /dev/null "$link"
	check "signed out" 401 "$(C -H 'OCS-APIRequest: true' -o /dev/null -w '%{http_code}' "$BASE/ocs/v2.php/cloud/user?format=json")"
}

if [ "$MODE" = normal ]; then
	sign_in
	where="$(location "$T/h-login")"
	check "$QA_ADMIN (a normal account now) signs in with the form" yes "$(case "$where" in */login*) echo no ;; ?*) echo yes ;; *) echo no ;; esac)"
	page_token
	check "the CSRF token of a signed-in page" yes "$([ -n "$TOKEN" ] && echo yes || echo no)"
	code="$(C -o "$T/page.html" -w '%{http_code}' "$PAGE")"
	check "a normal person: the admin page answers 403" "403 no" "$code $(grep -q 'nourax-org-privacy' "$T/page.html" && echo yes || echo no)"
	check "a normal person: GET of the switch -> 403" 403 "$(route GET "$T/get.json")"
	check "a normal person: POST off with the CSRF token -> 403" 403 "$(post_state off)"
	log "  the answer: $(head -c 120 "$T/post.json")"

	if [ ! -s "$CREDS/$QA_ADMIN.totp" ]; then
		# The second factor every admin has here (two-factor sign-in is enforced for "admin").
		C -X POST -H "requesttoken: $TOKEN" -H 'Accept: application/json' -H "Origin: $BASE" \
			--data-urlencode state=1 -o "$T/totp1.json" "$BASE/apps/twofactor_totp/settings/enable"
		"$PY" -I - "$T/totp1.json" "$CREDS/$QA_ADMIN.totp" <<'PY'
import json, sys, urllib.parse
d = json.load(open(sys.argv[1], encoding="utf-8"))
query = urllib.parse.parse_qs(urllib.parse.urlparse(d["qrUrl"]).query)
json.dump({"secret": d["secret"], "algorithm": query.get("algorithm", ["SHA1"])[0]}, open(sys.argv[2], "w"))
PY
		rm -f "$T/totp1.json"
		totp_code "$T/code"
		C -X POST -H "requesttoken: $TOKEN" -H 'Accept: application/json' -H "Origin: $BASE" \
			--data-urlencode state=2 --data-urlencode "code@$T/code" -o "$T/totp2.json" "$BASE/apps/twofactor_totp/settings/enable"
		rm -f "$T/code"
		check "$QA_ADMIN: its second factor (TOTP) is set up" 2 "$(field "$T/totp2.json" state)"
	else
		log "  the second factor is already set up ($QA_ADMIN.totp)"
	fi
	sign_out
	[ "$fails" -eq 0 ] || die "$fails check(s) failed"
	log "all org-privacy-page normal checks passed"
	exit 0
fi

# --- admin -------------------------------------------------------------------------------------
[ -s "$CREDS/$QA_ADMIN.totp" ] || die "no $CREDS/$QA_ADMIN.totp - run the normal step first"
sign_in
where="$(location "$T/h-login")"
check "an admin's sign-in asks for the second factor" yes "$(case "$where" in */login/challenge/* | */login/selectchallenge*) echo yes ;; *) echo "no ($where)" ;; esac)"
case "$where" in
*/login/selectchallenge*)
	C -o "$T/select.html" "$BASE${where#"$BASE"}"
	where="$(grep -o 'href="[^"]*/login/challenge/totp[^"]*"' "$T/select.html" | head -n 1 | sed 's/^href="//; s/"$//; s/&amp;/\&/g')"
	;;
esac
case "$where" in http*) ;; *) where="$BASE$where" ;; esac
C -o "$T/challenge.html" "$where"
challenge_token="$(token_of "$T/challenge.html")"
totp_code "$T/code"
C -H "Origin: $BASE" -D "$T/h-challenge" -o /dev/null --data-urlencode "challenge@$T/code" \
	--data-urlencode "requesttoken=$challenge_token" "$where"
rm -f "$T/code"
check "the code is taken" yes "$(case "$(location "$T/h-challenge")" in */login*) echo no ;; ?*) echo yes ;; *) echo no ;; esac)"
check "signed in as $QA_ADMIN" "$QA_ADMIN" "$(C -H 'OCS-APIRequest: true' -o "$T/me.json" "$BASE/ocs/v2.php/cloud/user?format=json"; field "$T/me.json" ocs.data.id)"
page_token

# The page.
code="$(C -o "$T/page.html" -w '%{http_code}' "$PAGE")"
check "the admin page /settings/admin/nourax-workspace -> 200" 200 "$code"
TOKEN="$(token_of "$T/page.html")"
"$PY" -I - "$T/page.html" "$RULES" "$BASE" "$T" <<'PY' > "$T/page.txt"
import base64, html, json, re, sys, urllib.request
from html.parser import HTMLParser

page = open(sys.argv[1], encoding="utf-8").read()
rules = json.load(open(sys.argv[2], encoding="utf-8"))
base, tmp = sys.argv[3], sys.argv[4]

def compile_all(key):
	out = []
	for rule in rules.get(key, []):
		flags = 0
		pattern = rule["re"]
		if pattern.startswith("(?i)"):
			flags, pattern = re.I, pattern[4:]
		out.append((rule["id"], re.compile(pattern, flags)))
	return out
names, blues, links = compile_all("name_patterns"), compile_all("blue_patterns"), compile_all("link_patterns")

def states():
	found = {}
	for sid, value in re.findall(r'id="initial-state-([^"]+)" value="([^"]*)"', page):
		try:
			found[sid] = json.loads(base64.b64decode(value))
		except Exception:
			pass
	return found

class Section(HTMLParser):
	"""The text, attributes and links inside <div id="nourax-org-privacy">."""
	def __init__(self):
		super().__init__()
		self.depth = 0
		self.text, self.attrs, self.links = [], [], []
	def handle_starttag(self, tag, attrs):
		attrs = dict(attrs)
		if self.depth == 0 and attrs.get("id") == "nourax-org-privacy":
			self.depth = 1
		elif self.depth:
			if tag not in ("br", "img", "input", "meta", "link", "hr"):
				self.depth += 1
		if self.depth:
			for name, value in attrs.items():
				if value:
					self.attrs.append(value)
					if name in ("href", "src", "action"):
						self.links.append(value)
	def handle_endtag(self, tag):
		if self.depth and tag not in ("br", "img", "input", "meta", "link", "hr"):
			self.depth -= 1
	def handle_data(self, data):
		if self.depth:
			self.text.append(data)

section = Section()
section.feed(page)
text = " ".join(" ".join(section.text).split())
st = states()
menu = [s for s in (st.get("settings-sections") or {}).get("admin", []) if s.get("id") == "nourax-workspace"]
title = re.search(r"<title>(.*?)</title>", page, re.S)

def fetch(path):
	with urllib.request.urlopen(base + path) as r:
		return r.read().decode("utf-8", "replace")

found = lambda s: "yes" if s in text else "no"
print("section", "yes" if text else "no")
print("title", "yes" if "Privacy between organisations" in text else "no")
print("pill-on", "yes" if re.search(r'id="nourax-privacy-pill" class="[^"]*--on"[^>]*>\s*On\s*<', page) else "no")
print("on-effects", found("When this is On") + "-" + found("only with people of one's own organisation and teams"))
print("off-warning", found("Everyone on the server can find everyone again") + "-" + found("The federation and Teams (circles) apps come back."))
print("buttons", ("yes" if 'id="nourax-privacy-off"' in page else "no") + "-" + ("yes" if re.search(r'id="nourax-privacy-on"[^>]*hidden', page) else "no"))
print("confirm-dialog", "yes" if '<dialog id="nourax-privacy-dialog"' in page else "no")
print("menu", json.dumps(menu[0]["name"] if menu else None))
icon = menu[0]["icon"] if menu else ""
print("menu-icon", "yes" if icon.endswith("/nourax_api/img/nourax-workspace.svg") or "/nourax_api/img/nourax-workspace.svg?" in icon else "no")
print("page-title", "yes" if title and "Nourax Workspace" in html.unescape(title.group(1)) else "no")
assets = re.findall(r'(?:src|href)="(/[^"]*nourax_api/(?:js/admin-privacy\.js|css/admin-privacy\.css|css/settings-nav\.css)[^"]*)"', page)
print("assets", " ".join(sorted({re.sub(r"\?.*", "", a).rsplit("/", 1)[-1] for a in assets})))
print("initial-state-url", "yes" if (st.get("nourax_api-org-privacy") or {}).get("url", "").endswith("/apps/nourax_api/admin/org-privacy") else "no")

hits = []
def scan(where, s, link_list=()):
	for rid, rx in names:
		if rx.search(s):
			hits.append("%s name %s" % (where, rid))
	for rid, rx in blues:
		if rx.search(s):
			hits.append("%s blue %s" % (where, rid))
	for link in link_list:
		for rid, rx in links:
			if rx.search(link):
				hits.append("%s link %s" % (where, rid))
scan("section text", text)
scan("section attributes", " ".join(section.attrs), section.links)
scan("menu entry", json.dumps(menu))
svg = ""
for a in sorted(set(assets)) + ([icon] if icon else []):
	body = fetch(a)
	if a == icon:
		svg = body
	scan(a.rsplit("/", 1)[-1].split("?")[0], body)
print("icon-colours", ("yes" if "#2563EB" in svg and "#fff" in svg else "no"))
print("branding-hits", json.dumps(hits))
PY
val() { awk -v k="$1" '$1 == k { $1 = ""; sub(/^ /, ""); print; exit }' "$T/page.txt"; }
check "page: the section is there" yes "$(val section)"
check "page: its title" yes "$(val title)"
check "page: the state is On" yes "$(val pill-on)"
check "page: what On changes" yes-yes "$(val on-effects)"
check "page: Off says everyone finds everyone again and the two apps come back" yes-yes "$(val off-warning)"
check "page: Switch off shown, Switch on hidden" yes-yes "$(val buttons)"
check "page: the confirmation dialog" yes "$(val confirm-dialog)"
check "page: the menu entry" '"Nourax Workspace"' "$(val menu)"
check "page: the menu entry's icon" yes "$(val menu-icon)"
check "page: the icon is a white mark on cobalt" yes "$(val icon-colours)"
check "page: the browser title names the section" yes "$(val page-title)"
check "page: its script and styles (and the menu icon's style)" "admin-privacy.css admin-privacy.js settings-nav.css" "$(val assets)"
check "page: the switch's address in the initial state" yes "$(val initial-state-url)"
check "page: no upstream name, link or blue in the section, script, styles or icon" "[]" "$(val branding-hits)"

# The switch's route.
check "GET of the switch -> 200" 200 "$(route GET "$T/get.json")"
check "GET: on" on "$(field "$T/get.json" status.state)"
check "POST off without the CSRF token -> 412" 412 "$(NO_TOKEN=1 post_state off)"
check "after it: still on" on "$(route GET "$T/get.json" >/dev/null; field "$T/get.json" status.state)"
check "POST a wrong state -> 400 invalid_state" "400 invalid_state" "$(post_state maybe) $(field "$T/post.json" error)"

# Off, then straight back On.
off_at="$(date +%s.%N)"
switched_off=1
code="$(post_state off)"
check "POST off -> 200 switched_off, state off" "200 switched_off off" "$code $(field "$T/post.json" result) $(field "$T/post.json" status.state)"
check "Off: federation and circles enabled again" "true true" \
	"$(field "$T/post.json" status.apps.federation.enabled) $(field "$T/post.json" status.apps.circles.enabled)"
cp "$T/post.json" "$T/off.json"
for attempt in 1 2 3; do
	code="$(post_state on)"
	[ "$code" = 200 ] && [ "$(field "$T/post.json" status.state)" = on ] && break
	log "  switching back on, attempt $attempt: HTTP $code"
done
on_at="$(date +%s.%N)"
check "POST on -> 200 switched_on, state on" "200 switched_on on" "$code $(field "$T/post.json" result) $(field "$T/post.json" status.state)"
[ "$(field "$T/post.json" status.state)" = on ] && switched_off=0
check "On: federation and circles disabled" "false false" \
	"$(field "$T/post.json" status.apps.federation.enabled) $(field "$T/post.json" status.apps.circles.enabled)"
log "  privacy was off for $(awk -v a="$off_at" -v b="$on_at" 'BEGIN { printf "%.1f", b - a }') s"
log "  Off changed: $(field "$T/off.json" changed | tr -d '[]"' | sed 's/,/, /g')"
check "Recent changes: on, then off, by $QA_ADMIN (admin page)" \
	"Switched on by $QA_ADMIN (admin page)|Switched off by $QA_ADMIN (admin page)" \
	"$(field "$T/post.json" history.0.text)|$(field "$T/post.json" history.1.text)"
check "GET afterwards: on" on "$(route GET "$T/get.json" >/dev/null; field "$T/get.json" status.state)"

sign_out
[ "$fails" -eq 0 ] || die "$fails check(s) failed"
log "all org-privacy-page admin checks passed"
