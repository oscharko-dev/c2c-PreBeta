package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

type stubProvider struct {
	t      *testing.T
	output map[string]any
	err    error
	status string
	calls  int
	mu     sync.Mutex
}

func (f *stubProvider) Name() string {
	return ModelProviderFoundryDevelopment
}

func (f *stubProvider) Invoke(_ context.Context, _ ModelInvocationRequest, _ ModelMetadata) (ModelInvocationOutput, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls++
	return ModelInvocationOutput{
		Status:   f.status,
		Data:     f.output,
		Metadata: nil,
	}, f.err
}

type inMemoryLedger struct {
	mu      sync.Mutex
	entries []ModelInvocationLedgerV0
}

func (l *inMemoryLedger) Append(record ModelInvocationLedgerV0) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	if err := record.Validate(); err != nil {
		return err
	}
	l.entries = append(l.entries, record)
	return nil
}

func (l *inMemoryLedger) List() ([]ModelInvocationLedgerV0, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	entries := make([]ModelInvocationLedgerV0, len(l.entries))
	copy(entries, l.entries)
	return entries, nil
}

type inMemoryEventSink struct {
	mu     sync.Mutex
	events []EventEnvelopeV0
}

func (s *inMemoryEventSink) Emit(event EventEnvelopeV0) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.events = append(s.events, event)
	return nil
}

func (s *inMemoryEventSink) List() ([]EventEnvelopeV0, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	events := make([]EventEnvelopeV0, len(s.events))
	copy(events, s.events)
	return events, nil
}

func newGatewayServiceForTest(now time.Time, provider ModelProvider, model ModelMetadata, allowlisted bool) *ModelGatewayService {
	ledger := &inMemoryLedger{}
	events := &inMemoryEventSink{}
	registry := ModelRegistry{
		Models: []ModelMetadata{model},
	}
	allowlist := FoundryDevelopmentAllowlist{
		Mode: ModelProviderFoundryDevelopment,
		Foundry: ProviderFoundryConfig{
			Endpoint:  "https://local",
			ApiKeyRef: "api-key-ref",
			TimeoutMs: 30000,
		},
	}
	if !allowlisted {
		allowlist.AllowedModelIDs = []string{"other-model"}
		allowlist.Roles = map[string][]string{
			AgentRoleTransformation: {"other-model"},
		}
	} else {
		allowlist.AllowedModelIDs = []string{model.ID}
		allowlist.Roles = map[string][]string{
			AgentRoleTransformation: {model.ID},
		}
	}
	return &ModelGatewayService{
		registry:                    registry,
		allowlist:                   allowlist,
		ledger:                      ledger,
		events:                      events,
		now:                         func() time.Time { return now },
		modelProvider:               ModelProviderFoundryDevelopment,
		dataPolicy:                  "public_synthetic_only",
		invocationLedgerEnabled:     true,
		harnessEventEmissionEnabled: true,
		defaultModelDeployment:      model.ID,
		providers:                   map[string]ModelProvider{provider.Name(): provider},
		providerTimeouts:            map[string]int64{provider.Name(): 30000},
	}
}

func TestModelGatewayRoutes_InvokeRequiresControlToken(t *testing.T) {
	now := time.Date(2026, 5, 14, 12, 0, 0, 0, time.UTC)
	provider := &stubProvider{
		output: map[string]any{"text": "ok"},
		status: "completed",
	}
	service := newGatewayServiceForTest(now, provider, activeModel("foundry-gpt", now), true)
	service.controlToken = "gateway-control-token"
	body, _ := json.Marshal(ModelInvocationRequest{
		RunID:                 "run-auth",
		ModelID:               "foundry-gpt",
		Actor:                 "agent-1",
		AgentRole:             AgentRoleTransformation,
		DataClass:             "model",
		PromptTemplateVersion: "v1",
		Prompt:                "Hello",
		TimeoutMs:             1000,
		Parameters:            map[string]any{},
	})

	unauthorized := httptest.NewRequest(http.MethodPost, "/v0/invoke", strings.NewReader(string(body)))
	unauthorized.Header.Set("content-type", "application/json")
	rr := httptest.NewRecorder()
	service.Routes().ServeHTTP(rr, unauthorized)
	if rr.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 without token, got %d body=%s", rr.Code, rr.Body.String())
	}
	if provider.calls != 0 {
		t.Fatalf("provider should not be called before auth, got %d calls", provider.calls)
	}

	authorized := httptest.NewRequest(http.MethodPost, "/v0/invoke", strings.NewReader(string(body)))
	authorized.Header.Set("content-type", "application/json")
	authorized.Header.Set("Authorization", "Bearer gateway-control-token")
	rr = httptest.NewRecorder()
	service.Routes().ServeHTTP(rr, authorized)
	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200 with token, got %d body=%s", rr.Code, rr.Body.String())
	}
	if provider.calls != 1 {
		t.Fatalf("expected one provider call after auth, got %d", provider.calls)
	}
}

func TestResolveGatewayConfigFromEnv_IssueVariables(t *testing.T) {
	t.Setenv("C2C_MODEL_PROVIDER", "azure_foundry")
	t.Setenv("C2C_MODEL_DEFAULT_DEPLOYMENT", "gpt-oss-120b")
	t.Setenv("C2C_MODEL_FALLBACK_DEPLOYMENTS", "mistral-large-3,phi-4")
	t.Setenv("C2C_MODEL_ALLOWED_DEPLOYMENTS", "gpt-oss-120b,mistral-large-3,phi-4")
	t.Setenv("C2C_MODEL_DATA_POLICY", "public_synthetic_only")
	t.Setenv("C2C_MODEL_INVOCATION_LEDGER_ENABLED", "true")
	t.Setenv("C2C_HARNESS_EVENT_EMISSION_ENABLED", "true")
	t.Setenv("HARNESS_EVENT_TOKEN", "harness-control-token")
	t.Setenv("MODEL_GATEWAY_CONTROL_TOKEN", "gateway-control-token")
	t.Setenv("AZURE_FOUNDRY_ENDPOINT", "https://workspacedevfoundry.example.com/openai/deployments")
	t.Setenv("AZURE_FOUNDRY_API_KEY", "dummy-key")
	t.Setenv("AZURE_FOUNDRY_API_VERSION", "2024-05-01-preview")

	cfg, err := resolveGatewayConfigFromEnv()
	if err != nil {
		t.Fatalf("expected config to resolve: %v", err)
	}
	if cfg.modelProvider != ModelProviderFoundryDevelopment {
		t.Fatalf("expected provider %s, got %s", ModelProviderFoundryDevelopment, cfg.modelProvider)
	}
	if cfg.defaultModelDeployment != "gpt-oss-120b" {
		t.Fatalf("unexpected default deployment %s", cfg.defaultModelDeployment)
	}
	if len(cfg.fallbackModelDeployments) != 2 {
		t.Fatalf("unexpected fallback count: %d", len(cfg.fallbackModelDeployments))
	}
	if !cfg.invocationLedgerEnabled || !cfg.harnessEventEmissionEnabled {
		t.Fatalf("expected ledger and event emission to be enabled")
	}
	if cfg.harnessEventToken != "harness-control-token" {
		t.Fatalf("unexpected harness event token")
	}
	if cfg.controlToken != "gateway-control-token" {
		t.Fatalf("unexpected control token")
	}
}

func TestModelGatewayService_InvokeSuccessCreatesLedgerAndEvent(t *testing.T) {
	now := time.Date(2026, 5, 14, 12, 0, 0, 0, time.UTC)
	provider := &stubProvider{
		output: map[string]any{
			"text": "ok",
		},
		status: "completed",
	}
	service := newGatewayServiceForTest(now, provider, ModelMetadata{
		ID:                        "foundry-gpt",
		DeploymentName:            "foundry-dep",
		ModelName:                 "gpt-4",
		Version:                   "2026-01",
		Provider:                  ModelProviderFoundryDevelopment,
		LifecycleStatus:           "approved",
		LicenseStatus:             "approved",
		ApprovalExpiry:            now.Add(24 * time.Hour).Format(time.RFC3339),
		AllowedDataClasses:        []string{"model"},
		SupportedTemplateVersions: []string{"v1"},
		SupportsStructuredOutput:  false,
	}, true)

	payload := ModelInvocationRequest{
		RunID:                 "run-1",
		ModelID:               "foundry-gpt",
		Actor:                 "agent-1",
		AgentRole:             AgentRoleTransformation,
		DataClass:             "model",
		PromptTemplateVersion: "v1",
		Prompt:                "Hello",
		TimeoutMs:             1000,
		Parameters: map[string]any{
			"temperature":      0.2,
			"promptTemplateId": "c2c.test-template.v0",
			"promptCopy":       "AZURE_FOUNDRY_API_KEY=abcdefghijklmnop",
		},
	}
	body, _ := json.Marshal(payload)
	req := httptest.NewRequest(http.MethodPost, "/v0/invoke", strings.NewReader(string(body)))
	req.Header.Set("content-type", "application/json")
	rr := httptest.NewRecorder()

	service.invokeHandler(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d", rr.Code)
	}
	var response ModelInvocationResponse
	if err := json.Unmarshal(rr.Body.Bytes(), &response); err != nil {
		t.Fatalf("expected model invocation response json: %v", err)
	}
	ledger := service.ledger.(*inMemoryLedger)
	if len(ledger.entries) != 1 {
		t.Fatalf("expected one ledger entry, got %d", len(ledger.entries))
	}
	if ledger.entries[0].Status != "completed" {
		t.Fatalf("expected ledger status completed, got %s", ledger.entries[0].Status)
	}
	if ledger.entries[0].Parameters["temperature"] != 0.2 {
		t.Fatalf("expected safe temperature parameter in ledger, got %#v", ledger.entries[0].Parameters)
	}
	if ledger.entries[0].Parameters["promptTemplateId"] != "c2c.test-template.v0" {
		t.Fatalf("expected promptTemplateId metadata in ledger, got %#v", ledger.entries[0].Parameters)
	}
	if _, ok := ledger.entries[0].Parameters["promptCopy"]; ok {
		t.Fatalf("unexpected promptCopy persisted in ledger parameters: %#v", ledger.entries[0].Parameters)
	}
	if response.Provider != ModelProviderFoundryDevelopment {
		t.Fatalf("expected provider %s, got %s", ModelProviderFoundryDevelopment, response.Provider)
	}
	if response.PromptTemplateVersion != "v1" {
		t.Fatalf("expected prompt template v1, got %s", response.PromptTemplateVersion)
	}
	if response.PolicyDecision != policyDecisionAllow {
		t.Fatalf("expected policy decision %s, got %s", policyDecisionAllow, response.PolicyDecision)
	}
	ledgerJSON, err := json.Marshal(ledger.entries[0])
	if err != nil {
		t.Fatalf("failed to marshal ledger entry: %v", err)
	}
	if response.LedgerRef.SHA256 != ComputeSHA256Hex(ledgerJSON) {
		t.Fatalf("ledgerRef sha does not match persisted ledger entry")
	}
	events := service.events.(*inMemoryEventSink)
	if len(events.events) != 1 {
		t.Fatalf("expected one event, got %d", len(events.events))
	}
	if events.events[0].Status != "completed" {
		t.Fatalf("expected completed event status, got %s", events.events[0].Status)
	}
	if provider.calls != 1 {
		t.Fatalf("expected provider call, got %d", provider.calls)
	}
}

func TestModelInvocationLedgerSchemaPresence(t *testing.T) {
	for _, candidate := range []string{
		filepath.Join("..", "..", "..", "schemas", "model-invocation-ledger-v0.json"),
	} {
		body, err := os.ReadFile(candidate)
		if err != nil {
			continue
		}
		if !strings.Contains(string(body), "model-invocation-ledger-v0.json") {
			t.Fatalf("schema file present but missing canonical $id: %s", candidate)
		}
		return
	}
	t.Fatalf("schemas/model-invocation-ledger-v0.json not found relative to service module")
}

func TestModelGatewayService_InvokeWithAuditSinksDisabledSkipsLedgerAndEvent(t *testing.T) {
	now := time.Date(2026, 5, 14, 12, 0, 0, 0, time.UTC)
	provider := &stubProvider{
		output: map[string]any{"text": "ok"},
		status: "completed",
	}
	service := newGatewayServiceForTest(now, provider, ModelMetadata{
		ID:                        "foundry-gpt",
		DeploymentName:            "foundry-dep",
		ModelName:                 "gpt-4",
		Version:                   "2026-01",
		Provider:                  ModelProviderFoundryDevelopment,
		LifecycleStatus:           "approved",
		LicenseStatus:             "approved",
		ApprovalExpiry:            now.Add(24 * time.Hour).Format(time.RFC3339),
		AllowedDataClasses:        []string{"model"},
		SupportedTemplateVersions: []string{"v1"},
		SupportsStructuredOutput:  false,
	}, true)
	service.invocationLedgerEnabled = false
	service.harnessEventEmissionEnabled = false

	payload := ModelInvocationRequest{
		RunID:                 "run-1",
		ModelID:               "foundry-gpt",
		Actor:                 "agent-1",
		AgentRole:             AgentRoleTransformation,
		DataClass:             "model",
		PromptTemplateVersion: "v1",
		Prompt:                "Hello",
		TimeoutMs:             1000,
		Parameters:            map[string]any{},
	}
	body, _ := json.Marshal(payload)
	req := httptest.NewRequest(http.MethodPost, "/v0/invoke", strings.NewReader(string(body)))
	req.Header.Set("content-type", "application/json")
	rr := httptest.NewRecorder()

	service.invokeHandler(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d", rr.Code)
	}
	if provider.calls != 1 {
		t.Fatalf("expected provider call, got %d", provider.calls)
	}
	if len(service.ledger.(*inMemoryLedger).entries) != 0 {
		t.Fatalf("expected no ledger entries when ledger is disabled")
	}
	if len(service.events.(*inMemoryEventSink).events) != 0 {
		t.Fatalf("expected no events when event emission is disabled")
	}
}

func TestModelGatewayService_RejectsModelNotInAllowlist(t *testing.T) {
	now := time.Date(2026, 5, 14, 12, 0, 0, 0, time.UTC)
	provider := &stubProvider{
		output: map[string]any{"text": "ok"},
		status: "completed",
	}
	service := newGatewayServiceForTest(now, provider, ModelMetadata{
		ID:                        "foundry-gpt",
		DeploymentName:            "foundry-dep",
		ModelName:                 "gpt-4",
		Version:                   "2026-01",
		Provider:                  ModelProviderFoundryDevelopment,
		LifecycleStatus:           "approved",
		LicenseStatus:             "approved",
		ApprovalExpiry:            now.Add(24 * time.Hour).Format(time.RFC3339),
		AllowedDataClasses:        []string{"model"},
		SupportedTemplateVersions: []string{"v1"},
		SupportsStructuredOutput:  false,
	}, false)

	payload := ModelInvocationRequest{
		RunID:                 "run-1",
		ModelID:               "foundry-gpt",
		Actor:                 "agent-1",
		AgentRole:             AgentRoleTransformation,
		DataClass:             "model",
		PromptTemplateVersion: "v1",
		Prompt:                "Hello",
		TimeoutMs:             1000,
		Parameters:            map[string]any{},
	}
	body, _ := json.Marshal(payload)
	req := httptest.NewRequest(http.MethodPost, "/v0/invoke", strings.NewReader(string(body)))
	req.Header.Set("content-type", "application/json")
	rr := httptest.NewRecorder()

	service.invokeHandler(rr, req)

	if rr.Code != http.StatusForbidden {
		t.Fatalf("expected status 403, got %d", rr.Code)
	}
	if !strings.Contains(rr.Body.String(), "modelId is not in allowlist") {
		t.Fatalf("expected allowlist error response, got %s", rr.Body.String())
	}
	ledger := service.ledger.(*inMemoryLedger)
	if len(ledger.entries) != 1 {
		t.Fatalf("expected one ledger entry, got %d", len(ledger.entries))
	}
	if ledger.entries[0].Status != statusRejected {
		t.Fatalf("expected rejected ledger status, got %s", ledger.entries[0].Status)
	}
	if provider.calls != 0 {
		t.Fatalf("expected no provider call, got %d", provider.calls)
	}
	events := service.events.(*inMemoryEventSink)
	if len(events.events) != 1 {
		t.Fatalf("expected one rejection event, got %d", len(events.events))
	}
	if events.events[0].PolicyDecision != policyDecisionDeny {
		t.Fatalf("expected policy deny, got %s", events.events[0].PolicyDecision)
	}
	if events.events[0].StateTransition != "validate.rejected" {
		t.Fatalf("expected validate.rejected transition, got %s", events.events[0].StateTransition)
	}
}

func TestModelGatewayService_RejectsInactiveAllowlistedModel(t *testing.T) {
	now := time.Date(2026, 5, 14, 12, 0, 0, 0, time.UTC)
	provider := &stubProvider{
		output: map[string]any{"text": "ok"},
		status: "completed",
	}
	service := newGatewayServiceForTest(now, provider, ModelMetadata{
		ID:                        "foundry-gpt",
		DeploymentName:            "foundry-dep",
		ModelName:                 "gpt-4",
		Version:                   "2026-01",
		Provider:                  ModelProviderFoundryDevelopment,
		LifecycleStatus:           "approved",
		LicenseStatus:             "approved",
		ApprovalExpiry:            now.Add(-24 * time.Hour).Format(time.RFC3339),
		AllowedDataClasses:        []string{"model"},
		SupportedTemplateVersions: []string{"v1"},
		SupportsStructuredOutput:  false,
	}, true)

	payload := ModelInvocationRequest{
		RunID:                 "run-1",
		ModelID:               "foundry-gpt",
		Actor:                 "agent-1",
		AgentRole:             AgentRoleTransformation,
		DataClass:             "model",
		PromptTemplateVersion: "v1",
		Prompt:                "Hello",
		TimeoutMs:             1000,
		Parameters:            map[string]any{},
	}
	body, _ := json.Marshal(payload)
	req := httptest.NewRequest(http.MethodPost, "/v0/invoke", strings.NewReader(string(body)))
	req.Header.Set("content-type", "application/json")
	rr := httptest.NewRecorder()

	service.invokeHandler(rr, req)

	if rr.Code != http.StatusForbidden {
		t.Fatalf("expected status 403, got %d", rr.Code)
	}
	if provider.calls != 0 {
		t.Fatalf("expected no provider call, got %d", provider.calls)
	}
	ledger := service.ledger.(*inMemoryLedger)
	if len(ledger.entries) != 1 {
		t.Fatalf("expected one ledger entry, got %d", len(ledger.entries))
	}
	if ledger.entries[0].Status != statusRejected {
		t.Fatalf("expected rejected ledger status, got %s", ledger.entries[0].Status)
	}
}

func TestModelGatewayService_RejectsMissingPromptTemplateWithoutLedgerFailure(t *testing.T) {
	now := time.Date(2026, 5, 14, 12, 0, 0, 0, time.UTC)
	provider := &stubProvider{
		output: map[string]any{"text": "ok"},
		status: "completed",
	}
	service := newGatewayServiceForTest(now, provider, ModelMetadata{
		ID:                        "foundry-gpt",
		DeploymentName:            "foundry-dep",
		ModelName:                 "gpt-4",
		Version:                   "2026-01",
		Provider:                  ModelProviderFoundryDevelopment,
		LifecycleStatus:           "approved",
		LicenseStatus:             "approved",
		ApprovalExpiry:            now.Add(24 * time.Hour).Format(time.RFC3339),
		AllowedDataClasses:        []string{"model"},
		SupportedTemplateVersions: []string{"v1"},
		SupportsStructuredOutput:  false,
	}, true)

	payload := ModelInvocationRequest{
		RunID:      "run-1",
		ModelID:    "foundry-gpt",
		Actor:      "agent-1",
		AgentRole:  AgentRoleTransformation,
		DataClass:  "model",
		Prompt:     "Hello",
		TimeoutMs:  1000,
		Parameters: map[string]any{},
	}
	body, _ := json.Marshal(payload)
	req := httptest.NewRequest(http.MethodPost, "/v0/invoke", strings.NewReader(string(body)))
	req.Header.Set("content-type", "application/json")
	rr := httptest.NewRecorder()

	service.invokeHandler(rr, req)

	if rr.Code != http.StatusBadRequest {
		t.Fatalf("expected status 400, got %d with body %s", rr.Code, rr.Body.String())
	}
	if !strings.Contains(rr.Body.String(), "promptTemplateVersion is required") {
		t.Fatalf("expected prompt template error response, got %s", rr.Body.String())
	}
	var response map[string]any
	if err := json.Unmarshal(rr.Body.Bytes(), &response); err != nil {
		t.Fatalf("expected json error response: %v", err)
	}
	if response["errorCode"] != errorCodeMalformedRequest {
		t.Fatalf("expected errorCode=%q, got %v", errorCodeMalformedRequest, response["errorCode"])
	}
	if provider.calls != 0 {
		t.Fatalf("expected no provider call, got %d", provider.calls)
	}
	ledger := service.ledger.(*inMemoryLedger)
	if len(ledger.entries) != 1 {
		t.Fatalf("expected one ledger entry, got %d", len(ledger.entries))
	}
	if ledger.entries[0].Status != statusRejected {
		t.Fatalf("expected rejected ledger status, got %s", ledger.entries[0].Status)
	}
	if ledger.entries[0].PromptTemplate != defaultTemplateVersion {
		t.Fatalf("expected default prompt template on rejected ledger, got %s", ledger.entries[0].PromptTemplate)
	}
}

func TestModelGatewayService_HealthMetadataContainsRuntimePolicy(t *testing.T) {
	now := time.Date(2026, 5, 14, 12, 0, 0, 0, time.UTC)
	provider := &stubProvider{}
	service := newGatewayServiceForTest(now, provider, ModelMetadata{
		ID:                        "foundry-gpt",
		DeploymentName:            "foundry-dep",
		ModelName:                 "gpt-4",
		Version:                   "2026-01",
		Provider:                  ModelProviderFoundryDevelopment,
		LifecycleStatus:           "approved",
		LicenseStatus:             "approved",
		ApprovalExpiry:            now.Add(24 * time.Hour).Format(time.RFC3339),
		AllowedDataClasses:        []string{"model"},
		SupportedTemplateVersions: []string{"v1"},
		SupportsStructuredOutput:  false,
	}, true)

	err := service.applyGatewayRuntimeConfig(gatewayConfig{
		defaultModelDeployment:      "foundry-gpt",
		fallbackModelDeployments:    []string{"foundry-gpt"},
		allowedModelDeployments:     []string{"foundry-gpt"},
		dataPolicy:                  "public_synthetic_only",
		invocationLedgerEnabled:     true,
		harnessEventEmissionEnabled: true,
		modelProvider:               ModelProviderFoundryDevelopment,
		azureFoundryAPIVersion:      "2024-05-01-preview",
	})
	if err != nil {
		t.Fatalf("expected config applied: %v", err)
	}

	req := httptest.NewRequest(http.MethodGet, "/v0/health", nil)
	rr := httptest.NewRecorder()

	service.healthHandler(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("expected health 200, got %d", rr.Code)
	}
	var payload ModelGatewayHealthResponse
	if err := json.Unmarshal(rr.Body.Bytes(), &payload); err != nil {
		t.Fatalf("expected valid json: %v", err)
	}
	if payload.Configured["defaultModelDeployment"] != "foundry-gpt" {
		t.Fatalf("unexpected default deployment %s", payload.Configured["defaultModelDeployment"])
	}
	if payload.Configured["fallbackModelDeployments"] != "foundry-gpt" {
		t.Fatalf("unexpected fallback deployments %s", payload.Configured["fallbackModelDeployments"])
	}
	if payload.Configured["allowedModelDeployments"] != "foundry-gpt" {
		t.Fatalf("unexpected allowed deployments %s", payload.Configured["allowedModelDeployments"])
	}
	if payload.Configured["dataPolicy"] != "public_synthetic_only" {
		t.Fatalf("unexpected data policy %s", payload.Configured["dataPolicy"])
	}
	if payload.Configured["invocationLedgerEnabled"] != strconv.FormatBool(true) {
		t.Fatalf("ledger expected enabled, got %s", payload.Configured["invocationLedgerEnabled"])
	}
}
