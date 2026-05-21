"""Repo-owned trust-case catalog loading and resolution helpers."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from hashlib import sha256
from pathlib import Path
from collections.abc import Mapping, Sequence
from typing import Any

from .artifacts import JsonObject


CATALOG_FILE = Path("fixtures/trust-cases/index.json")

_TRUST_CASE_ID_PATTERN = re.compile(r"^[A-Z][A-Z0-9-]{1,63}$")
_PROGRAM_ID_PATTERN = re.compile(r"^[A-Z][A-Z0-9-]{0,63}$")
_REFERENCE_FIXTURE_ID_PATTERN = _TRUST_CASE_ID_PATTERN
_PROGRAM_ARG_PATTERN = re.compile(r"^[A-Za-z0-9._:=@/+,-]*$")
_DATASET_ID_PATTERN = re.compile(r"^[A-Z][A-Z0-9_-]{1,63}$")
_ENV_KEY_PATTERN = re.compile(r"^[A-Z][A-Z0-9_]{0,63}$")
_ENV_VALUE_PATTERN = re.compile(r"^[A-Za-z0-9._:/=+\-]{0,256}$")
_ENVIRONMENT_PROFILE_IDS = {
    "generated-java-sandbox-v1",
    "reference-fixture-v1",
    "native-cobol-controlled-v1",
}
_COMPARISON_STRATEGIES = {"deterministic-output"}
_COMPARISON_POLICY_VERSION = "deterministic-output-v1"
_EVIDENCE_ARTIFACT_NAME = "executed-trust-case.json"


class TrustCaseCatalogError(ValueError):
    """Raised when the trust-case catalog or a resolution request is invalid."""


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[4]


def _canonical_json_bytes(payload: Any) -> bytes:
    return json.dumps(
        payload,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
    ).encode("utf-8")


def _required_string(value: Any, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise TrustCaseCatalogError(f"{field} is required")
    return value.strip()


def _required_bool(value: Any, field: str) -> bool:
    if not isinstance(value, bool):
        raise TrustCaseCatalogError(f"{field} must be a boolean")
    return value


def _required_mapping(value: Any, field: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise TrustCaseCatalogError(f"{field} must be an object")
    return value


def _required_sequence(value: Any, field: str) -> Sequence[Any]:
    if not isinstance(value, list):
        raise TrustCaseCatalogError(f"{field} must be an array")
    return value


def _validate_pattern(value: str, pattern: re.Pattern[str], field: str) -> str:
    if not pattern.fullmatch(value):
        raise TrustCaseCatalogError(f"{field} has an invalid format")
    return value


def _validate_program_args(value: Any) -> tuple[str, ...]:
    raw_args = _required_sequence(value, "runtime.programArgs")
    if len(raw_args) > 8:
        raise TrustCaseCatalogError("runtime.programArgs must contain at most 8 entries")
    args: list[str] = []
    for index, entry in enumerate(raw_args):
        if not isinstance(entry, str):
            raise TrustCaseCatalogError(
                f"runtime.programArgs[{index}] must be a string"
            )
        if len(entry) > 80:
            raise TrustCaseCatalogError(
                f"runtime.programArgs[{index}] must be at most 80 characters"
            )
        if entry.startswith("/") or ".." in entry or re.match(r"^[A-Za-z]:[\\/]", entry):
            raise TrustCaseCatalogError(
                f"runtime.programArgs[{index}] has an invalid format"
            )
        if not _PROGRAM_ARG_PATTERN.fullmatch(entry):
            raise TrustCaseCatalogError(
                f"runtime.programArgs[{index}] has an invalid format"
            )
        args.append(entry)
    return tuple(args)


def _catalog_hash(payload: Mapping[str, Any]) -> str:
    return sha256(_canonical_json_bytes(payload)).hexdigest()


@dataclass(frozen=True)
class TrustCaseCatalogEntry:
    trust_case_id: str
    version: str
    program_id: str
    title: str
    description: str
    default_for_program: bool
    source_reference_fixture_id: str
    source_reference_mode: str
    controlled_input_stdin: str | None
    controlled_input_dataset_ids: tuple[str, ...]
    controlled_input_expected_output_fixture_id: str
    runtime_program_args: tuple[str, ...]
    environment_profile_id: str
    environment_profile_description: str
    environment_profile_variables: JsonObject
    comparison_strategy_id: str
    comparison_policy_version: str
    supported_program_shape: JsonObject
    evidence_artifact_name: str

    @classmethod
    def from_payload(cls, payload: Mapping[str, Any]) -> "TrustCaseCatalogEntry":
        trust_case_id = _validate_pattern(
            _required_string(payload.get("trustCaseId"), "trustCaseId"),
            _TRUST_CASE_ID_PATTERN,
            "trustCaseId",
        )
        version = _required_string(payload.get("version"), "version")
        _validate_pattern(version, re.compile(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}$"), "version")
        program_id = _validate_pattern(
            _required_string(payload.get("programId"), "programId"),
            _PROGRAM_ID_PATTERN,
            "programId",
        )
        title = _required_string(payload.get("title"), "title")
        description = _required_string(payload.get("description"), "description")
        default_for_program = _required_bool(payload.get("defaultForProgram"), "defaultForProgram")

        source_reference = _required_mapping(payload.get("sourceReference"), "sourceReference")
        source_reference_fixture_id = _validate_pattern(
            _required_string(source_reference.get("fixtureId"), "sourceReference.fixtureId"),
            _REFERENCE_FIXTURE_ID_PATTERN,
            "sourceReference.fixtureId",
        )
        source_reference_mode = _required_string(source_reference.get("mode"), "sourceReference.mode")
        if source_reference_mode not in {"reference-fixture", "native-cobol"}:
            raise TrustCaseCatalogError("sourceReference.mode must be reference-fixture or native-cobol")

        controlled_input = _required_mapping(payload.get("controlledInput"), "controlledInput")
        controlled_input_stdin_raw = controlled_input.get("stdin")
        if controlled_input_stdin_raw is None:
            controlled_input_stdin = None
        else:
            if not isinstance(controlled_input_stdin_raw, str):
                raise TrustCaseCatalogError("controlledInput.stdin must be a string or null")
            if len(controlled_input_stdin_raw) > 8192:
                raise TrustCaseCatalogError("controlledInput.stdin must be at most 8192 characters")
            controlled_input_stdin = controlled_input_stdin_raw
        controlled_input_dataset_ids_raw = controlled_input.get("dataSetIds", [])
        controlled_input_dataset_ids_sequence = _required_sequence(
            controlled_input_dataset_ids_raw,
            "controlledInput.dataSetIds",
        )
        if len(controlled_input_dataset_ids_sequence) > 16:
            raise TrustCaseCatalogError("controlledInput.dataSetIds must contain at most 16 entries")
        controlled_input_dataset_ids: list[str] = []
        for index, entry in enumerate(controlled_input_dataset_ids_sequence):
            if not isinstance(entry, str) or not _DATASET_ID_PATTERN.fullmatch(entry):
                raise TrustCaseCatalogError(
                    f"controlledInput.dataSetIds[{index}] has an invalid format"
                )
            controlled_input_dataset_ids.append(entry)
        if len(set(controlled_input_dataset_ids)) != len(controlled_input_dataset_ids):
            raise TrustCaseCatalogError("controlledInput.dataSetIds must not contain duplicates")
        controlled_input_expected_output_fixture_id = _validate_pattern(
            _required_string(
                controlled_input.get("expectedOutputFixtureId"),
                "controlledInput.expectedOutputFixtureId",
            ),
            _REFERENCE_FIXTURE_ID_PATTERN,
            "controlledInput.expectedOutputFixtureId",
        )

        runtime = _required_mapping(payload.get("runtime"), "runtime")
        runtime_program_args = _validate_program_args(runtime.get("programArgs"))

        environment_profile = _required_mapping(
            payload.get("environmentProfile"), "environmentProfile"
        )
        environment_profile_id = _required_string(
            environment_profile.get("profileId"),
            "environmentProfile.profileId",
        )
        if environment_profile_id not in _ENVIRONMENT_PROFILE_IDS:
            raise TrustCaseCatalogError(
                "environmentProfile.profileId must be one of the catalog-owned controlled profiles"
            )
        environment_profile_description = _required_string(
            environment_profile.get("description"),
            "environmentProfile.description",
        )
        variables = _required_mapping(
            environment_profile.get("variables", {}),
            "environmentProfile.variables",
        )
        environment_profile_variables: JsonObject = {}
        for key, value in variables.items():
            if not isinstance(key, str) or not _ENV_KEY_PATTERN.fullmatch(key):
                raise TrustCaseCatalogError(
                    "environmentProfile.variables contains an invalid key"
                )
            if not isinstance(value, str) or not _ENV_VALUE_PATTERN.fullmatch(value):
                raise TrustCaseCatalogError(
                    f"environmentProfile.variables.{key} has an invalid value"
                )
            environment_profile_variables[key] = value

        comparison = _required_mapping(payload.get("comparison"), "comparison")
        comparison_strategy_id = _required_string(
            comparison.get("strategy"), "comparison.strategy"
        )
        if comparison_strategy_id not in _COMPARISON_STRATEGIES:
            raise TrustCaseCatalogError(
                "comparison.strategy must be deterministic-output"
            )
        comparison_policy_version = _required_string(
            comparison.get("policyVersion"), "comparison.policyVersion"
        )
        if comparison_policy_version != _COMPARISON_POLICY_VERSION:
            raise TrustCaseCatalogError(
                "comparison.policyVersion must be deterministic-output-v1"
            )

        supported_program_shape = dict(
            _required_mapping(payload.get("supportedProgramShape"), "supportedProgramShape")
        )
        evidence_identity = _required_mapping(payload.get("evidenceIdentity"), "evidenceIdentity")
        evidence_kind = _required_string(evidence_identity.get("kind"), "evidenceIdentity.kind")
        evidence_artifact_name = _required_string(
            evidence_identity.get("artifactName"), "evidenceIdentity.artifactName"
        )
        if evidence_kind != "trust-case":
            raise TrustCaseCatalogError("evidenceIdentity.kind must be trust-case")
        if evidence_artifact_name != _EVIDENCE_ARTIFACT_NAME:
            raise TrustCaseCatalogError(
                "evidenceIdentity.artifactName must be executed-trust-case.json"
            )

        return cls(
            trust_case_id=trust_case_id,
            version=version,
            program_id=program_id,
            title=title,
            description=description,
            default_for_program=default_for_program,
            source_reference_fixture_id=source_reference_fixture_id,
            source_reference_mode=source_reference_mode,
            controlled_input_stdin=controlled_input_stdin,
            controlled_input_dataset_ids=tuple(controlled_input_dataset_ids),
            controlled_input_expected_output_fixture_id=controlled_input_expected_output_fixture_id,
            runtime_program_args=runtime_program_args,
            environment_profile_id=environment_profile_id,
            environment_profile_description=environment_profile_description,
            environment_profile_variables=environment_profile_variables,
            comparison_strategy_id=comparison_strategy_id,
            comparison_policy_version=comparison_policy_version,
            supported_program_shape=supported_program_shape,
            evidence_artifact_name=evidence_artifact_name,
        )

    def to_identity_payload(self, *, catalog_version: str, catalog_hash: str) -> JsonObject:
        identity: JsonObject = {
            "trustCaseId": self.trust_case_id,
            "version": self.version,
            "programId": self.program_id,
            "catalogVersion": catalog_version,
            "catalogHash": catalog_hash,
            "sourceReferenceFixtureId": self.source_reference_fixture_id,
            "sourceReferenceMode": self.source_reference_mode,
            "sourceReference": {
                "fixtureId": self.source_reference_fixture_id,
                "mode": self.source_reference_mode,
            },
            "controlledInput": {
                "stdin": self.controlled_input_stdin,
                "dataSetIds": list(self.controlled_input_dataset_ids),
                "expectedOutputFixtureId": self.controlled_input_expected_output_fixture_id,
            },
            "runtimeProgramArgs": list(self.runtime_program_args),
            "runtime": {
                "programArgs": list(self.runtime_program_args),
            },
            "environmentProfileId": self.environment_profile_id,
            "environmentProfile": {
                "profileId": self.environment_profile_id,
                "description": self.environment_profile_description,
                "variables": dict(self.environment_profile_variables),
            },
            "comparisonStrategy": self.comparison_strategy_id,
            "comparisonPolicyVersion": self.comparison_policy_version,
            "supportedProgramShape": dict(self.supported_program_shape),
            "evidenceArtifactName": self.evidence_artifact_name,
        }
        digest_input = dict(identity)
        digest_input.pop("configurationDigest", None)
        identity["configurationDigest"] = _catalog_hash(digest_input)
        return identity


@dataclass(frozen=True)
class ResolvedTrustCase:
    catalog_version: str
    catalog_hash: str
    entry: TrustCaseCatalogEntry

    def to_identity_payload(self) -> JsonObject:
        return self.entry.to_identity_payload(
            catalog_version=self.catalog_version,
            catalog_hash=self.catalog_hash,
        )


class TrustCaseCatalog:
    def __init__(self, *, catalog_path: Path | None = None) -> None:
        self.catalog_path = catalog_path or (_repo_root() / CATALOG_FILE)
        if not self.catalog_path.is_file():
            raise TrustCaseCatalogError(
                f"trust-case catalog not found: {self.catalog_path}"
            )
        raw_bytes = self.catalog_path.read_bytes()
        try:
            payload = json.loads(raw_bytes.decode("utf-8"))
        except json.JSONDecodeError as exc:
            raise TrustCaseCatalogError("trust-case catalog must be valid JSON") from exc
        if not isinstance(payload, Mapping):
            raise TrustCaseCatalogError("trust-case catalog must be an object")
        self._payload = dict(payload)
        self.catalog_version = _required_string(
            payload.get("catalogVersion"), "catalogVersion"
        )
        schema_version = _required_string(payload.get("schemaVersion"), "schemaVersion")
        if schema_version != "v0":
            raise TrustCaseCatalogError("schemaVersion must be v0")
        description = payload.get("description")
        if description is not None:
            _required_string(description, "description")
        trust_cases = _required_sequence(payload.get("trustCases"), "trustCases")
        if not trust_cases:
            raise TrustCaseCatalogError("trustCases must contain at least one entry")
        self.catalog_hash = _catalog_hash(payload)
        entries: dict[str, TrustCaseCatalogEntry] = {}
        default_programs: set[str] = set()
        for index, raw_entry in enumerate(trust_cases):
            if not isinstance(raw_entry, Mapping):
                raise TrustCaseCatalogError(
                    f"trustCases[{index}] must be an object"
                )
            entry = TrustCaseCatalogEntry.from_payload(raw_entry)
            if entry.trust_case_id in entries:
                raise TrustCaseCatalogError(
                    f"duplicate trustCaseId in catalog: {entry.trust_case_id}"
                )
            entries[entry.trust_case_id] = entry
            if entry.default_for_program:
                if entry.program_id in default_programs:
                    raise TrustCaseCatalogError(
                        f"multiple default trust cases defined for programId {entry.program_id}"
                    )
                default_programs.add(entry.program_id)
        self._entries = entries

    @classmethod
    def load(cls, catalog_path: Path | None = None) -> "TrustCaseCatalog":
        return cls(catalog_path=catalog_path)

    def resolve(
        self,
        trust_case_id: str,
        *,
        program_id: str | None = None,
        source_reference_fixture_id: str | None = None,
        source_reference_mode: str | None = None,
    ) -> ResolvedTrustCase:
        trust_case_id = _validate_pattern(
            _required_string(trust_case_id, "trustCaseId"),
            _TRUST_CASE_ID_PATTERN,
            "trustCaseId",
        )
        entry = self._entries.get(trust_case_id)
        if entry is None:
            raise TrustCaseCatalogError(f"unknown trustCaseId: {trust_case_id}")

        if program_id is not None:
            program_id = _validate_pattern(
                _required_string(program_id, "programId"),
                _PROGRAM_ID_PATTERN,
                "programId",
            )
            if program_id != entry.program_id:
                raise TrustCaseCatalogError(
                    f"programId {program_id!r} does not match trustCaseId {trust_case_id!r}"
                )

        if source_reference_fixture_id is not None:
            source_reference_fixture_id = _validate_pattern(
                _required_string(
                    source_reference_fixture_id,
                    "sourceReferenceFixtureId",
                ),
                _REFERENCE_FIXTURE_ID_PATTERN,
                "sourceReferenceFixtureId",
            )
            if source_reference_fixture_id != entry.source_reference_fixture_id:
                raise TrustCaseCatalogError(
                    "sourceReferenceFixtureId does not match trustCaseId"
                )

        if source_reference_mode is not None:
            source_reference_mode = _required_string(
                source_reference_mode, "sourceReferenceMode"
            )
            if source_reference_mode != entry.source_reference_mode:
                raise TrustCaseCatalogError(
                    "sourceReferenceMode does not match trustCaseId"
                )

        return ResolvedTrustCase(
            catalog_version=self.catalog_version,
            catalog_hash=self.catalog_hash,
            entry=entry,
        )

    def get(self, trust_case_id: str) -> TrustCaseCatalogEntry | None:
        return self._entries.get(trust_case_id)

    @property
    def payload(self) -> JsonObject:
        return dict(self._payload)


def load_trust_case_catalog(catalog_path: Path | None = None) -> TrustCaseCatalog:
    return TrustCaseCatalog.load(catalog_path)
