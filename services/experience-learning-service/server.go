package main

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"sort"
	"strings"
	"sync"
	"time"
)

type ExperienceLearningService struct {
	cfg              experienceLearningConfig
	policy           LearningPolicy
	harnessEvents    HarnessEventLog
	ledgers          TrajectoryLedgerLog
	experienceEvents LearningEventLog
	// Studio-IDE-11 (#251): editor telemetry log — closed-enum, tag-only
	// learning signals shipped from the Studio via the BFF intake.
	editorTelemetryLog EditorTelemetryEventLog
	analyzer           *PatternAnalyzer
	summaries          map[string]RunLearningSummary
	artifactRegistry   map[string]LearningArtifactRecord
	artifactPath       string
	now                func() time.Time
	mu                 sync.RWMutex
}

type inProcessAnalyzeRequest struct {
	RunID string `json:"runId"`
}

func NewExperienceLearningService(
	cfg experienceLearningConfig,
	harnessEvents HarnessEventLog,
	ledgers TrajectoryLedgerLog,
	experienceEvents LearningEventLog,
	editorTelemetry EditorTelemetryEventLog,
	policy LearningPolicy,
	now func() time.Time,
) *ExperienceLearningService {
	if now == nil {
		now = time.Now().UTC
	}
	if editorTelemetry == nil {
		editorTelemetry = NewInMemoryEditorTelemetryStore()
	}
	service := &ExperienceLearningService{
		cfg:                cfg,
		policy:             policy,
		harnessEvents:      harnessEvents,
		ledgers:            ledgers,
		experienceEvents:   experienceEvents,
		editorTelemetryLog: editorTelemetry,
		analyzer:           NewPatternAnalyzer(policy, now),
		summaries:          map[string]RunLearningSummary{},
		artifactRegistry:   map[string]LearningArtifactRecord{},
		artifactPath:       cfg.artifactRegistryPath,
		now:                now,
	}
	if err := service.loadExistingArtifactRegistry(); err != nil {
		log.Printf("learning artifact registry init failed: %v", err)
	}
	return service
}

func (s *ExperienceLearningService) Routes() *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("/v0/health", s.healthHandler)
	mux.HandleFunc("/v0/config", s.configHandler)
	mux.HandleFunc("/v0/harness-events", s.ingestHarnessEventsHandler)
	mux.HandleFunc("/v0/trajectory-ledgers", s.ingestTrajectoryLedgersHandler)
	mux.HandleFunc("/v0/events", s.experienceEventsHandler)
	mux.HandleFunc("/v0/analyze", s.analyzeHandler)
	mux.HandleFunc("/v0/runs", s.runCollectionHandler)
	mux.HandleFunc("/v0/runs/", s.runItemHandler)
	mux.HandleFunc("/v0/policy", s.policyHandler)
	mux.HandleFunc("/v0/artifacts", s.artifactCollectionHandler)
	mux.HandleFunc("/v0/artifacts/", s.artifactItemHandler)
	// Studio-IDE-11 (#251): editor telemetry intake — closed-enum,
	// tag-only learning signals from the Studio editor via the BFF.
	mux.HandleFunc("/v0/editor-telemetry", s.editorTelemetryHandler)
	return mux
}

func (s *ExperienceLearningService) healthHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"status":        "ok",
		"service":       serviceName,
		"schemaVersion": experienceSchemaVersion,
		"observation":   s.policy.ObservationOnly,
		"policyVersion": s.policy.PolicyVersion,
	})
}

func (s *ExperienceLearningService) configHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"listenAddr":           s.cfg.listenAddr,
		"harnessEventPath":     s.cfg.harnessEventPath,
		"trajectoryPath":       s.cfg.trajectoryPath,
		"experienceEventPath":  s.cfg.experienceEventPath,
		"artifactRegistryPath": s.cfg.artifactRegistryPath,
		"autoAnalyzeOnIngest":  s.cfg.autoAnalyzeOnIngest,
	})
}

func (s *ExperienceLearningService) policyHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}
	writeJSON(w, http.StatusOK, s.policy)
}

func (s *ExperienceLearningService) ingestHarnessEventsHandler(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		events, err := s.harnessEvents.List()
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, events)
	case http.MethodPost:
		payload, err := io.ReadAll(r.Body)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "failed to read request body"})
			return
		}
		raw := strings.TrimSpace(string(payload))
		if raw == "" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "request body required"})
			return
		}
		var events []EventEnvelopeV0
		if raw[0] == '[' {
			if err := json.Unmarshal(payload, &events); err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid event array"})
				return
			}
		} else {
			var single EventEnvelopeV0
			if err := json.Unmarshal(payload, &single); err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid event object"})
				return
			}
			events = append(events, single)
		}
		runIDs, err := s.ingestHarnessEvents(events)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		if s.cfg.autoAnalyzeOnIngest {
			for _, runID := range runIDs {
				if _, err := s.RunLearningSummary(runID); err != nil {
					writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
					return
				}
			}
		}
		writeJSON(w, http.StatusCreated, map[string]any{
			"ingested": len(events),
			"runIds":   runIDs,
			"analyzed": s.cfg.autoAnalyzeOnIngest,
			"service":  serviceName,
		})
	default:
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
	}
}

func (s *ExperienceLearningService) ingestHarnessEvents(events []EventEnvelopeV0) ([]string, error) {
	seen := map[string]struct{}{}
	for i := range events {
		event := &events[i]
		if strings.TrimSpace(event.SchemaVersion) == "" {
			event.SchemaVersion = experienceSchemaVersion
		}
		if event.Service == "" {
			event.Service = serviceName
		}
		if event.CreatedAt.IsZero() {
			event.CreatedAt = s.now()
		}
		if event.StepID == 0 {
			event.StepID = int64(i + 1)
		}
		if event.PolicyDecision == "" {
			event.PolicyDecision = "policy allow"
		}
		if event.Status == "" {
			event.Status = "completed"
		}
		if strings.TrimSpace(event.Status) == "" {
			return nil, fmt.Errorf("status is required")
		}
		if event.RunID == "" {
			return nil, fmt.Errorf("runId is required")
		}
		if strings.TrimSpace(event.InputRef.URI) == "" {
			ref, err := NewEventReference("urn:experience-learning/input", map[string]any{
				"payload": event.Payload,
				"runId":   event.RunID,
				"eventId": event.EventID,
			})
			if err != nil {
				return nil, err
			}
			event.InputRef = ref
		}
		if strings.TrimSpace(event.OutputRef.URI) == "" {
			ref, err := NewEventReference("urn:experience-learning/output", map[string]any{
				"payload":  event.Payload,
				"status":   event.Status,
				"runId":    event.RunID,
				"eventId":  event.EventID,
				"captured": s.now().Format(time.RFC3339Nano),
			})
			if err != nil {
				return nil, err
			}
			event.OutputRef = ref
		}
		if err := s.harnessEvents.Append(*event); err != nil {
			return nil, err
		}
		seen[event.RunID] = struct{}{}
	}
	runIDs := make([]string, 0, len(seen))
	for runID := range seen {
		runIDs = append(runIDs, runID)
	}
	sort.Strings(runIDs)
	return runIDs, nil
}

func (s *ExperienceLearningService) ingestTrajectoryLedgersHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost && r.Method != http.MethodGet {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}
	if r.Method == http.MethodGet {
		ledgers, err := s.ledgers.List()
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, ledgers)
		return
	}
	var payload []AgentTrajectoryLedgerV0
	body, err := io.ReadAll(r.Body)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "failed to read request body"})
		return
	}
	raw := strings.TrimSpace(string(body))
	if raw == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "request body required"})
		return
	}
	if raw[0] == '[' {
		if err := json.Unmarshal(body, &payload); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid trajectory ledger array"})
			return
		}
	} else {
		var single AgentTrajectoryLedgerV0
		if err := json.Unmarshal(body, &single); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid trajectory ledger object"})
			return
		}
		payload = append(payload, single)
	}
	for _, item := range payload {
		if item.SchemaVersion == "" {
			item.SchemaVersion = experienceSchemaVersion
		}
		if item.CapturedAt.IsZero() {
			item.CapturedAt = s.now()
		}
		if err := s.ledgers.Append(item); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		if s.cfg.autoAnalyzeOnIngest {
			if _, err := s.RunLearningSummary(item.RunID); err != nil {
				writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
				return
			}
		}
	}
	writeJSON(w, http.StatusCreated, map[string]any{"ingested": len(payload), "service": serviceName})
}

func (s *ExperienceLearningService) experienceEventsHandler(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		items, err := s.experienceEvents.List()
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, items)
	default:
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
	}
}

func (s *ExperienceLearningService) analyzeHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}
	var req inProcessAnalyzeRequest
	if err := decodeJSON(r, &req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}
	if strings.TrimSpace(req.RunID) == "" {
		runIDs, err := s.collectRunIDs()
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		summaries := make([]RunLearningSummary, 0, len(runIDs))
		for _, runID := range runIDs {
			summary, err := s.RunLearningSummary(runID)
			if err != nil {
				writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
				return
			}
			summaries = append(summaries, summary)
		}
		writeJSON(w, http.StatusOK, summaries)
		return
	}
	summary, err := s.RunLearningSummary(req.RunID)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, summary)
}

func (s *ExperienceLearningService) runCollectionHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}
	runIDs, err := s.collectRunIDs()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	sort.Strings(runIDs)
	runSummaries := make([]RunLearningSummary, 0, len(runIDs))
	for _, runID := range runIDs {
		summary, err := s.RunLearningSummary(runID)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		runSummaries = append(runSummaries, summary)
	}
	writeJSON(w, http.StatusOK, runSummaries)
}

func (s *ExperienceLearningService) runItemHandler(w http.ResponseWriter, r *http.Request) {
	runPath := strings.TrimPrefix(r.URL.Path, "/v0/runs/")
	if strings.TrimSpace(runPath) == "" {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "run id required"})
		return
	}
	segments := strings.Split(runPath, "/")
	runID := segments[0]
	if runID == "" {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "run id required"})
		return
	}
	if len(segments) == 2 && segments[1] == "summary" {
		summary, err := s.RunLearningSummary(runID)
		if err != nil {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, summary)
		return
	}
	if len(segments) == 2 && segments[1] == "events" {
		items, err := s.experienceEvents.ByRun(runID)
		if err != nil {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, items)
		return
	}
	writeJSON(w, http.StatusNotFound, map[string]string{"error": "invalid run path"})
}

func (s *ExperienceLearningService) artifactCollectionHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	records := make([]LearningArtifactRecord, 0, len(s.artifactRegistry))
	for _, record := range s.artifactRegistry {
		records = append(records, record)
	}
	sort.Slice(records, func(i, j int) bool {
		return records[i].RunID < records[j].RunID
	})
	writeJSON(w, http.StatusOK, LearningArtifactRegistryV0{
		SchemaVersion: experienceSchemaVersion,
		GeneratedAt:   s.now(),
		Service:       serviceName,
		Records:       indexArtifacts(records),
	})
}

func (s *ExperienceLearningService) artifactItemHandler(w http.ResponseWriter, r *http.Request) {
	runID := strings.TrimPrefix(r.URL.Path, "/v0/artifacts/")
	if strings.TrimSpace(runID) == "" {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "run id required"})
		return
	}
	if r.Method != http.MethodGet {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}
	s.mu.RLock()
	record, ok := s.artifactRegistry[runID]
	s.mu.RUnlock()
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "artifact not found"})
		return
	}
	writeJSON(w, http.StatusOK, record)
}

func (s *ExperienceLearningService) RunLearningSummary(runID string) (RunLearningSummary, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	rawEvents, err := s.harnessEvents.List()
	if err != nil {
		return RunLearningSummary{}, err
	}
	ledgers, err := s.ledgers.List()
	if err != nil {
		return RunLearningSummary{}, err
	}
	candidates, summary, err := s.analyzer.AnalyzeRun(runID, rawEvents, ledgers)
	if err != nil {
		return RunLearningSummary{}, err
	}
	existing, err := s.experienceEvents.ByRun(runID)
	if err != nil {
		return RunLearningSummary{}, err
	}
	existingByKey := map[string]struct{}{}
	for _, item := range existing {
		key := item.PatternFingerprint
		if item.Pattern != "" {
			key = item.Pattern + ":" + key
		}
		existingByKey[key] = struct{}{}
	}
	for _, candidate := range candidates {
		key := candidate.PatternFingerprint
		if candidate.Pattern != "" {
			key = candidate.Pattern + ":" + key
		}
		_, exists := existingByKey[key]
		if exists {
			continue
		}
		_, err := s.experienceEvents.Append(candidate)
		if err != nil {
			return RunLearningSummary{}, err
		}
		existingByKey[key] = struct{}{}
	}
	storedSummary, err := s.experienceEvents.ByRun(runID)
	if err != nil {
		return RunLearningSummary{}, err
	}
	summary.CandidateCount = len(storedSummary)
	summary.CandidateByPattern = map[string]int{}
	for _, candidate := range storedSummary {
		summary.CandidateByPattern[candidate.Pattern]++
	}
	summary.ExperienceEventIDs = make([]string, 0, len(storedSummary))
	for _, candidate := range storedSummary {
		summary.ExperienceEventIDs = append(summary.ExperienceEventIDs, candidate.EventID)
	}
	summary.ObservedPatterns = sortedPatternKeys(summary.CandidateByPattern)
	s.summarysSetLocked(runID, summary)
	if err := s.persistArtifactRegistry(runID, summary, storedSummary); err != nil {
		return RunLearningSummary{}, err
	}
	return summary, nil
}

func (s *ExperienceLearningService) summaryForRun(runID string) (RunLearningSummary, bool) {
	item, ok := s.summaries[runID]
	return item, ok
}

func (s *ExperienceLearningService) summarysSetLocked(runID string, summary RunLearningSummary) {
	s.summaries[runID] = summary
}

func (s *ExperienceLearningService) collectRunIDs() ([]string, error) {
	events, err := s.harnessEvents.List()
	if err != nil {
		return nil, err
	}
	runSet := map[string]struct{}{}
	for _, item := range events {
		runSet[item.RunID] = struct{}{}
	}
	ledgers, err := s.ledgers.List()
	if err != nil {
		return nil, err
	}
	for _, item := range ledgers {
		runSet[item.RunID] = struct{}{}
	}
	runIDs := make([]string, 0, len(runSet))
	for runID := range runSet {
		runIDs = append(runIDs, runID)
	}
	return runIDs, nil
}

func (s *ExperienceLearningService) loadExistingArtifactRegistry() error {
	if s.cfg.artifactRegistryPath == "" {
		return nil
	}
	raw, err := os.ReadFile(s.cfg.artifactRegistryPath)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	var registry LearningArtifactRegistryV0
	if err := json.Unmarshal(raw, &registry); err != nil {
		return err
	}
	for _, item := range registry.Records {
		s.artifactRegistry[item.RunID] = item
	}
	return nil
}

func (s *ExperienceLearningService) persistArtifactRegistry(runID string, summary RunLearningSummary, storedSummary []ExperienceEventV0) error {
	if s.cfg.artifactRegistryPath == "" {
		return nil
	}
	artifact := LearningArtifactRecord{
		SchemaVersion:       experienceSchemaVersion,
		ArtifactID:          "artifact-" + runID,
		RunID:               runID,
		Service:             serviceName,
		GeneratedAt:         s.now(),
		Summary:             summary,
		ExperienceEventRefs: make([]string, 0, len(storedSummary)),
	}
	for _, item := range storedSummary {
		artifact.ExperienceEventRefs = append(artifact.ExperienceEventRefs, item.EventID)
	}
	s.artifactRegistry[runID] = artifact
	return s.writeArtifactRegistry()
}

func (s *ExperienceLearningService) writeArtifactRegistry() error {
	registry := LearningArtifactRegistryV0{
		SchemaVersion: experienceSchemaVersion,
		GeneratedAt:   s.now(),
		Service:       serviceName,
		Records:       s.artifactRegistry,
	}
	raw, err := json.MarshalIndent(registry, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(s.cfg.artifactRegistryPath, raw, 0o644)
}

func indexArtifacts(records []LearningArtifactRecord) map[string]LearningArtifactRecord {
	out := make(map[string]LearningArtifactRecord, len(records))
	for _, item := range records {
		out[item.RunID] = item
	}
	return out
}

func decodeJSON(r *http.Request, target any) error {
	defer func() { _ = r.Body.Close() }()
	return json.NewDecoder(r.Body).Decode(target)
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
