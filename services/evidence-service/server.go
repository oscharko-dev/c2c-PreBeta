package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"
)

const (
	defaultEventLogPath = "data/evidence-events-v0.jsonl"
	defaultExportRoot   = "data/evidence-exports"
	envEventLogPath     = "EVIDENCE_EVENT_LOG_PATH"
	envExportRoot       = "EVIDENCE_EXPORT_DIR"
)

type Service struct {
	store    *PackStore
	exporter *Exporter
	events   EventSink
	stepSeq  *stepCounter
}

type stepCounter struct {
	mu     sync.Mutex
	perRun map[string]int64
}

// NewService wires the in-memory pack store, exporter, and harness event sink
// together. Event persistence uses a JSONL file by default so a W0 run can be
// replayed by reading the log; this matches the pattern in
// services/agentic-harness-core.
func NewService(eventLogPath, exportRoot string) *Service {
	var sink EventSink = NewInMemoryEventSink()
	if path := strings.TrimSpace(eventLogPath); path != "" {
		persisted, err := NewJSONLFileEventSink(path)
		if err == nil {
			sink = persisted
		} else {
			log.Printf("event log initialization failed, falling back to memory sink: %v", err)
		}
	}
	return &Service{
		store:    NewPackStore(),
		exporter: NewExporter(exportRoot),
		events:   sink,
		stepSeq:  newStepCounter(),
	}
}

func (s *Service) Routes() *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("/v0/health", s.healthHandler)
	mux.HandleFunc("/v0/ready", s.readyHandler)
	mux.HandleFunc("/v0/packs", s.packCollectionHandler)
	mux.HandleFunc("/v0/packs/", s.packItemHandler)
	mux.HandleFunc("/v0/events", s.eventsHandler)
	return mux
}

func (s *Service) healthHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"status":  "ok",
		"service": ServiceName,
	})
}

func (s *Service) readyHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"status":         "ready",
		"service":        ServiceName,
		"packCount":      len(s.store.List()),
		"schemaVersion":  SchemaVersionV0,
		"capability":     CapabilityEvidence,
		"lastUpdatedAt":  time.Now().UTC(),
	})
}

func (s *Service) packCollectionHandler(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		writeJSON(w, http.StatusOK, s.store.List())
	case http.MethodPost:
		var input CreateInput
		if err := decodeJSON(r, &input); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		manifest, err := s.store.Create(input)
		if err != nil {
			writeError(w, statusForValidationError(err), err.Error())
			return
		}
		if err := s.emitPackEvent(manifest, EventTypePackCreated, "pack.created"); err != nil {
			log.Printf("event emission failed: %v", err)
		}
		writeJSON(w, http.StatusCreated, manifest)
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func (s *Service) packItemHandler(w http.ResponseWriter, r *http.Request) {
	rest := strings.TrimPrefix(r.URL.Path, "/v0/packs/")
	segments := strings.Split(rest, "/")
	if len(segments) == 0 || segments[0] == "" {
		writeError(w, http.StatusNotFound, "packId required")
		return
	}
	packID := segments[0]
	if len(segments) == 1 {
		switch r.Method {
		case http.MethodGet:
			manifest, ok := s.store.Get(packID)
			if !ok {
				writeError(w, http.StatusNotFound, "pack not found")
				return
			}
			writeJSON(w, http.StatusOK, manifest)
		case http.MethodPatch:
			var patch PatchInput
			if err := decodeJSON(r, &patch); err != nil {
				writeError(w, http.StatusBadRequest, err.Error())
				return
			}
			manifest, err := s.store.Update(packID, patch)
			if err != nil {
				writeError(w, statusForUpdate(err), err.Error())
				return
			}
			if err := s.emitPackEvent(manifest, EventTypePackUpdated, "pack.updated"); err != nil {
				log.Printf("event emission failed: %v", err)
			}
			writeJSON(w, http.StatusOK, manifest)
		default:
			writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		}
		return
	}
	if len(segments) != 2 {
		writeError(w, http.StatusNotFound, "invalid pack operation")
		return
	}
	switch segments[1] {
	case "validate":
		if r.Method != http.MethodPost {
			writeError(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		manifest, ok := s.store.Get(packID)
		if !ok {
			writeError(w, http.StatusNotFound, "pack not found")
			return
		}
		// Re-evaluate against the latest artifact set; the orchestrator may
		// have added evidence via PATCH between requests.
		result := EvaluateValidation(&manifest.Artifacts)
		statusCode := http.StatusOK
		if !result.OK {
			statusCode = http.StatusUnprocessableEntity
		}
		writeJSON(w, statusCode, map[string]any{
			"packId":     manifest.PackID,
			"runId":      manifest.RunID,
			"validation": result,
		})
	case "export":
		if r.Method != http.MethodPost {
			writeError(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		var req ExportRequest
		if err := decodeJSON(r, &req); err != nil {
			// Empty body is allowed and means "use defaults".
			if !errors.Is(err, errEmptyBody) {
				writeError(w, http.StatusBadRequest, err.Error())
				return
			}
			req = ExportRequest{}
		}
		manifest, ok := s.store.Get(packID)
		if !ok {
			writeError(w, http.StatusNotFound, "pack not found")
			return
		}
		// Validation must pass before export so consumers never receive a
		// pack that misses the W0 required artifact set.
		if !manifest.Validation.OK {
			writeJSON(w, http.StatusUnprocessableEntity, map[string]any{
				"error":      "pack is incomplete and cannot be exported",
				"validation": manifest.Validation,
			})
			return
		}
		record, err := s.exporter.Export(manifest, req)
		if err != nil {
			writeError(w, statusForValidationError(err), err.Error())
			return
		}
		updated, err := s.store.RecordExport(packID, record)
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		if err := s.emitPackEvent(updated, EventTypePackExported, "pack.exported"); err != nil {
			log.Printf("event emission failed: %v", err)
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"pack":   updated,
			"export": record,
		})
	default:
		writeError(w, http.StatusNotFound, "invalid pack operation")
	}
}

func (s *Service) eventsHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	events, err := s.events.List()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, events)
}

func (s *Service) emitPackEvent(manifest *EvidencePackManifest, eventType, transition string) error {
	payload := map[string]any{
		"packId":     manifest.PackID,
		"runId":      manifest.RunID,
		"workflowId": manifest.WorkflowID,
		"status":     manifest.Status,
		"validation": manifest.Validation,
	}
	inputRef, err := NewDataReference(
		fmt.Sprintf("urn:c2c/evidence/%s/manifest-input", manifest.PackID),
		payload, "application/json", "evidence-pack-input",
	)
	if err != nil {
		return err
	}
	outputRef, err := NewDataReference(
		fmt.Sprintf("urn:c2c/evidence/%s/manifest", manifest.PackID),
		manifest, "application/json", "evidence-pack-manifest",
	)
	if err != nil {
		return err
	}
	event := HarnessEvent{
		EventType:        eventType,
		RunID:            manifest.RunID,
		StepID:           s.stepSeq.next(manifest.RunID),
		Status:           manifest.Status,
		StateTransition:  transition,
		InputRef:         inputRef,
		OutputRef:        outputRef,
		Payload:          payload,
		RelatedRecords:   []string{"urn:c2c/evidence/" + manifest.PackID},
	}
	_, err = s.events.Emit(event)
	return err
}

func newStepCounter() *stepCounter {
	return &stepCounter{perRun: make(map[string]int64)}
}

func (c *stepCounter) next(runID string) int64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.perRun[runID]++
	return c.perRun[runID]
}

var errEmptyBody = errors.New("empty request body")

func decodeJSON(r *http.Request, target any) error {
	if r.Body == nil {
		return errEmptyBody
	}
	if !strings.Contains(r.Header.Get("Content-Type"), "application/json") && r.ContentLength != 0 {
		return fmt.Errorf("content-type must be application/json")
	}
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(target); err != nil {
		if errors.Is(err, io.EOF) {
			return errEmptyBody
		}
		return fmt.Errorf("invalid JSON body: %w", err)
	}
	return nil
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]string{"error": message})
}

func statusForValidationError(err error) int {
	if IsFieldValidationError(err) {
		return http.StatusBadRequest
	}
	return http.StatusBadRequest
}

func statusForUpdate(err error) int {
	if strings.Contains(err.Error(), "pack not found") {
		return http.StatusNotFound
	}
	return statusForValidationError(err)
}
