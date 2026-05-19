package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func newTestService(t *testing.T) *ExperienceLearningService {
	t.Helper()
	cfgNow := time.Date(2026, 5, 18, 12, 0, 0, 0, time.UTC)
	return NewExperienceLearningService(
		experienceLearningConfig{autoAnalyzeOnIngest: false},
		NewInMemoryHarnessEventStore(),
		NewInMemoryTrajectoryLedgerStore(),
		NewInMemoryExperienceEventStore(),
		NewInMemoryEditorTelemetryStore(),
		DefaultLearningPolicy(),
		func() time.Time { return cfgNow },
	)
}

func makeValidEvent(eventType string, payload map[string]any) map[string]any {
	raw, _ := json.Marshal(payload)
	return map[string]any{
		"schemaVersion": "v0",
		"eventType":     eventType,
		"occurredAt":    "2026-05-18T12:00:00Z",
		"receivedAt":    "2026-05-18T12:00:01Z",
		"sessionId":     "test-session-1",
		"tenantId":      "default",
		"userId":        "local",
		"payload":       json.RawMessage(raw),
	}
}

func TestEditorTelemetry_AcceptsValidBatch(t *testing.T) {
	service := newTestService(t)
	batch := map[string]any{
		"schemaVersion": "v0",
		"events": []map[string]any{
			makeValidEvent("hover.opened", map[string]any{"constructKind": "pic"}),
			makeValidEvent("marker.navigate", map[string]any{
				"direction":  "next",
				"sourceKind": "cobol",
				"severity":   "error",
			}),
			makeValidEvent("drafts.cleared", map[string]any{"purgedCountBucket": "lt_10"}),
		},
	}
	body, _ := json.Marshal(batch)
	req := httptest.NewRequest(http.MethodPost, "/v0/editor-telemetry", bytes.NewReader(body))
	w := httptest.NewRecorder()
	service.editorTelemetryHandler(w, req)

	if w.Code != http.StatusCreated {
		t.Fatalf("expected 201 created, got %d body=%s", w.Code, w.Body.String())
	}
	stored, err := service.editorTelemetryLog.List()
	if err != nil {
		t.Fatalf("list failed: %v", err)
	}
	if len(stored) != 3 {
		t.Fatalf("expected 3 stored events, got %d", len(stored))
	}
}

func TestEditorTelemetry_RejectsUnknownEventType(t *testing.T) {
	service := newTestService(t)
	batch := map[string]any{
		"schemaVersion": "v0",
		"events": []map[string]any{
			makeValidEvent("hover.opened", map[string]any{"constructKind": "pic"}),
		},
	}
	// Mutate the event type after construction so we exercise the
	// closed-enum rejection path.
	events := batch["events"].([]map[string]any)
	events[0]["eventType"] = "not.a.real.event"

	body, _ := json.Marshal(batch)
	req := httptest.NewRequest(http.MethodPost, "/v0/editor-telemetry", bytes.NewReader(body))
	w := httptest.NewRecorder()
	service.editorTelemetryHandler(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d body=%s", w.Code, w.Body.String())
	}
}

func TestEditorTelemetry_RejectsUnknownPayloadProperty(t *testing.T) {
	service := newTestService(t)
	batch := map[string]any{
		"schemaVersion": "v0",
		"events": []map[string]any{
			makeValidEvent("hover.opened", map[string]any{
				"constructKind": "pic",
				// Hostile extra field — must be rejected at the BFF boundary,
				// re-rejected here as defence in depth.
				"sourceFieldName": "ACCOUNT-BALANCE",
			}),
		},
	}
	body, _ := json.Marshal(batch)
	req := httptest.NewRequest(http.MethodPost, "/v0/editor-telemetry", bytes.NewReader(body))
	w := httptest.NewRecorder()
	service.editorTelemetryHandler(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for extra payload field, got %d body=%s", w.Code, w.Body.String())
	}
}

func TestEditorTelemetry_RejectsUnknownBatchProperty(t *testing.T) {
	service := newTestService(t)
	batch := map[string]any{
		"schemaVersion": "v0",
		"events":        []map[string]any{makeValidEvent("hover.opened", map[string]any{"constructKind": "pic"})},
		"sourceText":    "IDENTIFICATION DIVISION.",
	}
	body, _ := json.Marshal(batch)
	req := httptest.NewRequest(http.MethodPost, "/v0/editor-telemetry", bytes.NewReader(body))
	w := httptest.NewRecorder()
	service.editorTelemetryHandler(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for unknown batch property, got %d body=%s", w.Code, w.Body.String())
	}
}

func TestEditorTelemetry_RejectsUnknownEventProperty(t *testing.T) {
	service := newTestService(t)
	event := makeValidEvent("hover.opened", map[string]any{"constructKind": "pic"})
	event["sourceText"] = "IDENTIFICATION DIVISION."
	batch := map[string]any{
		"schemaVersion": "v0",
		"events":        []map[string]any{event},
	}
	body, _ := json.Marshal(batch)
	req := httptest.NewRequest(http.MethodPost, "/v0/editor-telemetry", bytes.NewReader(body))
	w := httptest.NewRecorder()
	service.editorTelemetryHandler(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for unknown event property, got %d body=%s", w.Code, w.Body.String())
	}
}

func TestEditorTelemetry_RejectsBatchAtomically(t *testing.T) {
	service := newTestService(t)
	batch := map[string]any{
		"schemaVersion": "v0",
		"events": []map[string]any{
			makeValidEvent("hover.opened", map[string]any{"constructKind": "pic"}),
			makeValidEvent("hover.opened", map[string]any{
				"constructKind": "pic",
				"sourceText":    "IDENTIFICATION DIVISION.",
			}),
		},
	}
	body, _ := json.Marshal(batch)
	req := httptest.NewRequest(http.MethodPost, "/v0/editor-telemetry", bytes.NewReader(body))
	w := httptest.NewRecorder()
	service.editorTelemetryHandler(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for invalid batch, got %d body=%s", w.Code, w.Body.String())
	}
	stored, err := service.editorTelemetryLog.List()
	if err != nil {
		t.Fatalf("list failed: %v", err)
	}
	if len(stored) != 0 {
		t.Fatalf("expected atomic rejection with 0 stored events, got %d", len(stored))
	}
}

func TestEditorTelemetry_RejectsHugePayload(t *testing.T) {
	service := newTestService(t)
	batch := map[string]any{
		"schemaVersion": "v0",
		"events":        make([]map[string]any, 0, 200),
	}
	events := batch["events"].([]map[string]any)
	for i := 0; i < 150; i += 1 {
		events = append(events, makeValidEvent("hover.opened", map[string]any{"constructKind": "pic"}))
	}
	batch["events"] = events

	body, _ := json.Marshal(batch)
	req := httptest.NewRequest(http.MethodPost, "/v0/editor-telemetry", bytes.NewReader(body))
	w := httptest.NewRecorder()
	service.editorTelemetryHandler(w, req)

	if w.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("expected 413, got %d body=%s", w.Code, w.Body.String())
	}
}

func TestEditorTelemetry_RejectsWrongSchemaVersion(t *testing.T) {
	service := newTestService(t)
	batch := map[string]any{
		"schemaVersion": "v1",
		"events":        []map[string]any{makeValidEvent("hover.opened", map[string]any{"constructKind": "pic"})},
	}
	body, _ := json.Marshal(batch)
	req := httptest.NewRequest(http.MethodPost, "/v0/editor-telemetry", bytes.NewReader(body))
	w := httptest.NewRecorder()
	service.editorTelemetryHandler(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d body=%s", w.Code, w.Body.String())
	}
}

func TestEditorTelemetry_RejectsMethodNotAllowed(t *testing.T) {
	service := newTestService(t)
	req := httptest.NewRequest(http.MethodGet, "/v0/editor-telemetry", nil)
	w := httptest.NewRecorder()
	service.editorTelemetryHandler(w, req)
	if w.Code != http.StatusMethodNotAllowed {
		t.Fatalf("expected 405, got %d body=%s", w.Code, w.Body.String())
	}
}

func TestEditorTelemetry_RejectsBadSessionId(t *testing.T) {
	service := newTestService(t)
	event := makeValidEvent("hover.opened", map[string]any{"constructKind": "pic"})
	// Smuggle an invalid character that the safe-ID pattern rejects.
	event["sessionId"] = "session id with spaces"
	batch := map[string]any{
		"schemaVersion": "v0",
		"events":        []map[string]any{event},
	}
	body, _ := json.Marshal(batch)
	req := httptest.NewRequest(http.MethodPost, "/v0/editor-telemetry", bytes.NewReader(body))
	w := httptest.NewRecorder()
	service.editorTelemetryHandler(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d body=%s", w.Code, w.Body.String())
	}
}

func TestEditorTelemetry_RestoreFromDiskSkipsInvalidLines(t *testing.T) {
	tmp := filepath.Join(t.TempDir(), "events.jsonl")
	// Seed three lines: one valid, one with an unknown eventType
	// (closed-enum violation), one structurally well-formed but with a
	// bad sessionId pattern. Only the valid event must be retained.
	validEvent := EditorTelemetryEventV0{
		SchemaVersion: "v0",
		EventType:     "hover.opened",
		OccurredAt:    time.Date(2026, 5, 18, 12, 0, 0, 0, time.UTC),
		ReceivedAt:    time.Date(2026, 5, 18, 12, 0, 1, 0, time.UTC),
		SessionID:     "good-session",
		TenantID:      "default",
		UserID:        "local",
		Payload:       json.RawMessage(`{"constructKind":"pic"}`),
	}
	invalidEventTypeLine, _ := json.Marshal(map[string]any{
		"schemaVersion": "v0",
		"eventType":     "not.a.real.event",
		"occurredAt":    "2026-05-18T12:00:00Z",
		"receivedAt":    "2026-05-18T12:00:01Z",
		"sessionId":     "bad-session",
		"tenantId":      "default",
		"userId":        "local",
		"payload":       map[string]any{"constructKind": "pic"},
	})
	badSessionLine, _ := json.Marshal(map[string]any{
		"schemaVersion": "v0",
		"eventType":     "hover.opened",
		"occurredAt":    "2026-05-18T12:00:00Z",
		"receivedAt":    "2026-05-18T12:00:01Z",
		"sessionId":     "session id with spaces",
		"tenantId":      "default",
		"userId":        "local",
		"payload":       map[string]any{"constructKind": "pic"},
	})
	validLine, _ := json.Marshal(validEvent)
	contents := append(invalidEventTypeLine, '\n')
	contents = append(contents, badSessionLine...)
	contents = append(contents, '\n')
	contents = append(contents, validLine...)
	contents = append(contents, '\n')
	if err := os.WriteFile(tmp, contents, 0o644); err != nil {
		t.Fatalf("seed file failed: %v", err)
	}
	store, err := NewJSONLEditorTelemetryStore(tmp)
	if err != nil {
		t.Fatalf("open store failed: %v", err)
	}
	defer func() { _ = store.Close() }()
	all, err := store.List()
	if err != nil {
		t.Fatalf("List failed: %v", err)
	}
	if len(all) != 1 {
		t.Fatalf("expected 1 valid event after restore, got %d", len(all))
	}
	if all[0].SessionID != "good-session" {
		t.Fatalf("unexpected event survived restore: %+v", all[0])
	}
}

func TestEditorTelemetry_StoreFiltersBySession(t *testing.T) {
	store := NewInMemoryEditorTelemetryStore()
	now := time.Date(2026, 5, 18, 12, 0, 0, 0, time.UTC)
	for _, sessionID := range []string{"s1", "s1", "s2"} {
		event := EditorTelemetryEventV0{
			SchemaVersion: "v0",
			EventType:     "hover.opened",
			OccurredAt:    now,
			ReceivedAt:    now,
			SessionID:     sessionID,
			TenantID:      "default",
			UserID:        "local",
			Payload:       json.RawMessage(`{"constructKind":"pic"}`),
		}
		if err := store.Append(event); err != nil {
			t.Fatalf("append failed: %v", err)
		}
	}
	s1, err := store.BySession("s1")
	if err != nil {
		t.Fatalf("BySession failed: %v", err)
	}
	if len(s1) != 2 {
		t.Fatalf("expected 2 events for s1, got %d", len(s1))
	}
	s2, err := store.BySession("s2")
	if err != nil {
		t.Fatalf("BySession s2 failed: %v", err)
	}
	if len(s2) != 1 {
		t.Fatalf("expected 1 event for s2, got %d", len(s2))
	}
}
