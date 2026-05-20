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
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field

from .artifacts import JsonObject, JsonValue


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

WORKFLOW_STATES: tuple[str, ...] = (
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
_ALLOWED_TRANSITIONS: dict[str, tuple[str, ...]] = {
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
STEP_ASSIST_DECISION = "assist-decision"
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
# Issue #167: invalid agent I/O — missing/oversized/malformed payload, missing
# model invocation reference, missing generated Java artifact reference, or
# unapproved artifact references.
FAILURE_AGENT_CONTRACT_INVALID = "agent_contract_invalid"
# Issue #255 / Studio-IDE-13: sentinel applied to a run that finished its
# generator-only pipeline by request (``runMode == "generate"``).  The
# classification is ``incomplete`` because verification was not requested,
# not because anything failed — UI consumers render this as a successful
# generator outcome rather than as an error per W02_UI_ERROR_CODES.
FAILURE_GENERATE_ONLY_COMPLETE = "generate_only_complete"

FAILURE_CODES: tuple[str, ...] = (
    FAILURE_UNSUPPORTED_COBOL,
    FAILURE_PARSE_FAILED,
    FAILURE_SEMANTIC_IR_FAILED,
    FAILURE_MODEL_GATEWAY_UNAVAILABLE,
    FAILURE_MODEL_POLICY_DENIED,
    FAILURE_AGENT_TIMEOUT,
    FAILURE_AGENT_CONTRACT_INVALID,
    FAILURE_JAVA_GENERATION_FAILED,
    FAILURE_JAVA_COMPILE_FAILED,
    FAILURE_JAVA_RUNTIME_FAILED,
    FAILURE_ORACLE_MISMATCH,
    FAILURE_EVIDENCE_INCOMPLETE,
    FAILURE_CANCELLED,
    FAILURE_GENERATE_ONLY_COMPLETE,
)


# ---------------------------------------------------------------------------
# Final classifications
# ---------------------------------------------------------------------------

CLASSIFICATION_SUCCESS = "success"
CLASSIFICATION_BLOCKED = "blocked"
CLASSIFICATION_FAILED = "failed"
CLASSIFICATION_CANCELLED = "cancelled"
CLASSIFICATION_INCOMPLETE = "incomplete"

FINAL_CLASSIFICATIONS: tuple[str, ...] = (
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


class AssistBudgetExhaustedError(WorkflowContractError):
    """Raised when the assist-decision gate has no productive-assist budget left.

    Issue #216 (W0.3-5): assist activations are budgeted per run alongside
    the existing repair-iteration budget. Exhaustion forces the gate to
    decide ``assist_not_required`` with reason ``assist_budget_exhausted``
    rather than silently proceeding with a productive AI activation.
    """


class ModelInvocationBudgetExhaustedError(WorkflowContractError):
    """Raised when a productive agent step would exceed the Model Gateway budget.

    Issue #216 (W0.3-5): every productive call routed through the Model
    Gateway consumes one unit of this run-scoped budget. Exhaustion blocks
    further productive agent invocations with a hard termination semantics
    — there is no hidden retry once the budget is gone.
    """


# ---------------------------------------------------------------------------
# Repair budget
# ---------------------------------------------------------------------------

# Enterprise default: AI-assisted paths are unbounded unless an operator
# explicitly configures a finite ceiling. We keep a large integer sentinel in
# the contract so existing {limit, used, remaining} payloads remain numeric.
UNLIMITED_AI_BUDGET = 2_147_483_647

# Repair attempts still accept explicit finite limits, but the default posture
# is unrestricted.
REPAIR_BUDGET_MIN = 1
REPAIR_BUDGET_MAX = UNLIMITED_AI_BUDGET
DEFAULT_REPAIR_BUDGET = UNLIMITED_AI_BUDGET


def clamp_repair_budget(value: int) -> int:
    """Clamp a repair-budget value to the supported positive-integer range."""
    if value < REPAIR_BUDGET_MIN:
        return REPAIR_BUDGET_MIN
    if value > REPAIR_BUDGET_MAX:
        return REPAIR_BUDGET_MAX
    return value


# noinspection PyClassHasNoInitInspection
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

    def to_dict(self) -> dict[str, int]:
        return {
            "limit": self.limit,
            "used": self.used,
            "remaining": self.remaining,
        }


# ---------------------------------------------------------------------------
# Assist budget (Issue #216 / W0.3-5)
# ---------------------------------------------------------------------------

# Productive AI assist activations accept explicit finite limits, but the
# default enterprise posture is unrestricted.
ASSIST_BUDGET_MIN = 1
ASSIST_BUDGET_MAX = UNLIMITED_AI_BUDGET
DEFAULT_ASSIST_BUDGET = UNLIMITED_AI_BUDGET


def clamp_assist_budget(value: int) -> int:
    """Clamp an assist-budget value to the supported positive-integer range."""
    if value < ASSIST_BUDGET_MIN:
        return ASSIST_BUDGET_MIN
    if value > ASSIST_BUDGET_MAX:
        return ASSIST_BUDGET_MAX
    return value


# noinspection PyClassHasNoInitInspection
@dataclass
class AssistBudget:
    """Tracks productive-assist activations against a bounded per-run limit.

    Issue #216 (W0.3-5): every productive AI activation decided by the
    assist-decision gate (Issue #214) consumes one unit. When exhausted,
    the gate must degrade to ``assist_not_required`` with reason
    ``assist_budget_exhausted`` so the deterministic baseline becomes the
    final candidate — there is no hidden continuation.
    """

    limit: int
    used: int = 0

    def __post_init__(self) -> None:
        if self.limit < ASSIST_BUDGET_MIN or self.limit > ASSIST_BUDGET_MAX:
            raise ValueError(
                f"assist budget must be within [{ASSIST_BUDGET_MIN}, {ASSIST_BUDGET_MAX}], got {self.limit}"
            )
        if self.used < 0:
            raise ValueError("assist budget used must be non-negative")

    @property
    def remaining(self) -> int:
        return max(0, self.limit - self.used)

    @property
    def exhausted(self) -> bool:
        return self.used >= self.limit

    def consume(self) -> int:
        """Consume one assist activation and return the new ``used`` counter.

        Raises ``AssistBudgetExhaustedError`` if no budget remains.
        """
        if self.exhausted:
            raise AssistBudgetExhaustedError(
                f"assist budget exhausted (limit={self.limit}, used={self.used})"
            )
        self.used += 1
        return self.used

    def to_dict(self) -> dict[str, int]:
        return {
            "limit": self.limit,
            "used": self.used,
            "remaining": self.remaining,
        }


# ---------------------------------------------------------------------------
# Model invocation budget (Issue #216 / W0.3-5)
# ---------------------------------------------------------------------------

# Counts productive Model Gateway calls across all agent roles in one run.
# Defaults to unrestricted for the enterprise baseline.
MODEL_INVOCATION_BUDGET_MIN = 1
MODEL_INVOCATION_BUDGET_MAX = UNLIMITED_AI_BUDGET
DEFAULT_MODEL_INVOCATION_BUDGET = UNLIMITED_AI_BUDGET


def clamp_model_invocation_budget(value: int) -> int:
    """Clamp a model-invocation-budget value to the W0.3-allowed range."""
    if value < MODEL_INVOCATION_BUDGET_MIN:
        return MODEL_INVOCATION_BUDGET_MIN
    if value > MODEL_INVOCATION_BUDGET_MAX:
        return MODEL_INVOCATION_BUDGET_MAX
    return value


# noinspection PyClassHasNoInitInspection
@dataclass
class ModelInvocationBudget:
    """Tracks Model Gateway calls against a bounded per-run cap.

    Issue #216 (W0.3-5): the budget covers every productive call routed
    through the Model Gateway (transformation agent and each repair
    iteration). The Orchestrator consumes one unit immediately *before*
    each call so an exhausted budget hard-terminates the productive path
    without a hidden retry.
    """

    limit: int
    used: int = 0

    def __post_init__(self) -> None:
        if (
            self.limit < MODEL_INVOCATION_BUDGET_MIN
            or self.limit > MODEL_INVOCATION_BUDGET_MAX
        ):
            raise ValueError(
                f"model invocation budget must be within "
                f"[{MODEL_INVOCATION_BUDGET_MIN}, {MODEL_INVOCATION_BUDGET_MAX}], "
                f"got {self.limit}"
            )
        if self.used < 0:
            raise ValueError("model invocation budget used must be non-negative")

    @property
    def remaining(self) -> int:
        return max(0, self.limit - self.used)

    @property
    def exhausted(self) -> bool:
        return self.used >= self.limit

    def consume(self) -> int:
        """Consume one model invocation and return the new ``used`` counter.

        Raises ``ModelInvocationBudgetExhaustedError`` if no budget remains.
        """
        if self.exhausted:
            raise ModelInvocationBudgetExhaustedError(
                f"model invocation budget exhausted "
                f"(limit={self.limit}, used={self.used})"
            )
        self.used += 1
        return self.used

    def to_dict(self) -> dict[str, int]:
        return {
            "limit": self.limit,
            "used": self.used,
            "remaining": self.remaining,
        }


# ---------------------------------------------------------------------------
# Editor-assist budget (Studio-IDE-10 / Issue #249 / ADR 0004)
# ---------------------------------------------------------------------------

# ADR 0004 defines the editor-assist channel as a parallel-governed channel
# with its own budget, distinct from the per-run productive budgets above.
# The enterprise default is unrestricted; the numeric sentinel keeps the wire
# shape stable for existing consumers.
EDITOR_ASSIST_BUDGET_MIN = 1
EDITOR_ASSIST_BUDGET_MAX = UNLIMITED_AI_BUDGET
DEFAULT_EDITOR_ASSIST_BUDGET = UNLIMITED_AI_BUDGET


class EditorAssistBudgetExhaustedError(WorkflowContractError):
    """Raised when the editor-assist channel has no units left.

    Issue #249 (Studio-IDE-10): the editor-assist channel is governed
    by a per-(tenantId, userId, sessionId) budget. Exhaustion forces
    the BFF to return ``budget_exhausted`` to the Studio rather than
    silently dropping the call.
    """


def clamp_editor_assist_budget(value: int) -> int:
    """Clamp an editor-assist-budget value to the ADR 0004 range [1, 10]."""
    if value < EDITOR_ASSIST_BUDGET_MIN:
        return EDITOR_ASSIST_BUDGET_MIN
    if value > EDITOR_ASSIST_BUDGET_MAX:
        return EDITOR_ASSIST_BUDGET_MAX
    return value


# noinspection PyClassHasNoInitInspection
@dataclass
class EditorAssistBudget:
    """Tracks editor-assist invocations against a bounded ADR 0004 limit.

    Studio-IDE-10 (#249): the editor-assist channel writes its own
    ``kind=editor_assist`` ledger entries and consumes this budget per
    Studio editor session. The dataclass mirrors :class:`AssistBudget`
    so the orchestrator-side budget tooling stays uniform; the BFF
    holds the live in-process state for V1 (see
    ``services/c2c-bff/src/editorExplain.ts``).
    """

    limit: int
    used: int = 0

    def __post_init__(self) -> None:
        if self.limit < EDITOR_ASSIST_BUDGET_MIN or self.limit > EDITOR_ASSIST_BUDGET_MAX:
            raise ValueError(
                f"editor-assist budget must be within "
                f"[{EDITOR_ASSIST_BUDGET_MIN}, {EDITOR_ASSIST_BUDGET_MAX}], "
                f"got {self.limit}"
            )
        if self.used < 0:
            raise ValueError("editor-assist budget used must be non-negative")

    @property
    def remaining(self) -> int:
        return max(0, self.limit - self.used)

    @property
    def exhausted(self) -> bool:
        return self.used >= self.limit

    def consume(self) -> int:
        """Consume one editor-assist invocation and return the new ``used`` counter.

        Raises ``EditorAssistBudgetExhaustedError`` if no budget remains.
        """
        if self.exhausted:
            raise EditorAssistBudgetExhaustedError(
                f"editor-assist budget exhausted "
                f"(limit={self.limit}, used={self.used})"
            )
        self.used += 1
        return self.used

    def to_dict(self) -> dict[str, int]:
        return {
            "limit": self.limit,
            "used": self.used,
            "remaining": self.remaining,
        }


# ---------------------------------------------------------------------------
# State transitions
# ---------------------------------------------------------------------------


# noinspection PyClassHasNoInitInspection
@dataclass(frozen=True)
class StateTransition:
    """One entry in the run state history."""

    state: str
    at: str
    message: str = ""
    failure_code: str | None = None

    def to_dict(self) -> JsonObject:
        payload: JsonObject = {
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

    def __init__(self, *, initial_state: str = STATE_RUN_ACCEPTED, now: str | None = None):
        if initial_state not in WORKFLOW_STATES:
            raise WorkflowContractError(f"unknown state: {initial_state}")
        self._lock = threading.Lock()
        self._current: str = initial_state
        self._history: list[StateTransition] = [
            StateTransition(state=initial_state, at=now or _iso_now(), message="run accepted")
        ]

    @property
    def current(self) -> str:
        with self._lock:
            result = self._current
        return result

    def history(self) -> list[StateTransition]:
        with self._lock:
            result = list(self._history)
        return result

    def advance(
        self,
        target: str,
        *,
        message: str = "",
        failure_code: str | None = None,
        now: str | None = None,
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

    def allowed_next(self) -> tuple[str, ...]:
        with self._lock:
            result = _ALLOWED_TRANSITIONS.get(self._current, ())
        return result


# ---------------------------------------------------------------------------
# Assist decision (Issue #214 / W0.3-3)
# ---------------------------------------------------------------------------

# The assist-decision gate makes productive AI participation an explicit,
# recorded Orchestrator decision rather than an inference from
# ``agent_attempt_count > 0`` or from Model Gateway availability. The
# Orchestrator records the decision on every productive run that reaches
# the gate; the BFF surfaces it on the run-workflow endpoint so consumers
# never have to infer AI activation indirectly.
#
# W0.3-3 deliberately ships a small, closed set of outcomes and reason
# codes. Deterministic uncertainty-based activation criteria are owned by
# Issue #215 (W0.3-4) and will extend ``ASSIST_REASON_CODES`` without
# changing the contract shape.

ASSIST_OUTCOME_REQUIRED = "assist_required"
ASSIST_OUTCOME_NOT_REQUIRED = "assist_not_required"

ASSIST_OUTCOMES: tuple[str, ...] = (
    ASSIST_OUTCOME_REQUIRED,
    ASSIST_OUTCOME_NOT_REQUIRED,
)

# Closed set of reason codes. The first four entries are the deterministic
# uncertainty criteria introduced in Issue #215 (W0.3-4); the last two are
# the caller-driven baseline introduced in Issue #214 (W0.3-3). Consumers
# must treat any code not listed here as opaque rather than rendering an
# unknown reason silently.
#
# When more than one uncertainty marker is present on a run, the workflow
# picks the most specific code from this priority order (top to bottom):
#
#   1. ``semantic_ir_bounded_ambiguity`` — the Semantic IR document carries
#      an explicit bounded-ambiguity marker, so the deterministic baseline
#      had to commit to one of several semantically valid interpretations.
#   2. ``translation_unsupported_repairable`` — the deterministic generator
#      reported ``unsupportedFeatures`` it could not lower, but the run is
#      otherwise repairable through productive assist.
#   3. ``baseline_open_assumptions`` — the deterministic baseline emitted
#      ``openAssumptions`` so the candidate is honest about what it had to
#      assume.
#   4. ``deterministic_candidate_low_confidence`` — the deterministic
#      candidate carries explicit low-confidence markers.
#   5. ``caller_explicit_opt_in`` — caller opted in but the deterministic
#      baseline produced no uncertainty markers; assist runs because the
#      caller asked, not because of detected uncertainty.
#   6. ``caller_did_not_opt_in`` — caller did not opt into productive
#      assist; deterministic baseline is the final candidate.
#   7. ``assist_budget_exhausted`` (Issue #216 / W0.3-5) — caller opted in
#      but the per-run assist budget has no units left, so the gate cannot
#      activate a productive agent. The deterministic baseline is the
#      final candidate. The outcome is always ``assist_not_required`` for
#      this code.
ASSIST_REASON_SEMANTIC_IR_BOUNDED_AMBIGUITY = "semantic_ir_bounded_ambiguity"
ASSIST_REASON_TRANSLATION_UNSUPPORTED_REPAIRABLE = "translation_unsupported_repairable"
ASSIST_REASON_BASELINE_OPEN_ASSUMPTIONS = "baseline_open_assumptions"
ASSIST_REASON_DETERMINISTIC_CANDIDATE_LOW_CONFIDENCE = "deterministic_candidate_low_confidence"
ASSIST_REASON_CALLER_EXPLICIT_OPT_IN = "caller_explicit_opt_in"
ASSIST_REASON_CALLER_DID_NOT_OPT_IN = "caller_did_not_opt_in"
ASSIST_REASON_ASSIST_BUDGET_EXHAUSTED = "assist_budget_exhausted"

# Deterministic uncertainty reason codes in priority order (most specific
# first). The workflow scans markers from the IR and the generated baseline
# and records the first match. Order is part of the contract: shuffling it
# changes which code consumers see and would be a v1 bump.
ASSIST_DETERMINISTIC_UNCERTAINTY_REASON_CODES: tuple[str, ...] = (
    ASSIST_REASON_SEMANTIC_IR_BOUNDED_AMBIGUITY,
    ASSIST_REASON_TRANSLATION_UNSUPPORTED_REPAIRABLE,
    ASSIST_REASON_BASELINE_OPEN_ASSUMPTIONS,
    ASSIST_REASON_DETERMINISTIC_CANDIDATE_LOW_CONFIDENCE,
)

ASSIST_REASON_CODES: tuple[str, ...] = (
    *ASSIST_DETERMINISTIC_UNCERTAINTY_REASON_CODES,
    ASSIST_REASON_CALLER_EXPLICIT_OPT_IN,
    ASSIST_REASON_CALLER_DID_NOT_OPT_IN,
    ASSIST_REASON_ASSIST_BUDGET_EXHAUSTED,
)

# Closed set of agent roles the gate may select. W0.3-3 only authorises
# the productive Transformation Agent; the Verification/Repair Agent
# continues to be activated by the bounded repair-budget loop and is not
# part of this gate.
ASSIST_AGENT_ROLE_TRANSFORMATION = "transformation_agent"

ASSIST_AGENT_ROLES: tuple[str, ...] = (
    ASSIST_AGENT_ROLE_TRANSFORMATION,
)


# noinspection PyClassHasNoInitInspection
@dataclass(frozen=True)
class AssistDecision:
    """Explicit Orchestrator-owned decision about productive AI assistance.

    Recorded on :class:`W02RunContract` so consumers can read whether
    assist was activated, why, and against which budget without inferring
    from agent attempts alone.
    """

    outcome: str
    reason_code: str
    decided_at: str
    selected_agent_role: str | None = None
    affected_artifact_refs: tuple[JsonObject, ...] = ()
    repair_budget_snapshot: JsonObject | None = None
    # Issue #216 (W0.3-5): extend the gate snapshot with assist and model
    # invocation budgets so consumers can audit the budgets that were
    # available at the moment the gate fired. Kept optional so that
    # contract-shape consumers that pre-date W0.3-5 still parse a gate
    # recorded before these fields were populated.
    assist_budget_snapshot: JsonObject | None = None
    model_invocation_budget_snapshot: JsonObject | None = None
    rationale: str | None = None

    def __post_init__(self) -> None:
        if self.outcome not in ASSIST_OUTCOMES:
            raise ValueError(
                f"unknown assist-decision outcome: {self.outcome!r}; "
                f"allowed: {sorted(ASSIST_OUTCOMES)}"
            )
        if self.reason_code not in ASSIST_REASON_CODES:
            raise ValueError(
                f"unknown assist-decision reason code: {self.reason_code!r}; "
                f"allowed: {sorted(ASSIST_REASON_CODES)}"
            )
        if (
            self.selected_agent_role is not None
            and self.selected_agent_role not in ASSIST_AGENT_ROLES
        ):
            raise ValueError(
                f"unknown assist-decision agent role: {self.selected_agent_role!r}; "
                f"allowed: {sorted(ASSIST_AGENT_ROLES)}"
            )
        if self.outcome == ASSIST_OUTCOME_REQUIRED and self.selected_agent_role is None:
            raise ValueError(
                "assist_required outcome requires a selected_agent_role"
            )
        if (
            self.outcome == ASSIST_OUTCOME_NOT_REQUIRED
            and self.selected_agent_role is not None
        ):
            raise ValueError(
                "assist_not_required outcome must not carry a selected_agent_role"
            )

    def to_dict(self) -> JsonObject:
        payload: JsonObject = {
            "outcome": self.outcome,
            "reasonCode": self.reason_code,
            "decidedAt": self.decided_at,
        }
        if self.selected_agent_role is not None:
            payload["selectedAgentRole"] = self.selected_agent_role
        if self.affected_artifact_refs:
            payload["affectedArtifactRefs"] = [
                dict(ref) for ref in self.affected_artifact_refs
            ]
        if self.repair_budget_snapshot is not None:
            payload["repairBudgetSnapshot"] = dict(self.repair_budget_snapshot)
        if self.assist_budget_snapshot is not None:
            payload["assistBudgetSnapshot"] = dict(self.assist_budget_snapshot)
        if self.model_invocation_budget_snapshot is not None:
            payload["modelInvocationBudgetSnapshot"] = dict(
                self.model_invocation_budget_snapshot
            )
        if self.rationale is not None:
            payload["rationale"] = self.rationale
        return payload


# ---------------------------------------------------------------------------
# Manual-edit provenance taxonomy (ADR 0007 / Issue #257)
# ---------------------------------------------------------------------------

# ADR 0007 defines a closed five-class taxonomy for the origin of a Java
# region. The first three classes describe machine-produced regions that
# have not been edited by hand since the Generator-Run; the last two
# describe regions whose authority has shifted to a human editor.
#
# Consumers MUST treat any string outside this closed set as opaque (per
# ADR 0006 §3 — Studio-BFF Contract Versioning Policy).

JAVA_REGION_ORIGIN_DETERMINISTIC = "deterministic"
JAVA_REGION_ORIGIN_AGENT_PROPOSED = "agent_proposed"
JAVA_REGION_ORIGIN_REPAIR_ATTEMPTED = "repair_attempted"
JAVA_REGION_ORIGIN_MANUAL_MODIFIED = "manual_modified"
JAVA_REGION_ORIGIN_MANUAL_EDIT = "manual_edit"

JAVA_REGION_ORIGIN_CLASSES: tuple[str, ...] = (
    JAVA_REGION_ORIGIN_DETERMINISTIC,
    JAVA_REGION_ORIGIN_AGENT_PROPOSED,
    JAVA_REGION_ORIGIN_REPAIR_ATTEMPTED,
    JAVA_REGION_ORIGIN_MANUAL_MODIFIED,
    JAVA_REGION_ORIGIN_MANUAL_EDIT,
)

# Subset whose presence triggers the manual-edit assist-interaction rule
# (ADR 0007 §5): the Verification/Repair Agent MUST NOT propose changes
# to such a region unless the assist decision carries
# ``ASSIST_REASON_CALLER_EXPLICIT_OPT_IN``.
JAVA_REGION_ORIGIN_MANUAL_CLASSES: tuple[str, ...] = (
    JAVA_REGION_ORIGIN_MANUAL_MODIFIED,
    JAVA_REGION_ORIGIN_MANUAL_EDIT,
)


# ---------------------------------------------------------------------------
# Run contract
# ---------------------------------------------------------------------------


# noinspection PyClassHasNoInitInspection
@dataclass
class W02RunContract:
    """Serialisable run contract exposed to BFF/UI/agent/evidence consumers.

    The contract is updated in place by :class:`WorkflowStateMachine` and the
    runner. Consumers receive a snapshot via :meth:`to_dict`.
    """

    run_id: str
    workflow_id: str
    requester: str
    source_ref: JsonObject
    state_machine: WorkflowStateMachine
    repair_budget: RepairBudget
    # Issue #216 (W0.3-5): per-run productive-assist activation budget
    # (consumed when the assist-decision gate decides ``assist_required``)
    # and the per-run Model Gateway invocation budget (consumed before
    # every productive gateway call). Both surface remaining/used counts
    # on every contract snapshot for UI-safe auditing.
    assist_budget: AssistBudget = field(
        default_factory=lambda: AssistBudget(limit=DEFAULT_ASSIST_BUDGET)
    )
    model_invocation_budget: ModelInvocationBudget = field(
        default_factory=lambda: ModelInvocationBudget(
            limit=DEFAULT_MODEL_INVOCATION_BUDGET
        )
    )
    active_step: str | None = None
    agent_attempt_count: int = 0
    generated_java_ref: JsonObject | None = None
    build_test_result_ref: JsonObject | None = None
    parity_comparison: JsonObject | None = None
    evidence_pack_ref: JsonObject | None = None
    final_classification: str | None = None
    failure_code: str | None = None
    failure_message: str | None = None
    repair_attempts: list[JsonObject] = field(default_factory=list)
    assist_decision: AssistDecision | None = None
    # ADR 0007 (#257): manual-edit provenance fields stamped on the run
    # summary when the run finalises. ``manual_edits_carried_over`` is
    # true iff the verified Java buffer contained at least one
    # ``manual_modified`` or ``manual_edit`` region; ``manual_drift_region_count``
    # is the number of such regions. Both fields are additive over the
    # pre-ADR-0007 contract — older persisted runs that lack them MUST be
    # read as ``False`` / ``0`` respectively.
    manual_edits_carried_over: bool = False
    manual_drift_region_count: int = 0
    # Studio-IDE-6 (#248): per-file trust-pillar overlay for the generated
    # Java surface. Keyed by Java file path (relative to the generated
    # project root); each value is a list of ``JavaRegionClassification``
    # records. ``None`` (the default) means the orchestrator has not
    # computed an overlay for this run — consumers must treat ``None`` as
    # "not yet available" rather than as "empty overlay". Additive over
    # the pre-IDE-6 contract per ADR 0006 §1 (``schemaVersion: v0``
    # semantics — absent = legacy v0 reader).
    java_region_classification: dict[str, list[JsonObject]] | None = None
    created_at: str = field(default_factory=_iso_now)
    updated_at: str = field(default_factory=_iso_now)

    def __post_init__(self) -> None:
        if not self.run_id:
            raise ValueError("run_id is required")
        if not self.workflow_id:
            raise ValueError("workflow_id is required")
        if self.final_classification is not None and self.final_classification not in FINAL_CLASSIFICATIONS:
            raise ValueError(f"unknown final classification: {self.final_classification}")
        if self.manual_drift_region_count < 0:
            raise ValueError("manual_drift_region_count must be non-negative")
        if self.manual_edits_carried_over and self.manual_drift_region_count == 0:
            raise ValueError(
                "manual_edits_carried_over=True requires manual_drift_region_count > 0"
            )
        if not self.manual_edits_carried_over and self.manual_drift_region_count > 0:
            raise ValueError(
                "manual_drift_region_count > 0 requires manual_edits_carried_over=True"
            )

    def touch(self, now: str | None = None) -> None:
        self.updated_at = now or _iso_now()

    def set_active_step(self, step: str | None) -> None:
        self.active_step = step
        self.touch()

    def record_agent_attempt(self) -> int:
        self.agent_attempt_count += 1
        self.touch()
        return self.agent_attempt_count

    def record_repair_attempt(self, entry: Mapping[str, JsonValue]) -> JsonObject:
        """Record one verification/repair-agent attempt on the run contract.

        Issue #170: every repair attempt — successful, refused, escalated,
        or no-change — leaves an entry on the trajectory ledger so Experience
        Learning can spot loop pathologies (no-change repeats, repeated
        contract-invalid, escalation rate per failure category).
        """
        if not isinstance(entry, Mapping):
            raise TypeError("repair attempt entry must be a mapping")
        decision = str(entry.get("repairDecision") or "").strip()
        if decision not in {"propose_candidate", "refuse", "escalate", "no_change"}:
            raise ValueError(
                f"unknown repairDecision on repair attempt entry: {decision!r}"
            )
        try:
            attempt_number = int(entry.get("attemptNumber"))
        except (TypeError, ValueError) as exc:
            raise ValueError("repair attempt entry requires integer attemptNumber") from exc
        if attempt_number < 1:
            raise ValueError("repair attempt entry attemptNumber must be >= 1")
        normalised: JsonObject = {
            "attemptNumber": attempt_number,
            "repairDecision": decision,
            "failureCategory": str(entry.get("failureCategory") or "") or None,
            "createdAt": str(entry.get("createdAt") or _iso_now()),
        }
        # Issue #280 (ADR 0007 §5): ``affectedRegions`` and ``manualRegionBlock``
        # surface the manual-edit assist-interaction rule on the trajectory so
        # Experience Learning can spot patterns where manual edits repeatedly
        # block repair. The fields are additive and only appear on entries the
        # orchestrator emits when the gate fires for a manual region.
        for optional_key in (
            "refusalCode",
            "escalationCode",
            "modelInvocationRef",
            "repairInputRef",
            "repairDecisionRef",
            "javaCandidateRef",
            "buildTestResultRef",
            "rationale",
            "diffFromPreviousRef",
            "affectedRegions",
            "manualRegionBlock",
        ):
            value = entry.get(optional_key)
            if value is None:
                continue
            if optional_key == "affectedRegions":
                if not isinstance(value, Sequence) or isinstance(value, (str, bytes)):
                    raise TypeError(
                        "repair attempt affectedRegions must be a sequence of region records"
                    )
                normalised_regions: list[JsonObject] = []
                for region in value:
                    if not isinstance(region, Mapping):
                        raise TypeError(
                            "repair attempt affectedRegions entries must be mappings"
                        )
                    normalised_regions.append(dict(region))
                normalised[optional_key] = normalised_regions
                continue
            if optional_key == "manualRegionBlock":
                normalised[optional_key] = bool(value)
                continue
            if isinstance(value, Mapping):
                normalised[optional_key] = dict(value)
            else:
                normalised[optional_key] = value
        if normalised["failureCategory"] is None:
            normalised.pop("failureCategory")
        self.repair_attempts.append(normalised)
        self.touch()
        return normalised

    @property
    def repeated_no_change_count(self) -> int:
        """Return the count of repair attempts classified as ``no_change``."""
        return sum(
            1
            for entry in self.repair_attempts
            if entry.get("repairDecision") == "no_change"
        )

    def record_assist_decision(self, decision: AssistDecision) -> AssistDecision:
        """Record the W0.3 assist-decision gate result on the run contract.

        Issue #214: every productive run that reaches the gate records an
        explicit decision so consumers do not need to infer AI activation
        from ``agent_attempt_count > 0`` or from Model Gateway state.
        Subsequent recordings overwrite the previous decision (the gate
        runs once per run today; future waves may re-evaluate).
        """
        if not isinstance(decision, AssistDecision):
            raise TypeError(
                "record_assist_decision requires an AssistDecision instance"
            )
        self.assist_decision = decision
        self.touch()
        return decision

    def set_generated_java_ref(self, ref: Mapping[str, JsonValue] | None) -> None:
        self.generated_java_ref = dict(ref) if ref else None
        self.touch()

    def set_build_test_result_ref(self, ref: Mapping[str, JsonValue] | None) -> None:
        self.build_test_result_ref = dict(ref) if ref else None
        self.touch()

    def set_parity_comparison(
        self, payload: Mapping[str, JsonValue] | None
    ) -> None:
        self.parity_comparison = dict(payload) if payload else None
        self.touch()

    def set_evidence_pack_ref(self, ref: Mapping[str, JsonValue] | None) -> None:
        self.evidence_pack_ref = dict(ref) if ref else None
        self.touch()

    def set_java_region_classification(
        self,
        classification: Mapping[str, list[JsonObject]] | None,
    ) -> None:
        """Record the Studio-IDE-6 per-file trust-pillar overlay.

        Issue #248: passing ``None`` clears any previous overlay (the
        orchestrator may compute the overlay only once the run reaches
        ``STATE_JAVA_CANDIDATE_PERSISTED``). The orchestrator validates
        the contents through :mod:`region_classification`; this setter
        only enforces the container shape.
        """
        if classification is None:
            self.java_region_classification = None
        else:
            self.java_region_classification = {
                str(path): [dict(region) for region in regions]
                for path, regions in classification.items()
            }
        self.touch()

    def set_manual_edit_summary(
        self,
        *,
        carried_over: bool,
        drift_region_count: int,
    ) -> None:
        """Record ADR 0007 manual-edit provenance summary on the run contract.

        Issue #257: ``carried_over`` is true iff the verified Java buffer
        contained at least one ``manual_modified`` or ``manual_edit``
        region; ``drift_region_count`` is the number of such regions.
        The orchestrator calls this once before finalising the run so
        every consumer of the contract — BFF, Studio, evidence-service —
        reads the same provenance summary.
        """
        if drift_region_count < 0:
            raise ValueError("drift_region_count must be non-negative")
        if carried_over and drift_region_count == 0:
            raise ValueError(
                "carried_over=True requires drift_region_count > 0"
            )
        if not carried_over and drift_region_count > 0:
            raise ValueError(
                "drift_region_count > 0 requires carried_over=True"
            )
        self.manual_edits_carried_over = carried_over
        self.manual_drift_region_count = drift_region_count
        self.touch()

    def finalize(
        self,
        classification: str,
        *,
        failure_code: str | None = None,
        failure_message: str | None = None,
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

    def to_dict(self) -> JsonObject:
        payload: JsonObject = {
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
            "assistBudget": self.assist_budget.to_dict(),
            "modelInvocationBudget": self.model_invocation_budget.to_dict(),
            "generatedJavaRef": dict(self.generated_java_ref) if self.generated_java_ref else None,
            "buildTestResultRef": dict(self.build_test_result_ref) if self.build_test_result_ref else None,
            "parityComparison": dict(self.parity_comparison) if self.parity_comparison else None,
            "evidencePackRef": dict(self.evidence_pack_ref) if self.evidence_pack_ref else None,
            "finalClassification": self.final_classification,
            "failureCode": self.failure_code,
            "failureMessage": self.failure_message,
            "repairAttempts": [dict(entry) for entry in self.repair_attempts],
            "assistDecision": self.assist_decision.to_dict() if self.assist_decision else None,
            "manualEditsCarriedOver": self.manual_edits_carried_over,
            "manualDriftRegionCount": self.manual_drift_region_count,
            # Studio-IDE-6 (#248): per-file trust-pillar overlay. Always
            # present on the snapshot so downstream readers see a stable
            # shape; the value is ``None`` when the orchestrator has not
            # produced an overlay yet.
            "javaRegionClassification": (
                {
                    path: [dict(region) for region in regions]
                    for path, regions in self.java_region_classification.items()
                }
                if self.java_region_classification is not None
                else None
            ),
            "createdAt": self.created_at,
            "updatedAt": self.updated_at,
        }
        return payload


def new_run_contract(
    *,
    run_id: str,
    workflow_id: str,
    requester: str,
    source_ref: Mapping[str, JsonValue],
    repair_budget_limit: int = DEFAULT_REPAIR_BUDGET,
    assist_budget_limit: int = DEFAULT_ASSIST_BUDGET,
    model_invocation_budget_limit: int = DEFAULT_MODEL_INVOCATION_BUDGET,
    now: str | None = None,
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
        assist_budget=AssistBudget(limit=clamp_assist_budget(assist_budget_limit)),
        model_invocation_budget=ModelInvocationBudget(
            limit=clamp_model_invocation_budget(model_invocation_budget_limit)
        ),
        active_step=STEP_ACCEPTED,
        created_at=timestamp,
        updated_at=timestamp,
    )
    return contract


# Mapping from common step-failure markers (the substrings reported by
# ``workflow.py`` exception text) to canonical W0.2 failure codes. Used by
# the runner to label run failures consistently.
STEP_TO_FAILURE_CODE: dict[str, str] = {
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
BUILD_TEST_FAILURE_REASONS: dict[str, str] = {
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


def build_test_outcome(payload: Mapping[str, JsonValue]) -> tuple[bool, str | None]:
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
