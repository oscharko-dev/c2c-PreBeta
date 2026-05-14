"""HTTP client helpers for orchestrator service dependencies."""

from __future__ import annotations

import json
import urllib.error
from dataclasses import dataclass
from typing import Any, Dict, Mapping, Optional
from urllib.request import Request, urlopen


class HttpClientError(Exception):
    """Raised when an HTTP interaction fails."""


# noinspection PyClassHasNoInitInspection
@dataclass
class HttpResponse:
    status: int
    payload: Any


class JSONHTTPClient:
    def __init__(self, timeout_seconds: int = 5, default_headers: Optional[Mapping[str, str]] = None) -> None:
        self.timeout_seconds = timeout_seconds
        self.default_headers = dict(default_headers or {})

    def post_json(self, url: str, payload: Mapping[str, Any], headers: Optional[Mapping[str, str]] = None) -> HttpResponse:
        raw = json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8")
        request = Request(
            url=url,
            data=raw,
            headers=self._headers({"Content-Type": "application/json"}, headers),
            method="POST",
        )
        return self._send(request)

    def patch_json(self, url: str, payload: Mapping[str, Any], headers: Optional[Mapping[str, str]] = None) -> HttpResponse:
        raw = json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8")
        request = Request(
            url=url,
            data=raw,
            headers=self._headers({"Content-Type": "application/json"}, headers),
            method="PATCH",
        )
        return self._send(request)

    def get_json(self, url: str, headers: Optional[Mapping[str, str]] = None) -> HttpResponse:
        request = Request(url=url, headers=self._headers({}, headers), method="GET")
        return self._send(request)

    def _headers(self, headers: Mapping[str, str], extra_headers: Optional[Mapping[str, str]] = None) -> Dict[str, str]:
        merged = dict(self.default_headers)
        merged.update(headers)
        merged.update(extra_headers or {})
        return merged

    def _send(self, request: Request) -> HttpResponse:
        try:
            with urlopen(request, timeout=self.timeout_seconds) as response:
                body = response.read()
                payload: Any = None
                if body:
                    payload = json.loads(body.decode("utf-8"))
                return HttpResponse(response.status, payload)
        except urllib.error.HTTPError as exc:
            body = exc.read().decode("utf-8", errors="replace") if exc.fp is not None else ""
            details = body[:200]
            raise HttpClientError(f"{request.get_method()} {request.full_url} failed with {exc.code}: {details}") from exc
        except urllib.error.URLError as exc:
            raise HttpClientError(f"{request.get_method()} {request.full_url} failed: {exc}") from exc
