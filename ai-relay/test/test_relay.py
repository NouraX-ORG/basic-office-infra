#!/usr/bin/env python3
# Tests of the Assistant's relay (ai-relay/relay.py) against a stand-in for NIG (mock_nig.py).
# Standard library only:
#   python -I ai-relay/test/test_relay.py            (on this PC, Python 3.12 or later)
#   docker run --rm -v "$PWD/ai-relay:/opt/ai-relay:ro" python:3.13.16-alpine3.24 \
#       python -I /opt/ai-relay/test/test_relay.py   (on the server, the same image as the service)
# Nothing here is a real secret: the relay token is made up per run and mock-key.txt is a test value.
# SPDX-License-Identifier: AGPL-3.0-or-later

import http.client
import json
import os
import secrets
import socket
import sys
import tempfile
import threading
import unittest

sys.dont_write_bytecode = True  # no __pycache__ folders in the repo (and the mount may be read-only)
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
sys.path.insert(0, HERE)

import mock_nig  # noqa: E402
import relay  # noqa: E402

TOKEN = secrets.token_urlsafe(32)
with open(os.path.join(HERE, "mock-key.txt"), encoding="utf-8") as f:
	MOCK_KEY = f.read().strip()


def free_port():
	with socket.socket() as s:
		s.bind(("127.0.0.1", 0))
		return s.getsockname()[1]


def start(server):
	thread = threading.Thread(target=server.serve_forever, daemon=True)
	thread.start()
	return server


class RelayTest(unittest.TestCase):
	@classmethod
	def setUpClass(cls):
		cls.tmp = tempfile.TemporaryDirectory()
		cls.token_file = os.path.join(cls.tmp.name, "ai_relay_token")
		cls.key_file = os.path.join(cls.tmp.name, "nig_assistant_key")
		with open(cls.token_file, "w", encoding="utf-8") as f:
			f.write(TOKEN + "\n")
		cls.mock_port = free_port()
		cls.mock = start(mock_nig.make_mock(cls.mock_port, MOCK_KEY))
		cls.relays = {}

	@classmethod
	def tearDownClass(cls):
		for server in cls.relays.values():
			server.shutdown()
			server.server_close()
		cls.mock.shutdown()
		cls.mock.server_close()
		cls.tmp.cleanup()

	def setUp(self):
		self.set_key(MOCK_KEY)

	def set_key(self, value):
		with open(self.key_file, "w", encoding="utf-8") as f:
			f.write(value)

	def relay_port(self, stream=False, nig_url=None, timeout="5"):
		name = (stream, nig_url, timeout)
		if name not in self.relays:
			config = relay.Config({
				"NIG_URL": nig_url or "http://127.0.0.1:%d" % self.mock_port,
				"NIG_KEY_FILE": self.key_file,
				"RELAY_TOKEN_FILE": self.token_file,
				"NIG_STREAM": "on" if stream else "off",
				"NIG_TIMEOUT": timeout,
				"MAX_BODY_BYTES": "65536",
				"LISTEN_HOST": "127.0.0.1",
				"LISTEN_PORT": str(free_port()),
			})
			self.relays[name] = start(relay.make_server(config, "test"))
		return self.relays[name].server_address[1]

	def call(self, method, path, body=None, token=TOKEN, port=None, raw=None):
		conn = http.client.HTTPConnection("127.0.0.1", port or self.relay_port(), timeout=10)
		headers = {"Content-Type": "application/json"}
		if token is not None:
			headers["Authorization"] = "Bearer " + token
		data = raw if raw is not None else (json.dumps(body).encode("utf-8") if body is not None else None)
		conn.request(method, path, body=data, headers=headers)
		resp = conn.getresponse()
		payload = resp.read()
		conn.close()
		return resp, payload

	def chat(self, prompt="Hello", port=None, **fields):
		body = {"model": "nourax-smart", "user": "qa-t5-1", "messages": [{"role": "user", "content": prompt}]}
		body.update(fields)
		body = {k: v for k, v in body.items() if v is not None}
		return self.call("POST", "/v1/chat/completions", body, port=port)

	def last_nig_request(self):
		conn = http.client.HTTPConnection("127.0.0.1", self.mock_port, timeout=5)
		conn.request("GET", "/_last")
		last = json.loads(conn.getresponse().read())
		conn.close()
		return last

	def clear_nig_request(self):
		with self.mock.RequestHandlerClass.lock:
			self.mock.RequestHandlerClass.last = {}

	def content(self, payload):
		return json.loads(payload)["choices"][0]["message"]["content"]

	# --- health and models ----------------------------------------------------------------------

	def test_health_shows_whether_the_key_is_set(self):
		resp, payload = self.call("GET", "/healthz", token=None)
		self.assertEqual(resp.status, 200)
		self.assertEqual(json.loads(payload)["nig_key"], "set")
		self.set_key("unset\n")
		resp, payload = self.call("GET", "/healthz", token=None)
		self.assertEqual(json.loads(payload)["nig_key"], "unset")
		self.assertNotIn(MOCK_KEY, payload.decode())

	def test_models_need_the_token_and_list_only_nourax_models(self):
		resp, _ = self.call("GET", "/v1/models", token=None)
		self.assertEqual(resp.status, 401)
		resp, payload = self.call("GET", "/v1/models")
		self.assertEqual(resp.status, 200)
		self.assertEqual([m["id"] for m in json.loads(payload)["data"]], ["nourax-smart", "nourax-long-context", "nourax-fast"])

	# --- who may call ---------------------------------------------------------------------------

	def test_chat_without_or_with_a_wrong_token_is_refused_and_nig_is_not_called(self):
		self.clear_nig_request()
		for token in (None, "wrong", TOKEN + "x"):
			resp, payload = self.call("POST", "/v1/chat/completions", {"model": "nourax-smart", "user": "qa-t5-1", "messages": []}, token=token)
			self.assertEqual(resp.status, 401)
			self.assertEqual(json.loads(payload)["error"]["code"], "invalid_api_key")
		self.assertEqual(self.last_nig_request(), {})

	def test_unknown_paths(self):
		resp, _ = self.call("POST", "/v1/images/generations", {"prompt": "x"})
		self.assertEqual(resp.status, 404)
		resp, _ = self.call("GET", "/v1/files")
		self.assertEqual(resp.status, 404)

	# --- what reaches NIG -----------------------------------------------------------------------

	def test_chat_is_forwarded_with_user_key_feature_and_only_chat_fields(self):
		resp, payload = self.chat(temperature=0.2, n=3, logit_bias={"1": 2}, stream=True, stream_options={"include_usage": True}, max_tokens=50)
		self.assertEqual(resp.status, 200)
		self.assertIsNone(resp.getheader("X-Nourax-Notice"))
		self.assertEqual(self.content(payload), "Mock answer for qa-t5-1 with nourax-smart.")
		last = self.last_nig_request()
		self.assertEqual(last["headers"]["authorization"], "Bearer " + MOCK_KEY)
		self.assertEqual(last["headers"]["x-nourax-feature"], "assistant")
		self.assertEqual(last["body"]["user"], "qa-t5-1")
		self.assertEqual(last["body"]["model"], "nourax-smart")
		self.assertEqual(last["body"]["temperature"], 0.2)
		self.assertEqual(last["body"]["max_tokens"], 50)
		for dropped in ("n", "logit_bias", "stream", "stream_options"):
			self.assertNotIn(dropped, last["body"])
		self.assertNotIn(TOKEN, json.dumps(last))

	def test_streaming_on_passes_nig_events_through(self):
		port = self.relay_port(stream=True)
		resp, payload = self.chat(port=port, stream=True)
		self.assertEqual(resp.status, 200)
		self.assertTrue(resp.getheader("Content-Type").startswith("text/event-stream"))
		text = payload.decode()
		self.assertIn('"content": "Mock "', text)
		self.assertTrue(text.rstrip().endswith("data: [DONE]"))
		self.assertTrue(self.last_nig_request()["body"]["stream"])

	def test_thinking_is_moved_out_of_the_reply(self):
		resp, payload = self.chat("MOCK:THINK")
		message = json.loads(payload)["choices"][0]["message"]
		self.assertEqual(message["content"], "Mock answer for qa-t5-1 with nourax-smart.")
		self.assertEqual(message["reasoning_content"], "Thinking it over.")

	# --- plain messages instead of errors -------------------------------------------------------

	def assert_notice(self, resp, payload, code, text):
		self.assertEqual(resp.status, 200)
		self.assertEqual(resp.getheader("X-Nourax-Notice"), code)
		self.assertEqual(self.content(payload), text)

	def test_no_user_means_not_available_and_nig_is_not_called(self):
		self.clear_nig_request()
		resp, payload = self.chat(user=None)
		self.assert_notice(resp, payload, "not_configured", "Nourax AI is not available yet.")
		resp, payload = self.chat(user="")
		self.assert_notice(resp, payload, "not_configured", "Nourax AI is not available yet.")
		self.assertEqual(self.last_nig_request(), {})

	def test_account_ids_outside_nigs_format_are_refused(self):
		for user in ("a b", "x@example.org", "-starts-with-dash", "a" * 129, 42):
			resp, payload = self.chat(user=user)
			self.assert_notice(resp, payload, "bad_user", "Nourax AI is not available for this account.")

	def test_only_allowed_models(self):
		for model in ("gpt-4.1-mini", "nourax-qwen", None):
			resp, payload = self.chat(model=model)
			self.assert_notice(resp, payload, "model_not_allowed", "That AI model is not available. Please choose another one.")

	def test_no_nig_key_yet(self):
		self.clear_nig_request()
		for value in ("unset\n", "", "  "):
			self.set_key(value)
			resp, payload = self.chat()
			self.assert_notice(resp, payload, "not_configured", "Nourax AI is not available yet.")
		self.assertEqual(self.last_nig_request(), {})

	def test_nig_errors_become_plain_messages(self):
		cases = {
			"MOCK:429": ("budget_exceeded", "You have reached your Nourax AI limit for now. Please try again later."),
			"MOCK:401": ("not_configured", "Nourax AI is not available yet."),
			"MOCK:403": ("model_not_allowed", "That AI model is not available. Please choose another one."),
			"MOCK:400": ("upstream_rejected", "Nourax AI could not process this request: The model refused this prompt"),
			"MOCK:500": ("busy", "Nourax AI is busy. Please try again in a moment."),
		}
		for prompt, (code, text) in cases.items():
			with self.subTest(prompt=prompt):
				resp, payload = self.chat(prompt)
				self.assert_notice(resp, payload, code, text)

	def test_wrong_key_at_nig_means_not_available(self):
		self.set_key("not-the-mock-key")
		resp, payload = self.chat()
		self.assert_notice(resp, payload, "not_configured", "Nourax AI is not available yet.")

	def test_nig_down_or_too_slow_means_busy(self):
		down = self.relay_port(nig_url="http://127.0.0.1:%d" % free_port())
		resp, payload = self.chat(port=down)
		self.assert_notice(resp, payload, "busy", "Nourax AI is busy. Please try again in a moment.")
		slow = self.relay_port(timeout="1")
		resp, payload = self.chat("MOCK:SLOW", port=slow)
		self.assert_notice(resp, payload, "busy", "Nourax AI is busy. Please try again in a moment.")

	def test_notices_are_streamed_when_a_stream_was_asked_for(self):
		port = self.relay_port(stream=True)
		self.set_key("unset")
		resp, payload = self.chat(port=port, stream=True)
		self.assertEqual(resp.status, 200)
		self.assertEqual(resp.getheader("X-Nourax-Notice"), "not_configured")
		events = [line[6:] for line in payload.decode().split("\n") if line.startswith("data: ")]
		self.assertEqual(events[-1], "[DONE]")
		self.assertEqual(json.loads(events[0])["choices"][0]["delta"]["content"], "Nourax AI is not available yet.")
		self.assertEqual(json.loads(events[1])["choices"][0]["finish_reason"], "stop")

	def test_bad_and_too_large_bodies(self):
		resp, payload = self.call("POST", "/v1/chat/completions", raw=b"not json")
		self.assert_notice(resp, payload, "bad_request", "Nourax AI could not read this request.")
		resp, payload = self.call("POST", "/v1/chat/completions", raw=b"[1,2]")
		self.assert_notice(resp, payload, "bad_request", "Nourax AI could not read this request.")
		resp, payload = self.chat("x" * 70000)
		self.assert_notice(resp, payload, "too_large", "This request is too large for Nourax AI. Try a shorter text.")


if __name__ == "__main__":
	unittest.main(verbosity=2)
