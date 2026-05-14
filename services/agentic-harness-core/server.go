package main

import (
	"errors"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"strings"
	"time"
)

const (
	defaultEventLogPath = "data/harness-events-v0.jsonl"

	eventTypeCapabilityRegistered = "capability.registered"
	eventTypeMCPRegistered       = "mcp-server.registered"
	eventTypeRunCompleted        = "run.completed"
	eventTypeRunFailed           = "run.failed"
	eventTypeRunUpdated          = "run.updated"
	eventTypeRunStarted          = "run.started"
)

type HarnessService struct {
	capabilities *CapabilityRegistry
	runStore     *RunStore
	mcpServers   *McpServerRegistry
	policy       PolicyEngine
	events       EventSink
	stepTracker  *RunStepTracker
}

type PolicyRequest struct {
	Action string            `json:"action"`
	Actor  string            `json:"actor"`
	Target map[string]string `json:"target"`
}

func NewHarnessService() *HarnessService {
	var eventSink EventSink = NewInMemoryEventSink()

	eventLogPath := strings.TrimSpace(os.Getenv("HARNESS_EVENT_LOG_PATH"))
	if eventLogPath == "" {
		eventLogPath = defaultEventLogPath
	}
	persistedSink, err := NewJSONLFileEventSink(eventLogPath)
	if err == nil {
		eventSink = persistedSink
	} else {
		log.Printf("event log initialization failed, falling back to memory sink: %v", err)
	}

	return &HarnessService{
		capabilities: NewCapabilityRegistry(),
		runStore:     NewRunStore(),
		mcpServers:   NewMcpServerRegistry(),
		policy:       DefaultPolicyEngine{},
		events:       eventSink,
		stepTracker:  NewRunStepTracker(),
	}
}

func (h *HarnessService) Routes() *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("/v0/health", h.healthHandler)
	mux.HandleFunc("/v0/ready", h.readyHandler)
	mux.HandleFunc("/v0/capabilities", h.capabilityCollectionHandler)
	mux.HandleFunc("/v0/capabilities/", h.capabilityItemHandler)
	mux.HandleFunc("/v0/mcp-servers", h.mcpServerCollectionHandler)
	mux.HandleFunc("/v0/mcp-servers/", h.mcpServerItemHandler)
	mux.HandleFunc("/v0/runs", h.runCollectionHandler)
	mux.HandleFunc("/v0/runs/", h.runItemHandler)
	mux.HandleFunc("/v0/events", h.eventsHandler)
	mux.HandleFunc("/v0/policy/decide", h.policyDecisionHandler)
	return mux
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func decodeJSON(r *http.Request, target any) error {
	if !strings.Contains(r.Header.Get("Content-Type"), "application/json") {
		return fmt.Errorf("content-type must be application/json")
	}
	return json.NewDecoder(r.Body).Decode(target)
}

func (h *HarnessService) healthHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"status":  "ok",
		"service": ActorSystem,
	})
}

func (h *HarnessService) readyHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"status":         "ready",
		"capabilities":   len(h.capabilities.List()),
		"runs":           len(h.runStore.List()),
		"mcpServerCount": len(h.mcpServers.List()),
		"eventEnvelope":  EventSchemaVersionV0,
		"policyGateway":  "enabled",
		"lastUpdated":    time.Now().UTC(),
	})
}

func (h *HarnessService) capabilityCollectionHandler(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		writeJSON(w, http.StatusOK, h.capabilities.List())
	case http.MethodPost:
		var request RegisterCapabilityRequest
		if err := decodeJSON(r, &request); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON body"})
			return
		}
		if request.CallerRole == "" {
			request.CallerRole = "agent"
		}

		decision, err := h.policy.Decide(ActionRegisterCapability, request.CallerRole, map[string]string{
			"id":        request.ID,
			"dataClass": request.DataClass,
		})
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "policy evaluation failed"})
			return
		}
		if !decision.Allowed {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": decision.Reason})
			return
		}

		if err := h.capabilities.Register(request.Capability); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}

		requestRef, err := NewEventReference("urn:harness/capability/request", request.Capability)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to create event payload hash"})
			return
		}
		responseRef, err := NewEventReference("urn:harness/capability/response", map[string]any{
			"id":      request.ID,
			"status":  "registered",
			"profile": request.PolicyProfile,
		})
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to create event payload hash"})
			return
		}

		_, err = h.emitEvent(EventEnvelopeV0{
			RunID:            systemRunID,
			EventType:        eventTypeCapabilityRegistered,
			Actor:            request.CallerRole,
			Capability:       "agentic-harness-core",
			DataClass:        request.DataClass,
			RedactionProfile: request.PolicyProfileOrDefault(),
			PolicyDecision:   decision.Reason,
			Status:           "ok",
			StateTransition:  "registry.registered",
			InputRef:         requestRef,
			OutputRef:        responseRef,
			Payload: map[string]any{
				"capabilityId": request.ID,
			},
			RelatedRecords: []string{"urn:harness/capability/" + request.ID},
		}, h.stepTracker)
		if err != nil {
			log.Printf("event emission failed: %v", err)
		}
		writeJSON(w, http.StatusCreated, request.Capability)
	default:
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
	}
}

func (h *HarnessService) capabilityItemHandler(w http.ResponseWriter, r *http.Request) {
	segments := strings.Split(strings.TrimPrefix(r.URL.Path, "/v0/capabilities/"), "/")
	if len(segments) == 0 || segments[0] == "" {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "capability id required"})
		return
	}
	capabilityID := segments[0]
	if strings.Contains(capabilityID, "/") {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "invalid capability operation"})
		return
	}

	switch r.Method {
	case http.MethodGet:
		if len(segments) != 1 {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "invalid capability operation"})
			return
		}
		capability, ok := h.capabilities.Get(capabilityID)
		if !ok {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "capability not found"})
			return
		}
		writeJSON(w, http.StatusOK, capability)
	case http.MethodPost:
		if len(segments) != 2 || segments[1] != "validate" {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "invalid capability operation"})
			return
		}
		capability, err := h.capabilities.Validate(capabilityID)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"valid":      true,
			"capability": capability.ID,
		})
	default:
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
	}
}

func (h *HarnessService) mcpServerCollectionHandler(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		writeJSON(w, http.StatusOK, h.mcpServers.List())
	case http.MethodPost:
		var request RegisterMcpServerRequest
		if err := decodeJSON(r, &request); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON body"})
			return
		}
			if request.CallerRole == "" {
				request.CallerRole = "agent"
			}
			decision, err := h.policy.Decide(ActionRegisterCapability, request.CallerRole, map[string]string{
				"id":        request.ID,
				"dataClass": DataClassOther,
			})
			if err != nil {
				writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "policy evaluation failed"})
				return
			}
			if !decision.Allowed {
				writeJSON(w, http.StatusForbidden, map[string]string{"error": decision.Reason})
				return
			}
			server := McpServer{
			ID:           request.ID,
			Name:         request.Name,
			Endpoint:     request.Endpoint,
			Protocol:     request.Protocol,
			Capabilities: request.Capabilities,
			RegisteredAt: time.Now().UTC(),
		}
		if err := h.mcpServers.Register(server); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		requestRef, err := NewEventReference("urn:harness/mcp/request", request)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to create event payload hash"})
			return
		}
		responseRef, err := NewEventReference("urn:harness/mcp/response", map[string]any{
			"id":      request.ID,
			"name":    request.Name,
			"status":  "registered",
		})
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to create event payload hash"})
			return
		}
		_, err = h.emitEvent(EventEnvelopeV0{
			RunID:            systemRunID,
			EventType:        eventTypeMCPRegistered,
			Actor:            "orchestrator",
			Capability:       "agentic-harness-core",
			DataClass:        DataClassOther,
			RedactionProfile: ProfileControlledByHarness,
				PolicyDecision:   decision.Reason,
			Status:           "ok",
			StateTransition:  "registry.registered",
			InputRef:         requestRef,
			OutputRef:        responseRef,
			Payload: map[string]any{
				"serverId": request.ID,
			},
			RelatedRecords: []string{"urn:harness/mcp/" + request.ID},
		}, h.stepTracker)
		if err != nil {
			log.Printf("event emission failed: %v", err)
		}
		writeJSON(w, http.StatusCreated, server)
	default:
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
	}
}

func (h *HarnessService) mcpServerItemHandler(w http.ResponseWriter, r *http.Request) {
	segments := strings.Split(strings.TrimPrefix(r.URL.Path, "/v0/mcp-servers/"), "/")
	if len(segments) == 0 || segments[0] == "" {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "server id required"})
		return
	}
	if len(segments) != 1 {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "invalid mcp server operation"})
		return
	}
	serverID := segments[0]
	server, ok := h.mcpServers.Get(serverID)
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "mcp server not found"})
		return
	}
	if r.Method != http.MethodGet {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}
	writeJSON(w, http.StatusOK, server)
}

func (h *HarnessService) runCollectionHandler(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		writeJSON(w, http.StatusOK, h.runStore.List())
	case http.MethodPost:
		var request RunCreateRequest
		if err := decodeJSON(r, &request); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON body"})
			return
		}
		if request.Requester == "" {
			request.Requester = "orchestrator"
		}
		decision, err := h.policy.Decide(ActionStartRun, request.Requester, map[string]string{
			"workflowId": request.WorkflowID,
		})
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "policy evaluation failed"})
			return
		}
		if !decision.Allowed {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": decision.Reason})
			return
		}
		run, err := h.runStore.Create(request, request.Requester, decision.Reason)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		requestRef, err := NewEventReference("urn:harness/run/request", request)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to create event payload hash"})
			return
		}
		outputRef, err := NewEventReference("urn:harness/run/"+run.RunID+"/state", run)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to create event payload hash"})
			return
		}
		_, err = h.emitEvent(EventEnvelopeV0{
			RunID:            run.RunID,
			EventType:        eventTypeRunStarted,
			Actor:            request.Requester,
			Capability:       "agentic-harness-core",
			DataClass:        DataClassOther,
			RedactionProfile: ProfileControlledByHarness,
			PolicyDecision:   decision.Reason,
			Status:           StatusStarting,
			StateTransition:  "created",
			InputRef:         requestRef,
			OutputRef:        outputRef,
			Payload: map[string]any{
				"workflowId": request.WorkflowID,
				"evidenceRefs": request.EvidenceRefs,
			},
		}, h.stepTracker)
		if err != nil {
			log.Printf("event emission failed: %v", err)
		}
		writeJSON(w, http.StatusCreated, run)
	default:
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
	}
}

func (h *HarnessService) runItemHandler(w http.ResponseWriter, r *http.Request) {
	runPath := strings.TrimPrefix(r.URL.Path, "/v0/runs/")
	segments := strings.Split(runPath, "/")
	if len(segments) == 0 || segments[0] == "" {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "run id required"})
		return
	}
	runID := segments[0]
	if len(segments) == 2 && segments[1] == "ledger" {
		run, found := h.runStore.Get(runID)
		if !found {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "run not found"})
			return
		}
		allEvents, err := h.events.List()
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		ledger, err := BuildAgentTrajectoryLedger(runID, allEvents)
		if err != nil {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": err.Error()})
			return
		}
		// Keep workflow id from source run state for easier replay.
		if run.WorkflowID != "" {
			ledger.WorkflowID = run.WorkflowID
		}
		ledger.Status = run.Status
		writeJSON(w, http.StatusOK, ledger)
		return
	}
	if len(segments) != 1 {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "invalid run operation"})
		return
	}

	switch r.Method {
	case http.MethodGet:
		run, ok := h.runStore.Get(runID)
		if !ok {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "run not found"})
			return
		}
		writeJSON(w, http.StatusOK, run)
	case http.MethodPatch:
		var request RunUpdateRequest
		if err := decodeJSON(r, &request); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON body"})
			return
		}
		if request.Status != "" {
			request.Status = strings.ToLower(request.Status)
		}
		if request.UpdatedBy == "" {
			request.UpdatedBy = "orchestrator"
		}
		action := ActionUpdateRun
		if request.Status == StatusCompleted {
			action = ActionCompleteRun
		}
		decision, err := h.policy.Decide(action, request.UpdatedBy, map[string]string{
			"runId":  runID,
			"status": request.Status,
		})
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "policy evaluation failed"})
			return
		}
		if !decision.Allowed {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": decision.Reason})
			return
		}
		run, previousStatus, err := h.runStore.Update(runID, request, request.UpdatedBy, decision.Reason)
		if err != nil {
			if strings.Contains(err.Error(), "run is already terminal") || strings.Contains(err.Error(), "invalid run transition") {
				writeJSON(w, http.StatusConflict, map[string]string{"error": err.Error()})
				return
			}
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		requestRef, err := NewEventReference("urn:harness/run/"+runID+"/request", request)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to create event payload hash"})
			return
		}
		outputRef, err := NewEventReference("urn:harness/run/"+runID+"/state", run)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to create event payload hash"})
			return
		}
		eventType := h.runEventType(run.Status)
		transition := fmt.Sprintf("%s->%s", previousStatus, run.Status)
		_, err = h.emitEvent(EventEnvelopeV0{
			RunID:            runID,
			EventType:        eventType,
			Actor:            request.UpdatedBy,
			Capability:       "agentic-harness-core",
			DataClass:        DataClassOther,
			RedactionProfile: ProfileControlledByHarness,
			PolicyDecision:   decision.Reason,
			Status:           run.Status,
			StateTransition:  transition,
			InputRef:         requestRef,
			OutputRef:        outputRef,
			Payload: map[string]any{
				"runId":  runID,
				"status": run.Status,
			},
		}, h.stepTracker)
		if err != nil {
			log.Printf("event emission failed: %v", err)
		}
		writeJSON(w, http.StatusOK, run)
	default:
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
	}
}

func (h *HarnessService) eventsHandler(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		items, err := h.events.List()
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, items)
	case http.MethodPost:
		var event EventEnvelopeV0
		if err := decodeJSON(r, &event); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON body"})
			return
		}
		if event.SchemaVersion == "" {
			event.SchemaVersion = EventSchemaVersionV0
		}
			if event.RunID == "" {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": "runId is required"})
				return
			}
			run, found := h.runStore.Get(event.RunID)
			if !found {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": "runId not found"})
				return
			}
			if run.Status == StatusCompleted || run.Status == StatusFailed {
				writeJSON(w, http.StatusConflict, map[string]string{"error": "run is already terminal"})
				return
			}
		if event.Service == "" {
			event.Service = ActorSystem
		}
		if event.CreatedAt.IsZero() {
			event.CreatedAt = time.Now().UTC()
		}
		emitted, err := h.emitEvent(event, h.stepTracker)
		if err != nil {
			var schemaErr SchemaValidationError
			if errors.As(err, &schemaErr) {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
				return
			}
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusCreated, emitted)
	default:
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
	}
}

func (h *HarnessService) emitEvent(event EventEnvelopeV0, tracker *RunStepTracker) (EventEnvelopeV0, error) {
	if event.StepID == 0 {
		event.StepID = tracker.Next(event.RunID)
	}
	event, err := h.enrichEventRefs(event)
	if err != nil {
		return EventEnvelopeV0{}, err
	}
	if err := event.Validate(); err != nil {
		return EventEnvelopeV0{}, err
	}
	return h.events.Emit(event)
}

func (h *HarnessService) enrichEventRefs(event EventEnvelopeV0) (EventEnvelopeV0, error) {
	payload := map[string]any{}
	if event.Payload != nil {
		payload = event.Payload
	}
	if event.InputRef.URI == "" {
		inputRef, err := NewEventReference(fmt.Sprintf("urn:harness/%s/%s/input", event.EventType, event.RunID), payload)
		if err != nil {
			return EventEnvelopeV0{}, err
		}
		event.InputRef = inputRef
	} else if event.InputRef.SHA256 == "" {
		inputRef, err := NewEventReference(event.InputRef.URI, payload)
		if err != nil {
			return EventEnvelopeV0{}, err
		}
		event.InputRef = inputRef
	}
	if event.OutputRef.URI == "" {
		outputRef, err := NewEventReference(fmt.Sprintf("urn:harness/%s/%s/output", event.EventType, event.RunID), payload)
		if err != nil {
			return EventEnvelopeV0{}, err
		}
		event.OutputRef = outputRef
	} else if event.OutputRef.SHA256 == "" {
		outputRef, err := NewEventReference(event.OutputRef.URI, payload)
		if err != nil {
			return EventEnvelopeV0{}, err
		}
		event.OutputRef = outputRef
	}
	return event, nil
}

func (h *HarnessService) runEventType(status string) string {
	switch status {
	case StatusCompleted:
		return eventTypeRunCompleted
	case StatusFailed:
		return eventTypeRunFailed
	default:
		return eventTypeRunUpdated
	}
}

func (h *HarnessService) policyDecisionHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}
	var req PolicyRequest
	if err := decodeJSON(r, &req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON body"})
		return
	}
	if req.Actor == "" {
		req.Actor = "agent"
	}
	decision, err := h.policy.Decide(req.Action, req.Actor, req.Target)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	if !decision.Allowed {
		writeJSON(w, http.StatusForbidden, decision)
		return
	}
	writeJSON(w, http.StatusOK, decision)
}

func (c Capability) PolicyProfileOrDefault() string {
	if c.PolicyProfile == "" {
		return ProfileControlledByHarness
	}
	return c.PolicyProfile
}
