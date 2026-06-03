"""
SysML v2 API Services - FastAPI sidecar / public surface.

In the consolidated forge-devops task this sidecar IS the public SysML
endpoint: it listens on SYSML_API_PORT (9000, the port the manifest and
Cloud Map advertise) and proxies to the official SysML v2 Java backend
running internally on SYSML_JAVA_PORT (8003). It adds /health and /metrics
that the rest of FORGE already understands.
"""

from __future__ import annotations

import json
import logging
import os
import sys
import time
import uuid
from contextlib import asynccontextmanager
from typing import Any

import httpx
import psutil
import uvicorn
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import PlainTextResponse, Response
from pydantic import BaseModel, Field


class JSONFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        return json.dumps({
            "timestamp": self.formatTime(record),
            "level": record.levelname,
            "message": record.getMessage(),
            "container": "forge-devops/sysml",
            **({"exception": self.formatException(record.exc_info)} if record.exc_info else {}),
        })


handler = logging.StreamHandler(sys.stdout)
handler.setFormatter(JSONFormatter())
logging.basicConfig(level=logging.INFO, handlers=[handler])
logger = logging.getLogger("sysml-api")

START_TIME = time.time()
FORGE_TIMEOUT = int(os.getenv("FORGE_TIMEOUT", "300"))
VERSION = "2.1.0"
CONTAINER_NAME = "sysml"
# Public listen port for this sidecar (SYSML_API_PORT, default 9000).
PUBLIC_PORT = int(os.getenv("SYSML_API_PORT", "9000"))
# Internal Java backend port (SYSML_JAVA_PORT, default 8003).
BACKEND_PORT = int(os.getenv("SYSML_JAVA_PORT", "8003"))
BACKEND_URL = f"http://localhost:{BACKEND_PORT}"

_metrics: dict[str, float] = {
    "request_count": 0, "error_count": 0, "proxy_count": 0,
    "total_latency_seconds": 0.0, "queue_depth": 0,
}

_http_client: httpx.AsyncClient | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _http_client
    logger.info(json.dumps({"event": "startup", "container": CONTAINER_NAME,
                            "public_port": PUBLIC_PORT, "backend": BACKEND_URL}))
    _http_client = httpx.AsyncClient(
        base_url=BACKEND_URL,
        timeout=FORGE_TIMEOUT,
        limits=httpx.Limits(max_connections=10),
    )
    yield
    if _http_client:
        await _http_client.aclose()
    logger.info(json.dumps({"event": "shutdown"}))


app = FastAPI(
    title="SysML v2 API Services",
    description="SysML v2 REST API proxy with health and Prometheus metrics",
    version=VERSION,
    lifespan=lifespan,
)


class SysMLRunRequest(BaseModel):
    endpoint: str = Field(default="/projects", description="Backend SysML v2 API endpoint path")
    method: str = Field(default="GET", description="HTTP method")
    payload: dict[str, Any] | None = Field(default=None)
    run_id: str | None = None


class RunResponse(BaseModel):
    result: dict[str, Any]
    duration_ms: float
    run_id: str


async def _backend_available() -> bool:
    try:
        resp = await _http_client.get("/", timeout=5.0)
        return resp.status_code < 500
    except Exception:
        return False


@app.get("/health")
async def health():
    _metrics["request_count"] += 1
    backend_ok = await _backend_available()
    return {
        "status": "ok" if backend_ok else "degraded",
        "container": CONTAINER_NAME,
        "uptime_seconds": round(time.time() - START_TIME, 2),
        "version": VERSION,
        "backend_available": backend_ok,
        "backend_url": BACKEND_URL,
    }


@app.get("/metrics", response_class=PlainTextResponse)
async def metrics():
    _metrics["request_count"] += 1
    uptime = time.time() - START_TIME
    avg_lat = (
        _metrics["total_latency_seconds"] / _metrics["proxy_count"]
        if _metrics["proxy_count"] > 0 else 0.0
    )
    mem = psutil.virtual_memory()
    lines = [
        f'forge_request_count{{container="{CONTAINER_NAME}"}} {_metrics["request_count"]:.0f}',
        f'forge_latency_seconds{{container="{CONTAINER_NAME}"}} {avg_lat:.6f}',
        f'forge_error_count{{container="{CONTAINER_NAME}"}} {_metrics["error_count"]:.0f}',
        f'forge_queue_depth{{container="{CONTAINER_NAME}"}} {_metrics["queue_depth"]:.0f}',
        f'forge_uptime_seconds{{container="{CONTAINER_NAME}"}} {uptime:.2f}',
        f'forge_memory_bytes_used{{container="{CONTAINER_NAME}"}} {mem.used}',
        f'forge_proxy_count{{container="{CONTAINER_NAME}"}} {_metrics["proxy_count"]:.0f}',
    ]
    return "\n".join(lines) + "\n"


@app.post("/run", response_model=RunResponse)
async def run(request: SysMLRunRequest):
    """Route a call to the SysML v2 Java backend."""
    _metrics["request_count"] += 1
    _metrics["queue_depth"] += 1
    run_id = request.run_id or str(uuid.uuid4())
    t0 = time.time()

    logger.info(json.dumps({"event": "run_start", "run_id": run_id, "endpoint": request.endpoint}))

    try:
        method = request.method.upper()
        try:
            if method == "GET":
                resp = await _http_client.get(request.endpoint, timeout=FORGE_TIMEOUT)
            elif method == "POST":
                resp = await _http_client.post(request.endpoint, json=request.payload, timeout=FORGE_TIMEOUT)
            elif method == "PUT":
                resp = await _http_client.put(request.endpoint, json=request.payload, timeout=FORGE_TIMEOUT)
            elif method == "DELETE":
                resp = await _http_client.delete(request.endpoint, timeout=FORGE_TIMEOUT)
            else:
                raise HTTPException(status_code=422, detail=f"Unsupported method: {method}")

            try:
                result_body = resp.json()
            except Exception:
                result_body = {"raw": resp.text}

            duration_ms = (time.time() - t0) * 1000
            _metrics["proxy_count"] += 1
            _metrics["total_latency_seconds"] += duration_ms / 1000

            logger.info(json.dumps({"event": "run_complete", "run_id": run_id, "status": resp.status_code}))
            return RunResponse(
                result={"status_code": resp.status_code, "body": result_body},
                duration_ms=round(duration_ms, 2),
                run_id=run_id,
            )

        except httpx.TimeoutException:
            raise HTTPException(status_code=504, detail=f"Backend timed out after {FORGE_TIMEOUT}s")
        except httpx.ConnectError:
            raise HTTPException(
                status_code=503,
                detail="SysML v2 Java backend is not available. Check backend status.",
            )

    except HTTPException:
        raise
    except Exception as exc:
        _metrics["error_count"] += 1
        logger.exception(json.dumps({"event": "run_error", "run_id": run_id, "error": str(exc)}))
        raise HTTPException(status_code=500, detail=str(exc))
    finally:
        _metrics["queue_depth"] = max(0, _metrics["queue_depth"] - 1)


@app.api_route("/api/{path:path}", methods=["GET", "POST", "PUT", "DELETE", "PATCH"])
async def proxy(path: str, request: Request):
    """Transparent proxy to the SysML v2 Java backend."""
    _metrics["request_count"] += 1
    t0 = time.time()
    try:
        body = await request.body()
        resp = await _http_client.request(
            method=request.method,
            url=f"/{path}",
            headers={k: v for k, v in request.headers.items() if k.lower() != "host"},
            content=body,
            timeout=FORGE_TIMEOUT,
        )
        _metrics["proxy_count"] += 1
        _metrics["total_latency_seconds"] += (time.time() - t0)
        return Response(content=resp.content, status_code=resp.status_code, headers=dict(resp.headers))
    except httpx.ConnectError:
        raise HTTPException(status_code=503, detail="SysML v2 backend unavailable")
    except Exception as exc:
        _metrics["error_count"] += 1
        raise HTTPException(status_code=500, detail=str(exc))


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=PUBLIC_PORT)
