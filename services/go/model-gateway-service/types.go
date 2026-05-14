package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

const (
	defaultModelRegistryPath = "config/model-registry.example.yaml"
	defaultAllowlistPath     = "config/foundry-development-allowlist-v0.yaml"
	defaultLedgerPath        = "data/model-invocation-ledger-v0.jsonl"
	defaultEventLogPath      = "data/model-gateway-events-v0.jsonl"
	defaultModelListenAddr   = ":8085"

	gatewayEventSchemaVersion       = "v0"
	eventServiceName                = "model-gateway-service"
	eventDataClassModelGateway      = "model-gateway"
	eventProfileControlledByHarness = "harness-control-plane"
)

const (
	ModelProviderFoundryDevelopment   = "foundry-development"
	ModelProviderCustomerInternalMock = "customer-internal-mock"
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

var allowedModelStatuses = map[string]struct{}{
	"approved": {},
}

var allowedLicenseStatuses = map[string]struct{}{
	"approved":  {},
	"compliant": {},
}

var allowedRedactionProfiles = map[string]struct{}{
	"agent-managed":                 {},
	eventProfileControlledByHarness: {},
	"none":                          {},
}

const (
	statusCompleted = "completed"
	statusFailed    = "failed"
	statusRejected  = "rejected"
)

const (
	policyDecisionAllow = "policy allow"
	policyDecisionDeny  = "policy deny"
)

const (
	eventTypeModelInvocationFailed = "model.invocation.failed"
	eventTypeModelInvocationDone   = "model.invocation.completed"
)

const (
	actorModelGateway = "model-gateway"
)

type SchemaValidationError struct {
	Path   string `json:"path"`
	Reason string `json:"reason"`
}

func (e SchemaValidationError) Error() string {
	return fmt.Sprintf("%s: %s", e.Path, e.Reason)
}

type ModelGatewayValidationError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func (e ModelGatewayValidationError) Error() string {
	return e.Message
}

type DataReference struct {
	URI      string `json:"uri"`
	SHA256   string `json:"sha256"`
	ByteSize int64  `json:"byteSize"`
}

func (r DataReference) Validate() error {
	if strings.TrimSpace(r.URI) == "" {
		return SchemaValidationError{Path: "uri", Reason: "uri is required"}
	}
	if strings.TrimSpace(r.SHA256) == "" {
		return SchemaValidationError{Path: "sha256", Reason: "sha256 is required"}
	}
	if len(r.SHA256) != 64 {
		return SchemaValidationError{Path: "sha256", Reason: "sha256 must be 64 hex chars"}
	}
	if _, err := hex.DecodeString(r.SHA256); err != nil {
		return SchemaValidationError{Path: "sha256", Reason: "sha256 must be valid hex"}
	}
	if r.ByteSize < 0 {
		return SchemaValidationError{Path: "byteSize", Reason: "byteSize must be non-negative"}
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
	LatencyMs        int64          `json:"latencyMs,omitempty"`
	InputRef         DataReference  `json:"inputRef"`
	OutputRef        DataReference  `json:"outputRef"`
	CreatedAt        time.Time      `json:"createdAt"`
	Payload          map[string]any `json:"payload,omitempty"`
	RelatedRecords   []string       `json:"relatedRecords,omitempty"`
}

func (e EventEnvelopeV0) Validate() error {
	if e.SchemaVersion != gatewayEventSchemaVersion {
		return SchemaValidationError{Path: "schemaVersion", Reason: "must be v0"}
	}
	if strings.TrimSpace(e.EventID) == "" {
		return SchemaValidationError{Path: "eventId", Reason: "required"}
	}
	if strings.TrimSpace(e.EventType) == "" {
		return SchemaValidationError{Path: "eventType", Reason: "required"}
	}
	if strings.TrimSpace(e.RunID) == "" {
		return SchemaValidationError{Path: "runId", Reason: "required"}
	}
	if e.StepID <= 0 {
		return SchemaValidationError{Path: "stepId", Reason: "required and must be > 0"}
	}
	if e.CreatedAt.IsZero() {
		return SchemaValidationError{Path: "createdAt", Reason: "required"}
	}
	if e.Actor == "" {
		return SchemaValidationError{Path: "actor", Reason: "required"}
	}
	if e.Capability == "" {
		return SchemaValidationError{Path: "capability", Reason: "required"}
	}
	if _, ok := allowedDataClasses[e.DataClass]; !ok {
		return SchemaValidationError{Path: "dataClass", Reason: "unsupported data class"}
	}
	if e.Status == "" {
		return SchemaValidationError{Path: "status", Reason: "required"}
	}
	if _, ok := allowedRedactionProfiles[e.RedactionProfile]; !ok {
		return SchemaValidationError{Path: "redactionProfile", Reason: "unsupported redaction profile"}
	}
	if strings.TrimSpace(e.RedactionProfile) == "" {
		return SchemaValidationError{Path: "redactionProfile", Reason: "required"}
	}
	if strings.TrimSpace(e.PolicyDecision) == "" {
		return SchemaValidationError{Path: "policyDecision", Reason: "required"}
	}
	if e.StateTransition == "" {
		return SchemaValidationError{Path: "stateTransition", Reason: "required"}
	}
	if err := e.InputRef.Validate(); err != nil {
		return err
	}
	if err := e.OutputRef.Validate(); err != nil {
		return err
	}
	return nil
}

type ModelInvocationRequest struct {
	RunID                  string         `json:"runId"`
	ModelID                string         `json:"modelId"`
	Actor                  string         `json:"actor"`
	DataClass              string         `json:"dataClass"`
	PromptTemplateVersion  string         `json:"promptTemplateVersion"`
	Prompt                 string         `json:"prompt"`
	StructuredOutput       bool           `json:"structuredOutput"`
	StructuredOutputSchema map[string]any `json:"structuredOutputSchema,omitempty"`
	Parameters             map[string]any `json:"parameters"`
	TimeoutMs              int64          `json:"timeoutMs"`
}

type ModelInvocationResponse struct {
	InvocationID          string         `json:"invocationId"`
	RunID                 string         `json:"runId"`
	ModelID               string         `json:"modelId"`
	Provider              string         `json:"provider"`
	PromptTemplateVersion string         `json:"promptTemplateVersion"`
	Status                string         `json:"status"`
	LatencyMs             int64          `json:"latencyMs"`
	LedgerRef             DataReference  `json:"ledgerRef"`
	Output                map[string]any `json:"output"`
}

type ModelInvocationOutput struct {
	Data     map[string]any
	Status   string
	Metadata map[string]any
}

type ModelInvocationLedgerV0 struct {
	SchemaVersion    string         `json:"schemaVersion"`
	InvocationID     string         `json:"invocationId"`
	RunID            string         `json:"runId"`
	ModelID          string         `json:"modelId"`
	Provider         string         `json:"provider"`
	DataClass        string         `json:"dataClass"`
	PromptTemplate   string         `json:"promptTemplateVersion"`
	PolicyDecision   string         `json:"policyDecision"`
	Status           string         `json:"status"`
	LatencyMs        int64          `json:"latencyMs"`
	RequestRef       DataReference  `json:"requestRef"`
	OutputRef        DataReference  `json:"outputRef"`
	ErrorClass       string         `json:"errorClass,omitempty"`
	ErrorMessage     string         `json:"errorMessage,omitempty"`
	Parameters       map[string]any `json:"parameters"`
	StructuredOutput bool           `json:"structuredOutput"`
	CreatedAt        time.Time      `json:"createdAt"`
}

func (l ModelInvocationLedgerV0) Validate() error {
	if l.SchemaVersion != gatewayEventSchemaVersion {
		return SchemaValidationError{Path: "schemaVersion", Reason: "must be v0"}
	}
	if strings.TrimSpace(l.InvocationID) == "" {
		return SchemaValidationError{Path: "invocationId", Reason: "required"}
	}
	if strings.TrimSpace(l.ModelID) == "" {
		return SchemaValidationError{Path: "modelId", Reason: "required"}
	}
	if strings.TrimSpace(l.Provider) == "" {
		return SchemaValidationError{Path: "provider", Reason: "required"}
	}
	if strings.TrimSpace(l.DataClass) == "" {
		return SchemaValidationError{Path: "dataClass", Reason: "required"}
	}
	if strings.TrimSpace(l.PromptTemplate) == "" {
		return SchemaValidationError{Path: "promptTemplateVersion", Reason: "required"}
	}
	if l.CreatedAt.IsZero() {
		return SchemaValidationError{Path: "createdAt", Reason: "required"}
	}
	if err := l.RequestRef.Validate(); err != nil {
		return err
	}
	if err := l.OutputRef.Validate(); err != nil {
		return err
	}
	if l.LatencyMs < 0 {
		return SchemaValidationError{Path: "latencyMs", Reason: "must be >= 0"}
	}
	if l.Status == "" {
		return SchemaValidationError{Path: "status", Reason: "required"}
	}
	switch l.Status {
	case statusCompleted, statusFailed, statusRejected:
	default:
		return SchemaValidationError{Path: "status", Reason: "must be completed, failed, or rejected"}
	}
	if strings.TrimSpace(l.PolicyDecision) == "" {
		return SchemaValidationError{Path: "policyDecision", Reason: "required"}
	}
	return nil
}

type ModelGatewayHealthResponse struct {
	Status      string            `json:"status"`
	Service     string            `json:"service"`
	Schema      string            `json:"schema"`
	Providers   []string          `json:"providers"`
	ActiveModel int               `json:"activeModels"`
	Configured  map[string]string `json:"configured"`
}

func ComputeSHA256Ref(payload any) (DataReference, error) {
	return ComputeSHA256RefWithURI("urn:model-gateway/payload", payload)
}

func ComputeSHA256RefWithURI(uri string, payload any) (DataReference, error) {
	raw, err := json.Marshal(payload)
	if err != nil {
		return DataReference{}, err
	}
	return DataReference{
		URI:      uri,
		SHA256:   ComputeSHA256Hex(raw),
		ByteSize: int64(len(raw)),
	}, nil
}

func ComputeSHA256Hex(value []byte) string {
	sum := sha256.Sum256(value)
	return hex.EncodeToString(sum[:])
}
