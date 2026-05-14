package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestCapabilityRegistryFlow(t *testing.T) {
	service := newTestHarnessService(t)
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
	res, err := authPostJSON(server.URL+"/v0/capabilities", raw, "orchestrator-service", "orchestrator")
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

	res, err = authPostJSON(server.URL+"/v0/capabilities/cobol.parse/validate", []byte(`{}`), "orchestrator-service", "orchestrator")
	if err != nil {
		t.Fatalf("validate capability request failed: %v", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("expected validate 200, got %d", res.StatusCode)
	}
}

func TestRunStateLifecycle(t *testing.T) {
	service := newTestHarnessService(t)
	server := httptest.NewServer(service.Routes())
	defer server.Close()

	create := RunCreateRequest{
		WorkflowID: "w0-migration-run",
		Requester:  "orchestrator",
	}
	res, err := authPostJSON(server.URL+"/v0/runs", mustJSON(create), "orchestrator-service", "orchestrator")
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
		Status:    StatusCompleted,
		UpdatedBy: "orchestrator",
		Message:   "harness finished migration slice",
	}
	updateRaw := mustJSON(update)
	res, err = authPatchJSON(server.URL+"/v0/runs/"+run.RunID, updateRaw, "orchestrator-service", "orchestrator")
	if err != nil {
		t.Fatalf("update run request failed: %v", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("expected run update 200, got %d", res.StatusCode)
	}
}

func TestRunStateRejectsTerminalTransition(t *testing.T) {
	service := newTestHarnessService(t)
	server := httptest.NewServer(service.Routes())
	defer server.Close()

	create := RunCreateRequest{
		WorkflowID: "w0-terminal-transition",
		Requester:  "orchestrator",
	}
	res, err := authPostJSON(server.URL+"/v0/runs", mustJSON(create), "orchestrator-service", "orchestrator")
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
		Status:    StatusCompleted,
		UpdatedBy: "orchestrator",
		Message:   "completed successfully",
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
	service := newTestHarnessService(t)
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
	res, err := authPostJSON(server.URL+"/v0/capabilities", mustJSON(capability), "direct-agent", "agent")
	if err != nil {
		t.Fatalf("policy block request failed: %v", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusForbidden {
		t.Fatalf("expected 403 for direct agent model integration registration, got %d", res.StatusCode)
	}

	blockedDataClasses := []string{DataClassModelGateway, DataClassBuildTest}
	for _, dataClass := range blockedDataClasses {
		t.Run(dataClass, func(t *testing.T) {
			decision, err := service.policy.Decide(ActionRegisterCapability, "agent", map[string]string{
				"id":        "blocked-" + dataClass,
				"dataClass": dataClass,
			})
			if err != nil {
				t.Fatalf("policy decide failed: %v", err)
			}
			if decision.Allowed {
				t.Fatalf("expected agent registration for %s to be denied", dataClass)
			}
		})
	}
}

func TestOrchestratorCanRegisterCoreCapability(t *testing.T) {
	service := newTestHarnessService(t)
	server := httptest.NewServer(service.Routes())
	defer server.Close()

	capability := RegisterCapabilityRequest{
		Capability: Capability{
			ID:            "build-test.run",
			Name:          "Build/test runner",
			Owner:         "build-test-runner-service",
			Endpoint:      "https://build-test.internal/run-verification",
			DataClass:     DataClassBuildTest,
			PolicyProfile: ProfileControlledByHarness,
			Version:       "v0.1.0",
		},
	}
	res, err := authPostJSON(server.URL+"/v0/capabilities", mustJSON(capability), "orchestrator-service", "orchestrator")
	if err != nil {
		t.Fatalf("orchestrator registration request failed: %v", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("expected orchestrator core capability registration 201, got %d", res.StatusCode)
	}
}

func TestMutatingEndpointsRequireHarnessToken(t *testing.T) {
	t.Setenv(envHarnessControlPlaneToken, "")
	service := NewHarnessService()
	server := httptest.NewServer(service.Routes())
	defer server.Close()

	res, err := http.Post(server.URL+"/v0/runs", "application/json", bytes.NewReader(mustJSON(RunCreateRequest{
		WorkflowID: "w0-auth-required",
	})))
	if err != nil {
		t.Fatalf("create run request failed: %v", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("expected 503 when harness token is not configured, got %d", res.StatusCode)
	}
}

func TestCapabilityRegistrationRejectsDuplicateIDs(t *testing.T) {
	registry := NewCapabilityRegistry()
	capability := Capability{
		ID:            "cobol.parse",
		Name:          "COBOL parser",
		Owner:         "cobol-parser-service",
		Endpoint:      "http://parser-service.internal/parse",
		DataClass:     DataClassParser,
		PolicyProfile: ProfileControlledByHarness,
		Version:       "v0.1.0",
	}
	if err := registry.Register(capability); err != nil {
		t.Fatalf("initial register failed: %v", err)
	}
	capability.Owner = "poisoned-service"
	if err := registry.Register(capability); err == nil {
		t.Fatalf("expected duplicate capability registration to be rejected")
	}
}

func mustJSON(value any) []byte {
	raw, err := json.Marshal(value)
	if err != nil {
		panic(err)
	}
	return raw
}

func newTestHarnessService(t *testing.T) *HarnessService {
	t.Helper()
	t.Setenv(envHarnessControlPlaneToken, testHarnessToken)
	return NewHarnessService()
}

const testHarnessToken = "test-harness-token"

func authPostJSON(url string, raw []byte, actor string, role string) (*http.Response, error) {
	req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(raw))
	if err != nil {
		return nil, err
	}
	addAuthHeaders(req, actor, role)
	return http.DefaultClient.Do(req)
}

func authPatchJSON(url string, raw []byte, actor string, role string) (*http.Response, error) {
	req, err := http.NewRequest(http.MethodPatch, url, bytes.NewReader(raw))
	if err != nil {
		return nil, err
	}
	addAuthHeaders(req, actor, role)
	return http.DefaultClient.Do(req)
}

func addAuthHeaders(req *http.Request, actor string, role string) {
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(headerAuthorization, "Bearer "+testHarnessToken)
	req.Header.Set(headerHarnessActor, actor)
	req.Header.Set(headerHarnessRole, role)
}

func doRunPatch(url string, payload RunUpdateRequest) (*http.Response, error) {
	return authPatchJSON(url, mustJSON(payload), "orchestrator-service", "orchestrator")
}
