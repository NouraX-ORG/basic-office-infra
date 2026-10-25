#!/usr/bin/env python3
# A stand-in for NIG (https://nig.nourax.org) for the relay's tests. It answers like NIG's
# src/handler.ts: the service key in "Authorization: Bearer", "user" required in NIG's format, and
# errors as {"error":{"code","message"}}. The last user message picks the answer:
#   MOCK:429  429 budget_exceeded        MOCK:401  401 unauthorized
#   MOCK:403  403 model_not_allowed      MOCK:400  400 upstream_rejected
#   MOCK:500  502 upstream_unavailable   MOCK:SLOW waits 3 s first
#   MOCK:THINK  "<think>...</think>" before the reply
# anything else: "Mock answer for <user> with <model>." (streamed when "stream" is true).
# GET /_last shows the last chat request as received (headers and body), for the tests only.
# Run on its own: python -I mock_nig.py PORT KEY_FILE
# SPDX-License-Identifier: AGPL-3.0-or-later

import json
import re
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

TAG_VALUE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}")
MODELS = ("nourax-smart", "nourax-long-context", "nourax-fast")


class MockNig(BaseHTTPRequestHandler):
	key = ""
	last = {}
	lock = threading.Lock()

	def log_message(self, format, *args):  # noqa: A002
		pass

	def send_json(self, status, body):
		data = json.dumps(body).encode("utf-8")
		self.send_response(status)
		self.send_header("Content-Type", "application/json")
		self.send_header("Content-Length", str(len(data)))
		self.end_headers()
		self.wfile.write(data)

	def error(self, status, code, message):
		self.send_json(status, {"error": {"code": code, "message": message}})

	def do_GET(self):
		if self.path == "/health":
			self.send_json(200, {"status": "ok"})
		elif self.path == "/_last":
			with self.lock:
				self.send_json(200, type(self).last)
		else:
			self.error(404, "not_found", "Unknown path")

	def do_POST(self):
		raw = self.rfile.read(int(self.headers.get("Content-Length", "0")))
		body = json.loads(raw or b"{}")
		with self.lock:
			type(self).last = {"headers": {k.lower(): v for k, v in self.headers.items()}, "body": body}
		if self.path != "/v1/chat/completions":
			self.error(404, "not_found", "Unknown path")
			return
		if self.headers.get("Authorization") != "Bearer " + self.key:
			self.error(401, "unauthorized", "Missing or invalid service key")
			return
		user = body.get("user")
		if not user:
			self.error(400, "user_required", "Send the end user's id in the `user` field")
			return
		if not isinstance(user, str) or not TAG_VALUE.fullmatch(user):
			self.error(400, "invalid_user", "`user` must be an id made of letters, digits and . _ : -")
			return
		model = body.get("model")
		if model not in MODELS:
			self.error(400, "unknown_model", "Unknown model; see GET /v1/models")
			return
		messages = body.get("messages") or [{}]
		prompt = str(messages[-1].get("content", ""))
		if prompt == "MOCK:429":
			self.error(429, "budget_exceeded", "Spend limit exceeded")
		elif prompt == "MOCK:401":
			self.error(401, "unauthorized", "Missing or invalid service key")
		elif prompt == "MOCK:403":
			self.error(403, "model_not_allowed", "This service may not use that model")
		elif prompt == "MOCK:400":
			self.error(400, "upstream_rejected", "The model refused this prompt")
		elif prompt == "MOCK:500":
			self.error(502, "upstream_unavailable", "Every model behind this name failed; try again shortly")
		else:
			if prompt == "MOCK:SLOW":
				time.sleep(3)
			reply = "Mock answer for %s with %s." % (user, model)
			if prompt == "MOCK:THINK":
				reply = "<think>Thinking it over.</think>\n\n" + reply
			if body.get("stream") is True:
				self.send_response(200)
				self.send_header("Content-Type", "text/event-stream")
				self.end_headers()
				for word in reply.split(" "):
					chunk = {"object": "chat.completion.chunk", "model": model,
						"choices": [{"index": 0, "delta": {"content": word + " "}, "finish_reason": None}]}
					self.wfile.write(b"data: " + json.dumps(chunk).encode("utf-8") + b"\n\n")
					self.wfile.flush()
				self.wfile.write(b"data: [DONE]\n\n")
				return
			self.send_json(200, {
				"id": "mock-1", "object": "chat.completion", "created": int(time.time()), "model": model,
				"choices": [{"index": 0, "message": {"role": "assistant", "content": reply}, "finish_reason": "stop"}],
				"usage": {"prompt_tokens": 5, "completion_tokens": 7, "total_tokens": 12},
			})


def make_mock(port, key):
	handler = type("ConfiguredMockNig", (MockNig,), {"key": key, "last": {}, "lock": threading.Lock()})
	server = ThreadingHTTPServer(("0.0.0.0", port), handler)
	server.daemon_threads = True
	return server


if __name__ == "__main__":
	with open(sys.argv[2], encoding="utf-8") as f:
		mock_key = f.read().strip()
	make_mock(int(sys.argv[1]), mock_key).serve_forever()
