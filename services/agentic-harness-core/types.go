package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sort"
	"time"
)

const (
	ActionRegisterCapability = "register_capability"
	ActionStartRun           = "start_run"
	ActionUpdateRun          = "update_run"
	ActionCompleteRun        = "complete_run"
)

const (
	DataClassModel        = "model"
	DataClassEvidence     = "evidence"
	DataClassRAG          = "rag"
	DataClassGraph        = "graph"
	DataClassParser       = "parser"
	DataClassGenerator    = "generator"
	DataClassBuildTest    = "build-test"
	DataClassTest         = "test"
	DataClassModelGateway = "model-gateway"
	DataClassOther        = "other"
)

const (
	ProfileControlledByHarness = "harness-control-plane"
	ProfileAgentManaged        = "agent-managed"
	ProfileNoRedaction         = "none"
)

const (
	ActorSystem = "harness-core"
)

const (
	EventSchemaVersionV0 = "v0"
)

var allowedDataClasses = map[string]struct{}{
	DataClassModel:        {},
	DataClassEvidence:     {},
	DataClassRAG:          {},
	DataClassGraph:        {},
	DataClassParser:       {},
	DataClassGenerator:    {},
	DataClassBuildTest:    {},
	DataClassTest:         {},
	DataClassModelGateway: {},
	DataClassOther:        {},
}

var allowedRedactionProfiles = map[string]struct{}{
	ProfileControlledByHarness: {},
	ProfileAgentManaged:        {},
	ProfileNoRedaction:         {},
}

type Capability struct {
	ID            string `json:"id"`
	Name          string `json:"name"`
	Owner         string `json:"owner"`
	Endpoint      string `json:"endpoint"`
	DataClass     string `json:"dataClass"`
	PolicyProfile string `json:"policyProfile"`
	Version       string `json:"version"`
	Description   string `json:"description"`
}

type RegistryValidationError struct {
	Reason string `json:"reason"`
}

func (e RegistryValidationError) Error() string {
	return e.Reason
}

type SchemaValidationError struct {
	Path   string `json:"path"`
	Reason string `json:"reason"`
}

func (e SchemaValidationError) Error() string {
	return fmt.Sprintf("%s: %s", e.Path, e.Reason)
}

type PolicyDecision struct {
	Allowed bool   `json:"allowed"`
	Reason  string `json:"reason"`
}

type EventReference struct {
	URI      string `json:"uri"`
	SHA256   string `json:"sha256"`
	ByteSize int64  `json:"byteSize"`
	MIMEType string `json:"mimeType,omitempty"`
	Kind     string `json:"kind,omitempty"`
}

func (r EventReference) Validate() error {
	if r.URI == "" {
		return SchemaValidationError{Path: "ref.uri", Reason: "uri is required"}
	}
	if r.SHA256 == "" {
		return SchemaValidationError{Path: "ref.sha256", Reason: "sha256 is required"}
	}
	if len(r.SHA256) != 64 {
		return SchemaValidationError{Path: "ref.sha256", Reason: "sha256 must be 64 hex chars"}
	}
	_, err := hex.DecodeString(r.SHA256)
	if err != nil {
		return SchemaValidationError{Path: "ref.sha256", Reason: "sha256 must be valid hex"}
	}
	if r.ByteSize < 0 {
		return SchemaValidationError{Path: "ref.byteSize", Reason: "byteSize must be non-negative"}
	}
	return nil
}

type EventCost struct {
	Currency string  `json:"currency,omitempty"`
	Amount   float64 `json:"amount"`
	Unit     string  `json:"unit,omitempty"`
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
	Cost             *EventCost     `json:"cost,omitempty"`
	InputRef         EventReference `json:"inputRef"`
	OutputRef        EventReference `json:"outputRef"`
	CreatedAt        time.Time      `json:"createdAt"`
	Payload          map[string]any `json:"payload,omitempty"`
	RelatedRecords   []string       `json:"relatedRecords,omitempty"`
}

func (e EventEnvelopeV0) Validate() error {
	if e.SchemaVersion == "" {
		return SchemaValidationError{Path: "schemaVersion", Reason: "schemaVersion is required"}
	}
	if e.SchemaVersion != EventSchemaVersionV0 {
		return SchemaValidationError{Path: "schemaVersion", Reason: "schemaVersion must be v0"}
	}
	if e.EventID == "" {
		return SchemaValidationError{Path: "eventId", Reason: "eventId is required"}
	}
	if e.EventType == "" {
		return SchemaValidationError{Path: "eventType", Reason: "eventType is required"}
	}
	if e.Service == "" {
		return SchemaValidationError{Path: "service", Reason: "service is required"}
	}
	if e.RunID == "" {
		return SchemaValidationError{Path: "runId", Reason: "runId is required"}
	}
	if e.StepID <= 0 {
		return SchemaValidationError{Path: "stepId", Reason: "stepId must be > 0"}
	}
	if e.Actor == "" {
		return SchemaValidationError{Path: "actor", Reason: "actor is required"}
	}
	if e.Capability == "" {
		return SchemaValidationError{Path: "capability", Reason: "capability is required"}
	}
	if _, ok := allowedDataClasses[e.DataClass]; !ok {
		return SchemaValidationError{Path: "dataClass", Reason: "unsupported dataClass"}
	}
	if _, ok := allowedRedactionProfiles[e.RedactionProfile]; !ok {
		return SchemaValidationError{Path: "redactionProfile", Reason: "unsupported redactionProfile"}
	}
	if e.PolicyDecision == "" {
		return SchemaValidationError{Path: "policyDecision", Reason: "policyDecision is required"}
	}
	if e.Status == "" {
		return SchemaValidationError{Path: "status", Reason: "status is required"}
	}
	if e.StateTransition == "" {
		return SchemaValidationError{Path: "stateTransition", Reason: "stateTransition is required"}
	}
	if e.CreatedAt.IsZero() {
		return SchemaValidationError{Path: "createdAt", Reason: "createdAt is required"}
	}
	if err := e.InputRef.Validate(); err != nil {
		return err
	}
	if err := e.OutputRef.Validate(); err != nil {
		return err
	}
	if e.LatencyMs != nil && *e.LatencyMs < 0 {
		return SchemaValidationError{Path: "latencyMs", Reason: "latencyMs must be >= 0"}
	}
	if e.Cost != nil && e.Cost.Amount < 0 {
		return SchemaValidationError{Path: "cost.amount", Reason: "amount must be >= 0"}
	}
	return nil
}

type AgentTrajectoryEntry struct {
	EventID         string         `json:"eventId"`
	StepID          int64          `json:"stepId"`
	Actor           string         `json:"actor"`
	Capability      string         `json:"capability"`
	DataClass       string         `json:"dataClass"`
	EventType       string         `json:"eventType"`
	StateTransition string         `json:"stateTransition"`
	Status          string         `json:"status"`
	ErrorClass      string         `json:"errorClass,omitempty"`
	InputRef        EventReference `json:"inputRef"`
	OutputRef       EventReference `json:"outputRef"`
	RelatedRecords  []string       `json:"relatedRecords,omitempty"`
	CreatedAt       time.Time      `json:"createdAt"`
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
	if l.SchemaVersion == "" {
		return SchemaValidationError{Path: "schemaVersion", Reason: "schemaVersion is required"}
	}
	if l.SchemaVersion != EventSchemaVersionV0 {
		return SchemaValidationError{Path: "schemaVersion", Reason: "schemaVersion must be v0"}
	}
	if l.RunID == "" {
		return SchemaValidationError{Path: "runId", Reason: "runId is required"}
	}
	if l.Status == "" {
		return SchemaValidationError{Path: "status", Reason: "status is required"}
	}
	if l.CapturedAt.IsZero() {
		return SchemaValidationError{Path: "capturedAt", Reason: "capturedAt is required"}
	}
	seen := make(map[int64]struct{}, len(l.Steps))
	for i, step := range l.Steps {
		if step.EventID == "" {
			return SchemaValidationError{Path: "steps.eventId", Reason: fmt.Sprintf("step[%d] eventId is required", i)}
		}
		if step.StepID <= 0 {
			return SchemaValidationError{Path: "steps.stepId", Reason: fmt.Sprintf("step[%d].stepId must be > 0", i)}
		}
		if _, exists := seen[step.StepID]; exists {
			return SchemaValidationError{Path: "steps.stepId", Reason: fmt.Sprintf("step[%d] has duplicate stepId", i)}
		}
		seen[step.StepID] = struct{}{}
		if step.Actor == "" {
			return SchemaValidationError{Path: "steps.actor", Reason: fmt.Sprintf("step[%d] actor is required", i)}
		}
		if _, ok := allowedDataClasses[step.DataClass]; !ok {
			return SchemaValidationError{Path: "steps.dataClass", Reason: fmt.Sprintf("step[%d] has unsupported dataClass", i)}
		}
		if err := step.InputRef.Validate(); err != nil {
			return err
		}
		if err := step.OutputRef.Validate(); err != nil {
			return err
		}
	}
	return nil
}

func BuildAgentTrajectoryLedger(runID string, events []EventEnvelopeV0) (AgentTrajectoryLedgerV0, error) {
	if runID == "" {
		return AgentTrajectoryLedgerV0{}, SchemaValidationError{Path: "runId", Reason: "runId is required"}
	}
	filtered := make([]EventEnvelopeV0, 0, len(events))
	for _, event := range events {
		if event.RunID == runID {
			filtered = append(filtered, event)
		}
	}
	if len(filtered) == 0 {
		return AgentTrajectoryLedgerV0{}, SchemaValidationError{Path: "events", Reason: "no events for run"}
	}
	sort.Slice(filtered, func(i, j int) bool {
		if filtered[i].CreatedAt.Equal(filtered[j].CreatedAt) {
			return filtered[i].StepID < filtered[j].StepID
		}
		return filtered[i].CreatedAt.Before(filtered[j].CreatedAt)
	})
	steps := make([]AgentTrajectoryEntry, 0, len(filtered))
	latest := filtered[len(filtered)-1]
	ledger := AgentTrajectoryLedgerV0{
		SchemaVersion: EventSchemaVersionV0,
		RunID:         runID,
		Status:        latest.Status,
		StartedAt:     filtered[0].CreatedAt,
		CompletedAt:   time.Time{},
		CapturedAt:    time.Now().UTC(),
		Steps:         make([]AgentTrajectoryEntry, 0, len(filtered)),
	}
	for i, event := range filtered {
		steps = append(steps, AgentTrajectoryEntry{
			EventID:         event.EventID,
			StepID:          int64(i + 1),
			Actor:           event.Actor,
			Capability:      event.Capability,
			DataClass:       event.DataClass,
			EventType:       event.EventType,
			StateTransition: event.StateTransition,
			Status:          event.Status,
			ErrorClass:      event.ErrorClass,
			InputRef:        event.InputRef,
			OutputRef:       event.OutputRef,
			RelatedRecords:  event.RelatedRecords,
			CreatedAt:       event.CreatedAt,
		})
		if event.EventType == "run.completed" || event.EventType == "run.failed" {
			ledger.CompletedAt = event.CreatedAt
		}
	}
	ledger.Steps = steps
	if payloadWorkflowID, ok := latest.Payload["workflowId"].(string); ok && payloadWorkflowID != "" {
		ledger.WorkflowID = payloadWorkflowID
	}
	return ledger, ledger.Validate()
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
	return EventReference{
		URI:      uri,
		SHA256:   ComputeSHA256Hex(raw),
		ByteSize: int64(len(raw)),
	}, nil
}

type RunState struct {
	RunID          string    `json:"runId"`
	WorkflowID     string    `json:"workflowId"`
	Status         string    `json:"status"`
	EvidenceRefs   []string  `json:"evidenceRefs"`
	PolicyDecision string    `json:"policyDecision"`
	Message        string    `json:"message"`
	LastUpdatedAt  time.Time `json:"lastUpdatedAt"`
	StartedAt      time.Time `json:"startedAt"`
	CreatedAt      time.Time `json:"createdAt"`
	UpdatedBy      string    `json:"updatedBy"`
}

type RunUpdateRequest struct {
	Status         string   `json:"status"`
	UpdatedBy      string   `json:"updatedBy"`
	EvidenceRefs   []string `json:"evidenceRefs"`
	PolicyDecision string   `json:"policyDecision"`
	Message        string   `json:"message"`
}

type RunCreateRequest struct {
	WorkflowID   string   `json:"workflowId"`
	Requester    string   `json:"requester"`
	EvidenceRefs []string `json:"evidenceRefs"`
}

type RegisterCapabilityRequest struct {
	CallerRole string `json:"callerRole"`
	Capability `json:"capability"`
}

type RegisterMcpServerRequest struct {
	CallerRole   string   `json:"callerRole"`
	ID           string   `json:"id"`
	Name         string   `json:"name"`
	Endpoint     string   `json:"endpoint"`
	Protocol     string   `json:"protocol"`
	Capabilities []string `json:"capabilities"`
}

type McpServer struct {
	ID           string    `json:"id"`
	Name         string    `json:"name"`
	Endpoint     string    `json:"endpoint"`
	Protocol     string    `json:"protocol"`
	Capabilities []string  `json:"capabilities"`
	RegisteredAt time.Time `json:"registeredAt"`
}
