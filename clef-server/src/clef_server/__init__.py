"""A minimal System One server for Clef.

Clef's weights ship `joint_schema_model.systemone`, which answers a System One
request body in-process. This wraps it in the HTTP route the eval speaks:
`POST /v1/systemone`. One model, one GPU, one forward pass at a time.

Environment:
  CLEF_MODEL_PATH  Hugging Face repo or local directory. Default Cloudflare/clef.
  CLEF_API_KEY     When set, requests must send `Authorization: Bearer <key>`.
  CLEF_HOST        Default 127.0.0.1.
  CLEF_PORT        Default 8800.
  CLEF_DEVICE      Default cuda.
"""

from __future__ import annotations

import os
import secrets
import sys
import threading
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import Body, FastAPI, Header, HTTPException


class Clef:
    """The loaded model, plus a lock: the GPU runs one request at a time."""

    def __init__(self, model_path: str, device: str) -> None:
        from huggingface_hub import snapshot_download

        path = Path(model_path) if Path(model_path).is_dir() else Path(snapshot_download(model_path))
        # The release's model code lives next to its weights.
        sys.path.insert(0, str(path))
        import joint_schema_model

        self._systemone = joint_schema_model.systemone
        self.model, self.processor = joint_schema_model.load_release_model(path, device=device)
        self.name = path.name if Path(model_path).is_dir() else model_path.split("/")[-1].lower()
        self._lock = threading.Lock()

    def answer(self, request: dict[str, Any]) -> dict[str, Any]:
        # `systemone` requires a model name; the eval may leave it out.
        request = {"model": self.name, **request}
        with self._lock:
            return self._systemone(self.model, self.processor, request)


def create_app(clef: Clef | None = None) -> FastAPI:
    state: dict[str, Clef] = {}

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        if clef is not None:
            state["clef"] = clef
        else:
            started = time.monotonic()
            print("Loading Clef: about 52 GB, downloaded on first use.", flush=True)
            state["clef"] = Clef(
                os.environ.get("CLEF_MODEL_PATH", "Cloudflare/clef"),
                os.environ.get("CLEF_DEVICE", "cuda"),
            )
            print(f"Loaded {state['clef'].name} in {time.monotonic() - started:.0f} s.", flush=True)
        yield

    app = FastAPI(title="clef-server", lifespan=lifespan)
    api_key = os.environ.get("CLEF_API_KEY") or None

    @app.get("/health")
    def health() -> dict[str, str]:
        return {"status": "ok", "model": state["clef"].name}

    # A sync route: FastAPI runs it on a worker thread, so a forward pass does
    # not block the event loop, and the lock in `Clef.answer` queues the rest.
    @app.post("/v1/systemone")
    def systemone(
        request: dict[str, Any] = Body(...),
        authorization: str | None = Header(default=None),
    ) -> dict[str, Any]:
        if api_key and not secrets.compare_digest(authorization or "", f"Bearer {api_key}"):
            raise HTTPException(status_code=401, detail="Missing or wrong API key.")
        if request.get("images") or request.get("videos"):
            raise HTTPException(status_code=400, detail="This server accepts text and JSON state only.")
        try:
            return state["clef"].answer(request)
        except ValueError as error:
            raise HTTPException(status_code=400, detail=str(error)) from error

    return app


def main() -> None:
    import uvicorn

    uvicorn.run(
        create_app(),
        host=os.environ.get("CLEF_HOST", "127.0.0.1"),
        port=int(os.environ.get("CLEF_PORT", "8800")),
    )
