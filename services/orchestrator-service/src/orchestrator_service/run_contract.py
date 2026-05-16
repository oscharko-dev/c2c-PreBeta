"""W0.2 Orchestrator run contract: state machine, failure codes, and run shape.

Issue #166 defines the workflow contract that the Orchestrator owns and exposes
to its consumers (BFF, UI, agents, evidence-service). This module is the single
source of truth for:

* Allowed W0.2 workflow states and their order.
* Allowed transitions between those states (the state machine).
* The closed set of failure codes a non-success run can surface.
* The closed set of final classifications a finished run can carry.
* The JSON-serialisable run-contract shape.

The contract is deliberately decoupled from the deterministic W0 step pipeline
that ``workflow.py`` drives today. ``workflow.py`` advances this state machine
at each major boundary; later W0.2 issues plug actual transformation and
verification/repair agents into the same boundaries without changing this
contract.

The Harness consumes state-change events emitted by the Orchestrator (see
``workflow.py``) but does not decide the next workflow step. That responsibility
remains with the Orchestrator.
"""

from __future__ import annotations

import datetime
import threading
from dataclasses import dataclass, field
from typing import Any, Dict, List, Mapping, Optional, Tuple


SCHEMA_VERSION = "v0"


def _iso_now() -> str:
    return datetime.datetime.now(tz=datetime.timezone.utc).isoformat().replace("+00:00", "Z")


# ---------------------------------------------------------------------------
# States
# ---------------------------------------------------------------------------

# The twelve W0.2 workflow states defined by Issue #166.
STATE_RUN_ACCEPTED = "run_accepted"
STATE_SOURCE_NORMALIZED = "source_normalized"
STATE_COBOL_PARSE_ATTEMPTED = "cobol_parse_attempted"
STATE_SEMANTIC_IR_READY = "semantic_ir_ready"
STATE_SEMANTIC_IR_BLOCKED = "semantic_ir_blocked"
STATE_BASELINE_GENERATION_ATTEMPTED = "baseline_generation_attempted"
STATE_TRANSFORMATION_AGENT_INVOKED = "transformation_agent_invoked"
STATE_JAVA_CANDIDATE_PERSISTED = "java_candidate_persisted"
STATE_BUILD_TEST_RUNNING = "build_test_running"
STATE_VERIFICATION_REPAIR_INVOKED = "verification_repair_invoked"
STATE_FINAL_JAVA_SELECTED = "final_java_selected"
STATE_RUN_BLOCKED = "run_blocked"
STATE_EVIDENCE_MATERIALIZED = "evidence_materialized"
STATE_EVIDENCE_INCOMPLETE = "evidence_incomplete"
STATE_FINAL_CLASSIFICATION = "final_classification"

WORKFLOW_STATES: Tuple[str, ...] = (
    STATE_RUN_ACCEPTED,
    STATE_SOURCE_NORMALIZED,
    STATE_COBOL_PARSE_ATTEMPTED,
    STATE_SEMANTIC_IR_READY,
    STATE_SEMANTIC_IR_BLOCKED,
    STATE_BASELINE_GENERATION_ATTEMPTED,
    STATE_TRANSFORMATION_AGENT_INVOKED,
    STATE_JAVA_CANDIDATE_PERSISTED,
    STATE_BUILD_TEST_RUNNING,
    STATE_VERIFICATION_REPAIR_INVOKED,
    STATE_FINAL_JAVA_SELECTED,
    STATE_RUN_BLOCKED,
    STATE_EVIDENCE_MATERIALIZED,
    STATE_EVIDENCE_INCOMPLETE,
    STATE_FINAL_CLASSIFICATION,
)

# Transitions allowed from each state. Any transition that is not listed here
# is rejected by ``WorkflowStateMachine`` with ``IllegalTransitionError``.
# ``STATE_FINAL_CLASSIFICATION`` is terminal.
_ALLOWED_TRANSITIONS: Dict[str, Tuple[str, ...]] = {
    STATE_RUN_ACCEPTED: (
        STATE_SOURCE_NORMALIZED,
        STATE_RUN_BLOCKED,
    ),
    STATE_SOURCE_NORMALIZED: (
        STATE_COBOL_PARSE_ATTEMPTED,
        STATE_RUN_BLOCKED,
    ),
    STATE_COBOL_PARSE_ATTEMPTED: (
        STATE_SEMANTIC_IR_READY,
        STATE_SEMANTIC_IR_BLOCKED,
        STATE_RUN_BLOCKED,
    ),
    STATE_SEMANTIC_IR_READY: (
        STATE_BASELINE_GENERATION_ATTEMPTED,
        STATE_TRANSFORMATION_AGENT_INVOKED,
        STATE_RUN_BLOCKED,
    ),
    STATE_SEMANTIC_IR_BLOCKED: (
        STATE_RUN_BLOCKED,
        STATE_EVIDENCE_INCOMPLETE,
    ),
    STATE_BASELINE_GENERATION_ATTEMPTED: (
        STATE_TRANSFORMATION_AGENT_INVOKED,
        STATE_JAVA_CANDIDATE_PERSISTED,
        STATE_RUN_BLOCKED,
    ),
    STATE_TRANSFORMATION_AGENT_INVOKED: (
        STATE_JAVA_CANDIDATE_PERSISTED,
        STATE_RUN_BLOCKED,
    ),
    STATE_JAVA_CANDIDATE_PERSISTED: (
        STATE_BUILD_TEST_RUNNING,
        STATE_RUN_BLOCKED,
    ),
    STATE_BUILD_TEST_RUNNING: (
        STATE_FINAL_JAVA_SELECTED,
        STATE_VERIFICATION_REPAIR_INVOKED,
        STATE_RUN_BLOCKED,
    ),
    STATE_VERIFICATION_REPAIR_INVOKED: (
        STATE_TRANSFORMATION_AGENT_INVOKED,
        STATE_JAVA_CANDIDATE_PERSISTED,
        STATE_BUILD_TEST_RUNNING,
        STATE_FINAL_JAVA_SELECTED,
        STATE_RUN_BLOCKED,
    ),
    STATE_FINAL_JAVA_SELECTED: (
        STATE_EVIDENCE_MATERIALIZED,
        STATE_EVIDENCE_INCOMPLETE,
    ),
    STATE_RUN_BLOCKED: (
        STATE_EVIDENCE_INCOMPLETE,
        STATE_EVIDENCE_MATERIALIZED,
        STATE_FINAL_CLASSIFICATION,
    ),
    STATE_EVIDENCE_MATERIALIZED: (
        STATE_FINAL_CLASSIFICATION,
    ),
    STATE_EVIDENCE_INCOMPLETE: (
        STATE_FINAL_CLASSIFICATION,
    ),
    STATE_FINAL_CLASSIFICATION: (),
}

# Steps that consumers map to user-visible "active step" labels. These are the
# names ``workflow.py`` already emits in its progress log.
STEP_ACCEPTED = "accepted"
STEP_NORMALIZE_SOURCE = "normalize-source"
STEP_PARSE_COBOL = "parse-cobol"
STEP_GENERATE_IR = "generate-ir"
STEP_GENERATE_JAVA = "generate-java"
STEP_TRANSFORMATION_AGENT = "transformation-agent"
STEP_COMPILE_TEST_JAVA = "compile-test-java"
STEP_VERIFICATION_REPAIR_AGENT = "verification-repair-agent"
STEP_WRITE_EVIDENCE = "write-evidence"
STEP_FINALIZE = "finalize"


# ---------------------------------------------------------------------------
# Failure codes
# ---------------------------------------------------------------------------

FAILURE_UNSUPPORTED_COBOL = "unsupported_cobol"
FAILURE_PARSE_FAILED = "parse_failed"
FAILURE_SEMANTIC_IR_FAILED = "semantic_ir_failed"
FAILURE_MODEL_GATEWAY_UNAVAILABLE = "model_gateway_unavailable"
FAILURE_MODEL_POLICY_DENIED = "model_policy_denied"
FAILURE_AGENT_TIMEOUT = "agent_timeout"
FAILURE_JAVA_GENERATION_FAILED = "java_generation_failed"
FAILURE_JAVA_COMPILE_FAILED = "java_compile_failed"
FAILURE_JAVA_RUNTIME_FAILED = "java_runtime_failed"
FAILURE_ORACLE_MISMATCH = "oracle_mismatch"
FAILURE_EVIDENCE_INCOMPLETE = "evidence_incomplete"
FAILURE_CANCELLED = "cancelled"

FAILURE_CODES: Tuple[str, ...] = (
    FAILURE_UNSUPPORTED_COBOL,
    FAILURE_PARSE_FAILED,
    FAILURE_SEMANTIC_IR_FAILED,
    FAILURE_MODEL_GATEWAY_UNAVAILABLE,
    FAILURE_MODEL_POLICY_DENIED,
    FAILURE_AGENT_TIMEOUT,
    FAILURE_JAVA_GENERATION_FAILED,
    FAILURE_JAVA_COMPILE_FAILED,
    FAILURE_JAVA_RUNTIME_FAILED,
    FAILURE_ORACLE_MISMATCH,
    FAILURE_EVIDENCE_INCOMPLETE,
    FAILURE_CANCELLED,
)


# ---------------------------------------------------------------------------
# Final classifications
# ---------------------------------------------------------------------------

CLASSIFICATION_SUCCESS = "success"
CLASSIFICATION_BLOCKED = "blocked"
CLASSIFICATION_FAILED = "failed"
CLASSIFICATION_CANCELLED = "cancelled"
CLASSIFICATION_INCOMPLETE = "incomplete"

FINAL_CLASSIFICATIONS: Tuple[str, ...] = (
    CLASSIFICATION_SUCCESS,
    CLASSIFICATION_BLOCKED,
    CLASSIFICATION_FAILED,
    CLASSIFICATION_CANCELLED,
    CLASSIFICATION_INCOMPLETE,
)


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------


class WorkflowContractError(Exception):
    """Base class for run-contract errors."""


class IllegalTransitionError(WorkflowContractError):
    """Raised when a caller attempts a transition that the contract forbids."""


class RepairBudgetExhaustedError(WorkflowContractError):
    """Raised when the repair loop exceeds the configured iteration limit."""


# ---------------------------------------------------------------------------
# Repair budget
# ---------------------------------------------------------------------------

# Hard W0.2 bounds taken from Issue #166's "iteration limit … 1 to 3"
# constraint. The default is two attempts.
REPAIR_BUDGET_MIN = 1
REPAIR_BUDGET_MAX = 3
DEFAULT_REPAIR_BUDGET = 2


def clamp_repair_budget(value: int) -> int:
    """Clamp a repair-budget value to the W0.2-allowed range [1, 3]."""
    if value < REPAIR_BUDGET_MIN:
        return REPAIR_BUDGET_MIN
    if value > REPAIR_BUDGET_MAX:
        return REPAIR_BUDGET_MAX
    return value


@dataclass
class RepairBudget:
    """Tracks repair attempts against a bounded W0.2 iteration limit."""

    limit: int
    used: int = 0

    def __post_init__(self) -> None:
        if self.limit < REPAIR_BUDGET_MIN or self.limit > REPAIR_BUDGET_MAX:
            raise ValueError(
                f"repair budget must be within [{REPAIR_BUDGET_MIN}, {REPAIR_BUDGET_MAX}], got {self.limit}"
            )
        if self.used < 0:
            raise ValueError("repair budget used must be non-negative")

    @property
    def remaining(self) -> int:
        return max(0, self.limit - self.used)

    @property
    def exhausted(self) -> bool:
        return self.used >= self.limit

    def consume(self) -> int:
        """Consume one repair attempt and return the new ``used`` counter.

        Raises ``RepairBudgetExhaustedError`` if no budget remains.
        """
        if self.exhausted:
            raise RepairBudgetExhaustedError(
                f"repair budget exhausted (limit={self.limit}, used={self.used})"
            )
        self.used += 1
        return self.used

    def to_dict(self) -> Dict[str, int]:
        return {
            "limit": self.limit,
            "used": self.used,
            "remaining": self.remaining,
        }


# ---------------------------------------------------------------------------
# State transitions
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class StateTransition:
    """One entry in the run state history."""

    state: str
    at: str
    message: str = ""
    failure_code: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        payload: Dict[str, Any] = {
            "state": self.state,
            "at": self.at,
        }
        if self.message:
            payload["message"] = self.message
        if self.failure_code:
            payload["failureCode"] = self.failure_code
        return payload


# ---------------------------------------------------------------------------
# State machine
# ---------------------------------------------------------------------------


class WorkflowStateMachine:
    """Enforces the allowed W0.2 state transitions for a single run.

    Thread-safe: ``workflow.py`` may advance the machine from the runner thread
    while consumers serialise a snapshot via :meth:`to_dict`.
    """

    def __init__(self, *, initial_state: str = STATE_RUN_ACCEPTED, now: Optional[str] = None):
        if initial_state not in WORKFLOW_STATES:
            raise WorkflowContractError(f"unknown state: {initial_state}")
        self._lock = threading.Lock()
        self._current: str = initial_state
        self._history: List[StateTransition] = [
            StateTransition(state=initial_state, at=now or _iso_now(), message="run accepted")
        ]

    @property
    def current(self) -> str:
        with self._lock:
            return self._current

    def history(self) -> List[StateTransition]:
        with self._lock:
            return list(self._history)

    def advance(
        self,
        target: str,
        *,
        message: str = "",
        failure_code: Optional[str] = None,
        now: Optional[str] = None,
    ) -> StateTransition:
        """Advance to ``target`` if the transition is allowed.

        Raises ``IllegalTransitionError`` if the transition is not in the
        contract. Raises ``WorkflowContractError`` for unknown states or
        unknown failure codes.
        """
        if target not in WORKFLOW_STATES:
            raise WorkflowContractError(f"unknown state: {target}")
        if failure_code is not None and failure_code not in FAILURE_CODES:
            raise WorkflowContractError(f"unknown failure code: {failure_code}")

        with self._lock:
            allowed = _ALLOWED_TRANSITIONS.get(self._current, ())
            if target not in allowed:
                raise IllegalTransitionError(
                    f"cannot transition from {self._current!r} to {target!r}; "
                    f"allowed targets: {sorted(allowed)}"
                )
            transition = StateTransition(
                state=target,
                at=now or _iso_now(),
                message=message,
                failure_code=failure_code,
            )
            self._current = target
            self._history.append(transition)
            return transition

    def allowed_next(self) -> Tuple[str, ...]:
        with self._lock:
            return _ALLOWED_TRANSITIONS.get(self._current, ())


# ---------------------------------------------------------------------------
# Run contract
# ---------------------------------------------------------------------------


@dataclass
class W02RunContract:
    """Serialisable run contract exposed to BFF/UI/agent/evidence consumers.

    The contract is updated in place by :class:`WorkflowStateMachine` and the
    runner. Consumers receive a snapshot via :meth:`to_dict`.
    """

    run_id: str
    workflow_id: str
    requester: str
    source_ref: Dict[str, Any]
    state_machine: WorkflowStateMachine
    repair_budget: RepairBudget
    active_step: Optional[str] = None
    agent_attempt_count: int = 0
    generated_java_ref: Optional[Dict[str, Any]] = None
    build_test_result_ref: Optional[Dict[str, Any]] = None
    evidence_pack_ref: Optional[Dict[str, Any]] = None
    final_classification: Optional[str] = None
    failure_code: Optional[str] = None
    failure_message: Optional[str] = None
    created_at: str = field(default_factory=_iso_now)
    updated_at: str = field(default_factory=_iso_now)

    def __post_init__(self) -> None:
        if not self.run_id:
            raise ValueError("run_id is required")
        if not self.workflow_id:
            raise ValueError("workflow_id is required")
        if self.final_classification is not None and self.final_classification not in FINAL_CLASSIFICATIONS:
            raise ValueError(f"unknown final classification: {self.final_classification}")

    def touch(self, now: Optional[str] = None) -> None:
        self.updated_at = now or _iso_now()

    def set_active_step(self, step: Optional[str]) -> None:
        self.active_step = step
        self.touch()

    def record_agent_attempt(self) -> int:
        self.agent_attempt_count += 1
        self.touch()
        return self.agent_attempt_count

    def set_generated_java_ref(self, ref: Optional[Mapping[str, Any]]) -> None:
        self.generated_java_ref = dict(ref) if ref else None
        self.touch()

    def set_build_test_result_ref(self, ref: Optional[Mapping[str, Any]]) -> None:
        self.build_test_result_ref = dict(ref) if ref else None
        self.touch()

    def set_evidence_pack_ref(self, ref: Optional[Mapping[str, Any]]) -> None:
        self.evidence_pack_ref = dict(ref) if ref else None
        self.touch()

    def finalize(
        self,
        classification: str,
        *,
        failure_code: Optional[str] = None,
        failure_message: Optional[str] = None,
    ) -> None:
        if classification not in FINAL_CLASSIFICATIONS:
            raise ValueError(f"unknown final classification: {classification}")
        if classification != CLASSIFICATION_SUCCESS and failure_code is None:
            # Non-success runs must carry an explicit failure code so consumers
            # can render and audit the reason.
            raise ValueError("non-success classifications require a failure_code")
        if failure_code is not None and failure_code not in FAILURE_CODES:
            raise ValueError(f"unknown failure code: {failure_code}")
        self.final_classification = classification
        self.failure_code = failure_code
        self.failure_message = failure_message
        # ``finalize`` only records the classification; the caller is
        # responsible for driving the state machine into
        # ``STATE_FINAL_CLASSIFICATION`` so the history reflects the
        # workflow ordering.
        self.state_machine.advance(
            STATE_FINAL_CLASSIFICATION,
            message=failure_message or f"run finalised as {classification}",
            failure_code=failure_code,
        )
        self.active_step = None
        self.touch()

    def to_dict(self) -> Dict[str, Any]:
        payload: Dict[str, Any] = {
            "schemaVersion": SCHEMA_VERSION,
            "runId": self.run_id,
            "workflowId": self.workflow_id,
            "requester": self.requester,
            "sourceRef": dict(self.source_ref),
            "currentState": self.state_machine.current,
            "stateHistory": [transition.to_dict() for transition in self.state_machine.history()],
            "activeStep": self.active_step,
            "agentAttemptCount": self.agent_attempt_count,
            "repairBudget": self.repair_budget.to_dict(),
            "generatedJavaRef": dict(self.generated_java_ref) if self.generated_java_ref else None,
            "buildTestResultRef": dict(self.build_test_result_ref) if self.build_test_result_ref else None,
            "evidencePackRef": dict(self.evidence_pack_ref) if self.evidence_pack_ref else None,
            "finalClassification": self.final_classification,
            "failureCode": self.failure_code,
            "failureMessage": self.failure_message,
            "createdAt": self.created_at,
            "updatedAt": self.updated_at,
        }
        return payload


def new_run_contract(
    *,
    run_id: str,
    workflow_id: str,
    requester: str,
    source_ref: Mapping[str, Any],
    repair_budget_limit: int = DEFAULT_REPAIR_BUDGET,
    now: Optional[str] = None,
) -> W02RunContract:
    """Construct a fresh W0.2 run contract in the ``run_accepted`` state."""
    timestamp = now or _iso_now()
    contract = W02RunContract(
        run_id=run_id,
        workflow_id=workflow_id,
        requester=requester,
        source_ref=dict(source_ref),
        state_machine=WorkflowStateMachine(initial_state=STATE_RUN_ACCEPTED, now=timestamp),
        repair_budget=RepairBudget(limit=clamp_repair_budget(repair_budget_limit)),
        active_step=STEP_ACCEPTED,
        created_at=timestamp,
        updated_at=timestamp,
    )
    return contract


# Mapping from common step-failure markers (the substrings reported by
# ``workflow.py`` exception text) to canonical W0.2 failure codes. Used by
# the runner to label run failures consistently.
STEP_TO_FAILURE_CODE: Dict[str, str] = {
    STEP_PARSE_COBOL: FAILURE_PARSE_FAILED,
    STEP_GENERATE_IR: FAILURE_SEMANTIC_IR_FAILED,
    STEP_GENERATE_JAVA: FAILURE_JAVA_GENERATION_FAILED,
    STEP_COMPILE_TEST_JAVA: FAILURE_JAVA_COMPILE_FAILED,
    STEP_WRITE_EVIDENCE: FAILURE_EVIDENCE_INCOMPLETE,
    STEP_TRANSFORMATION_AGENT: FAILURE_JAVA_GENERATION_FAILED,
    STEP_VERIFICATION_REPAIR_AGENT: FAILURE_AGENT_TIMEOUT,
}


# Build-test payload statuses that the W0.2 contract treats as "Java passed
# deterministic verification". Anything else triggers the repair loop.
BUILD_TEST_SUCCESS_STATUSES = frozenset({"ok", "passed", "success", "complete", "verified"})

# Build-test payload failure reasons mapped to canonical failure codes. The
# runner uses this map to pick the failure code attached to a blocked run
# when the build-test runner returns a structured reason.
BUILD_TEST_FAILURE_REASONS: Dict[str, str] = {
    "compile_failed": FAILURE_JAVA_COMPILE_FAILED,
    "compile-failed": FAILURE_JAVA_COMPILE_FAILED,
    "compile_error": FAILURE_JAVA_COMPILE_FAILED,
    "java_compile_failed": FAILURE_JAVA_COMPILE_FAILED,
    "runtime_failed": FAILURE_JAVA_RUNTIME_FAILED,
    "runtime-failed": FAILURE_JAVA_RUNTIME_FAILED,
    "runtime_error": FAILURE_JAVA_RUNTIME_FAILED,
    "java_runtime_failed": FAILURE_JAVA_RUNTIME_FAILED,
    "oracle_mismatch": FAILURE_ORACLE_MISMATCH,
    "oracle-mismatch": FAILURE_ORACLE_MISMATCH,
    "equivalence_mismatch": FAILURE_ORACLE_MISMATCH,
    "behaviour_mismatch": FAILURE_ORACLE_MISMATCH,
}


def build_test_outcome(payload: Mapping[str, Any]) -> Tuple[bool, Optional[str]]:
    """Classify a build-test runner payload.

    Returns ``(success, failure_code_or_none)``. The orchestrator uses this to
    decide whether to enter the verification/repair state.
    """
    status = str(payload.get("status") or "").strip().lower()
    if status in BUILD_TEST_SUCCESS_STATUSES:
        return True, None
    reason = str(payload.get("reason") or payload.get("failureReason") or "").strip().lower()
    failure_code = BUILD_TEST_FAILURE_REASONS.get(reason)
    if failure_code is None:
        # Distinguish compile vs runtime vs oracle when the payload exposes
        # discrete sub-results, otherwise fall back to compile_failed which is
        # the earliest deterministic gate.
        if payload.get("oracleMismatch") or payload.get("oracleResult") == "mismatch":
            failure_code = FAILURE_ORACLE_MISMATCH
        elif payload.get("runtime") == "failed" or payload.get("runtimeStatus") == "failed":
            failure_code = FAILURE_JAVA_RUNTIME_FAILED
        else:
            failure_code = FAILURE_JAVA_COMPILE_FAILED
    return False, failure_code
