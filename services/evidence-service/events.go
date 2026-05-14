package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const (
	EventTypePackCreated  = "evidence.pack.created"
	EventTypePackUpdated  = "evidence.pack.updated"
	EventTypePackExported = "evidence.pack.exported"

	DataClassEvidence            = "evidence"
	RedactionHarnessControlPlane = "harness-control-plane"
	PolicyAllowDefault           = "policy allow"
	ActorService                 = "evidence-service"
)

// EventCost mirrors the optional cost block on agentic-harness-core's
// EventEnvelopeV0.cost. Kept as a value-on-the-wire so emitting "no cost"
// stays one nil pointer.
type EventCost struct {
	Currency string  `json:"currency,omitempty"`
	Amount   float64 `json:"amount"`
	Unit     string  `json:"unit,omitempty"`
}

// EvidenceEventPayload is the typed payload shape evidence-service writes
// onto every event. Keeping this strongly-typed (instead of map[string]any)
// prevents accidental drift into untyped fields and makes downstream
// consumers parse against a stable contract.
type EvidenceEventPayload struct {
	PackID     string           `json:"packId"`
	RunID      string           `json:"runId"`
	WorkflowID string           `json:"workflowId,omitempty"`
	Status     string           `json:"status"`
	Validation ValidationResult `json:"validation"`
}

// HarnessEvent mirrors the v0 envelope contract enforced by
// agentic-harness-core/types.go EventEnvelopeV0. The optional ErrorClass,
// LatencyMs, and Cost fields are kept here so an emitted event can be
// forwarded verbatim to POST /v0/events without a re-shape step.
type HarnessEvent struct {
	SchemaVersion    string                `json:"schemaVersion"`
	EventID          string                `json:"eventId"`
	EventType        string                `json:"eventType"`
	Service          string                `json:"service"`
	RunID            string                `json:"runId"`
	StepID           int64                 `json:"stepId"`
	Actor            string                `json:"actor"`
	Capability       string                `json:"capability"`
	DataClass        string                `json:"dataClass"`
	RedactionProfile string                `json:"redactionProfile"`
	PolicyDecision   string                `json:"policyDecision"`
	Status           string                `json:"status"`
	StateTransition  string                `json:"stateTransition"`
	ErrorClass       string                `json:"errorClass,omitempty"`
	LatencyMs        *int64                `json:"latencyMs,omitempty"`
	Cost             *EventCost            `json:"cost,omitempty"`
	InputRef         DataReference         `json:"inputRef"`
	OutputRef        DataReference         `json:"outputRef"`
	CreatedAt        time.Time             `json:"createdAt"`
	Payload          *EvidenceEventPayload `json:"payload,omitempty"`
	RelatedRecords   []string              `json:"relatedRecords,omitempty"`
}

type EventSink interface {
	Emit(event HarnessEvent) (HarnessEvent, error)
	List() ([]HarnessEvent, error)
}

type InMemoryEventSink struct {
	mu     sync.RWMutex
	events []HarnessEvent
	seq    atomic.Uint64
}

func NewInMemoryEventSink() *InMemoryEventSink {
	return &InMemoryEventSink{events: make([]HarnessEvent, 0)}
}

func (s *InMemoryEventSink) Emit(event HarnessEvent) (HarnessEvent, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	event = normalize(event, s.seq.Add(1))
	s.events = append(s.events, event)
	return event, nil
}

func (s *InMemoryEventSink) List() ([]HarnessEvent, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]HarnessEvent, 0, len(s.events))
	return append(out, s.events...), nil
}

type JSONLFileEventSink struct {
	InMemoryEventSink
	path string
	file *os.File
}

func NewJSONLFileEventSink(path string) (*JSONLFileEventSink, error) {
	if strings.TrimSpace(path) == "" {
		return nil, fmt.Errorf("event log path is required")
	}
	if dir := filepath.Dir(path); dir != "." {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return nil, fmt.Errorf("create event log directory failed: %w", err)
		}
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR|os.O_APPEND, 0o640)
	if err != nil {
		return nil, fmt.Errorf("open event log file failed: %w", err)
	}
	sink := &JSONLFileEventSink{
		InMemoryEventSink: InMemoryEventSink{events: make([]HarnessEvent, 0)},
		path:              path,
		file:              file,
	}
	if err := sink.restore(); err != nil {
		_ = file.Close()
		return nil, err
	}
	return sink, nil
}

func (s *JSONLFileEventSink) restore() error {
	if _, err := s.file.Seek(0, 0); err != nil {
		return fmt.Errorf("seek event log: %w", err)
	}
	scanner := bufio.NewScanner(s.file)
	scanner.Buffer(make([]byte, 64*1024), 1024*1024)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		var event HarnessEvent
		if err := json.Unmarshal([]byte(line), &event); err != nil {
			return fmt.Errorf("invalid persisted event: %w", err)
		}
		s.events = append(s.events, event)
	}
	if err := scanner.Err(); err != nil {
		return fmt.Errorf("read event log: %w", err)
	}
	s.seq.Store(uint64(len(s.events)))
	_, err := s.file.Seek(0, 2)
	return err
}

func (s *JSONLFileEventSink) Emit(event HarnessEvent) (HarnessEvent, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	event = normalize(event, s.seq.Add(1))
	line, err := json.Marshal(event)
	if err != nil {
		return HarnessEvent{}, err
	}
	if _, err := s.file.Write(append(line, '\n')); err != nil {
		return HarnessEvent{}, fmt.Errorf("append event log: %w", err)
	}
	if err := s.file.Sync(); err != nil {
		return HarnessEvent{}, fmt.Errorf("sync event log: %w", err)
	}
	s.events = append(s.events, event)
	return event, nil
}

func (s *JSONLFileEventSink) List() ([]HarnessEvent, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]HarnessEvent, 0, len(s.events))
	return append(out, s.events...), nil
}

func normalize(event HarnessEvent, nextID uint64) HarnessEvent {
	now := time.Now().UTC()
	if event.SchemaVersion == "" {
		event.SchemaVersion = SchemaVersionV0
	}
	if event.EventID == "" {
		event.EventID = fmt.Sprintf("hev-evidence-%s-%d", now.Format("20060102"), nextID)
	}
	if event.Service == "" {
		event.Service = ServiceName
	}
	if event.Actor == "" {
		event.Actor = ActorService
	}
	if event.Capability == "" {
		event.Capability = CapabilityEvidence
	}
	if event.DataClass == "" {
		event.DataClass = DataClassEvidence
	}
	if event.RedactionProfile == "" {
		event.RedactionProfile = RedactionHarnessControlPlane
	}
	if event.PolicyDecision == "" {
		event.PolicyDecision = PolicyAllowDefault
	}
	if event.CreatedAt.IsZero() {
		event.CreatedAt = now
	}
	return event
}
