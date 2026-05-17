#!/usr/bin/env python3
"""Tiny CORS-adding reverse proxy for Ollama.

Browser  →  http://<this-host>:8767  →  $OLLAMA_UPSTREAM

Why: Ollama replies 403 to CORS preflight by default. Setting
`OLLAMA_ORIGINS=*` on the Ollama host is the proper fix, but if you can't
touch that host (or don't want to), running this proxy on the same machine
that serves the course is the next-best option.

Configuration (all via env vars or the .env file next to this script):
    OLLAMA_UPSTREAM   — URL of the upstream Ollama API. Default: http://localhost:11434
    LISTEN_HOST       — interface to bind on.             Default: 127.0.0.1 (loopback only)
                        Set to 0.0.0.0 if you genuinely need LAN access; this also
                        exposes /chat-config keys to anyone on the network, so use
                        with care.
    LISTEN_PORT       — port this proxy listens on.       Default: 8767
    GEMINI_API_KEY    — surfaced to the widget via /chat-config
    ANTHROPIC_API_KEY — surfaced to the widget via /chat-config
    TAVILY_API_KEY    — surfaced to the widget via /chat-config

DO NOT hardcode any IPs or keys in this file. Put them in `.env` (gitignored).

Streaming: chunked passthrough so /api/chat with stream:true forwards
Ollama's NDJSON tokens as they arrive.

Usage:
    python3 cors-proxy.py
    # then point chat-widget settings to:  http://localhost:8767
"""
from __future__ import annotations

import http.server
import json
import os
import pathlib
import socketserver
import threading
import urllib.error
import urllib.request


def _load_dotenv(path: pathlib.Path) -> None:
    """Tiny `.env` parser — KEY=value lines, optional quotes, no shell expansion.

    Loaded into os.environ on startup so the proxy can serve API keys via
    /chat-config without ever exposing them on the command line. Existing
    process env wins over .env values.
    """
    if not path.exists():
        return
    try:
        for raw in path.read_text(encoding="utf-8").splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, _, v = line.partition("=")
            k = k.strip()
            v = v.strip().strip('"').strip("'")
            if k and k not in os.environ:
                os.environ[k] = v
    except OSError:
        return


_load_dotenv(pathlib.Path(__file__).resolve().parent / ".env")

LISTEN_HOST = os.environ.get("LISTEN_HOST", "127.0.0.1")   # loopback by default
LISTEN_PORT = int(os.environ.get("LISTEN_PORT", "8767"))
UPSTREAM    = os.environ.get("OLLAMA_UPSTREAM", "http://localhost:11434")
TIMEOUT     = 600  # seconds — long, because model generation can be slow

# Special internal endpoint that surfaces API keys from this process's env
# to the chat widget. ONLY env vars listed here are forwarded. Keep this
# list tight — anything here is readable by anyone who can reach the proxy.
ENV_KEY_MAP = {
    "geminiKey":    "GEMINI_API_KEY",
    "anthropicKey": "ANTHROPIC_API_KEY",
    "tavilyKey":    "TAVILY_API_KEY",
}
CONFIG_PATH = "/chat-config"   # widget hits this on startup


CORS_HEADERS = {
    "Access-Control-Allow-Origin":  "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Max-Age":       "86400",
}


class ProxyHandler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    # Make logging compact.
    def log_message(self, fmt, *args):  # noqa: D401
        print(f"[proxy] {self.address_string()} - {fmt % args}")

    def _send_cors(self):
        for k, v in CORS_HEADERS.items():
            self.send_header(k, v)

    def do_OPTIONS(self):  # noqa: N802
        self.send_response(204)
        self._send_cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):  # noqa: N802
        if self.path.split("?")[0] == CONFIG_PATH:
            self._serve_config()
            return
        self._proxy("GET")

    def _serve_config(self):
        config = {}
        for widget_key, env_var in ENV_KEY_MAP.items():
            val = os.environ.get(env_var)
            if val:
                config[widget_key] = val
        body = json.dumps(config).encode()
        self.send_response(200)
        self._send_cors()
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):  # noqa: N802
        self._proxy("POST")

    def _proxy(self, method: str):
        url = UPSTREAM + self.path
        body = None
        if "content-length" in (h.lower() for h in self.headers):
            length = int(self.headers.get("content-length", 0))
            body = self.rfile.read(length) if length else None

        req = urllib.request.Request(url=url, data=body, method=method)
        # Forward most headers, drop hop-by-hop ones.
        skip = {"host", "origin", "referer", "connection", "accept-encoding"}
        for k, v in self.headers.items():
            if k.lower() in skip:
                continue
            req.add_header(k, v)

        try:
            r = urllib.request.urlopen(req, timeout=TIMEOUT)
        except urllib.error.HTTPError as e:
            self.send_response(e.code)
            self._send_cors()
            err = e.read() or b""
            self.send_header("Content-Length", str(len(err)))
            self.end_headers()
            self.wfile.write(err)
            return
        except Exception as e:  # noqa: BLE001
            msg = f"proxy error: {e}".encode()
            self.send_response(502)
            self._send_cors()
            self.send_header("Content-Length", str(len(msg)))
            self.end_headers()
            self.wfile.write(msg)
            return

        try:
            self.send_response(r.status)
            for k, v in r.headers.items():
                if k.lower() in {"content-length", "transfer-encoding", "connection"}:
                    continue
                self.send_header(k, v)
            self._send_cors()
            self.send_header("Transfer-Encoding", "chunked")
            self.end_headers()

            # Chunked passthrough so streaming bytes flow as they arrive.
            while True:
                chunk = r.read(2048)
                if not chunk:
                    break
                self.wfile.write(f"{len(chunk):X}\r\n".encode())
                self.wfile.write(chunk)
                self.wfile.write(b"\r\n")
                self.wfile.flush()
            # Final zero-length chunk
            self.wfile.write(b"0\r\n\r\n")
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            # Client closed early; ignore.
            pass
        finally:
            r.close()


class ThreadingServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    allow_reuse_address = True
    daemon_threads = True


def main():
    server = ThreadingServer((LISTEN_HOST, LISTEN_PORT), ProxyHandler)
    bind = "all interfaces (0.0.0.0)" if LISTEN_HOST == "0.0.0.0" else LISTEN_HOST
    print(f"[proxy] listening on {bind}:{LISTEN_PORT}  ->  {UPSTREAM}")
    if LISTEN_HOST == "0.0.0.0":
        print(f"[proxy] WARNING: binding to 0.0.0.0 exposes /chat-config (API keys) to anyone on the LAN")
    print(f"[proxy] from the browser, point chat host to:  http://localhost:{LISTEN_PORT}")
    detected = [k for k, ev in ENV_KEY_MAP.items() if os.environ.get(ev)]
    if detected:
        print(f"[proxy] auto-serving env keys at {CONFIG_PATH} : {', '.join(detected)}")
    else:
        print(f"[proxy] no API keys detected in env. set GEMINI_API_KEY / ANTHROPIC_API_KEY / TAVILY_API_KEY before starting if you want auto-config.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("[proxy] shutting down")
        server.shutdown()


if __name__ == "__main__":
    main()
