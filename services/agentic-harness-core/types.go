package main

import (
	"time"
)

const (
	ActionRegisterCapability = "register_capability"
	ActionStartRun          = "start_run"
	ActionUpdateRun         = "update_run"
	ActionCompleteRun       = "complete_run"
)

const (
	DataClassModel     = "model"
	DataClassEvidence  = "evidence"
	DataClassRAG       = "rag"
	DataClassGraph     = "graph"
	DataClassParser    = "parser"
	DataClassGenerator = "generator"
	DataClassTest      = "test"
	DataClassOther     = "other"
)

const (
	ProfileControlledByHarness = "harness-control-plane"
	ProfileAgentManaged       = "agent-managed"
)

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

type PolicyDecision struct {
	Allowed bool   `json:"allowed"`
	Reason  string `json:"reason"`
}

type Event struct {
	ID        string         `json:"id"`
	Type      string         `json:"type"`
	Source    string         `json:"source"`
	CreatedAt time.Time      `json:"createdAt"`
	Payload   map[string]any `json:"payload"`
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
	Capability        `json:"capability"`
}

type RegisterMcpServerRequest struct {
	ID          string   `json:"id"`
	Name        string   `json:"name"`
	Endpoint    string   `json:"endpoint"`
	Protocol    string   `json:"protocol"`
	Capabilities []string `json:"capabilities"`
}

type McpServer struct {
	ID           string   `json:"id"`
	Name         string   `json:"name"`
	Endpoint     string   `json:"endpoint"`
	Protocol     string   `json:"protocol"`
	Capabilities []string `json:"capabilities"`
	RegisteredAt time.Time `json:"registeredAt"`
}
