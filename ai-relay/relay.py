#!/usr/bin/env python3
# Nourax AI relay for the Assistant (compose service "ai-relay", docs/assistant.md).
#
# The Assistant's AI provider (the integration_openai app in the file server) sends its OpenAI-style
# requests here instead of to an AI company: http://ai-relay:8080/v1. This relay
#   1. lets in only the file server: "Authorization: Bearer <ai_relay_token>", compared in constant time;
#   2. needs "user" (the account id; scripts/configure.d/50-assistant.sh makes integration_openai send
#      it) in NIG's format, and one of the allowed nourax-* models;
#   3. keeps only plain chat fields, adds NIG's service key and "X-Nourax-Feature: assistant", and
#      sends the request to NIG, so it counts against that person's Nourax AI budget;
#   4. turns every refusal or failure into a normal answer with a plain message, so people read
#      "Nourax AI is not available yet." instead of an error, and the file server never retries a
#      429 by sleeping.
# The NIG key stays in this container (a compose secret); it is never sent to the file server.
# Prompts and replies are never logged or stored: one log line per request (time, account id,
# model, NIG status or notice, milliseconds).
#
# Python standard library only, so the official python image runs it unchanged.
#   GET  /healthz              {"status":"ok","nig_key":"set|unset","token":"set|unset","stream":"on|off","version":...}
#   GET  /v1/models            the allowed models, OpenAI format (token needed)
#   POST /v1/chat/completions  the chat request (token needed)
# Settings (environment): NIG_URL, NIG_KEY_FILE, RELAY_TOKEN_FILE, NIG_FEATURE, ALLOWED_MODELS,
# NIG_STREAM (off: NIG gets stream=false and the answer comes back whole), NIG_TIMEOUT (seconds),
# MAX_BODY_BYTES, LISTEN_HOST, LISTEN_PORT.
# SPDX-License-Identifier: AGPL-3.0-or-later

import hashlib
import hmac
import http.client
import json
import os
import re
import signal
import ssl
import sys
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# OpenAI chat fields passed on to NIG; anything else (n, logit_bias, the caller's own user, ...) is
# dropped. The same list as the editors' relay (office-ai/src/relay.ts).
CHAT_FIELDS = (
	"messages",
	"stream",
	"stream_options",
	"temperature",
	"top_p",
	"max_tokens",
	"max_completion_tokens",
	"stop",
	"presence_penalty",
	"frequency_penalty",
	"seed",
	"response_format",
	"tools",
	"tool_choice",
)

# NIG's rule for ids it puts in its logs (NIG_Cloudflare_Live src/handler.ts, TAG_VALUE).
USER_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}")

# What people read. The same wording as the editors' relay.
MESSAGES = {
	"not_configured": "Nourax AI is not available yet.",
	"bad_user": "Nourax AI is not available for this account.",
	"model_not_allowed": "That AI model is not available. Please choose another one.",
	"budget_exceeded": "You have reached your Nourax AI limit for now. Please try again later.",
	"too_large": "This request is too large for Nourax AI. Try a shorter text.",
	"bad_request": "Nourax AI could not read this request.",
	"busy": "Nourax AI is busy. Please try again in a moment.",
}

THINK_START = "<think>"
THINK_END = "</think>"
MAX_ANSWER_BYTES = 32 * 1024 * 1024
MAX_ERROR_BYTES = 64 * 1024


def env_flag(value):
	return str(value).strip().lower() in ("1", "on", "true", "yes")


class Config:
	"""Settings from the environment, read once at start. Secret files are read on every request."""

	def __init__(self, env):
		self.nig_url = env.get("NIG_URL", "https://nig.nourax.org").strip().rstrip("/")
		parts = urllib.parse.urlsplit(self.nig_url)
		if parts.scheme not in ("http", "https") or not parts.hostname:
			raise ValueError("NIG_URL must be an http(s) address, for example https://nig.nourax.org")
		self.nig_scheme = parts.scheme
		self.nig_host = parts.hostname
		self.nig_port = parts.port or (443 if parts.scheme == "https" else 80)
		self.nig_path = parts.path.rstrip("/") + "/v1/chat/completions"
		self.nig_key_file = env.get("NIG_KEY_FILE", "/run/secrets/nig_assistant_key")
		self.token_file = env.get("RELAY_TOKEN_FILE", "/run/secrets/ai_relay_token")
		self.feature = env.get("NIG_FEATURE", "assistant")
		if not USER_ID.fullmatch(self.feature):
			raise ValueError("NIG_FEATURE must be made of letters, digits and . _ : -")
		models = env.get("ALLOWED_MODELS", "nourax-smart,nourax-long-context,nourax-fast")
		self.models = [m.strip() for m in models.split(",") if m.strip()]
		self.stream = env_flag(env.get("NIG_STREAM", "off"))
		self.timeout = float(env.get("NIG_TIMEOUT", "110"))
		self.max_body = int(env.get("MAX_BODY_BYTES", str(8 * 1024 * 1024)))
		self.host = env.get("LISTEN_HOST", "0.0.0.0")
		self.port = int(env.get("LISTEN_PORT", "8080"))


def read_secret(path):
	"""The secret in a file, or "" when the file is missing, empty or still says "unset"."""
	try:
		with open(path, "r", encoding="utf-8") as f:
			value = f.read().strip()
	except OSError:
		return ""
	return "" if value.lower() == "unset" else value


def code_version():
	try:
		with open(os.path.abspath(__file__), "rb") as f:
			return hashlib.sha256(f.read()).hexdigest()[:12]
	except OSError:
		return "unknown"


def split_thinking(answer):
	"""A thinking model may put "<think>...</think>" before its reply. Move it to reasoning_content,
	where the Assistant shows it apart from the reply. Only for whole (not streamed) answers."""
	for choice in answer.get("choices") or []:
		message = choice.get("message") if isinstance(choice, dict) else None
		if not isinstance(message, dict):
			continue
		content = message.get("content")
		if not isinstance(content, str):
			continue
		stripped = content.lstrip()
		if not stripped.startswith(THINK_START) or THINK_END not in stripped:
			continue
		thought, _, reply = stripped[len(THINK_START):].partition(THINK_END)
		message["content"] = reply.strip()
		if not message.get("reasoning_content"):
			message["reasoning_content"] = thought.strip()
	return answer


def nig_error(raw):
	"""NIG answers errors as {"error":{"code":..., "message":...}}."""
	try:
		parsed = json.loads(raw.decode("utf-8", "replace"))
		error = parsed.get("error") if isinstance(parsed, dict) else None
		if isinstance(error, dict):
			return str(error.get("code") or ""), str(error.get("message") or "")
	except ValueError:
		pass
	return "", ""


def one_line(text, limit=300):
	text = " ".join(str(text).split())
	return text[:limit]


class Relay(BaseHTTPRequestHandler):
	server_version = "nourax-ai-relay"
	sys_version = ""
	timeout = 60  # seconds to read a request from the file server

	# Set by make_server.
	config = None
	version = "unknown"

	def log_message(self, format, *args):  # noqa: A002 - the base class's name
		# The default access log is replaced by one line per chat request (log_request below).
		pass

	def log_request_line(self, **fields):
		fields = {"t": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), **fields}
		sys.stdout.write(json.dumps(fields, separators=(",", ":")) + "\n")
		sys.stdout.flush()

	# --- answers ---------------------------------------------------------------------------------

	def send_json(self, status, body, headers=None):
		data = json.dumps(body, separators=(",", ":")).encode("utf-8")
		self.send_response(status)
		self.send_header("Content-Type", "application/json")
		self.send_header("Content-Length", str(len(data)))
		self.send_header("Cache-Control", "no-store")
		for name, value in (headers or {}).items():
			self.send_header(name, value)
		self.end_headers()
		self.wfile.write(data)

	def send_error_json(self, status, message, code):
		self.send_json(status, {"error": {"message": message, "type": "invalid_request_error", "code": code}})

	def send_notice(self, code, model, as_stream, message=None):
		"""A plain message as a normal chat answer (HTTP 200), marked with X-Nourax-Notice."""
		text = message or MESSAGES[code]
		created = int(time.time())
		answer_id = "nourax-notice-%d" % created
		model = model if isinstance(model, str) and model else "nourax-ai"
		if not as_stream:
			self.send_json(200, {
				"id": answer_id,
				"object": "chat.completion",
				"created": created,
				"model": model,
				"choices": [{"index": 0, "message": {"role": "assistant", "content": text}, "finish_reason": "stop"}],
				"usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
			}, {"X-Nourax-Notice": code})
			return
		chunks = [
			{"choices": [{"index": 0, "delta": {"role": "assistant", "content": text}, "finish_reason": None}]},
			{"choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]},
		]
		self.send_response(200)
		self.send_header("Content-Type", "text/event-stream")
		self.send_header("Cache-Control", "no-store")
		self.send_header("X-Nourax-Notice", code)
		self.end_headers()
		for chunk in chunks:
			event = {"id": answer_id, "object": "chat.completion.chunk", "created": created, "model": model, **chunk}
			self.wfile.write(b"data: " + json.dumps(event, separators=(",", ":")).encode("utf-8") + b"\n\n")
		self.wfile.write(b"data: [DONE]\n\n")
		self.wfile.flush()

	# --- checks ----------------------------------------------------------------------------------

	def authorised(self):
		token = read_secret(self.config.token_file)
		match = re.fullmatch(r"Bearer (\S+)", self.headers.get("Authorization", ""))
		if not token or not match:
			return False
		return hmac.compare_digest(match.group(1).encode("utf-8"), token.encode("utf-8"))

	# --- routes ----------------------------------------------------------------------------------

	def do_GET(self):
		path = urllib.parse.urlsplit(self.path).path
		if path == "/healthz":
			self.send_json(200, {
				"status": "ok",
				"nig_key": "set" if read_secret(self.config.nig_key_file) else "unset",
				"token": "set" if read_secret(self.config.token_file) else "unset",
				"stream": "on" if self.config.stream else "off",
				"version": self.version,
			})
		elif path == "/v1/models":
			if not self.authorised():
				self.send_error_json(401, "Invalid relay token", "invalid_api_key")
				return
			self.send_json(200, {
				"object": "list",
				"data": [{"id": m, "object": "model", "created": 0, "owned_by": "nourax"} for m in self.config.models],
			})
		else:
			self.send_error_json(404, "Unknown path", "not_found")

	def do_POST(self):
		started = time.monotonic()
		path = urllib.parse.urlsplit(self.path).path
		if path != "/v1/chat/completions":
			self.send_error_json(404, "Only chat is offered", "not_found")
			return
		if not self.authorised():
			self.log_request_line(event="refused", reason="relay token")
			self.send_error_json(401, "Invalid relay token", "invalid_api_key")
			return

		log = {"user": None, "model": None, "stream": False}

		def notice(code, reason=None, message=None, as_stream=False):
			self.send_notice(code, log["model"], as_stream, message)
			log.update(notice=code, ms=int((time.monotonic() - started) * 1000))
			if reason:
				log["reason"] = reason
			self.log_request_line(**log)

		try:
			length = int(self.headers.get("Content-Length", ""))
		except ValueError:
			length = -1
		if length < 0:
			notice("bad_request", "no Content-Length")
			return
		if length > self.config.max_body:
			self.close_connection = True
			notice("too_large", "%d bytes" % length)
			return
		try:
			body = json.loads(self.rfile.read(length).decode("utf-8"))
		except (ValueError, UnicodeDecodeError):
			body = None
		if not isinstance(body, dict):
			notice("bad_request", "not a JSON object")
			return

		as_stream = body.get("stream") is True and self.config.stream
		log["stream"] = as_stream
		model = body.get("model")
		log["model"] = model if isinstance(model, str) else None
		user = body.get("user")
		if user is None or user == "":
			# The file server did not say who is asking: the integration_openai patch of
			# scripts/configure.d/50-assistant.sh is missing (an app update removes it). Nobody is charged.
			notice("not_configured", "no user in the request: is the integration_openai patch in place?", as_stream=as_stream)
			return
		if not isinstance(user, str) or not USER_ID.fullmatch(user):
			notice("bad_user", "account id not in NIG's format", as_stream=as_stream)
			return
		log["user"] = user
		if not isinstance(model, str) or model not in self.config.models:
			notice("model_not_allowed", as_stream=as_stream)
			return
		key = read_secret(self.config.nig_key_file)
		if not key:
			notice("not_configured", "no NIG key yet (secret nig_assistant_key)", as_stream=as_stream)
			return

		out = {"model": model, "user": user}
		for field in CHAT_FIELDS:
			if field in body:
				out[field] = body[field]
		if not self.config.stream:
			# Whole answers only, so every call carries its token usage (see NIG_STREAM).
			out.pop("stream", None)
			out.pop("stream_options", None)

		conn = None
		answering = False  # True once NIG's answer has started to go out: no notice after that
		try:
			if self.config.nig_scheme == "https":
				conn = http.client.HTTPSConnection(
					self.config.nig_host, self.config.nig_port, timeout=self.config.timeout,
					context=ssl.create_default_context())
			else:
				conn = http.client.HTTPConnection(self.config.nig_host, self.config.nig_port, timeout=self.config.timeout)
			conn.request("POST", self.config.nig_path, body=json.dumps(out).encode("utf-8"), headers={
				"Authorization": "Bearer " + key,
				"Content-Type": "application/json",
				"Accept": "text/event-stream" if as_stream else "application/json",
				"X-Nourax-Feature": self.config.feature,
				"User-Agent": "nourax-ai-relay",
			})
			upstream = conn.getresponse()
			log["status"] = upstream.status

			if 200 <= upstream.status < 300:
				content_type = upstream.getheader("Content-Type", "")
				if as_stream and content_type.startswith("text/event-stream"):
					answering = True
					self.send_response(upstream.status)
					self.send_header("Content-Type", content_type)
					self.send_header("Cache-Control", "no-store")
					self.end_headers()
					while True:
						chunk = upstream.read1(65536)
						if not chunk:
							break
						self.wfile.write(chunk)
						self.wfile.flush()
					log["ms"] = int((time.monotonic() - started) * 1000)
					self.log_request_line(**log)
					return
				raw = upstream.read(MAX_ANSWER_BYTES + 1)
				try:
					answer = json.loads(raw.decode("utf-8")) if len(raw) <= MAX_ANSWER_BYTES else None
				except (ValueError, UnicodeDecodeError):
					answer = None
				if not isinstance(answer, dict):
					notice("busy", "NIG answer is not JSON", as_stream=as_stream)
					return
				self.send_json(200, split_thinking(answer))
				log["ms"] = int((time.monotonic() - started) * 1000)
				self.log_request_line(**log)
				return

			code, message = nig_error(upstream.read(MAX_ERROR_BYTES))
			log["nig_code"] = code
			if upstream.status == 429 and code == "budget_exceeded":
				notice("budget_exceeded", as_stream=as_stream)
			elif upstream.status == 401:
				notice("not_configured", "NIG refused the key (SERVICE_KEY_ASSISTANT and nig_assistant_key differ?)", as_stream=as_stream)
			elif upstream.status == 403 or code in ("unknown_model", "model_not_allowed"):
				notice("model_not_allowed", as_stream=as_stream)
			elif code == "invalid_user":
				notice("bad_user", as_stream=as_stream)
			elif 400 <= upstream.status < 500 and code == "upstream_rejected":
				notice("upstream_rejected", message="Nourax AI could not process this request: " + one_line(message), as_stream=as_stream)
			elif 400 <= upstream.status < 500:
				notice("bad_request", "NIG %d %s" % (upstream.status, code), as_stream=as_stream)
			else:
				notice("busy", as_stream=as_stream)
		except (OSError, http.client.HTTPException) as err:
			# Timeouts, refused connections, NIG cut off while streaming, or the file server hung up.
			if answering:
				log.update(ms=int((time.monotonic() - started) * 1000), reason="stream cut off: " + type(err).__name__)
				self.log_request_line(**log)
				self.close_connection = True
				return
			try:
				notice("busy", "NIG unreachable or too slow: " + type(err).__name__, as_stream=as_stream)
			except OSError:
				self.close_connection = True
		finally:
			if conn is not None:
				conn.close()


def make_server(config, version=None):
	handler = type("ConfiguredRelay", (Relay,), {"config": config, "version": version or code_version()})
	server = ThreadingHTTPServer((config.host, config.port), handler)
	server.daemon_threads = True
	return server


def main():
	try:
		config = Config(os.environ)
	except ValueError as err:
		sys.stderr.write("ai-relay: %s\n" % err)
		return 2
	server = make_server(config)
	# PID 1 in a container ignores SIGTERM unless it handles it.
	signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
	sys.stdout.write(json.dumps({
		"event": "start", "nig": config.nig_url, "feature": config.feature, "models": config.models,
		"stream": "on" if config.stream else "off", "version": code_version(),
	}) + "\n")
	sys.stdout.flush()
	try:
		server.serve_forever()
	finally:
		server.server_close()
	return 0


if __name__ == "__main__":
	sys.exit(main())
