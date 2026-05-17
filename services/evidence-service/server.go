package main

import (
	"crypto/subtle"
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

	// maxRequestBodyBytes caps incoming JSON ingest so a single oversized
	// POST cannot OOM the service. W0 evidence requests are reference-only
	// (no raw payloads) so 1 MiB is generous in practice.
	maxRequestBodyBytes = 1 << 20
)

// HealthResponse is the typed shape of GET /v0/health.
type HealthResponse struct {
	Status  string `json:"status"`
	Service string `json:"service"`
}

// ReadyResponse is the typed shape of GET /v0/ready.
type ReadyResponse struct {
	Status        string    `json:"status"`
	Service       string    `json:"service"`
	PackCount     int       `json:"packCount"`
	SchemaVersion string    `json:"schemaVersion"`
	Capability    string    `json:"capability"`
	LastUpdatedAt time.Time `json:"lastUpdatedAt"`
}

// ValidateResponse is the typed shape of POST /v0/packs/{id}/validate.
type ValidateResponse struct {
	PackID     string           `json:"packId"`
	RunID      string           `json:"runId"`
	Validation ValidationResult `json:"validation"`
}

// IncompletePackResponse is the typed 422 response when an export is
// refused because required artifacts are missing.
type IncompletePackResponse struct {
	Error      string           `json:"error"`
	Validation ValidationResult `json:"validation"`
}

// ExportResponse is the typed shape of POST /v0/packs/{id}/export.
type ExportResponse struct {
	Pack   *EvidencePackManifest `json:"pack"`
	Export ExportRecord          `json:"export"`
}

// ErrorResponse is the typed shape of every {"error": "..."} body.
type ErrorResponse struct {
	Error string `json:"error"`
}

type Service struct {
	store        *PackStore
	exporter     *Exporter
	events       EventSink
	stepSeq      *stepCounter
	controlToken string
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
			// Intentionally do not log the path; the err is already
			// path-free via errEventLog.
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

func (s *Service) SetControlToken(token string) {
	s.controlToken = strings.TrimSpace(token)
}

func (s *Service) requireControlToken(w http.ResponseWriter, r *http.Request) bool {
	expected := strings.TrimSpace(s.controlToken)
	if expected == "" {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return false
	}
	presented := presentedControlToken(r)
	if subtle.ConstantTimeCompare([]byte(presented), []byte(expected)) != 1 {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return false
	}
	return true
}

func presentedControlToken(r *http.Request) string {
	if raw := strings.TrimSpace(r.Header.Get("X-C2C-Control-Token")); raw != "" {
		return raw
	}
	if raw := strings.TrimSpace(r.Header.Get("X-Harness-Token")); raw != "" {
		return raw
	}
	raw := strings.TrimSpace(r.Header.Get("Authorization"))
	const prefix = "bearer "
	if strings.HasPrefix(strings.ToLower(raw), prefix) {
		return strings.TrimSpace(raw[len(prefix):])
	}
	return ""
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
	writeJSON(w, http.StatusOK, HealthResponse{Status: "ok", Service: ServiceName})
}

func (s *Service) readyHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	writeJSON(w, http.StatusOK, ReadyResponse{
		Status:        "ready",
		Service:       ServiceName,
		PackCount:     len(s.store.List()),
		SchemaVersion: SchemaVersionV0,
		Capability:    CapabilityEvidence,
		LastUpdatedAt: time.Now().UTC(),
	})
}

func (s *Service) packCollectionHandler(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		writeJSON(w, http.StatusOK, s.store.List())
	case http.MethodPost:
		if !s.requireControlToken(w, r) {
			return
		}
		var input CreateInput
		if err := decodeJSON(w, r, &input); err != nil {
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
			if !s.requireControlToken(w, r) {
				return
			}
			var patch PatchInput
			if err := decodeJSON(w, r, &patch); err != nil {
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
		if !s.requireControlToken(w, r) {
			return
		}
		manifest, ok := s.store.Get(packID)
		if !ok {
			writeError(w, http.StatusNotFound, "pack not found")
			return
		}
		// Re-evaluate against the latest artifact set; the orchestrator may
		// have added evidence via PATCH between requests.
		result := EvaluateValidationForWave(&manifest.Artifacts, manifest.Wave)
		result.CompletenessStatus = deriveCompletenessStatus(
			result,
			manifest.Classification == ClassificationBlocked,
		)
		statusCode := http.StatusOK
		if !result.OK {
			statusCode = http.StatusUnprocessableEntity
		}
		writeJSON(w, statusCode, ValidateResponse{
			PackID:     manifest.PackID,
			RunID:      manifest.RunID,
			Validation: result,
		})
	case "export":
		if r.Method != http.MethodPost {
			writeError(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		if !s.requireControlToken(w, r) {
			return
		}
		var req ExportRequest
		if err := decodeJSON(w, r, &req); err != nil {
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
			writeJSON(w, http.StatusUnprocessableEntity, IncompletePackResponse{
				Error:      "pack is incomplete and cannot be exported",
				Validation: manifest.Validation,
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
		writeJSON(w, http.StatusOK, ExportResponse{
			Pack:   updated,
			Export: record,
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
	payload := &EvidenceEventPayload{
		PackID:     manifest.PackID,
		RunID:      manifest.RunID,
		WorkflowID: manifest.WorkflowID,
		Status:     manifest.Status,
		Validation: manifest.Validation,
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
		EventType:       eventType,
		RunID:           manifest.RunID,
		StepID:          s.stepSeq.next(manifest.RunID),
		Status:          manifest.Status,
		StateTransition: transition,
		InputRef:        inputRef,
		OutputRef:       outputRef,
		Payload:         payload,
		RelatedRecords:  []string{"urn:c2c/evidence/" + manifest.PackID},
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

// decodeJSON is generic on the request body type so every handler binds to
// a specific request struct at the call site instead of routing an
// untyped interface value through the helper.
func decodeJSON[T any](w http.ResponseWriter, r *http.Request, target *T) error {
	if r.Body == nil {
		return errEmptyBody
	}
	ct := r.Header.Get("Content-Type")
	if ct != "" && !strings.Contains(ct, "application/json") {
		return fmt.Errorf("content-type must be application/json")
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxRequestBodyBytes)
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

// writeJSON is generic on the response shape; the type parameter pins the
// payload to a known struct at every call site instead of accepting an
// untyped interface value. The body is buffered up front so a marshal
// failure surfaces as a real 500 instead of a truncated 200.
func writeJSON[T any](w http.ResponseWriter, status int, value T) {
	body, err := json.Marshal(value)
	if err != nil {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(`{"error":"failed to encode response"}`))
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write(body)
}

func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, ErrorResponse{Error: message})
}

func statusForValidationError(err error) int {
	if IsFieldValidationError(err) {
		return http.StatusBadRequest
	}
	return http.StatusInternalServerError
}

func statusForUpdate(err error) int {
	if err == nil {
		return http.StatusInternalServerError
	}
	if strings.Contains(err.Error(), "pack not found") {
		return http.StatusNotFound
	}
	return statusForValidationError(err)
}
