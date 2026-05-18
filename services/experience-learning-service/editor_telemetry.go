package main

// Studio-IDE-11 (#251): editor telemetry ingest.
//
// The BFF intake (`services/c2c-bff/src/editorTelemetry.ts`) validates the
// closed-enum, tag-only payload and augments each event with tenantId,
// userId, and a server-side receivedAt before forwarding here. This
// service re-validates the contract as defence in depth (no source
// content may sneak through any boundary) and persists each event to a
// JSONL store the analyzer can later mine for editor-interaction
// learning signals.
//
// The schema mirrors `schemas/editor-telemetry-event-v0.json` and the
// Studio types in `apps/c2c-studio/src/types/editor-telemetry.ts`. All
// three layers carry the SAME closed enums; any drift is a contract
// violation and the validator below will reject it.

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"regexp"
	"strings"
	"sync"
	"time"
)

const (
	editorTelemetrySchemaVersion = "v0"
)

// EditorTelemetryEventV0 is the wire-level event after BFF augmentation.
// The payload is kept as a raw JSON message so the validator's closed-set
// rules apply without forcing every per-eventType payload into its own
// Go struct.
type EditorTelemetryEventV0 struct {
	SchemaVersion string          `json:"schemaVersion"`
	EventType     string          `json:"eventType"`
	OccurredAt    time.Time       `json:"occurredAt"`
	ReceivedAt    time.Time       `json:"receivedAt"`
	SessionID     string          `json:"sessionId"`
	TenantID      string          `json:"tenantId"`
	UserID        string          `json:"userId"`
	Payload       json.RawMessage `json:"payload"`
}

type editorTelemetryIngestRequest struct {
	SchemaVersion string                   `json:"schemaVersion"`
	Events        []EditorTelemetryEventV0 `json:"events"`
}

type editorTelemetryIngestResponse struct {
	SchemaVersion string `json:"schemaVersion"`
	Accepted      int    `json:"accepted"`
	Service       string `json:"service"`
}

// EditorTelemetryEventLog mirrors the other event-log interfaces in
// storage.go so a test can swap the disk-backed store for an
// in-memory one.
type EditorTelemetryEventLog interface {
	List() ([]EditorTelemetryEventV0, error)
	Append(EditorTelemetryEventV0) error
	BySession(sessionID string) ([]EditorTelemetryEventV0, error)
}

// ---------------------------------------------------------------------------
// Validation — closed-enum, tag-only event types
// ---------------------------------------------------------------------------

var allowedEditorTelemetryEventTypes = map[string]struct{}{
	"marker.navigate":               {},
	"hover.opened":                  {},
	"hover.expanded":                {},
	"lineage.navigate":              {},
	"stacktrace.frame_click":        {},
	"diff.open":                     {},
	"assist.invoked":                {},
	"assist.result":                 {},
	"save.local":                    {},
	"conflict.resolved":             {},
	"generate.invoked":              {},
	"generate.result":               {},
	"compile_check.invoked":         {},
	"compile_check.result":          {},
	"verify.invoked":                {},
	"verify.result":                 {},
	"three_way_merge.opened":        {},
	"three_way_merge.resolved":      {},
	"manual_edit.region_classified": {},
	"format.invoked":                {},
	"format.result":                 {},
	"lint.markers_changed":          {},
}

var (
	safeIDPattern         = regexp.MustCompile(`^[A-Za-z0-9._\-]{1,128}$`)
	irCodeOrKindPattern   = regexp.MustCompile(`^[A-Z][A-Z0-9_]{0,63}$`)
	maxEditorTelemetryLen = 100 * 1024 // 100 KB, mirrors BFF cap
	maxEditorBatchEvents  = 100
)

// validatePayload re-enforces the closed-enum, tag-only contract for the
// given event type. The payload is decoded into a map for inspection;
// because each branch enumerates the allowed keys explicitly and rejects
// anything else, a hostile or buggy client cannot smuggle additional
// properties through.
func validateEditorTelemetryPayload(eventType string, raw json.RawMessage) error {
	var payload map[string]any
	if err := json.Unmarshal(raw, &payload); err != nil {
		return fmt.Errorf("payload must be a JSON object")
	}
	switch eventType {
	case "marker.navigate":
		return ensureFields(payload,
			[]string{"direction", "sourceKind", "severity"},
			[]string{"irCodeOrIRNodeKind"},
			func(p map[string]any) error {
				if err := requireEnum(p, "direction", "next", "prev"); err != nil {
					return err
				}
				if err := requireEnum(p, "sourceKind", "cobol", "java"); err != nil {
					return err
				}
				if err := requireEnum(p, "severity", "error", "warning", "info", "hint"); err != nil {
					return err
				}
				if v, ok := p["irCodeOrIRNodeKind"]; ok {
					s, ok := v.(string)
					if !ok || !irCodeOrKindPattern.MatchString(s) {
						return fmt.Errorf("irCodeOrIRNodeKind must be SCREAMING_SNAKE_CASE")
					}
				}
				return nil
			})
	case "hover.opened", "hover.expanded":
		return ensureFields(payload,
			[]string{"constructKind"},
			nil,
			func(p map[string]any) error {
				return requireEnum(p, "constructKind",
					"pic", "comp3", "usage", "occurs", "redefines", "value",
					"section", "paragraph", "fixed-format-zone")
			})
	case "lineage.navigate":
		return ensureFields(payload,
			[]string{"direction", "resolved"},
			[]string{"mappingClass", "unresolvedReason"},
			func(p map[string]any) error {
				if err := requireEnum(p, "direction", "java_to_cobol", "cobol_to_java"); err != nil {
					return err
				}
				if err := requireBool(p, "resolved"); err != nil {
					return err
				}
				if _, ok := p["mappingClass"]; ok {
					if err := requireEnum(p, "mappingClass",
						"direct", "aggregated", "synthesized", "agent_originated"); err != nil {
						return err
					}
				}
				if _, ok := p["unresolvedReason"]; ok {
					if err := requireEnum(p, "unresolvedReason",
						"no_mapping", "stale_manual_edit", "manual_only"); err != nil {
						return err
					}
				}
				return nil
			})
	case "stacktrace.frame_click":
		return ensureFields(payload,
			[]string{"resolved"}, nil,
			func(p map[string]any) error { return requireBool(p, "resolved") })
	case "diff.open":
		return ensureFields(payload,
			[]string{"hasPrevious", "lineageAvailable"}, nil,
			func(p map[string]any) error {
				if err := requireBool(p, "hasPrevious"); err != nil {
					return err
				}
				return requireBool(p, "lineageAvailable")
			})
	case "assist.invoked":
		return ensureFields(payload,
			[]string{"sourceKind", "regionLineCount", "redactionApplied"}, nil,
			func(p map[string]any) error {
				if err := requireEnum(p, "sourceKind", "cobol", "java"); err != nil {
					return err
				}
				if err := requireNonNegativeInt(p, "regionLineCount"); err != nil {
					return err
				}
				return requireNonNegativeInt(p, "redactionApplied")
			})
	case "assist.result":
		return ensureFields(payload,
			[]string{"outcome"}, nil,
			func(p map[string]any) error {
				return requireEnum(p, "outcome",
					"success", "budget_exhausted", "policy_denied",
					"gateway_unavailable", "timeout", "invalid_region")
			})
	case "save.local":
		return ensureFields(payload,
			[]string{"kind", "encrypted"}, nil,
			func(p map[string]any) error {
				if err := requireEnum(p, "kind", "cobol", "java"); err != nil {
					return err
				}
				return requireBool(p, "encrypted")
			})
	case "conflict.resolved":
		return ensureFields(payload,
			[]string{"kind", "pick"}, nil,
			func(p map[string]any) error {
				if err := requireEnum(p, "kind", "cobol", "java"); err != nil {
					return err
				}
				return requireEnum(p, "pick", "backend_sample", "local_draft", "last_run_input")
			})
	case "generate.invoked":
		return ensureFields(payload,
			[]string{"trigger", "hadManualEdits"}, nil,
			func(p map[string]any) error {
				if err := requireEnum(p, "trigger",
					"generate", "regenerate", "generate_and_verify"); err != nil {
					return err
				}
				return requireBool(p, "hadManualEdits")
			})
	case "generate.result":
		return ensureFields(payload,
			[]string{"outcome", "latencyBucket"}, nil,
			func(p map[string]any) error {
				if err := requireEnum(p, "outcome",
					"success", "merge_required", "failed", "cancelled"); err != nil {
					return err
				}
				return requireEnum(p, "latencyBucket", "lt_2s", "lt_10s", "lt_60s", "ge_60s")
			})
	case "compile_check.invoked":
		return ensureFields(payload,
			[]string{"trigger"}, nil,
			func(p map[string]any) error {
				return requireEnum(p, "trigger", "toolbar", "shortcut")
			})
	case "compile_check.result":
		return ensureFields(payload,
			[]string{"outcome", "diagnosticCountBucket", "latencyBucket"}, nil,
			func(p map[string]any) error {
				if err := requireEnum(p, "outcome",
					"ok", "errors", "gateway_unavailable", "timeout"); err != nil {
					return err
				}
				if err := requireEnum(p, "diagnosticCountBucket",
					"zero", "lt_10", "lt_100", "ge_100"); err != nil {
					return err
				}
				return requireEnum(p, "latencyBucket", "lt_1s", "lt_5s", "ge_5s")
			})
	case "verify.invoked":
		return ensureFields(payload,
			[]string{"trigger", "hadManualEdits"}, nil,
			func(p map[string]any) error {
				if err := requireEnum(p, "trigger", "toolbar", "shortcut"); err != nil {
					return err
				}
				return requireBool(p, "hadManualEdits")
			})
	case "verify.result":
		return ensureFields(payload,
			[]string{"outcome"}, nil,
			func(p map[string]any) error {
				return requireEnum(p, "outcome",
					"success", "compile_failed", "run_failed", "output_divergence",
					"blocked", "cancelled", "gateway_unavailable")
			})
	case "three_way_merge.opened":
		return ensureFields(payload,
			[]string{"regionCountBucket"}, nil,
			func(p map[string]any) error {
				return requireEnum(p, "regionCountBucket", "lt_5", "lt_20", "ge_20")
			})
	case "three_way_merge.resolved":
		return ensureFields(payload,
			[]string{"regionsPickedPerSource", "cancelled"}, nil,
			func(p map[string]any) error {
				if err := requireBool(p, "cancelled"); err != nil {
					return err
				}
				regions, ok := p["regionsPickedPerSource"].(map[string]any)
				if !ok {
					return fmt.Errorf("regionsPickedPerSource must be an object")
				}
				return ensureFields(regions,
					[]string{"manual", "new_generator", "baseline"}, nil,
					func(r map[string]any) error {
						for _, key := range []string{"manual", "new_generator", "baseline"} {
							if err := requireNonNegativeInt(r, key); err != nil {
								return err
							}
						}
						return nil
					})
			})
	case "manual_edit.region_classified":
		return ensureFields(payload,
			[]string{"originClass"},
			[]string{"mappingClass"},
			func(p map[string]any) error {
				if err := requireEnum(p, "originClass", "manual_modified", "manual_edit"); err != nil {
					return err
				}
				if _, ok := p["mappingClass"]; ok {
					if err := requireEnum(p, "mappingClass",
						"direct", "aggregated", "synthesized", "agent_originated"); err != nil {
						return err
					}
				}
				return nil
			})
	case "format.invoked":
		return ensureFields(payload,
			[]string{"trigger", "fileLineCountBucket"}, nil,
			func(p map[string]any) error {
				if err := requireEnum(p, "trigger", "shortcut", "on_save"); err != nil {
					return err
				}
				return requireEnum(p, "fileLineCountBucket", "lt_100", "lt_1000", "ge_1000")
			})
	case "format.result":
		return ensureFields(payload,
			[]string{"outcome", "latencyBucket"}, nil,
			func(p map[string]any) error {
				if err := requireEnum(p, "outcome",
					"success", "unavailable", "timeout", "noop"); err != nil {
					return err
				}
				return requireEnum(p, "latencyBucket", "lt_500ms", "lt_1500ms", "ge_1500ms")
			})
	case "lint.markers_changed":
		return ensureFields(payload,
			[]string{"countBucket"}, nil,
			func(p map[string]any) error {
				return requireEnum(p, "countBucket", "zero", "lt_10", "lt_50", "ge_50")
			})
	}
	return fmt.Errorf("unsupported eventType %q", eventType)
}

func (e EditorTelemetryEventV0) Validate() error {
	if strings.TrimSpace(e.SchemaVersion) == "" {
		return SchemaValidationError{Path: "schemaVersion", Reason: "required"}
	}
	if e.SchemaVersion != editorTelemetrySchemaVersion {
		return SchemaValidationError{Path: "schemaVersion", Reason: "must be v0"}
	}
	if _, ok := allowedEditorTelemetryEventTypes[e.EventType]; !ok {
		return SchemaValidationError{Path: "eventType", Reason: "unsupported editor-telemetry event type"}
	}
	if e.OccurredAt.IsZero() {
		return SchemaValidationError{Path: "occurredAt", Reason: "required"}
	}
	if e.ReceivedAt.IsZero() {
		return SchemaValidationError{Path: "receivedAt", Reason: "required"}
	}
	if !safeIDPattern.MatchString(e.SessionID) {
		return SchemaValidationError{Path: "sessionId", Reason: "must match ^[A-Za-z0-9._-]{1,128}$"}
	}
	if !safeIDPattern.MatchString(e.TenantID) {
		return SchemaValidationError{Path: "tenantId", Reason: "must match ^[A-Za-z0-9._-]{1,128}$"}
	}
	if !safeIDPattern.MatchString(e.UserID) {
		return SchemaValidationError{Path: "userId", Reason: "must match ^[A-Za-z0-9._-]{1,128}$"}
	}
	if len(e.Payload) == 0 {
		return SchemaValidationError{Path: "payload", Reason: "required"}
	}
	if err := validateEditorTelemetryPayload(e.EventType, e.Payload); err != nil {
		return SchemaValidationError{Path: "payload", Reason: err.Error()}
	}
	return nil
}

func ensureFields(
	payload map[string]any,
	required []string,
	optional []string,
	check func(map[string]any) error,
) error {
	allowed := make(map[string]struct{}, len(required)+len(optional))
	for _, key := range required {
		allowed[key] = struct{}{}
	}
	for _, key := range optional {
		allowed[key] = struct{}{}
	}
	for key := range payload {
		if _, ok := allowed[key]; !ok {
			return fmt.Errorf("unknown property %q", key)
		}
	}
	for _, key := range required {
		if _, ok := payload[key]; !ok {
			return fmt.Errorf("missing required property %q", key)
		}
	}
	if check == nil {
		return nil
	}
	return check(payload)
}

func requireEnum(payload map[string]any, key string, allowed ...string) error {
	raw, ok := payload[key].(string)
	if !ok {
		return fmt.Errorf("%s must be a string", key)
	}
	for _, candidate := range allowed {
		if raw == candidate {
			return nil
		}
	}
	return fmt.Errorf("%s must be one of %v", key, allowed)
}

func requireBool(payload map[string]any, key string) error {
	if _, ok := payload[key].(bool); !ok {
		return fmt.Errorf("%s must be a boolean", key)
	}
	return nil
}

func requireNonNegativeInt(payload map[string]any, key string) error {
	raw, ok := payload[key].(float64)
	if !ok {
		return fmt.Errorf("%s must be a number", key)
	}
	if raw < 0 || raw != float64(int64(raw)) {
		return fmt.Errorf("%s must be a non-negative integer", key)
	}
	return nil
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

type InMemoryEditorTelemetryStore struct {
	mu     sync.RWMutex
	events []EditorTelemetryEventV0
}

func NewInMemoryEditorTelemetryStore() *InMemoryEditorTelemetryStore {
	return &InMemoryEditorTelemetryStore{
		events: make([]EditorTelemetryEventV0, 0),
	}
}

func (s *InMemoryEditorTelemetryStore) List() ([]EditorTelemetryEventV0, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]EditorTelemetryEventV0, 0, len(s.events))
	out = append(out, s.events...)
	return out, nil
}

func (s *InMemoryEditorTelemetryStore) Append(event EditorTelemetryEventV0) error {
	if err := event.Validate(); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.events = append(s.events, event)
	return nil
}

func (s *InMemoryEditorTelemetryStore) BySession(sessionID string) ([]EditorTelemetryEventV0, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]EditorTelemetryEventV0, 0)
	for _, event := range s.events {
		if event.SessionID == sessionID {
			out = append(out, event)
		}
	}
	return out, nil
}

type JSONLEditorTelemetryStore struct {
	InMemoryEditorTelemetryStore
	path string
	file *os.File
}

func NewJSONLEditorTelemetryStore(path string) (*JSONLEditorTelemetryStore, error) {
	if strings.TrimSpace(path) == "" {
		return nil, fmt.Errorf("editor telemetry path is required")
	}
	if err := ensureDir(path); err != nil {
		return nil, err
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR|os.O_APPEND, 0o644)
	if err != nil {
		return nil, fmt.Errorf("open editor telemetry log failed: %w", err)
	}
	store := &JSONLEditorTelemetryStore{
		InMemoryEditorTelemetryStore: InMemoryEditorTelemetryStore{
			events: make([]EditorTelemetryEventV0, 0),
		},
		path: path,
		file: file,
	}
	if err := store.restoreFromDisk(); err != nil {
		_ = file.Close()
		return nil, err
	}
	return store, nil
}

func (s *JSONLEditorTelemetryStore) restoreFromDisk() error {
	if _, err := s.file.Seek(0, 0); err != nil {
		return fmt.Errorf("seek editor telemetry log failed: %w", err)
	}
	scanner := bufio.NewScanner(s.file)
	scanner.Buffer(make([]byte, 0, 64*1024), maxEditorTelemetryLen)
	skipped := 0
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		var event EditorTelemetryEventV0
		if err := json.Unmarshal([]byte(line), &event); err != nil {
			return fmt.Errorf("invalid editor telemetry line: %w", err)
		}
		// Re-enforce the closed-enum contract on the read path: a log
		// hand-edited or produced by an older binary must not deliver
		// invalid events into ``BySession`` / ``List`` results that
		// would themselves be rejected if re-submitted. Skipping plus
		// logging keeps the service available without silently
		// trusting disk state.
		if err := event.Validate(); err != nil {
			log.Printf(
				"editor telemetry restore: skipping invalid line: %v",
				err,
			)
			skipped++
			continue
		}
		s.events = append(s.events, event)
	}
	if err := scanner.Err(); err != nil {
		return fmt.Errorf("read editor telemetry log failed: %w", err)
	}
	if skipped > 0 {
		log.Printf(
			"editor telemetry restore: skipped %d invalid line(s)",
			skipped,
		)
	}
	if _, err := s.file.Seek(0, 2); err != nil {
		return err
	}
	return nil
}

func (s *JSONLEditorTelemetryStore) Append(event EditorTelemetryEventV0) error {
	if err := event.Validate(); err != nil {
		return err
	}
	line, err := json.Marshal(event)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, err := s.file.Write(append(line, '\n')); err != nil {
		return fmt.Errorf("append editor telemetry failed: %w", err)
	}
	if err := s.file.Sync(); err != nil {
		return fmt.Errorf("sync editor telemetry log failed: %w", err)
	}
	s.events = append(s.events, event)
	return nil
}

func (s *JSONLEditorTelemetryStore) Close() error {
	if s.file == nil {
		return nil
	}
	err := s.file.Close()
	s.file = nil
	return err
}

// ---------------------------------------------------------------------------
// HTTP handler — registered in server.go
// ---------------------------------------------------------------------------

func (s *ExperienceLearningService) editorTelemetryHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}
	defer func() { _ = r.Body.Close() }()
	limited := http.MaxBytesReader(w, r.Body, int64(maxEditorTelemetryLen))
	payload, err := io.ReadAll(limited)
	if err != nil {
		writeJSON(w, http.StatusRequestEntityTooLarge, map[string]string{"error": "request too large"})
		return
	}
	raw := strings.TrimSpace(string(payload))
	if raw == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "request body required"})
		return
	}
	var req editorTelemetryIngestRequest
	if err := json.Unmarshal(payload, &req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid telemetry batch"})
		return
	}
	if req.SchemaVersion != editorTelemetrySchemaVersion {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "schemaVersion must be v0"})
		return
	}
	if len(req.Events) == 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "events must be a non-empty array"})
		return
	}
	if len(req.Events) > maxEditorBatchEvents {
		writeJSON(w, http.StatusRequestEntityTooLarge, map[string]string{"error": "batch exceeds maximum event count"})
		return
	}
	for i := range req.Events {
		if err := s.editorTelemetryLog.Append(req.Events[i]); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{
				"error": fmt.Sprintf("events[%d]: %s", i, err.Error()),
			})
			return
		}
	}
	writeJSON(w, http.StatusCreated, editorTelemetryIngestResponse{
		SchemaVersion: editorTelemetrySchemaVersion,
		Accepted:      len(req.Events),
		Service:       serviceName,
	})
}
