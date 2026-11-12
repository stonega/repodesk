"""Bounded local Qwen3-ASR bridge. stdout is a single JSON protocol response."""
import contextlib
import fcntl
import io
import json
import math
import os
from pathlib import Path
import sys

MODEL = "Qwen/Qwen3-ASR-0.6B"
REVISION = "5eb144179a02acc5e5ba31e748d22b0cf3e303b0"
MAX_BYTES = 5 * 1024 * 1024
MAX_SECONDS = 120


def write_state(root, state, error=None):
    value = {"state": state, "revision": REVISION}
    if error:
        value["error"] = error
    temporary = root / f"state-{os.getpid()}.tmp"
    temporary.write_text(json.dumps(value), encoding="utf-8")
    temporary.replace(root / "state.json")


def status(root):
    with (root / "download.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return {"state": "downloading"}
        try:
            state = json.loads((root / "state.json").read_text())
        except (FileNotFoundError, ValueError):
            return {"state": "not_downloaded"}
        if state.get("revision") != REVISION:
            return {"state": "not_downloaded"}
        if state.get("state") == "downloading":
            return {"state": "error", "error": "download_interrupted"}
        if state.get("state") == "ready" and (not (root / "model/config.json").is_file() or not list((root / "model").glob("*.safetensors"))):
            return {"state": "error", "error": "model_files_missing"}
        return {k: v for k, v in state.items() if k in ("state", "error")}


def download(root):
    if status(root)["state"] == "ready":
        return {"state": "ready"}
    with (root / "download.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return {"state": "downloading"}
        write_state(root, "downloading")
        try:
            from huggingface_hub import snapshot_download
            snapshot_download(
                MODEL, revision=REVISION, local_dir=str(root / "model"),
                token=False, allow_patterns=["*.json", "*.safetensors", "*.txt"],
            )
            if not (root / "model/config.json").is_file() or not list((root / "model").glob("*.safetensors")):
                raise ValueError("missing weights")
            write_state(root, "ready")
            return {"state": "ready"}
        except Exception:
            write_state(root, "error", "download_failed")
            return {"state": "error", "error": "download_failed"}


class AudioError(Exception):
    pass


def load_model(root):
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    import torch
    from qwen_asr import Qwen3ASRModel
    torch.set_num_threads(min(4, os.cpu_count() or 1))
    model = Qwen3ASRModel.from_pretrained(
        str(root / "model"), dtype=torch.float32, device_map="cpu",
        local_files_only=True, trust_remote_code=False,
        max_inference_batch_size=1, max_new_tokens=256,
    )
    generate = model.model.generate

    def complete_generate(*args, **kwargs):
        result = generate(*args, **kwargs)
        sequences = getattr(result, "sequences", result)
        produced = sequences.shape[1] - kwargs["input_ids"].shape[1]
        eos = model.model.generation_config.eos_token_id
        eos = eos if isinstance(eos, list) else [eos]
        if produced >= kwargs["max_new_tokens"] and any(
            token not in eos for token in sequences[:, -1].tolist()
        ):
            # Never present a generation cut off by its token limit as complete speech.
            raise AudioError("audio_transcription_failed")
        return result

    model.model.generate = complete_generate
    return model


def transcribe(root, raw=None, session=None):
    if status(root)["state"] != "ready":
        raise AudioError("audio_model_not_ready")
    if raw is None:
        raw = sys.stdin.buffer.read(MAX_BYTES + 1)
    if not raw or len(raw) > MAX_BYTES:
        raise AudioError("audio_invalid")
    import av
    import numpy as np
    # Decode from memory. Reject containers with no audio and stop before allocating
    # more than two minutes of samples; nested network/file protocols are disabled.
    chunks = []
    size = 0
    try:
        with av.open(io.BytesIO(raw), mode="r", options={"protocol_whitelist": "pipe"}) as container:
            if not container.streams.audio:
                raise AudioError("audio_invalid")
            resampler = av.AudioResampler(format="fltp", layout="mono", rate=16000)
            for frame in container.decode(container.streams.audio[0]):
                for output in resampler.resample(frame):
                    size += output.samples
                    if size > MAX_SECONDS * 16000:
                        raise AudioError("audio_too_long")
                    chunks.append(output.to_ndarray().reshape(-1).copy())
            for output in resampler.resample(None):
                size += output.samples
                if size > MAX_SECONDS * 16000:
                    raise AudioError("audio_too_long")
                chunks.append(output.to_ndarray().reshape(-1).copy())
    except AudioError:
        raise
    except Exception:
        raise AudioError("audio_invalid") from None
    if not chunks:
        raise AudioError("audio_invalid")
    # Serialize inference across API/worker processes sharing this cache.
    with (root / "inference.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        samples = np.concatenate(chunks)
        if float(np.max(np.abs(samples))) < 0.001:
            raise AudioError("audio_no_speech")
        session = session if session is not None else {}
        if "model" not in session:
            session["model"] = load_model(root)
        model = session["model"]
        # Short voice notes need a short decode budget; longer recordings retain room.
        model.max_new_tokens = min(2048, max(256, math.ceil(size / 16000 * 16) + 64))
        text = "\n".join(r.text for r in model.transcribe(audio=(samples, 16000), language=None)).strip()
        if not text:
            raise AudioError("audio_no_speech")
        if len(text) > 32000:
            raise AudioError("audio_transcription_failed")
        return {"text": text}


def serve(root):
    session = {}
    protocol = sys.stdout
    while True:
        header = sys.stdin.buffer.readline(16)
        if not header:
            return
        size = int(header)
        if not 0 < size <= MAX_BYTES or not header.endswith(b"\n"):
            raise AudioError("audio_invalid")
        raw = sys.stdin.buffer.read(size)
        if len(raw) != size:
            raise AudioError("audio_invalid")
        try:
            # Keep library progress/logging outside the private JSON response pipe.
            with contextlib.redirect_stdout(sys.stderr):
                response = transcribe(root, raw, session)
        except Exception as error:
            response = {"error": str(error) if isinstance(error, AudioError) else "audio_transcription_failed"}
        finally:
            raw = None
        print(json.dumps(response, ensure_ascii=False), file=protocol, flush=True)
        response = None


def main():
    action, directory = sys.argv[1:]
    root = Path(directory)
    root.mkdir(parents=True, exist_ok=True)
    if action == "status":
        return status(root)
    if action == "download":
        return download(root)
    if action == "transcribe":
        return transcribe(root)
    if action == "serve":
        serve(root)
        return
    raise ValueError("unknown action")


if __name__ == "__main__":
    try:
        if sys.argv[1] == "serve":
            main()
        else:
            with contextlib.redirect_stdout(sys.stderr):
                response = main()
            print(json.dumps(response, ensure_ascii=False))
    except Exception as error:
        print(json.dumps({"error": str(error) if isinstance(error, AudioError) else "audio_transcription_failed"}))
        sys.exit(1)
