package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestCapabilityRegistryFlow(t *testing.T) {
	service := NewHarnessService()
	server := httptest.NewServer(service.Routes())
	defer server.Close()

	registerPayload := RegisterCapabilityRequest{
		CallerRole: "orchestrator",
		Capability: Capability{
			ID:            "cobol.parse",
			Name:          "COBOL parser",
			Owner:         "parser-service",
			Endpoint:      "http://parser-service.internal/parse",
			DataClass:     DataClassParser,
			PolicyProfile: ProfileControlledByHarness,
			Version:       "v0.1.0",
		},
	}
	raw := mustJSON(registerPayload)
	res, err := http.Post(server.URL+"/v0/capabilities", "application/json", bytes.NewReader(raw))
	if err != nil {
		t.Fatalf("register capability request failed: %v", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("expected 201, got %d", res.StatusCode)
	}

	res, err = http.Get(server.URL + "/v0/capabilities/cobol.parse")
	if err != nil {
		t.Fatalf("get capability request failed: %v", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("expected get 200, got %d", res.StatusCode)
	}

	res, err = http.Post(server.URL+"/v0/capabilities/cobol.parse/validate", "application/json", bytes.NewReader([]byte(`{}`)))
	if err != nil {
		t.Fatalf("validate capability request failed: %v", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("expected validate 200, got %d", res.StatusCode)
	}
}

func TestRunStateLifecycle(t *testing.T) {
	service := NewHarnessService()
	server := httptest.NewServer(service.Routes())
	defer server.Close()

	create := RunCreateRequest{
		WorkflowID: "w0-migration-run",
		Requester:  "orchestrator",
	}
	res, err := http.Post(server.URL+"/v0/runs", "application/json", bytes.NewReader(mustJSON(create)))
	if err != nil {
		t.Fatalf("create run request failed: %v", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("expected run create 201, got %d", res.StatusCode)
	}

	var run RunState
	if err := json.NewDecoder(res.Body).Decode(&run); err != nil {
		t.Fatalf("decode run create response failed: %v", err)
	}
	if run.Status != StatusStarting {
		t.Fatalf("expected run status %s, got %s", StatusStarting, run.Status)
	}

	update := RunUpdateRequest{
		Status:     StatusCompleted,
		UpdatedBy:  "orchestrator",
		Message:    "harness finished migration slice",
	}
	updateRaw := mustJSON(update)
	req, err := http.NewRequest(http.MethodPatch, server.URL+"/v0/runs/"+run.RunID, bytes.NewReader(updateRaw))
	if err != nil {
		t.Fatalf("create patch request failed: %v", err)
	}
	req.Header.Set("Content-Type", "application/json")
	res, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("update run request failed: %v", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("expected run update 200, got %d", res.StatusCode)
	}
}

func TestRunStateRejectsTerminalTransition(t *testing.T) {
	service := NewHarnessService()
	server := httptest.NewServer(service.Routes())
	defer server.Close()

	create := RunCreateRequest{
		WorkflowID: "w0-terminal-transition",
		Requester:  "orchestrator",
	}
	res, err := http.Post(server.URL+"/v0/runs", "application/json", bytes.NewReader(mustJSON(create)))
	if err != nil {
		t.Fatalf("create run request failed: %v", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("expected run create 201, got %d", res.StatusCode)
	}

	var run RunState
	if err := json.NewDecoder(res.Body).Decode(&run); err != nil {
		t.Fatalf("decode run create response failed: %v", err)
	}

	complete := RunUpdateRequest{
		Status:     StatusCompleted,
		UpdatedBy:  "orchestrator",
		Message:    "completed successfully",
	}
	completeRes, err := doRunPatch(server.URL+"/v0/runs/"+run.RunID, complete)
	if err != nil {
		t.Fatalf("complete run request failed: %v", err)
	}
	defer completeRes.Body.Close()
	if completeRes.StatusCode != http.StatusOK {
		t.Fatalf("expected run complete 200, got %d", completeRes.StatusCode)
	}

	failed := RunUpdateRequest{
		Status:    StatusFailed,
		UpdatedBy: "orchestrator",
		Message:   "should be rejected",
	}
	failedRes, err := doRunPatch(server.URL+"/v0/runs/"+run.RunID, failed)
	if err != nil {
		t.Fatalf("patch terminal run request failed: %v", err)
	}
	defer failedRes.Body.Close()
	if failedRes.StatusCode != http.StatusConflict {
		t.Fatalf("expected run terminal transition 409, got %d", failedRes.StatusCode)
	}
}

func TestPolicyProtectsDirectAgentIntegration(t *testing.T) {
	service := NewHarnessService()
	policyRequest := PolicyRequest{
		Action: ActionRegisterCapability,
		Actor:  "agent",
		Target: map[string]string{
			"id":        "model-gateway",
			"dataClass": DataClassModel,
		},
	}
	if _, err := service.policy.Decide(policyRequest.Action, policyRequest.Actor, policyRequest.Target); err != nil {
		t.Fatalf("policy decide failed: %v", err)
	}

	server := httptest.NewServer(service.Routes())
	defer server.Close()

	capability := RegisterCapabilityRequest{
		CallerRole: "agent",
		Capability: Capability{
			ID:            "model.generate",
			Name:          "Model generator",
			Owner:         "model-gateway-service",
			Endpoint:      "https://model-gateway.internal/generate",
			DataClass:     DataClassModel,
			PolicyProfile: ProfileControlledByHarness,
			Version:       "v0.1.0",
		},
	}
	res, err := http.Post(server.URL+"/v0/capabilities", "application/json", bytes.NewReader(mustJSON(capability)))
	if err != nil {
		t.Fatalf("policy block request failed: %v", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusForbidden {
		t.Fatalf("expected 403 for direct agent model integration registration, got %d", res.StatusCode)
	}
}

func mustJSON(value any) []byte {
	raw, err := json.Marshal(value)
	if err != nil {
		panic(err)
	}
	return raw
}

func doRunPatch(url string, payload RunUpdateRequest) (*http.Response, error) {
	req, err := http.NewRequest(http.MethodPatch, url, bytes.NewReader(mustJSON(payload)))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	return http.DefaultClient.Do(req)
}
