"""Standard-library-only checks for the production speech bridge."""
import io
from pathlib import Path
import runpy
from types import SimpleNamespace
import unittest
from unittest.mock import patch

bridge = runpy.run_path(str(Path(__file__).parents[2] / "src/transcription/qwen-asr.py"))


class Sequence:
    def __init__(self, length, last):
        self.shape = (1, length)
        self.last = last

    def __getitem__(self, key):
        return SimpleNamespace(tolist=lambda: [self.last])


class BridgeTests(unittest.TestCase):
    def test_token_limit_rejects_an_unfinished_transcript(self):
        result = SimpleNamespace(sequences=Sequence(8, 99))
        core = SimpleNamespace(
            generate=lambda **kwargs: result,
            generation_config=SimpleNamespace(eos_token_id=[1, 2]),
        )
        model = SimpleNamespace(model=core)
        torch = SimpleNamespace(float32="float32", set_num_threads=lambda count: None)
        qwen = SimpleNamespace(Qwen3ASRModel=SimpleNamespace(from_pretrained=lambda *args, **kwargs: model))
        with patch.dict("sys.modules", {"torch": torch, "qwen_asr": qwen}):
            loaded = bridge["load_model"](Path("/unused"))
        inputs = dict(input_ids=SimpleNamespace(shape=(1, 4)), max_new_tokens=4)
        with self.assertRaisesRegex(bridge["AudioError"], "audio_transcription_failed"):
            loaded.model.generate(**inputs)
        result.sequences = Sequence(8, 2)
        self.assertIs(loaded.model.generate(**inputs), result)
        result.sequences = Sequence(7, 99)
        self.assertIs(loaded.model.generate(**inputs), result)

    def test_serve_reuses_only_the_model_session_and_keeps_stdout_clean(self):
        sessions = []

        def transcribe(root, raw, session):
            print("library progress must not enter JSON")
            sessions.append(session)
            self.assertIsInstance(raw, bytes)
            if raw == b"bad":
                raise bridge["AudioError"]("audio_invalid")
            return {"text": raw.decode()}

        raw = "你好\nGitHub".encode()
        requests = b"3\nbad" + str(len(raw)).encode() + b"\n" + raw
        stdin = SimpleNamespace(buffer=io.BytesIO(requests))
        output = io.StringIO()
        namespace = bridge["serve"].__globals__
        with patch.dict(namespace, {"transcribe": transcribe}), patch("sys.stdin", stdin), patch("sys.stdout", output), patch("sys.stderr", io.StringIO()):
            bridge["serve"](Path("/unused"))
        import json
        responses = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertEqual(responses, [{"error": "audio_invalid"}, {"text": raw.decode()}])
        self.assertIs(sessions[0], sessions[1])
        self.assertEqual(sessions[0], {})

    def test_serve_rejects_oversized_and_incomplete_frames(self):
        for raw in [b"5242881\n", b"3\na"]:
            with patch("sys.stdin", SimpleNamespace(buffer=io.BytesIO(raw))):
                with self.assertRaisesRegex(bridge["AudioError"], "audio_invalid"):
                    bridge["serve"](Path("/unused"))


if __name__ == "__main__":
    unittest.main()
