#!/usr/bin/env python3
"""Free, keyless, OpenAI-compatible speech-to-text for Heads-Up Desk (faster-whisper on CPU).

    python3 -m venv .stt && .stt/bin/pip install faster-whisper
    .stt/bin/python scripts/local-stt.py            # -> http://127.0.0.1:9000/v1/audio/transcriptions
    STT_BASE_URL=http://127.0.0.1:9000/v1 npm --prefix server run demo

Implements just enough of POST /v1/audio/transcriptions (multipart 'file') for the server's stt.ts.
"""
import email.parser, io, json, os, sys, time, wave
import numpy as np
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from faster_whisper import WhisperModel

MODEL = os.environ.get("WHISPER_MODEL", "small.en")
PORT = int(os.environ.get("PORT", "9000"))
model = WhisperModel(MODEL, device="cpu", compute_type="int8")
PROMPT = "Crypto commands: alert bitcoin above 60k, long ETH 200, bet yes 20, reply on it, Hyperliquid, Polymarket, Telegram."


class H(BaseHTTPRequestHandler):
    def do_POST(self):
        if not self.path.endswith("/audio/transcriptions"):
            return self.reply(404, {"error": "not found"})
        body = self.rfile.read(int(self.headers.get("content-length", 0)))
        msg = email.parser.BytesParser().parsebytes(b"Content-Type: " + self.headers["content-type"].encode() + b"\r\n\r\n" + body)
        audio = next((p.get_payload(decode=True) for p in msg.get_payload() if p.get_param("name", header="content-disposition") == "file"), None)
        if not audio:
            return self.reply(400, {"error": "missing file"})
        t = time.time()
        with wave.open(io.BytesIO(audio)) as w:  # server always sends 16 kHz mono s16le WAV (the G2 mic format)
            pcm = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768.0
        pad = np.zeros(8000, dtype=np.float32)  # 0.5 s of silence each side curbs Whisper hallucinations on short clips
        segs, _ = model.transcribe(np.concatenate([pad, pcm, pad]), language="en", initial_prompt=PROMPT, beam_size=5,
                                   temperature=0.0, condition_on_previous_text=False, vad_filter=False)
        text = " ".join(s.text.strip() for s in segs).strip()
        print(f"[stt] {time.time() - t:.2f}s  {text!r}", flush=True)
        self.reply(200, {"text": text})

    def reply(self, code, obj):
        data = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    print(f"[stt] faster-whisper {MODEL} on http://127.0.0.1:{PORT}/v1", flush=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()
