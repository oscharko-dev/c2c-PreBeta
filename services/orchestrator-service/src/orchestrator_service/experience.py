"""Experience-Learning gateway for forwarding events and ledgers from UI-started runs.

Issue #96 requires that runs started through the UI flow into the
experience-learning-service so the Harness/Experience Learning System can
observe what happened. The orchestrator already emits step events to Harness
and persists the trajectory ledger; this module forwards those signals to the
experience-learning-service ingestion endpoints (`/v0/harness-events`,
`/v0/trajectory-ledgers`).

All forwarding is best-effort: an outage in experience-learning must never
break the orchestrator control plane. Failures are logged at debug level and
swallowed.
"""

from __future__ import annotations

import logging
from collections.abc import Mapping, Sequence

from .artifacts import JsonValue
from .client import JSONHTTPClient


# noinspection PyClassHasNoInitInspection
class NullExperienceLearningGateway:
    """No-op gateway used when experience-learning is not configured."""

    enabled: bool = False
    base_url: str = ""

    @staticmethod
    def post_harness_events(_events: Sequence[Mapping[str, JsonValue]]) -> None:
        return None

    @staticmethod
    def post_trajectory_ledger(_ledger: Mapping[str, JsonValue]) -> None:
        return None

    @staticmethod
    def get_run_summary(_run_id: str) -> Mapping[str, JsonValue] | None:
        return None

    @staticmethod
    def summary_uri(_run_id: str) -> str:
        return ""


class ExperienceLearningGateway:
    """HTTP client for the experience-learning-service ingestion + summary API.

    The gateway speaks the v0 contract documented in
    services/experience-learning-service/server.go:
      - POST /v0/harness-events: ingest one or more EventEnvelopeV0
      - POST /v0/trajectory-ledgers: ingest one or more AgentTrajectoryLedgerV0
      - GET  /v0/runs/{runId}/summary: read the cached RunLearningSummary
    """

    enabled: bool = True

    def __init__(self, base_url: str, http: JSONHTTPClient, *, headers: Mapping[str, str] | None = None):
        if not base_url:
            raise ValueError("experience-learning base URL is required")
        self.base_url = base_url.rstrip("/")
        self.http = http
        self.headers = dict(headers or {})
        self._logger = logging.getLogger(__name__)

    def post_harness_events(self, events: Sequence[Mapping[str, JsonValue]]) -> None:
        if not events:
            return
        payload = [dict(event) for event in events]
        try:
            self.http.post_json(
                f"{self.base_url}/v0/harness-events",
                payload,
                headers=self.headers,
            )
        except Exception as exc:  # pragma: no cover - best-effort path
            self._logger.debug(
                "experience-learning harness-events ingest failed: count=%d err=%s",
                len(payload),
                exc,
            )

    def post_trajectory_ledger(self, ledger: Mapping[str, JsonValue]) -> None:
        if not ledger:
            return
        try:
            self.http.post_json(
                f"{self.base_url}/v0/trajectory-ledgers",
                dict(ledger),
                headers=self.headers,
            )
        except Exception as exc:  # pragma: no cover - best-effort path
            self._logger.debug(
                "experience-learning trajectory ingest failed: runId=%s err=%s",
                ledger.get("runId"),
                exc,
            )

    def get_run_summary(self, run_id: str) -> Mapping[str, JsonValue] | None:
        if not run_id:
            return None
        try:
            response = self.http.get_json(
                f"{self.base_url}/v0/runs/{run_id}/summary",
                headers=self.headers,
            )
        except Exception as exc:  # pragma: no cover - best-effort path
            self._logger.debug(
                "experience-learning run-summary fetch failed: runId=%s err=%s",
                run_id,
                exc,
            )
            return None
        if response.status != 200:
            return None
        if not isinstance(response.payload, Mapping):
            return None
        return dict(response.payload)

    def summary_uri(self, run_id: str) -> str:
        if not run_id:
            return ""
        return f"{self.base_url}/v0/runs/{run_id}/summary"
