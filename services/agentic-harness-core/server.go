package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strings"
	"time"
)

const (
	eventTypeRunCompleted = "run.completed"
	eventTypeRunFailed    = "run.failed"
	eventTypeRunUpdated   = "run.updated"
	eventTypeRunStarted   = "run.started"
)

type HarnessService struct {
	capabilities *CapabilityRegistry
	runStore     *RunStore
	mcpServers   *McpServerRegistry
	policy       PolicyEngine
	events       EventSink
}

type PolicyRequest struct {
	Action string            `json:"action"`
	Actor  string            `json:"actor"`
	Target map[string]string `json:"target"`
}

func NewHarnessService() *HarnessService {
	return &HarnessService{
		capabilities: NewCapabilityRegistry(),
		runStore:     NewRunStore(),
		mcpServers:   NewMcpServerRegistry(),
		policy:       DefaultPolicyEngine{},
		events:       NewInMemoryEventSink(),
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
		"service": "agentic-harness-core",
	})
}

func (h *HarnessService) readyHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"status":          "ready",
		"capabilities":    len(h.capabilities.List()),
		"runs":            len(h.runStore.List()),
		"mcpServerCount":  len(h.mcpServers.List()),
		"eventEnvelope":   "supported",
		"policyGateways":  "enabled",
		"lastUpdatedTime": time.Now().UTC(),
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
			log.Printf("policy evaluation failed: %v", err)
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
		if err := h.events.Emit(Event{
			Type:   "capability.registered",
			Source: "agentic-harness-core",
			Payload: map[string]any{
				"capabilityId": request.ID,
				"decision":     decision,
			},
		}); err != nil {
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
		if err := h.events.Emit(Event{
			Type:   "mcp-server.registered",
			Source: "agentic-harness-core",
			Payload: map[string]any{
				"id": request.ID,
			},
		}); err != nil {
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
		if err := h.events.Emit(Event{
			Type:   eventTypeRunStarted,
			Source: "agentic-harness-core",
			Payload: map[string]any{
				"runId": run.RunID,
			},
		}); err != nil {
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
		run, err := h.runStore.Update(runID, request, request.UpdatedBy, decision.Reason)
		if err != nil {
			if strings.Contains(err.Error(), "run is already terminal") || strings.Contains(err.Error(), "invalid run transition") {
				writeJSON(w, http.StatusConflict, map[string]string{"error": err.Error()})
				return
			}
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		if err := h.events.Emit(Event{
			Type:   h.runEventType(run.Status),
			Source: "agentic-harness-core",
			Payload: map[string]any{
				"runId":  runID,
				"status": run.Status,
			},
		}); err != nil {
			log.Printf("event emission failed: %v", err)
		}
		writeJSON(w, http.StatusOK, run)
	default:
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
	}
}

func (h *HarnessService) eventsHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}
	items, err := h.events.List()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, items)
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
