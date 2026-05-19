package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"regexp"
	"strings"
	"time"
)

const (
	SchemaVersionV0    = "v0"
	WaveW0             = "w0"
	WaveW02            = "w0.2"
	CapabilityEvidence = "evidence.pack"
	ServiceName        = "evidence-service"

	StatusComplete   = "complete"
	StatusIncomplete = "incomplete"
	StatusInvalid    = "invalid"

	// CompletenessStatusComplete and its siblings are the W0.2 completenessStatus values (Issue #171).
	// Decoupled from the legacy status field so the orchestrator can distinguish "missing required
	// evidence" (evidence_incomplete) from "upstream failure blocked the run"
	// (blocked). A run is success-classifiable only when completenessStatus is "complete".
	CompletenessStatusComplete           = "complete"
	CompletenessStatusEvidenceIncomplete = "evidence_incomplete"
	CompletenessStatusBlocked            = "blocked"

	// ClassificationSuccess and its siblings are the final classification of the W0.2 run as
	// observed from the evidence pack (Issue #171). A successful run REQUIRES completenessStatus=complete.
	ClassificationSuccess            = "success"
	ClassificationEvidenceIncomplete = "evidence_incomplete"
	ClassificationBlocked            = "blocked"
	ClassificationFailed             = "failed"

	// JavaCandidateOriginBaseline and its siblings are Java-candidate origin attributions (Issue #171).
	JavaCandidateOriginBaseline            = "deterministic-baseline"
	JavaCandidateOriginTransformationAgent = "transformation-agent"
	JavaCandidateOriginVerificationRepair  = "verification-repair-agent"

	// RepairDecisionProposeCandidate and its siblings are repair-attempt decision values (Issue #171).
	// Mirrors agent-repair-decision-v0.
	RepairDecisionProposeCandidate = "propose_candidate"
	RepairDecisionRefuse           = "refuse"
	RepairDecisionEscalate         = "escalate"
	RepairDecisionNoChange         = "no_change"

	// AgentRoleOrchestrator and its siblings are per-agent trajectory roles (Issue #171).
	AgentRoleOrchestrator       = "orchestrator"
	AgentRoleTransformation     = "transformation"
	AgentRoleVerificationRepair = "verification-repair"

	// OracleKindCobolRuntime and its siblings are oracle-kind enum values (Issue #171).
	// Mirrors build-test-result-v0.oracleComparison.
	OracleKindCobolRuntime     = "cobol-runtime"
	OracleKindSynthetic        = "synthetic"
	OracleKindTrueGoldenMaster = "true-golden-master"
	OracleKindUserProvided     = "user-provided"
	OracleKindAbsent           = "absent"

	// AssistOutcomeRequired and its sibling are W0.3 assist-decision outcomes
	// (Issue #217). Mirrors orchestrator run_contract.ASSIST_OUTCOMES.
	AssistOutcomeRequired    = "assist_required"
	AssistOutcomeNotRequired = "assist_not_required"

	// AssistReason* are the closed set of W0.3 assist-decision reason codes
	// (Issues #214, #215, #216, #217). Anything outside this set is rejected
	// by evidence-service so reviewers never see an unrecognised reason.
	AssistReasonSemanticIRBoundedAmbiguity          = "semantic_ir_bounded_ambiguity"
	AssistReasonTranslationUnsupportedRepairable    = "translation_unsupported_repairable"
	AssistReasonBaselineOpenAssumptions             = "baseline_open_assumptions"
	AssistReasonDeterministicCandidateLowConfidence = "deterministic_candidate_low_confidence"
	AssistReasonCallerExplicitOptIn                 = "caller_explicit_opt_in"
	AssistReasonCallerDidNotOptIn                   = "caller_did_not_opt_in"
	AssistReasonAssistBudgetExhausted               = "assist_budget_exhausted"

	// AssistAgentRoleTransformation is the only agent role the assist-decision
	// gate may select in W0.3 (Issue #214). The Verification/Repair Agent runs
	// under the bounded repair-budget loop and is not part of this gate.
	AssistAgentRoleTransformation = "transformation_agent"

	ExportFormatDirectory = "directory"
	ExportFormatTar       = "tar"
)

var packIDPattern = regexp.MustCompile(`^epk-[A-Za-z0-9._-]+$`)

var sha256Pattern = regexp.MustCompile(`^[0-9a-fA-F]{64}$`)

// requiredArtifactsW0 lists the W0 minimum artifact set. The manifest is
// considered "complete" only when every entry here resolves to a non-empty
// reference. Anything missing is recorded in validation.missingArtifacts and
// the status flips to "incomplete".
var requiredArtifactsW0 = []string{
	"sourceCobol",
	"semanticIr",
	"generatedJava",
	"buildTestResults",
	"harnessEvents",
	"modelInvocations",
}

// requiredArtifactsW02 (Issue #171, extended by Issue #217) lists the
// artifacts a reviewer needs to reconstruct a W0.2 productive-agent run
// end-to-end. Successful W0.2 runs must materialise every entry below;
// absence flips completenessStatus to "evidence_incomplete" and refuses
// success classification.
//
// Issue #217 (W0.3-6) adds:
//   - assistDecision: the Orchestrator-owned assist-decision recorded for
//     this run, so the pack always answers "was AI required, and why?".
//   - budgetSummary: the final consumption snapshot of the three bounded
//     run budgets (repair, assist, model invocation), so the pack always
//     records the budget pressure observed during the run.
//
// Both fields are required for non-blocked runs. Blocked runs may legitimately
// terminate before the assist-decision gate fires (e.g., parse_failed); for
// those, validateBlockedW02RequiredArtifacts in store.go relaxes the
// assistDecision requirement while keeping budgetSummary mandatory.
var requiredArtifactsW02 = []string{
	"sourceCobol",
	"sourceMetadata",
	"parseOutput",
	"semanticIr",
	"generatedJava",
	"generatedJavaArtifacts",
	"finalJavaArtifact",
	"runtimeVersion",
	"buildTestResults",
	"oracleComparison",
	"harnessEvents",
	"modelInvocations",
	"agentTrajectories",
	"assistDecision",
	"budgetSummary",
}

// DataReference matches the dataReference $def in
// schemas/evidence-pack-manifest-v0.json and across the other v0 schemas in
// this repository. URI + sha256 lets the bundle stay machine-readable without
// shipping raw payloads.
type DataReference struct {
	URI      string `json:"uri"`
	SHA256   string `json:"sha256"`
	ByteSize int64  `json:"byteSize"`
	MIMEType string `json:"mimeType,omitempty"`
	Kind     string `json:"kind,omitempty"`
}

func (r DataReference) IsZero() bool {
	return r.URI == "" && r.SHA256 == "" && r.ByteSize == 0
}

func (r DataReference) Validate(path string) error {
	if r.URI == "" {
		return fieldError(path+".uri", "uri is required")
	}
	if ContainsSecretLike(r.URI) {
		return fieldError(path+".uri", "uri appears to contain a secret or credential and was rejected by evidence-service")
	}
	if parsed, err := url.Parse(r.URI); err == nil {
		scheme := strings.ToLower(parsed.Scheme)
		if (scheme == "http" || scheme == "https") && parsed.RawQuery != "" {
			return fieldError(path+".uri", "http artifact uri must not contain query parameters")
		}
	}
	if r.SHA256 == "" {
		return fieldError(path+".sha256", "sha256 is required")
	}
	if !sha256Pattern.MatchString(r.SHA256) {
		return fieldError(path+".sha256", "sha256 must be 64 hex chars")
	}
	if _, err := hex.DecodeString(r.SHA256); err != nil {
		return fieldError(path+".sha256", "sha256 must be valid hex")
	}
	if r.ByteSize < 0 {
		return fieldError(path+".byteSize", "byteSize must be non-negative")
	}
	return nil
}

type TransformationPass struct {
	Name           string         `json:"name"`
	Order          int            `json:"order,omitempty"`
	InputRef       *DataReference `json:"inputRef,omitempty"`
	OutputRef      DataReference  `json:"outputRef"`
	PolicyDecision string         `json:"policyDecision,omitempty"`
}

func (p TransformationPass) Validate(path string) error {
	if p.Name == "" {
		return fieldError(path+".name", "name is required")
	}
	if err := p.OutputRef.Validate(path + ".outputRef"); err != nil {
		return err
	}
	if p.InputRef != nil {
		if err := p.InputRef.Validate(path + ".inputRef"); err != nil {
			return err
		}
	}
	return nil
}

type ModelInvocationRef struct {
	InvocationID          string        `json:"invocationId"`
	ModelID               string        `json:"modelId"`
	Provider              string        `json:"provider,omitempty"`
	PromptTemplateVersion string        `json:"promptTemplateVersion,omitempty"`
	PromptTemplateID      string        `json:"promptTemplateId,omitempty"`
	PolicyDecision        string        `json:"policyDecision,omitempty"`
	Status                string        `json:"status,omitempty"`
	Reason                string        `json:"reason,omitempty"`
	PolicyVersion         string        `json:"policyVersion,omitempty"`
	PolicyID              string        `json:"policyId,omitempty"`
	AgentRole             string        `json:"agentRole,omitempty"`
	LatencyMs             int64         `json:"latencyMs,omitempty"`
	ErrorCode             string        `json:"errorCode,omitempty"`
	ErrorClass            string        `json:"errorClass,omitempty"`
	Timestamp             string        `json:"timestamp,omitempty"`
	LedgerRef             DataReference `json:"ledgerRef"`
}

func (m ModelInvocationRef) Validate(path string) error {
	if m.InvocationID == "" {
		return fieldError(path+".invocationId", "invocationId is required")
	}
	if m.ModelID == "" {
		return fieldError(path+".modelId", "modelId is required")
	}
	if err := m.LedgerRef.Validate(path + ".ledgerRef"); err != nil {
		return err
	}
	// Issue #171 — fail closed if a caller smuggled raw secrets into any
	// stringly-typed field. Evidence packs are reviewer-visible and must
	// never contain credentials, API keys, bearer tokens, or model-provider
	// secrets even when the upstream caller is well-behaved most of the
	// time.
	for fieldName, value := range map[string]string{
		"invocationId":          m.InvocationID,
		"modelId":               m.ModelID,
		"provider":              m.Provider,
		"promptTemplateVersion": m.PromptTemplateVersion,
		"promptTemplateId":      m.PromptTemplateID,
		"policyDecision":        m.PolicyDecision,
		"status":                m.Status,
		"reason":                m.Reason,
		"policyVersion":         m.PolicyVersion,
		"policyId":              m.PolicyID,
		"agentRole":             m.AgentRole,
		"errorCode":             m.ErrorCode,
		"errorClass":            m.ErrorClass,
		"timestamp":             m.Timestamp,
	} {
		if ContainsSecretLike(value) {
			return fieldError(path+"."+fieldName, "value appears to contain a secret or credential and was rejected by evidence-service")
		}
	}
	return nil
}

// JavaCandidateRef (Issue #171) references a single Java candidate persisted
// during a W0.2 run together with the metadata reviewers need to attribute
// it: which agent produced it (origin) and which repair attempt yielded it.
type JavaCandidateRef struct {
	URI           string `json:"uri"`
	SHA256        string `json:"sha256"`
	ByteSize      int64  `json:"byteSize"`
	MIMEType      string `json:"mimeType,omitempty"`
	Kind          string `json:"kind,omitempty"`
	Origin        string `json:"origin"`
	AttemptNumber int    `json:"attemptNumber"`
	Selected      bool   `json:"selected,omitempty"`
}

func (c JavaCandidateRef) IsZero() bool {
	return c.URI == "" && c.SHA256 == "" && c.ByteSize == 0 && c.Origin == ""
}

func (c JavaCandidateRef) Validate(path string) error {
	if err := c.AsDataReference().Validate(path); err != nil {
		return err
	}
	switch c.Origin {
	case JavaCandidateOriginBaseline,
		JavaCandidateOriginTransformationAgent,
		JavaCandidateOriginVerificationRepair:
	default:
		return fieldError(path+".origin", "origin must be deterministic-baseline|transformation-agent|verification-repair-agent")
	}
	if c.AttemptNumber < 0 {
		return fieldError(path+".attemptNumber", "attemptNumber must be non-negative")
	}
	return nil
}

// AsDataReference returns the value-typed DataReference subset of a candidate
// so callers can re-use the standard reference-only helpers.
func (c JavaCandidateRef) AsDataReference() DataReference {
	return DataReference{
		URI:      c.URI,
		SHA256:   c.SHA256,
		ByteSize: c.ByteSize,
		MIMEType: c.MIMEType,
		Kind:     c.Kind,
	}
}

// RepairAttempt (Issue #171) captures one Verification/Repair Agent
// invocation. attemptNumber matches the orchestrator's repair counter; the
// referenced build/test result is the run that triggered the call.
type RepairAttempt struct {
	AttemptNumber       int                 `json:"attemptNumber"`
	Decision            string              `json:"decision"`
	DecisionRef         *DataReference      `json:"decisionRef,omitempty"`
	ModelInvocationRef  *ModelInvocationRef `json:"modelInvocationRef,omitempty"`
	NewJavaCandidateRef *JavaCandidateRef   `json:"newJavaCandidateRef,omitempty"`
	BuildTestResultRef  DataReference       `json:"buildTestResultRef"`
	RefusalCode         string              `json:"refusalCode,omitempty"`
	NoChange            bool                `json:"noChange,omitempty"`
}

func (r RepairAttempt) Validate(path string) error {
	if r.AttemptNumber <= 0 {
		return fieldError(path+".attemptNumber", "attemptNumber must be > 0")
	}
	switch r.Decision {
	case RepairDecisionProposeCandidate,
		RepairDecisionRefuse,
		RepairDecisionEscalate,
		RepairDecisionNoChange:
	default:
		return fieldError(path+".decision", "decision must be propose_candidate|refuse|escalate|no_change")
	}
	if err := r.BuildTestResultRef.Validate(path + ".buildTestResultRef"); err != nil {
		return err
	}
	if r.DecisionRef != nil {
		if err := r.DecisionRef.Validate(path + ".decisionRef"); err != nil {
			return err
		}
	}
	if r.ModelInvocationRef != nil {
		if err := r.ModelInvocationRef.Validate(path + ".modelInvocationRef"); err != nil {
			return err
		}
	}
	if r.NewJavaCandidateRef != nil {
		if err := r.NewJavaCandidateRef.Validate(path + ".newJavaCandidateRef"); err != nil {
			return err
		}
	}
	if r.Decision == RepairDecisionProposeCandidate && r.NewJavaCandidateRef == nil {
		return fieldError(path+".newJavaCandidateRef", "propose_candidate decisions must reference the new Java candidate")
	}
	if (r.Decision == RepairDecisionRefuse || r.Decision == RepairDecisionEscalate) && r.RefusalCode == "" {
		return fieldError(path+".refusalCode", "refuse/escalate decisions must include a refusalCode")
	}
	return nil
}

// AgentTrajectoryRef (Issue #171) references one agent's trajectory ledger
// for the run. Multiple entries are expected when several productive agents
// run during a W0.2 workflow.
type AgentTrajectoryRef struct {
	AgentRole string        `json:"agentRole"`
	LedgerRef DataReference `json:"ledgerRef"`
}

func (t AgentTrajectoryRef) Validate(path string) error {
	switch t.AgentRole {
	case AgentRoleOrchestrator,
		AgentRoleTransformation,
		AgentRoleVerificationRepair:
	default:
		return fieldError(path+".agentRole", "agentRole must be orchestrator|transformation|verification-repair")
	}
	return t.LedgerRef.Validate(path + ".ledgerRef")
}

// OracleComparison (Issue #171) records the comparison between the run's
// actual Java output and the oracle / golden master. matched=false means the
// run is not classifiable as success at the evidence layer regardless of
// whether the deterministic build/test gate passed.
type OracleComparison struct {
	Matched            bool           `json:"matched"`
	OracleKind         string         `json:"oracleKind,omitempty"`
	ExpectedRef        *DataReference `json:"expectedRef,omitempty"`
	ActualRef          *DataReference `json:"actualRef,omitempty"`
	ExpectedSHA256     string         `json:"expectedSha256,omitempty"`
	ActualSHA256       string         `json:"actualSha256,omitempty"`
	BuildTestResultRef *DataReference `json:"buildTestResultRef,omitempty"`
	Classification     string         `json:"classification,omitempty"`
	Summary            string         `json:"summary,omitempty"`
}

func (o OracleComparison) IsZero() bool {
	return !o.Matched &&
		o.OracleKind == "" &&
		o.ExpectedRef == nil &&
		o.ActualRef == nil &&
		o.ExpectedSHA256 == "" &&
		o.ActualSHA256 == "" &&
		o.BuildTestResultRef == nil &&
		o.Classification == "" &&
		o.Summary == ""
}

func (o OracleComparison) Validate(path string) error {
	if o.OracleKind != "" {
		switch o.OracleKind {
		case OracleKindCobolRuntime,
			OracleKindSynthetic,
			OracleKindTrueGoldenMaster,
			OracleKindUserProvided,
			OracleKindAbsent:
		default:
			return fieldError(path+".oracleKind", "oracleKind must be cobol-runtime|synthetic|true-golden-master|user-provided|absent")
		}
	}
	if o.ExpectedSHA256 != "" && !sha256Pattern.MatchString(o.ExpectedSHA256) {
		return fieldError(path+".expectedSha256", "expectedSha256 must be 64 hex chars")
	}
	if o.ActualSHA256 != "" && !sha256Pattern.MatchString(o.ActualSHA256) {
		return fieldError(path+".actualSha256", "actualSha256 must be 64 hex chars")
	}
	if o.ExpectedRef != nil {
		if err := o.ExpectedRef.Validate(path + ".expectedRef"); err != nil {
			return err
		}
	}
	if o.ActualRef != nil {
		if err := o.ActualRef.Validate(path + ".actualRef"); err != nil {
			return err
		}
	}
	if o.BuildTestResultRef != nil {
		if err := o.BuildTestResultRef.Validate(path + ".buildTestResultRef"); err != nil {
			return err
		}
	}
	return nil
}

type RuntimeVersion struct {
	ID  string         `json:"id"`
	Ref *DataReference `json:"ref,omitempty"`
}

func (rv RuntimeVersion) IsZero() bool {
	return rv.ID == "" && (rv.Ref == nil || rv.Ref.IsZero())
}

// BudgetSnapshot (Issue #217) is the per-budget snapshot embedded inside
// BudgetSummary and AssistDecisionLineage. limit and used are authoritative;
// remaining is materialised for consumers (always max(0, limit-used)).
type BudgetSnapshot struct {
	Limit     int `json:"limit"`
	Used      int `json:"used"`
	Remaining int `json:"remaining"`
}

func (b BudgetSnapshot) IsZero() bool {
	return b.Limit == 0 && b.Used == 0 && b.Remaining == 0
}

func (b BudgetSnapshot) Validate(path string) error {
	if b.Limit < 0 {
		return fieldError(path+".limit", "limit must be non-negative")
	}
	if b.Used < 0 {
		return fieldError(path+".used", "used must be non-negative")
	}
	if b.Remaining < 0 {
		return fieldError(path+".remaining", "remaining must be non-negative")
	}
	expectedRemaining := b.Limit - b.Used
	if expectedRemaining < 0 {
		expectedRemaining = 0
	}
	if b.Remaining != expectedRemaining {
		return fieldError(path+".remaining", "remaining must equal max(0, limit - used)")
	}
	return nil
}

// BudgetSummary (Issue #217) records the end-of-run consumption snapshot for
// the three bounded run budgets defined in Issue #216 (repair, assist, model
// invocation). Required on every W0.2 pack — including blocked packs — so
// reviewers can always answer "what budget pressure did this run encounter?".
type BudgetSummary struct {
	Repair          BudgetSnapshot `json:"repair"`
	Assist          BudgetSnapshot `json:"assist"`
	ModelInvocation BudgetSnapshot `json:"modelInvocation"`
}

func (b *BudgetSummary) IsZero() bool {
	if b == nil {
		return true
	}
	return b.Repair.IsZero() && b.Assist.IsZero() && b.ModelInvocation.IsZero()
}

func (b *BudgetSummary) Validate(path string) error {
	if b == nil {
		return fieldError(path, "budgetSummary is required")
	}
	if err := b.Repair.Validate(path + ".repair"); err != nil {
		return err
	}
	if err := b.Assist.Validate(path + ".assist"); err != nil {
		return err
	}
	if err := b.ModelInvocation.Validate(path + ".modelInvocation"); err != nil {
		return err
	}
	return nil
}

// AssistDecisionLineage (Issue #217) mirrors the orchestrator's AssistDecision
// contract (Issues #214/#215/#216) inside the evidence pack so reviewers can
// answer "was AI required, why, and against which budgets?" without
// re-fetching the run contract. The closed enums are intentionally identical
// to the BFF's AssistDecisionSummary and the orchestrator's run_contract
// constants — drift is a contract bug.
type AssistDecisionLineage struct {
	Outcome                       string          `json:"outcome"`
	ReasonCode                    string          `json:"reasonCode"`
	DecidedAt                     string          `json:"decidedAt"`
	SelectedAgentRole             string          `json:"selectedAgentRole,omitempty"`
	Rationale                     string          `json:"rationale,omitempty"`
	RepairBudgetSnapshot          *BudgetSnapshot `json:"repairBudgetSnapshot,omitempty"`
	AssistBudgetSnapshot          *BudgetSnapshot `json:"assistBudgetSnapshot,omitempty"`
	ModelInvocationBudgetSnapshot *BudgetSnapshot `json:"modelInvocationBudgetSnapshot,omitempty"`
	AffectedArtifactRefs          []DataReference `json:"affectedArtifactRefs,omitempty"`
}

func (a *AssistDecisionLineage) IsZero() bool {
	if a == nil {
		return true
	}
	return a.Outcome == "" && a.ReasonCode == "" && a.DecidedAt == ""
}

func (a *AssistDecisionLineage) Validate(path string) error {
	if a == nil {
		return fieldError(path, "assistDecision is required")
	}
	switch a.Outcome {
	case AssistOutcomeRequired, AssistOutcomeNotRequired:
	default:
		return fieldError(path+".outcome", "outcome must be assist_required|assist_not_required")
	}
	switch a.ReasonCode {
	case AssistReasonSemanticIRBoundedAmbiguity,
		AssistReasonTranslationUnsupportedRepairable,
		AssistReasonBaselineOpenAssumptions,
		AssistReasonDeterministicCandidateLowConfidence,
		AssistReasonCallerExplicitOptIn,
		AssistReasonCallerDidNotOptIn,
		AssistReasonAssistBudgetExhausted:
	default:
		return fieldError(path+".reasonCode", "reasonCode must be one of the closed W0.3 assist-decision reason codes")
	}
	if a.DecidedAt == "" {
		return fieldError(path+".decidedAt", "decidedAt is required")
	}
	if a.SelectedAgentRole != "" && a.SelectedAgentRole != AssistAgentRoleTransformation {
		return fieldError(path+".selectedAgentRole", "selectedAgentRole must be transformation_agent when set")
	}
	if a.Outcome == AssistOutcomeRequired && a.SelectedAgentRole == "" {
		return fieldError(path+".selectedAgentRole", "assist_required outcome requires a selectedAgentRole")
	}
	if a.Outcome == AssistOutcomeNotRequired && a.SelectedAgentRole != "" {
		return fieldError(path+".selectedAgentRole", "assist_not_required outcome must not carry a selectedAgentRole")
	}
	if a.ReasonCode == AssistReasonAssistBudgetExhausted && a.Outcome != AssistOutcomeNotRequired {
		// Issue #216: budget-exhausted always degrades to assist_not_required.
		return fieldError(path+".outcome", "assist_budget_exhausted reason requires outcome=assist_not_required")
	}
	// Issue #217: a decision that REACHED the gate (i.e., it was recorded at
	// all) must carry all three gate-time budget snapshots so reviewers can
	// audit the budget posture the orchestrator observed at decision time.
	// Decisions emitted for the not-required-baseline cases still passed
	// through the gate and thus still have the snapshots — there is no
	// path that records a decision without first sampling the budgets.
	for _, snapshot := range []struct {
		ref  *BudgetSnapshot
		path string
	}{
		{a.RepairBudgetSnapshot, path + ".repairBudgetSnapshot"},
		{a.AssistBudgetSnapshot, path + ".assistBudgetSnapshot"},
		{a.ModelInvocationBudgetSnapshot, path + ".modelInvocationBudgetSnapshot"},
	} {
		if snapshot.ref == nil {
			return fieldError(snapshot.path, "gate-time budget snapshot is required on every recorded assist-decision")
		}
		if err := snapshot.ref.Validate(snapshot.path); err != nil {
			return err
		}
	}
	for i, ref := range a.AffectedArtifactRefs {
		if err := ref.Validate(fmt.Sprintf("%s.affectedArtifactRefs[%d]", path, i)); err != nil {
			return err
		}
	}
	if ContainsSecretLike(a.Rationale) {
		return fieldError(path+".rationale", "rationale appears to contain a secret or credential and was rejected by evidence-service")
	}
	return nil
}

type Artifacts struct {
	SourceCobol            []DataReference      `json:"sourceCobol,omitempty"`
	SourceMetadata         *DataReference       `json:"sourceMetadata,omitempty"`
	CorpusMetadata         *DataReference       `json:"corpusMetadata,omitempty"`
	ParseOutput            *DataReference       `json:"parseOutput,omitempty"`
	SemanticIR             *DataReference       `json:"semanticIr,omitempty"`
	TransformationPasses   []TransformationPass `json:"transformationPasses,omitempty"`
	GeneratedJava          *DataReference       `json:"generatedJava,omitempty"`
	GeneratedJavaArtifacts []JavaCandidateRef   `json:"generatedJavaArtifacts,omitempty"`
	FinalJavaArtifact      *JavaCandidateRef    `json:"finalJavaArtifact,omitempty"`
	RepairAttempts         []RepairAttempt      `json:"repairAttempts,omitempty"`
	AgentTrajectories      []AgentTrajectoryRef `json:"agentTrajectories,omitempty"`
	OracleComparison       *OracleComparison    `json:"oracleComparison,omitempty"`
	RuntimeVersion         *RuntimeVersion      `json:"runtimeVersion,omitempty"`
	ModelInvocations       []ModelInvocationRef `json:"modelInvocations,omitempty"`
	BuildTestResults       []DataReference      `json:"buildTestResults,omitempty"`
	SBOM                   []DataReference      `json:"sbom,omitempty"`
	LicenseReports         []DataReference      `json:"licenseReports,omitempty"`
	HarnessEvents          *DataReference       `json:"harnessEvents,omitempty"`
	TrajectoryLedger       *DataReference       `json:"trajectoryLedger,omitempty"`
	ExperienceEvents       []DataReference      `json:"experienceEvents,omitempty"`
	// Issue #217 (W0.3-6): assist-decision and budget-consumption lineage.
	// AssistDecision is required for non-blocked W0.2 runs; BudgetSummary is
	// required for every W0.2 run (including blocked ones).
	AssistDecision *AssistDecisionLineage `json:"assistDecision,omitempty"`
	BudgetSummary  *BudgetSummary         `json:"budgetSummary,omitempty"`
	// ADR 0007 (#257, Issue #279): reference to the per-region manual-edit
	// overlay JSON. Present iff the run-summary
	// ``manualEditsCarriedOver`` flag is true; omitted when false. Structural
	// validation lives on the ref type itself; the "missing overlay when
	// carried_over=true" reporting lives in EvaluateValidationForManifest;
	// the strict cross-field consistency (signal ↔ overlay, regionCount
	// tally, "MUST be absent when false") is enforced in manifest.Validate
	// via validateManualEditConsistency.
	ManualEditOverlay *ManualEditOverlayRef `json:"manualEditOverlay,omitempty"`
}

// ManualEditOverlayRef (ADR 0007 #257, Issue #279) references the per-region
// manual-edit overlay JSON artifact persisted alongside a W0.2 run's Java
// candidate history. Required when the run-summary
// “manualEditsCarriedOver“ flag is true; absent when the flag is false.
// The overlay body itself is content-addressed JSON of the shape
// “{ schemaVersion: "v0", regions: ManualEditRegion[] }“ documented in
// ADR 0007 §3 — evidence-service does not dereference or re-validate the
// inner body, but enforces the structural envelope (URI, sha256, byte size,
// schema version, region count) and the cross-field consistency rule.
type ManualEditOverlayRef struct {
	URI           string `json:"uri"`
	SHA256        string `json:"sha256"`
	ByteSize      int64  `json:"byteSize"`
	MIMEType      string `json:"mimeType,omitempty"`
	Kind          string `json:"kind,omitempty"`
	SchemaVersion string `json:"schemaVersion,omitempty"`
	RegionCount   int    `json:"regionCount"`
}

func (r *ManualEditOverlayRef) IsZero() bool {
	if r == nil {
		return true
	}
	return r.URI == "" && r.SHA256 == "" && r.ByteSize == 0 && r.RegionCount == 0
}

func (r *ManualEditOverlayRef) AsDataReference() DataReference {
	if r == nil {
		return DataReference{}
	}
	return DataReference{
		URI:      r.URI,
		SHA256:   r.SHA256,
		ByteSize: r.ByteSize,
		MIMEType: r.MIMEType,
		Kind:     r.Kind,
	}
}

func (r *ManualEditOverlayRef) Validate(path string) error {
	if r == nil {
		return fieldError(path, "manualEditOverlay is required")
	}
	if err := r.AsDataReference().Validate(path); err != nil {
		return err
	}
	if r.SchemaVersion != "" && r.SchemaVersion != SchemaVersionV0 {
		return fieldError(path+".schemaVersion", "schemaVersion must be v0 when set")
	}
	// regionCount mirrors the run-summary manualDriftRegionCount and MUST
	// be > 0 on a persisted overlay. An overlay with zero regions is
	// indistinguishable from "no manual edits" and MUST be omitted entirely
	// (the orchestrator drops it before persistence).
	if r.RegionCount <= 0 {
		return fieldError(path+".regionCount", "regionCount must be > 0 when the overlay is persisted")
	}
	return nil
}

type OpenAssumption struct {
	ID          string `json:"id"`
	Description string `json:"description"`
	Owner       string `json:"owner,omitempty"`
}

type UnsupportedFeature struct {
	Feature   string         `json:"feature"`
	Context   string         `json:"context,omitempty"`
	SourceRef *DataReference `json:"sourceRef,omitempty"`
}

type ValidationResult struct {
	OK                 bool     `json:"ok"`
	RequiredArtifacts  []string `json:"requiredArtifacts"`
	MissingArtifacts   []string `json:"missingArtifacts"`
	Messages           []string `json:"messages,omitempty"`
	CompletenessStatus string   `json:"completenessStatus"`
}

type ExportRecord struct {
	Format    string    `json:"format"`
	URI       string    `json:"uri"`
	SHA256    string    `json:"sha256,omitempty"`
	ByteSize  int64     `json:"byteSize,omitempty"`
	CreatedAt time.Time `json:"createdAt"`
}

// EvidencePackManifest matches the JSON schema at
// schemas/evidence-pack-manifest-v0.json. The "wave" field is "w0" or
// "w0.2"; the latter activates the W0.2 completeness rules (Issue #171).
type EvidencePackManifest struct {
	SchemaVersion      string `json:"schemaVersion"`
	Capability         string `json:"capability"`
	Service            string `json:"service"`
	PackID             string `json:"packId"`
	RunID              string `json:"runId"`
	WorkflowID         string `json:"workflowId,omitempty"`
	Wave               string `json:"wave"`
	Status             string `json:"status"`
	CompletenessStatus string `json:"completenessStatus"`
	Classification     string `json:"classification"`
	Summary            string `json:"summary,omitempty"`
	// ADR 0007 (#257, Issue #279): manual-edit provenance mirrors of
	// W02RunContract.manual_edits_carried_over and
	// W02RunContract.manual_drift_region_count. ``omitempty`` keeps the
	// pre-ADR-0007 wire shape unchanged for runs that never carried
	// manual edits; consumers MUST treat absence as false / 0 per
	// ADR 0006 §2.
	ManualEditsCarriedOver bool                 `json:"manualEditsCarriedOver,omitempty"`
	ManualDriftRegionCount int                  `json:"manualDriftRegionCount,omitempty"`
	CreatedAt              time.Time            `json:"createdAt"`
	CreatedBy              string               `json:"createdBy,omitempty"`
	Artifacts              Artifacts            `json:"artifacts"`
	OpenAssumptions        []OpenAssumption     `json:"openAssumptions,omitempty"`
	UnsupportedFeatures    []UnsupportedFeature `json:"unsupportedFeatures,omitempty"`
	Validation             ValidationResult     `json:"validation"`
	Exports                []ExportRecord       `json:"exports,omitempty"`
}

func fieldError(path, reason string) error {
	return &FieldValidationError{Path: path, Reason: reason}
}

type FieldValidationError struct {
	Path   string `json:"path"`
	Reason string `json:"reason"`
}

func (e *FieldValidationError) Error() string {
	return fmt.Sprintf("%s: %s", e.Path, e.Reason)
}

func IsFieldValidationError(err error) bool {
	var fve *FieldValidationError
	return errors.As(err, &fve)
}

func (m *EvidencePackManifest) Validate() error {
	if m.SchemaVersion != SchemaVersionV0 {
		return fieldError("schemaVersion", "schemaVersion must be v0")
	}
	if m.Capability != CapabilityEvidence {
		return fieldError("capability", "capability must be evidence.pack")
	}
	if m.Service == "" {
		return fieldError("service", "service is required")
	}
	if !packIDPattern.MatchString(m.PackID) {
		return fieldError("packId", "packId must match epk-[A-Za-z0-9._-]+")
	}
	if m.RunID == "" {
		return fieldError("runId", "runId is required")
	}
	switch m.Wave {
	case WaveW0, WaveW02:
	default:
		return fieldError("wave", "wave must be w0 or w0.2")
	}
	switch m.Status {
	case StatusComplete, StatusIncomplete, StatusInvalid:
	default:
		return fieldError("status", "status must be complete|incomplete|invalid")
	}
	if m.CompletenessStatus == "" {
		return fieldError("completenessStatus", "completenessStatus is required")
	}
	switch m.CompletenessStatus {
	case CompletenessStatusComplete,
		CompletenessStatusEvidenceIncomplete,
		CompletenessStatusBlocked:
	default:
		return fieldError("completenessStatus", "completenessStatus must be complete|evidence_incomplete|blocked")
	}
	if m.Classification == "" {
		return fieldError("classification", "classification is required")
	}
	switch m.Classification {
	case ClassificationSuccess,
		ClassificationEvidenceIncomplete,
		ClassificationBlocked,
		ClassificationFailed:
	default:
		return fieldError("classification", "classification must be success|evidence_incomplete|blocked|failed")
	}
	if m.Validation.CompletenessStatus == "" {
		return fieldError("validation.completenessStatus", "completenessStatus is required")
	}
	if m.Validation.CompletenessStatus != m.CompletenessStatus {
		return fieldError("validation.completenessStatus", "must match top-level completenessStatus")
	}
	if m.Classification == ClassificationSuccess && m.CompletenessStatus != CompletenessStatusComplete {
		return fieldError("classification", "success requires completenessStatus=complete")
	}
	if m.CompletenessStatus == CompletenessStatusBlocked && m.Classification != ClassificationBlocked {
		return fieldError("classification", "blocked completenessStatus requires classification=blocked")
	}
	if m.CreatedAt.IsZero() {
		return fieldError("createdAt", "createdAt is required")
	}
	if err := validateManualEditConsistency(
		m.ManualEditsCarriedOver,
		m.ManualDriftRegionCount,
		m.Artifacts.ManualEditOverlay,
	); err != nil {
		return err
	}
	return validateArtifactsShape(&m.Artifacts)
}

// validateManualEditConsistency (ADR 0007 #257, Issue #279) enforces the
// cross-field contract between the run-summary signals
// (“manualEditsCarriedOver“ / “manualDriftRegionCount“) and the
// “artifacts.manualEditOverlay“ reference. The orchestrator owns both
// inputs; evidence-service fails closed when they disagree so a reviewer
// never sees a pack that claims manual edits without an overlay (or vice
// versa).
//
// The forbiddance branch treats ANY non-nil overlay pointer as "present"
// — including a zero-valued “{}“ — because Go's “omitempty“ on a
// pointer only suppresses serialisation when the pointer itself is nil,
// not when it points at an empty struct. Storing a non-nil zero overlay
// would otherwise leak a stale “manualEditOverlay: {}“ object onto the
// manifest. The presence branch is stricter: it also requires the overlay
// to be non-zero so a structurally valid ref is what reaches downstream
// consumers.
func validateManualEditConsistency(
	carriedOver bool,
	driftRegionCount int,
	overlay *ManualEditOverlayRef,
) error {
	if driftRegionCount < 0 {
		return fieldError("manualDriftRegionCount", "manualDriftRegionCount must be non-negative")
	}
	overlayPresent := overlay != nil && !overlay.IsZero()
	switch {
	case carriedOver && driftRegionCount == 0:
		return fieldError(
			"manualDriftRegionCount",
			"manualEditsCarriedOver=true requires manualDriftRegionCount > 0",
		)
	case !carriedOver && driftRegionCount > 0:
		return fieldError(
			"manualDriftRegionCount",
			"manualDriftRegionCount > 0 requires manualEditsCarriedOver=true",
		)
	case carriedOver && !overlayPresent:
		return fieldError(
			"artifacts.manualEditOverlay",
			"manualEditsCarriedOver=true requires artifacts.manualEditOverlay",
		)
	case !carriedOver && overlay != nil:
		return fieldError(
			"artifacts.manualEditOverlay",
			"manualEditsCarriedOver=false forbids artifacts.manualEditOverlay",
		)
	}
	if overlayPresent && overlay.RegionCount != driftRegionCount {
		return fieldError(
			"artifacts.manualEditOverlay.regionCount",
			"manualEditOverlay.regionCount must equal manualDriftRegionCount",
		)
	}
	return nil
}

// validateArtifactsShape enforces structural rules on individual references
// without re-running the "is the required set populated?" check (that lives
// in EvaluateValidation and is reflected in manifest.validation).
func validateArtifactsShape(a *Artifacts) error {
	for i, ref := range a.SourceCobol {
		if err := ref.Validate(fmt.Sprintf("artifacts.sourceCobol[%d]", i)); err != nil {
			return err
		}
	}
	if a.SourceMetadata != nil {
		if err := a.SourceMetadata.Validate("artifacts.sourceMetadata"); err != nil {
			return err
		}
	}
	if a.CorpusMetadata != nil {
		if err := a.CorpusMetadata.Validate("artifacts.corpusMetadata"); err != nil {
			return err
		}
	}
	if a.ParseOutput != nil {
		if err := a.ParseOutput.Validate("artifacts.parseOutput"); err != nil {
			return err
		}
	}
	if a.SemanticIR != nil {
		if err := a.SemanticIR.Validate("artifacts.semanticIr"); err != nil {
			return err
		}
	}
	for i, pass := range a.TransformationPasses {
		if err := pass.Validate(fmt.Sprintf("artifacts.transformationPasses[%d]", i)); err != nil {
			return err
		}
	}
	if a.GeneratedJava != nil {
		if err := a.GeneratedJava.Validate("artifacts.generatedJava"); err != nil {
			return err
		}
	}
	for i, c := range a.GeneratedJavaArtifacts {
		if err := c.Validate(fmt.Sprintf("artifacts.generatedJavaArtifacts[%d]", i)); err != nil {
			return err
		}
	}
	if a.FinalJavaArtifact != nil {
		if err := a.FinalJavaArtifact.Validate("artifacts.finalJavaArtifact"); err != nil {
			return err
		}
	}
	for i, r := range a.RepairAttempts {
		if err := r.Validate(fmt.Sprintf("artifacts.repairAttempts[%d]", i)); err != nil {
			return err
		}
	}
	for i, t := range a.AgentTrajectories {
		if err := t.Validate(fmt.Sprintf("artifacts.agentTrajectories[%d]", i)); err != nil {
			return err
		}
	}
	if a.OracleComparison != nil {
		if err := a.OracleComparison.Validate("artifacts.oracleComparison"); err != nil {
			return err
		}
	}
	if a.RuntimeVersion != nil {
		if a.RuntimeVersion.ID == "" {
			return fieldError("artifacts.runtimeVersion.id", "id is required")
		}
		if a.RuntimeVersion.Ref != nil {
			if err := a.RuntimeVersion.Ref.Validate("artifacts.runtimeVersion.ref"); err != nil {
				return err
			}
		}
	}
	for i, inv := range a.ModelInvocations {
		if err := inv.Validate(fmt.Sprintf("artifacts.modelInvocations[%d]", i)); err != nil {
			return err
		}
	}
	for i, ref := range a.BuildTestResults {
		if err := ref.Validate(fmt.Sprintf("artifacts.buildTestResults[%d]", i)); err != nil {
			return err
		}
	}
	for i, ref := range a.SBOM {
		if err := ref.Validate(fmt.Sprintf("artifacts.sbom[%d]", i)); err != nil {
			return err
		}
	}
	for i, ref := range a.LicenseReports {
		if err := ref.Validate(fmt.Sprintf("artifacts.licenseReports[%d]", i)); err != nil {
			return err
		}
	}
	if a.HarnessEvents != nil {
		if err := a.HarnessEvents.Validate("artifacts.harnessEvents"); err != nil {
			return err
		}
	}
	if a.TrajectoryLedger != nil {
		if err := a.TrajectoryLedger.Validate("artifacts.trajectoryLedger"); err != nil {
			return err
		}
	}
	for i, ref := range a.ExperienceEvents {
		if err := ref.Validate(fmt.Sprintf("artifacts.experienceEvents[%d]", i)); err != nil {
			return err
		}
	}
	if a.AssistDecision != nil && !a.AssistDecision.IsZero() {
		if err := a.AssistDecision.Validate("artifacts.assistDecision"); err != nil {
			return err
		}
	}
	if a.BudgetSummary != nil && !a.BudgetSummary.IsZero() {
		if err := a.BudgetSummary.Validate("artifacts.budgetSummary"); err != nil {
			return err
		}
	}
	if a.ManualEditOverlay != nil {
		// Validate any non-nil overlay structurally — including a
		// zero-valued ``{}`` — so the structural check is defence-in-depth
		// for the cross-field rule in validateManualEditConsistency. A
		// non-nil empty overlay surfaces as "uri is required" here even
		// if the caller's payload bypassed the cross-field check (e.g.,
		// via a future code path that calls validateArtifactsShape
		// directly).
		if err := a.ManualEditOverlay.Validate("artifacts.manualEditOverlay"); err != nil {
			return err
		}
	}
	return nil
}

// EvaluateValidation walks the required artifact set for the given wave and
// reports any missing references. The result is purely informative — the
// manifest can still serialize — but consumers (orchestrator, BFF) should
// refuse to treat the bundle as "complete" unless ok=true. When wave is
// empty or "w0", the W0 minimum set applies; when wave is "w0.2" the W0.2
// extended set applies (Issue #171), which fails closed on missing Java
// candidates, repair-attempt context, agent trajectories, and oracle
// comparison.
func EvaluateValidation(a *Artifacts) ValidationResult {
	return EvaluateValidationForWave(a, WaveW0)
}

func EvaluateValidationForWave(a *Artifacts, wave string) ValidationResult {
	missing := make([]string, 0)
	var required []string
	switch wave {
	case WaveW02:
		required = append([]string{}, requiredArtifactsW02...)
		if len(a.SourceCobol) == 0 {
			missing = append(missing, "sourceCobol")
		}
		if a.SourceMetadata == nil || a.SourceMetadata.IsZero() {
			missing = append(missing, "sourceMetadata")
		}
		if a.ParseOutput == nil || a.ParseOutput.IsZero() {
			missing = append(missing, "parseOutput")
		}
		if a.SemanticIR == nil || a.SemanticIR.IsZero() {
			missing = append(missing, "semanticIr")
		}
		// Either the legacy GeneratedJava ref or the new
		// GeneratedJavaArtifacts/FinalJavaArtifact contract must be
		// populated. We require BOTH the legacy ref (for backwards-
		// compatible consumers) AND the W0.2 fields, because a W0.2 run
		// publishes the deterministic baseline AND the productive-agent
		// candidate; reviewers must be able to inspect every candidate.
		if a.GeneratedJava == nil || a.GeneratedJava.IsZero() {
			missing = append(missing, "generatedJava")
		}
		if len(a.GeneratedJavaArtifacts) == 0 {
			missing = append(missing, "generatedJavaArtifacts")
		}
		if a.FinalJavaArtifact == nil || a.FinalJavaArtifact.IsZero() {
			missing = append(missing, "finalJavaArtifact")
		}
		if len(a.BuildTestResults) == 0 {
			missing = append(missing, "buildTestResults")
		}
		if a.OracleComparison == nil || a.OracleComparison.IsZero() {
			missing = append(missing, "oracleComparison")
		}
		if a.RuntimeVersion == nil || a.RuntimeVersion.IsZero() {
			missing = append(missing, "runtimeVersion")
		}
		if a.HarnessEvents == nil || a.HarnessEvents.IsZero() {
			missing = append(missing, "harnessEvents")
		}
		if len(a.ModelInvocations) == 0 {
			missing = append(missing, "modelInvocations")
		}
		if len(a.AgentTrajectories) == 0 {
			missing = append(missing, "agentTrajectories")
		}
		// Issue #217 (W0.3-6): assist-decision and budget summary are
		// required for the W0.2 evidence pack. budgetSummary stays mandatory
		// on every W0.2 run (including blocked ones); assistDecision is
		// expected for any run that reached the gate, and the store relaxes
		// it for runs blocked before the gate fired (see store.go).
		if a.AssistDecision == nil || a.AssistDecision.IsZero() {
			missing = append(missing, "assistDecision")
		}
		if a.BudgetSummary == nil || a.BudgetSummary.IsZero() {
			missing = append(missing, "budgetSummary")
		}
		missing = append(missing, validateW02ReferentialIntegrity(a)...)
	default:
		required = append([]string{}, requiredArtifactsW0...)
		if len(a.SourceCobol) == 0 {
			missing = append(missing, "sourceCobol")
		}
		if a.SemanticIR == nil || a.SemanticIR.IsZero() {
			missing = append(missing, "semanticIr")
		}
		if a.GeneratedJava == nil || a.GeneratedJava.IsZero() {
			missing = append(missing, "generatedJava")
		}
		if len(a.BuildTestResults) == 0 {
			missing = append(missing, "buildTestResults")
		}
		if a.HarnessEvents == nil || a.HarnessEvents.IsZero() {
			missing = append(missing, "harnessEvents")
		}
		if len(a.ModelInvocations) == 0 {
			missing = append(missing, "modelInvocations")
		}
	}

	messages := make([]string, 0)
	if len(missing) > 0 {
		label := "W0"
		if wave == WaveW02 {
			label = "W0.2"
		}
		messages = append(messages, fmt.Sprintf("missing required %s artifacts: %v", label, missing))
	}
	completenessStatus := CompletenessStatusComplete
	if len(missing) > 0 {
		completenessStatus = CompletenessStatusEvidenceIncomplete
	}
	return ValidationResult{
		OK:                 len(missing) == 0,
		RequiredArtifacts:  required,
		MissingArtifacts:   missing,
		Messages:           messages,
		CompletenessStatus: completenessStatus,
	}
}

// EvaluateValidationForManifest (ADR 0007 #257, Issue #279) augments
// EvaluateValidationForWave with the run-summary signals stamped on the
// manifest. Today it folds the manual-edit overlay completeness rule into
// the validation result: when “manualEditsCarriedOver“ is true and
// “artifacts.manualEditOverlay“ is absent, "manualEditOverlay" surfaces
// in MissingArtifacts so a reviewer can see exactly why the pack flips to
// “evidence_incomplete“.
//
// The strict cross-field contract (signal ↔ overlay, regionCount tally)
// is enforced separately in manifest.Validate via
// validateManualEditConsistency; the validator's job here is to report
// missing artifacts, not to police signal/overlay agreement.
func EvaluateValidationForManifest(m *EvidencePackManifest) ValidationResult {
	if m == nil {
		return ValidationResult{
			OK:                 false,
			RequiredArtifacts:  nil,
			MissingArtifacts:   nil,
			Messages:           []string{"manifest is required"},
			CompletenessStatus: CompletenessStatusEvidenceIncomplete,
		}
	}
	result := EvaluateValidationForWave(&m.Artifacts, m.Wave)
	if m.ManualEditsCarriedOver {
		// Extend RequiredArtifacts so downstream consumers can rely on it as
		// the authoritative list — keep MissingArtifacts ⊆ RequiredArtifacts.
		// Append-only and de-duplicated so re-evaluating the same manifest
		// stays stable across calls.
		if !stringSliceContains(result.RequiredArtifacts, "manualEditOverlay") {
			result.RequiredArtifacts = append(result.RequiredArtifacts, "manualEditOverlay")
		}
		overlay := m.Artifacts.ManualEditOverlay
		if overlay == nil || overlay.IsZero() {
			if !stringSliceContains(result.MissingArtifacts, "manualEditOverlay") {
				result.MissingArtifacts = append(result.MissingArtifacts, "manualEditOverlay")
			}
			result.OK = false
			result.CompletenessStatus = CompletenessStatusEvidenceIncomplete
			result.Messages = append(
				result.Messages,
				"manualEditsCarriedOver=true requires the manualEditOverlay artifact",
			)
		}
	}
	return result
}

// stringSliceContains is a tiny O(n) membership check used to keep
// EvaluateValidationForManifest idempotent under repeated calls.
func stringSliceContains(haystack []string, needle string) bool {
	for _, value := range haystack {
		if value == needle {
			return true
		}
	}
	return false
}

func validateW02ReferentialIntegrity(a *Artifacts) []string {
	missing := make([]string, 0)
	if hasAgentTrajectoryRole(a.AgentTrajectories, AgentRoleVerificationRepair) && len(a.RepairAttempts) == 0 {
		missing = append(missing, "repairAttempts")
	}
	modelInvocationRefs := make(map[string]struct{}, len(a.ModelInvocations))
	modelInvocationRoles := make(map[string]struct{}, len(a.ModelInvocations))
	for _, invocation := range a.ModelInvocations {
		if invocation.InvocationID != "" && !invocation.LedgerRef.IsZero() {
			modelInvocationRefs[modelInvocationKey(invocation)] = struct{}{}
		}
		if invocation.AgentRole != "" {
			modelInvocationRoles[invocation.AgentRole] = struct{}{}
		}
	}
	if hasAgentTrajectoryRole(a.AgentTrajectories, AgentRoleTransformation) {
		if _, ok := modelInvocationRoles[AgentRoleTransformation]; !ok {
			missing = append(missing, "modelInvocations.transformation")
		}
	}
	if hasAgentTrajectoryRole(a.AgentTrajectories, AgentRoleVerificationRepair) {
		if _, ok := modelInvocationRoles[AgentRoleVerificationRepair]; !ok {
			missing = append(missing, "modelInvocations.verification-repair")
		}
	}
	if a.FinalJavaArtifact != nil && !a.FinalJavaArtifact.IsZero() && len(a.GeneratedJavaArtifacts) > 0 {
		matchCount := 0
		selectedMatchCount := 0
		for _, candidate := range a.GeneratedJavaArtifacts {
			if sameJavaCandidate(candidate, *a.FinalJavaArtifact) {
				matchCount++
				if candidate.Selected {
					selectedMatchCount++
				}
			} else if candidate.Selected {
				missing = append(missing, "generatedJavaArtifacts.selected")
			}
		}
		if matchCount != 1 {
			missing = append(missing, "finalJavaArtifact.generatedJavaArtifacts")
		}
		if matchCount == 1 && selectedMatchCount != 1 {
			missing = append(missing, "generatedJavaArtifacts.selected")
		}
	}
	if a.GeneratedJava != nil && !a.GeneratedJava.IsZero() && a.FinalJavaArtifact != nil && !a.FinalJavaArtifact.IsZero() {
		if a.GeneratedJava.URI != a.FinalJavaArtifact.URI || a.GeneratedJava.SHA256 != a.FinalJavaArtifact.SHA256 {
			missing = append(missing, "generatedJava.finalJavaArtifact")
		}
	}
	// Issue #217 (W0.3-6): when both the BudgetSummary and the AssistDecision
	// gate-time snapshots are present, the end-of-run consumption must be at
	// least the snapshot taken at gate time (budgets only grow). Drift would
	// indicate that the orchestrator silently re-used budget after the gate
	// recorded its snapshot, which we refuse to certify as audit-complete.
	if a.AssistDecision != nil && !a.AssistDecision.IsZero() && a.BudgetSummary != nil && !a.BudgetSummary.IsZero() {
		if snap := a.AssistDecision.AssistBudgetSnapshot; snap != nil && a.BudgetSummary.Assist.Used < snap.Used {
			missing = append(missing, "budgetSummary.assist.usedRegression")
		}
		if snap := a.AssistDecision.RepairBudgetSnapshot; snap != nil && a.BudgetSummary.Repair.Used < snap.Used {
			missing = append(missing, "budgetSummary.repair.usedRegression")
		}
		if snap := a.AssistDecision.ModelInvocationBudgetSnapshot; snap != nil && a.BudgetSummary.ModelInvocation.Used < snap.Used {
			missing = append(missing, "budgetSummary.modelInvocation.usedRegression")
		}
	}
	// Issue #217: when the assist-decision selected the Transformation Agent,
	// the run must carry a model invocation tagged with the transformation
	// role; otherwise the audit trail does not back up the gate's claim.
	if a.AssistDecision != nil && a.AssistDecision.Outcome == AssistOutcomeRequired && a.AssistDecision.SelectedAgentRole == AssistAgentRoleTransformation {
		hasTransformationInvocation := false
		for _, invocation := range a.ModelInvocations {
			if invocation.AgentRole == AgentRoleTransformation {
				hasTransformationInvocation = true
				break
			}
		}
		if !hasTransformationInvocation {
			missing = append(missing, "assistDecision.modelInvocations.transformation")
		}
	}

	buildTestRefs := make(map[string]struct{}, len(a.BuildTestResults))
	for _, ref := range a.BuildTestResults {
		buildTestRefs[dataReferenceKey(ref)] = struct{}{}
	}
	candidateRefs := make(map[string]struct{}, len(a.GeneratedJavaArtifacts))
	for _, candidate := range a.GeneratedJavaArtifacts {
		candidateRefs[javaCandidateKey(candidate)] = struct{}{}
	}
	for i, attempt := range a.RepairAttempts {
		if _, ok := buildTestRefs[dataReferenceKey(attempt.BuildTestResultRef)]; !ok {
			missing = append(missing, fmt.Sprintf("repairAttempts[%d].buildTestResultRef", i))
		}
		if attempt.ModelInvocationRef == nil {
			missing = append(missing, fmt.Sprintf("repairAttempts[%d].modelInvocationRef", i))
		} else if attempt.ModelInvocationRef.AgentRole != AgentRoleVerificationRepair {
			missing = append(missing, fmt.Sprintf("repairAttempts[%d].modelInvocationRef.agentRole", i))
		} else if _, ok := modelInvocationRefs[modelInvocationKey(*attempt.ModelInvocationRef)]; !ok {
			missing = append(missing, fmt.Sprintf("repairAttempts[%d].modelInvocationRef", i))
		}
		if attempt.NewJavaCandidateRef != nil {
			if _, ok := candidateRefs[javaCandidateKey(*attempt.NewJavaCandidateRef)]; !ok {
				missing = append(missing, fmt.Sprintf("repairAttempts[%d].newJavaCandidateRef", i))
			}
		}
	}
	return missing
}

func hasAgentTrajectoryRole(trajectories []AgentTrajectoryRef, role string) bool {
	for _, trajectory := range trajectories {
		if trajectory.AgentRole == role {
			return true
		}
	}
	return false
}

func sameJavaCandidate(left, right JavaCandidateRef) bool {
	return left.URI == right.URI && left.SHA256 == right.SHA256
}

func dataReferenceKey(ref DataReference) string {
	return ref.URI + "\x00" + ref.SHA256
}

func modelInvocationKey(ref ModelInvocationRef) string {
	return ref.InvocationID + "\x00" + dataReferenceKey(ref.LedgerRef)
}

func javaCandidateKey(ref JavaCandidateRef) string {
	return ref.URI + "\x00" + ref.SHA256
}

// deriveClassification (Issue #171) projects the validation result into the
// final manifest-level classification. A run is success-classifiable ONLY
// when completenessStatus is "complete". Any failure to materialise the
// required set forces the classification to "evidence_incomplete" (fail
// closed) so downstream consumers cannot mistakenly promote a missing-
// evidence run to success.
func deriveClassification(v ValidationResult, blocked bool) string {
	if blocked {
		return ClassificationBlocked
	}
	if v.OK {
		return ClassificationSuccess
	}
	return ClassificationEvidenceIncomplete
}

// secretLikePatterns (Issue #171) covers credential/API-key formats that
// MUST NEVER appear inside the evidence pack. The list is intentionally
// conservative: when in doubt we reject and force the upstream caller to
// scrub. False positives are preferable to leaking a real secret into an
// auditor-visible artifact bundle.
var secretLikePatterns = []*regexp.Regexp{
	// Common bearer/token prefixes.
	regexp.MustCompile(`(?i)bearer\s+[A-Za-z0-9._\-]{8,}`),
	// OpenAI / Anthropic-style API keys (sk-...) and similar long-lived
	// secrets. The threshold (16) avoids matching short identifiers like
	// `sk-test` or `pk-12`.
	regexp.MustCompile(`\bsk-[A-Za-z0-9_\-]{16,}\b`),
	regexp.MustCompile(`\b(?:sk_live|sk_test|pk_live|pk_test)_[A-Za-z0-9]{12,}\b`),
	// AWS access key id (AKIA + 16 chars).
	regexp.MustCompile(`\bAKIA[0-9A-Z]{16}\b`),
	// AWS secret access key (literal env-var name appearing with a value).
	regexp.MustCompile(`(?i)aws_secret_access_key\s*[:=]\s*[A-Za-z0-9/+=]{20,}`),
	// Generic api-key=... assignment with a substantive value.
	regexp.MustCompile(`(?i)\bapi[_-]?key\b\s*[:=]\s*[A-Za-z0-9._\-]{12,}`),
	// Hugging Face tokens.
	regexp.MustCompile(`\bhf_[A-Za-z0-9]{20,}\b`),
	// GitHub personal access tokens / fine-grained tokens.
	regexp.MustCompile(`\bghp_[A-Za-z0-9]{20,}\b`),
	regexp.MustCompile(`\bghs_[A-Za-z0-9]{20,}\b`),
	regexp.MustCompile(`\bgithub_pat_[A-Za-z0-9_]{20,}\b`),
	// JWT-shaped triplet (three base64url segments separated by dots).
	regexp.MustCompile(`\beyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\b`),
	// PEM private key blocks.
	regexp.MustCompile(`-----BEGIN [A-Z ]*PRIVATE KEY-----`),
}

// ContainsSecretLike reports whether the supplied value matches any of the
// secret/credential patterns evidence-service refuses to accept. Exported so
// the orchestrator and BFF can pre-screen payloads with the same rules.
func ContainsSecretLike(value string) bool {
	if value == "" {
		return false
	}
	for _, re := range secretLikePatterns {
		if re.MatchString(value) {
			return true
		}
	}
	return false
}

func ComputeSHA256Hex(value []byte) string {
	sum := sha256.Sum256(value)
	return hex.EncodeToString(sum[:])
}

// NewDataReference hashes the canonical-JSON form of payload and packs it
// into a DataReference. Generic on the payload type so the caller binds to
// a concrete struct instead of routing an untyped value through the
// helper. Use this for in-memory references; for on-disk files callers
// should pre-hash the bytes and construct the struct directly.
func NewDataReference[T any](uri string, payload T, mimeType, kind string) (DataReference, error) {
	raw, err := json.Marshal(payload)
	if err != nil {
		return DataReference{}, err
	}
	return DataReference{
		URI:      uri,
		SHA256:   ComputeSHA256Hex(raw),
		ByteSize: int64(len(raw)),
		MIMEType: mimeType,
		Kind:     kind,
	}, nil
}
