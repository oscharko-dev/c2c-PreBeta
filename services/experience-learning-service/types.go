package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/url"
	"sort"
	"strings"
	"time"
)

const (
	experienceSchemaVersion = "v0"
	serviceName             = "experience-learning-service"
	serviceActor            = "experience-learning-service"
	eventTypeObservation    = "experience.observed"
)

const (
	dataClassModel        = "model"
	dataClassEvidence     = "evidence"
	dataClassRAG          = "rag"
	dataClassGraph        = "graph"
	dataClassParser       = "parser"
	dataClassGenerator    = "generator"
	dataClassBuildTest    = "build-test"
	dataClassTest         = "test"
	dataClassModelGateway = "model-gateway"
	dataClassOther        = "other"
)

const (
	redactionProfileControlled = "harness-control-plane"
	redactionProfileAgent      = "agent-managed"
	redactionProfileNone       = "none"
)

const (
	statusObserved = "observed"
	statusIgnored  = "ignored"
)

const (
	patternRepeatAction    = "repeat_action"
	patternUnchangedOutput = "unchanged_output"
	patternRepeatedFailure = "repeated_failure"
	patternCompileFailure  = "compile_failure"
	patternTestFailure     = "test_failure"
	patternRetry           = "retry"
	patternAbort           = "aborted_run"
	patternBudgetOverrun   = "budget_overrun"
	patternAcceptedPattern = "accepted_pattern"
)

const defaultPolicyMode = "observation"

var allowedDataClasses = map[string]struct{}{
	dataClassModel:        {},
	dataClassEvidence:     {},
	dataClassRAG:          {},
	dataClassGraph:        {},
	dataClassParser:       {},
	dataClassGenerator:    {},
	dataClassBuildTest:    {},
	dataClassTest:         {},
	dataClassModelGateway: {},
	dataClassOther:        {},
}

var allowedRedactionProfiles = map[string]struct{}{
	redactionProfileControlled: {},
	redactionProfileAgent:      {},
	redactionProfileNone:       {},
}

var allowedEventStatuses = map[string]struct{}{
	statusObserved: {},
	statusIgnored:  {},
}

var allowedPolicyModes = map[string]struct{}{
	defaultPolicyMode: {},
}

type SchemaValidationError struct {
	Path   string `json:"path"`
	Reason string `json:"reason"`
}

func (e SchemaValidationError) Error() string {
	return fmt.Sprintf("%s: %s", e.Path, e.Reason)
}

type EventReference struct {
	URI      string `json:"uri"`
	SHA256   string `json:"sha256"`
	ByteSize int64  `json:"byteSize"`
}

func (r EventReference) Validate() error {
	if strings.TrimSpace(r.URI) == "" {
		return SchemaValidationError{Path: "uri", Reason: "required"}
	}
	if _, err := url.Parse(r.URI); err != nil && strings.Contains(r.URI, "://") {
		return SchemaValidationError{Path: "uri", Reason: "invalid URI"}
	}
	if strings.TrimSpace(r.SHA256) == "" {
		return SchemaValidationError{Path: "sha256", Reason: "required"}
	}
	if len(r.SHA256) != 64 {
		return SchemaValidationError{Path: "sha256", Reason: "must be 64 hex chars"}
	}
	if _, err := hex.DecodeString(r.SHA256); err != nil {
		return SchemaValidationError{Path: "sha256", Reason: "must be valid hex"}
	}
	if r.ByteSize < 0 {
		return SchemaValidationError{Path: "byteSize", Reason: "must be >= 0"}
	}
	return nil
}

type EventEnvelopeV0 struct {
	SchemaVersion    string         `json:"schemaVersion"`
	EventID          string         `json:"eventId"`
	EventType        string         `json:"eventType"`
	Service          string         `json:"service"`
	RunID            string         `json:"runId"`
	StepID           int64          `json:"stepId"`
	Actor            string         `json:"actor"`
	Capability       string         `json:"capability"`
	DataClass        string         `json:"dataClass"`
	RedactionProfile string         `json:"redactionProfile"`
	PolicyDecision   string         `json:"policyDecision"`
	Status           string         `json:"status"`
	StateTransition  string         `json:"stateTransition"`
	ErrorClass       string         `json:"errorClass,omitempty"`
	LatencyMs        *int64         `json:"latencyMs,omitempty"`
	InputRef         EventReference `json:"inputRef"`
	OutputRef        EventReference `json:"outputRef"`
	CreatedAt        time.Time      `json:"createdAt"`
	Payload          map[string]any `json:"payload,omitempty"`
	RelatedRecords   []string       `json:"relatedRecords,omitempty"`
}

func (e EventEnvelopeV0) Validate() error {
	if strings.TrimSpace(e.SchemaVersion) == "" {
		return SchemaValidationError{Path: "schemaVersion", Reason: "required"}
	}
	if e.SchemaVersion != experienceSchemaVersion {
		return SchemaValidationError{Path: "schemaVersion", Reason: "must be v0"}
	}
	if strings.TrimSpace(e.EventID) == "" {
		return SchemaValidationError{Path: "eventId", Reason: "required"}
	}
	if strings.TrimSpace(e.EventType) == "" {
		return SchemaValidationError{Path: "eventType", Reason: "required"}
	}
	if strings.TrimSpace(e.Service) == "" {
		return SchemaValidationError{Path: "service", Reason: "required"}
	}
	if strings.TrimSpace(e.RunID) == "" {
		return SchemaValidationError{Path: "runId", Reason: "required"}
	}
	if e.StepID <= 0 {
		return SchemaValidationError{Path: "stepId", Reason: "must be > 0"}
	}
	if strings.TrimSpace(e.Actor) == "" {
		return SchemaValidationError{Path: "actor", Reason: "required"}
	}
	if strings.TrimSpace(e.Capability) == "" {
		return SchemaValidationError{Path: "capability", Reason: "required"}
	}
	if _, ok := allowedDataClasses[e.DataClass]; !ok {
		return SchemaValidationError{Path: "dataClass", Reason: "unsupported"}
	}
	if _, ok := allowedRedactionProfiles[e.RedactionProfile]; !ok {
		return SchemaValidationError{Path: "redactionProfile", Reason: "unsupported"}
	}
	if strings.TrimSpace(e.PolicyDecision) == "" {
		return SchemaValidationError{Path: "policyDecision", Reason: "required"}
	}
	if strings.TrimSpace(e.Status) == "" {
		return SchemaValidationError{Path: "status", Reason: "required"}
	}
	if strings.TrimSpace(e.StateTransition) == "" {
		return SchemaValidationError{Path: "stateTransition", Reason: "required"}
	}
	if e.CreatedAt.IsZero() {
		return SchemaValidationError{Path: "createdAt", Reason: "required"}
	}
	if err := e.InputRef.Validate(); err != nil {
		return err
	}
	if err := e.OutputRef.Validate(); err != nil {
		return err
	}
	if e.LatencyMs != nil && *e.LatencyMs < 0 {
		return SchemaValidationError{Path: "latencyMs", Reason: "must be >= 0"}
	}
	return nil
}

type AgentTrajectoryEntry struct {
	EventID         string    `json:"eventId"`
	StepID          int64     `json:"stepId"`
	Actor           string    `json:"actor"`
	Capability      string    `json:"capability"`
	DataClass       string    `json:"dataClass"`
	EventType       string    `json:"eventType"`
	StateTransition string    `json:"stateTransition"`
	Status          string    `json:"status"`
	CreatedAt       time.Time `json:"createdAt"`
}

type AgentTrajectoryLedgerV0 struct {
	SchemaVersion string                 `json:"schemaVersion"`
	RunID         string                 `json:"runId"`
	Status        string                 `json:"status"`
	WorkflowID    string                 `json:"workflowId,omitempty"`
	StartedAt     time.Time              `json:"startedAt"`
	CompletedAt   time.Time              `json:"completedAt,omitempty"`
	CapturedAt    time.Time              `json:"capturedAt"`
	Steps         []AgentTrajectoryEntry `json:"steps"`
}

func (l AgentTrajectoryLedgerV0) Validate() error {
	if strings.TrimSpace(l.SchemaVersion) == "" {
		return SchemaValidationError{Path: "schemaVersion", Reason: "required"}
	}
	if l.SchemaVersion != experienceSchemaVersion {
		return SchemaValidationError{Path: "schemaVersion", Reason: "must be v0"}
	}
	if strings.TrimSpace(l.RunID) == "" {
		return SchemaValidationError{Path: "runId", Reason: "required"}
	}
	if strings.TrimSpace(l.Status) == "" {
		return SchemaValidationError{Path: "status", Reason: "required"}
	}
	if l.CapturedAt.IsZero() {
		return SchemaValidationError{Path: "capturedAt", Reason: "required"}
	}
	seen := map[int64]struct{}{}
	for idx, step := range l.Steps {
		if strings.TrimSpace(step.EventID) == "" {
			return SchemaValidationError{Path: fmt.Sprintf("steps[%d].eventId", idx), Reason: "required"}
		}
		if step.StepID <= 0 {
			return SchemaValidationError{Path: fmt.Sprintf("steps[%d].stepId", idx), Reason: "must be > 0"}
		}
		if _, exists := seen[step.StepID]; exists {
			return SchemaValidationError{Path: fmt.Sprintf("steps[%d].stepId", idx), Reason: "duplicate step id"}
		}
		seen[step.StepID] = struct{}{}
		if strings.TrimSpace(step.Actor) == "" {
			return SchemaValidationError{Path: fmt.Sprintf("steps[%d].actor", idx), Reason: "required"}
		}
		if strings.TrimSpace(step.Capability) == "" {
			return SchemaValidationError{Path: fmt.Sprintf("steps[%d].capability", idx), Reason: "required"}
		}
		if _, ok := allowedDataClasses[step.DataClass]; !ok {
			return SchemaValidationError{Path: fmt.Sprintf("steps[%d].dataClass", idx), Reason: "unsupported"}
		}
		if strings.TrimSpace(step.EventType) == "" {
			return SchemaValidationError{Path: fmt.Sprintf("steps[%d].eventType", idx), Reason: "required"}
		}
		if strings.TrimSpace(step.StateTransition) == "" {
			return SchemaValidationError{Path: fmt.Sprintf("steps[%d].stateTransition", idx), Reason: "required"}
		}
		if strings.TrimSpace(step.Status) == "" {
			return SchemaValidationError{Path: fmt.Sprintf("steps[%d].status", idx), Reason: "required"}
		}
		if step.CreatedAt.IsZero() {
			return SchemaValidationError{Path: fmt.Sprintf("steps[%d].createdAt", idx), Reason: "required"}
		}
	}
	return nil
}

type ExperienceEventV0 struct {
	SchemaVersion      string         `json:"schemaVersion"`
	EventID            string         `json:"eventId"`
	EventType          string         `json:"eventType"`
	Service            string         `json:"service"`
	RunID              string         `json:"runId"`
	Actor              string         `json:"actor"`
	Capability         string         `json:"capability"`
	DataClass          string         `json:"dataClass"`
	RedactionProfile   string         `json:"redactionProfile"`
	PolicyDecision     string         `json:"policyDecision"`
	Status             string         `json:"status"`
	StateTransition    string         `json:"stateTransition"`
	InputHash          string         `json:"inputHash"`
	OutputHash         string         `json:"outputHash"`
	Pattern            string         `json:"pattern"`
	PatternFingerprint string         `json:"patternFingerprint"`
	BuildTestOutcome   string         `json:"buildTestOutcome,omitempty"`
	Occurrences        int            `json:"occurrences"`
	Confidence         float64        `json:"confidence"`
	FirstStepID        int64          `json:"firstStepId,omitempty"`
	LastStepID         int64          `json:"lastStepId,omitempty"`
	RelatedRecords     []string       `json:"relatedRecords,omitempty"`
	EvidenceRefs       []string       `json:"evidenceRefs,omitempty"`
	ObservationOnly    bool           `json:"observationOnly"`
	PolicyVersion      string         `json:"policyVersion"`
	Payload            map[string]any `json:"payload,omitempty"`
	CreatedAt          time.Time      `json:"createdAt"`
	ObservedAt         time.Time      `json:"observedAt"`
}

func (e ExperienceEventV0) Validate() error {
	if strings.TrimSpace(e.SchemaVersion) == "" {
		return SchemaValidationError{Path: "schemaVersion", Reason: "required"}
	}
	if e.SchemaVersion != experienceSchemaVersion {
		return SchemaValidationError{Path: "schemaVersion", Reason: "must be v0"}
	}
	if strings.TrimSpace(e.EventID) == "" {
		return SchemaValidationError{Path: "eventId", Reason: "required"}
	}
	if strings.TrimSpace(e.EventType) == "" {
		return SchemaValidationError{Path: "eventType", Reason: "required"}
	}
	if strings.TrimSpace(e.Service) == "" {
		return SchemaValidationError{Path: "service", Reason: "required"}
	}
	if strings.TrimSpace(e.RunID) == "" {
		return SchemaValidationError{Path: "runId", Reason: "required"}
	}
	if strings.TrimSpace(e.Actor) == "" {
		return SchemaValidationError{Path: "actor", Reason: "required"}
	}
	if strings.TrimSpace(e.Capability) == "" {
		return SchemaValidationError{Path: "capability", Reason: "required"}
	}
	if _, ok := allowedDataClasses[e.DataClass]; !ok {
		return SchemaValidationError{Path: "dataClass", Reason: "unsupported"}
	}
	if _, ok := allowedRedactionProfiles[e.RedactionProfile]; !ok {
		return SchemaValidationError{Path: "redactionProfile", Reason: "unsupported"}
	}
	if strings.TrimSpace(e.PolicyDecision) == "" {
		return SchemaValidationError{Path: "policyDecision", Reason: "required"}
	}
	if strings.TrimSpace(e.Status) == "" {
		return SchemaValidationError{Path: "status", Reason: "required"}
	}
	if _, ok := allowedEventStatuses[e.Status]; !ok {
		return SchemaValidationError{Path: "status", Reason: "unsupported"}
	}
	if strings.TrimSpace(e.StateTransition) == "" {
		return SchemaValidationError{Path: "stateTransition", Reason: "required"}
	}
	if e.Occurrences <= 0 {
		return SchemaValidationError{Path: "occurrences", Reason: "must be > 0"}
	}
	if e.Confidence < 0 || e.Confidence > 1 {
		return SchemaValidationError{Path: "confidence", Reason: "must be in [0,1]"}
	}
	if strings.TrimSpace(e.InputHash) != "" && len(e.InputHash) != 64 {
		return SchemaValidationError{Path: "inputHash", Reason: "must be 64 hex chars"}
	}
	if strings.TrimSpace(e.InputHash) != "" {
		if _, err := hex.DecodeString(e.InputHash); err != nil {
			return SchemaValidationError{Path: "inputHash", Reason: "must be valid hex"}
		}
	}
	if strings.TrimSpace(e.OutputHash) != "" && len(e.OutputHash) != 64 {
		return SchemaValidationError{Path: "outputHash", Reason: "must be 64 hex chars"}
	}
	if strings.TrimSpace(e.OutputHash) != "" {
		if _, err := hex.DecodeString(e.OutputHash); err != nil {
			return SchemaValidationError{Path: "outputHash", Reason: "must be valid hex"}
		}
	}
	if e.CreatedAt.IsZero() {
		return SchemaValidationError{Path: "createdAt", Reason: "required"}
	}
	if e.ObservedAt.IsZero() {
		return SchemaValidationError{Path: "observedAt", Reason: "required"}
	}
	return nil
}

type LearningArtifactRecord struct {
	SchemaVersion       string             `json:"schemaVersion"`
	ArtifactID          string             `json:"artifactId"`
	RunID               string             `json:"runId"`
	Service             string             `json:"service"`
	GeneratedAt         time.Time          `json:"generatedAt"`
	Summary             RunLearningSummary `json:"summary"`
	ExperienceEventRefs []string           `json:"experienceEventRefs"`
}

type LearningArtifactRegistryV0 struct {
	SchemaVersion string                            `json:"schemaVersion"`
	GeneratedAt   time.Time                         `json:"generatedAt"`
	Service       string                            `json:"service"`
	Records       map[string]LearningArtifactRecord `json:"records"`
}

type RunLearningSummary struct {
	RunID              string         `json:"runId"`
	RunStatus          string         `json:"runStatus,omitempty"`
	ObservedAt         time.Time      `json:"observedAt"`
	SourceEventCount   int            `json:"sourceEventCount"`
	SourceLedgerCount  int            `json:"sourceLedgerCount"`
	CandidateCount     int            `json:"candidateCount"`
	CandidateByPattern map[string]int `json:"candidateByPattern"`
	ExperienceEventIDs []string       `json:"experienceEventIds"`
	ObservedPatterns   []string       `json:"observedPatterns"`
	ObservationOnly    bool           `json:"observationOnly"`
	PolicyVersion      string         `json:"policyVersion"`
	PolicyFingerprint  string         `json:"policyFingerprint"`
}

type PolicyDecision struct {
	Mode    string `json:"mode"`
	Reason  string `json:"reason"`
	Allowed bool   `json:"allowed"`
}

type PatternKey struct {
	Actor        string
	Capability   string
	InputHash    string
	OutputHash   string
	Status       string
	BuildOutcome string
}

func (k PatternKey) String() string {
	parts := []string{
		k.Actor,
		k.Capability,
		k.InputHash,
		k.OutputHash,
		k.Status,
		k.BuildOutcome,
	}
	return strings.Join(parts, "|")
}

func (k PatternKey) Fingerprint() string {
	raw, _ := json.Marshal(k)
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])
}

type LearningEventLog interface {
	List() ([]ExperienceEventV0, error)
	Append(ExperienceEventV0) (ExperienceEventV0, error)
	ByRun(runID string) ([]ExperienceEventV0, error)
	Clear() error
}

type HarnessEventLog interface {
	List() ([]EventEnvelopeV0, error)
	Append(EventEnvelopeV0) error
	ByRun(runID string) ([]EventEnvelopeV0, error)
}

type TrajectoryLedgerLog interface {
	List() ([]AgentTrajectoryLedgerV0, error)
	Append(AgentTrajectoryLedgerV0) error
	ByRun(runID string) ([]AgentTrajectoryLedgerV0, error)
}

func ComputeSHA256Hex(value []byte) string {
	sum := sha256.Sum256(value)
	return hex.EncodeToString(sum[:])
}

func NewEventReference(uri string, payload any) (EventReference, error) {
	raw, err := json.Marshal(payload)
	if err != nil {
		return EventReference{}, err
	}
	if strings.TrimSpace(uri) == "" {
		return EventReference{}, SchemaValidationError{Path: "uri", Reason: "required"}
	}
	if _, err := url.Parse(uri); err != nil && strings.Contains(uri, "://") {
		return EventReference{}, SchemaValidationError{Path: "uri", Reason: "invalid URI"}
	}
	return EventReference{
		URI:      uri,
		SHA256:   ComputeSHA256Hex(raw),
		ByteSize: int64(len(raw)),
	}, nil
}

func sortedPatternKeys(values map[string]int) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}
