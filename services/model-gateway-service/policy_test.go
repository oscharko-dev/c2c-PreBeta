package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// activeModel returns a registry-shaped ModelMetadata that is approved for the
// fixed test clock used across these tests.
func activeModel(id string, now time.Time) ModelMetadata {
	return ModelMetadata{
		ID:                        id,
		DisplayName:               id,
		Provider:                  ModelProviderFoundryDevelopment,
		DeploymentName:            id,
		ModelName:                 id,
		Version:                   "1",
		LifecycleStatus:           "approved",
		LicenseStatus:             "approved",
		ApprovalExpiry:            now.Add(24 * time.Hour).Format(time.RFC3339),
		AllowedDataClasses:        []string{"model"},
		SupportedTemplateVersions: []string{"v1"},
		SupportsStructuredOutput:  false,
		DefaultTimeoutMs:          15000,
		Capability:                "model-generation",
	}
}

// TestAllowlist_RolePolicyResolution covers the role-to-model policy helpers
// required by Issue #168 acceptance criteria ("strict model allowlist or
// registry entry for W0.2 agent roles" and "unit tests for role-to-model
// policy resolution").
func TestAllowlist_RolePolicyResolution(t *testing.T) {
	cfg := FoundryDevelopmentAllowlist{
		Mode:            ModelProviderFoundryDevelopment,
		AllowedModelIDs: []string{"alpha", "beta", "gamma"},
		Roles: map[string][]string{
			AgentRoleTransformation:     {"alpha", "beta"},
			AgentRoleVerificationRepair: {"beta", "gamma"},
		},
	}
	if !cfg.IsRoleConfigured(AgentRoleTransformation) {
		t.Fatalf("expected transformation role to be configured")
	}
	if cfg.IsRoleConfigured("not-a-role") {
		t.Fatalf("expected unknown role to be unconfigured")
	}
	if !cfg.IsRoleAllowed(AgentRoleTransformation, "alpha") {
		t.Fatalf("alpha should be allowed for transformation")
	}
	if cfg.IsRoleAllowed(AgentRoleTransformation, "gamma") {
		t.Fatalf("gamma must not be allowed for transformation")
	}
	if !cfg.IsRoleAllowed(AgentRoleVerificationRepair, "gamma") {
		t.Fatalf("gamma should be allowed for verification-repair")
	}
	if cfg.IsRoleAllowed(AgentRoleVerificationRepair, "alpha") {
		t.Fatalf("alpha must not be allowed for verification-repair")
	}
	// Unconfigured and blank roles are denied in governed mode: callers must
	// identify a role so the gateway can enforce role-to-model policy.
	if cfg.IsRoleAllowed("custom-role", "alpha") {
		t.Fatalf("unconfigured role must be denied")
	}
	if cfg.IsRoleAllowed("", "alpha") {
		t.Fatalf("empty role must be denied")
	}
	models := cfg.AllowedModelsForRole(AgentRoleTransformation)
	if len(models) != 2 || models[0] != "alpha" || models[1] != "beta" {
		t.Fatalf("unexpected allowed models for transformation: %v", models)
	}
	if cfg.AllowedModelsForRole("not-a-role") != nil {
		t.Fatalf("expected nil for unconfigured role")
	}
}

// TestAllowlist_Validate_RoleReferencesGeneralAllowlist guarantees that the
// loader refuses configurations where a role references a model that is not
// in `allowedModelIds`. This protects against silent privilege escalation.
func TestAllowlist_Validate_RoleReferencesGeneralAllowlist(t *testing.T) {
	cfg := FoundryDevelopmentAllowlist{
		Mode:            ModelProviderFoundryDevelopment,
		AllowedModelIDs: []string{"alpha"},
		Roles: map[string][]string{
			AgentRoleTransformation: {"alpha", "delta"},
		},
	}
	err := cfg.Validate()
	if err == nil {
		t.Fatalf("expected validation to fail for role referencing model not in allowlist")
	}
	if !strings.Contains(err.Error(), "delta") {
		t.Fatalf("expected error to mention disallowed model, got %v", err)
	}
}

// TestAllowlist_Validate_RoleMustNotBeEmpty guarantees that a role with no
// models is refused at load time.
func TestAllowlist_Validate_RoleMustNotBeEmpty(t *testing.T) {
	cfg := FoundryDevelopmentAllowlist{
		Mode:            ModelProviderFoundryDevelopment,
		AllowedModelIDs: []string{"alpha"},
		Roles: map[string][]string{
			AgentRoleTransformation: {},
		},
	}
	if err := cfg.Validate(); err == nil {
		t.Fatalf("expected validation to fail when role has no models")
	}
}

// TestAllowlist_PolicyID_Defaults checks the resolved policy id falls back to
// the default constant when unset.
func TestAllowlist_PolicyID_Defaults(t *testing.T) {
	cfg := FoundryDevelopmentAllowlist{}
	if cfg.ResolvedPolicyID() != defaultPolicyID {
		t.Fatalf("expected default policy id %q, got %q", defaultPolicyID, cfg.ResolvedPolicyID())
	}
	cfg.PolicyID = "custom-v3"
	if cfg.ResolvedPolicyID() != "custom-v3" {
		t.Fatalf("expected custom policy id, got %q", cfg.ResolvedPolicyID())
	}
}

func newGatewayServiceWithRoles(now time.Time, model ModelMetadata, roles map[string][]string) *ModelGatewayService {
	ledger := &inMemoryLedger{}
	events := &inMemoryEventSink{}
	registry := ModelRegistry{Models: []ModelMetadata{model}}
	if roles == nil {
		roles = map[string][]string{
			AgentRoleTransformation: {model.ID},
		}
	}
	allowlist := FoundryDevelopmentAllowlist{
		Mode:            ModelProviderFoundryDevelopment,
		PolicyID:        "foundry-development-v0",
		AllowedModelIDs: []string{model.ID},
		Roles:           roles,
		Foundry: ProviderFoundryConfig{
			Endpoint:  "https://local",
			ApiKeyRef: "api-key-ref",
			TimeoutMs: 30000,
		},
	}
	stub := &stubProvider{
		output: map[string]any{"text": "ok"},
		status: "completed",
	}
	return &ModelGatewayService{
		registry:                    registry,
		allowlist:                   allowlist,
		ledger:                      ledger,
		events:                      events,
		now:                         func() time.Time { return now },
		modelProvider:               ModelProviderFoundryDevelopment,
		dataPolicy:                  "public_synthetic_only",
		policyID:                    allowlist.PolicyID,
		invocationLedgerEnabled:     true,
		harnessEventEmissionEnabled: true,
		defaultModelDeployment:      model.ID,
		allowedModelDeployments:     []string{model.ID},
		providers:                   map[string]ModelProvider{stub.Name(): stub},
		providerTimeouts:            map[string]int64{stub.Name(): 30000},
	}
}

// TestInvoke_ForbiddenRole exercises the gateway-level role enforcement and
// ensures the rejection produces a ledger entry with errorCode set to
// model_policy_denied so the Orchestrator can map it to
// FAILURE_MODEL_POLICY_DENIED.
func TestInvoke_ForbiddenRole(t *testing.T) {
	now := time.Date(2026, 5, 14, 12, 0, 0, 0, time.UTC)
	model := activeModel("foundry-gpt", now)
	service := newGatewayServiceWithRoles(now, model, map[string][]string{
		AgentRoleTransformation:     {model.ID},
		AgentRoleVerificationRepair: {}, // empty list => role exists but no model allowed
	})
	// Repair role explicitly excludes the only registered model.
	service.allowlist.Roles[AgentRoleVerificationRepair] = []string{}

	payload := ModelInvocationRequest{
		RunID:                 "run-role-1",
		ModelID:               "foundry-gpt",
		Actor:                 "agent-1",
		AgentRole:             AgentRoleVerificationRepair,
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
		t.Fatalf("expected 403 for forbidden role, got %d body=%s", rr.Code, rr.Body.String())
	}
	var resp map[string]any
	if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
		t.Fatalf("expected JSON response: %v", err)
	}
	if got := resp["errorCode"]; got != errorCodePolicyDenied {
		t.Fatalf("expected errorCode=%q got %v", errorCodePolicyDenied, got)
	}
	if resp["policyId"] != "foundry-development-v0" {
		t.Fatalf("expected policyId in response, got %v", resp["policyId"])
	}
	if validationCode, _ := resp["validationCode"].(string); validationCode != "forbidden_role" {
		t.Fatalf("expected validationCode=forbidden_role, got %v", resp["validationCode"])
	}
	ledger := service.ledger.(*inMemoryLedger).entries
	if len(ledger) != 1 {
		t.Fatalf("expected one ledger entry, got %d", len(ledger))
	}
	if ledger[0].Status != statusRejected {
		t.Fatalf("expected rejected status, got %s", ledger[0].Status)
	}
	if ledger[0].ErrorCode != errorCodePolicyDenied {
		t.Fatalf("expected ledger errorCode=%q got %q", errorCodePolicyDenied, ledger[0].ErrorCode)
	}
	if ledger[0].AgentRole != AgentRoleVerificationRepair {
		t.Fatalf("expected ledger agentRole recorded, got %q", ledger[0].AgentRole)
	}
	if ledger[0].PolicyID != "foundry-development-v0" {
		t.Fatalf("expected policyId recorded, got %q", ledger[0].PolicyID)
	}
}

func TestInvoke_MissingOrUnknownRoleIsDenied(t *testing.T) {
	now := time.Date(2026, 5, 14, 12, 0, 0, 0, time.UTC)
	model := activeModel("foundry-gpt", now)
	service := newGatewayServiceWithRoles(now, model, map[string][]string{
		AgentRoleTransformation: {model.ID},
	})

	for _, role := range []string{"", "invented-role"} {
		payload := ModelInvocationRequest{
			RunID:                 "run-role-required",
			ModelID:               "foundry-gpt",
			Actor:                 "agent-1",
			AgentRole:             role,
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
			t.Fatalf("role %q: expected 403, got %d body=%s", role, rr.Code, rr.Body.String())
		}
		var resp map[string]any
		if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
			t.Fatalf("role %q: expected JSON response: %v", role, err)
		}
		if resp["errorCode"] != errorCodePolicyDenied {
			t.Fatalf("role %q: expected errorCode=%q got %v", role, errorCodePolicyDenied, resp["errorCode"])
		}
		if resp["validationCode"] != "forbidden_role" {
			t.Fatalf("role %q: expected validationCode=forbidden_role got %v", role, resp["validationCode"])
		}
	}
}

// TestInvoke_RoleAllowsModel proves the happy path: when a role is configured
// and the model is listed for that role, the invocation succeeds and the
// agentRole/policyId metadata flows through the response and the ledger.
func TestInvoke_RoleAllowsModel(t *testing.T) {
	now := time.Date(2026, 5, 14, 12, 0, 0, 0, time.UTC)
	model := activeModel("foundry-gpt", now)
	service := newGatewayServiceWithRoles(now, model, map[string][]string{
		AgentRoleTransformation: {model.ID},
	})

	payload := ModelInvocationRequest{
		RunID:                 "run-role-2",
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
		t.Fatalf("expected 200, got %d body=%s", rr.Code, rr.Body.String())
	}
	var response ModelInvocationResponse
	if err := json.Unmarshal(rr.Body.Bytes(), &response); err != nil {
		t.Fatalf("expected JSON response: %v", err)
	}
	if response.AgentRole != AgentRoleTransformation {
		t.Fatalf("expected agentRole on response, got %q", response.AgentRole)
	}
	if response.PolicyID != "foundry-development-v0" {
		t.Fatalf("expected policyId on response, got %q", response.PolicyID)
	}
	ledger := service.ledger.(*inMemoryLedger).entries
	if ledger[0].AgentRole != AgentRoleTransformation {
		t.Fatalf("expected agentRole on ledger entry")
	}
	if ledger[0].PolicyID != "foundry-development-v0" {
		t.Fatalf("expected policyId on ledger entry")
	}
}

// TestCapabilitiesEndpoint_ReportsRoleAvailability covers the GET
// /v0/capabilities contract required by Issue #168: the Orchestrator must be
// able to read per-role availability so it can fail early when an approved
// W0.2 model is not reachable.
func TestCapabilitiesEndpoint_ReportsRoleAvailability(t *testing.T) {
	now := time.Date(2026, 5, 14, 12, 0, 0, 0, time.UTC)
	model := activeModel("foundry-gpt", now)
	service := newGatewayServiceWithRoles(now, model, map[string][]string{
		AgentRoleTransformation:     {model.ID},
		AgentRoleVerificationRepair: {"some-missing-model"},
	})

	req := httptest.NewRequest(http.MethodGet, "/v0/capabilities", nil)
	rr := httptest.NewRecorder()
	service.capabilitiesHandler(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("expected capabilities 200, got %d", rr.Code)
	}
	var body ModelGatewayCapabilitiesResponse
	if err := json.Unmarshal(rr.Body.Bytes(), &body); err != nil {
		t.Fatalf("expected json: %v", err)
	}
	if body.PolicyID != "foundry-development-v0" {
		t.Fatalf("expected policyId in capabilities, got %q", body.PolicyID)
	}
	if body.Provider != ModelProviderFoundryDevelopment {
		t.Fatalf("unexpected provider %q", body.Provider)
	}
	roleByName := map[string]RoleAvailability{}
	for _, role := range body.Roles {
		roleByName[role.Role] = role
	}
	transformation, ok := roleByName[AgentRoleTransformation]
	if !ok {
		t.Fatalf("expected transformation role in capabilities")
	}
	if transformation.Status != "ok" {
		t.Fatalf("expected transformation role status=ok got %q", transformation.Status)
	}
	if len(transformation.AvailableModels) != 1 || transformation.AvailableModels[0] != model.ID {
		t.Fatalf("expected transformation available models=[%s], got %v", model.ID, transformation.AvailableModels)
	}

	repair, ok := roleByName[AgentRoleVerificationRepair]
	if !ok {
		t.Fatalf("expected verification-repair role in capabilities")
	}
	if repair.Status != "unavailable" {
		t.Fatalf("expected repair role status=unavailable got %q", repair.Status)
	}
	if repair.Reason == "" {
		t.Fatalf("expected repair role reason to be populated")
	}
	if body.Status != "degraded" {
		t.Fatalf("expected overall status=degraded when a role is unavailable, got %q", body.Status)
	}
}

func TestCapabilitiesEndpoint_UnconfiguredRoleIsUnavailable(t *testing.T) {
	now := time.Date(2026, 5, 14, 12, 0, 0, 0, time.UTC)
	model := activeModel("foundry-gpt", now)
	service := newGatewayServiceWithRoles(now, model, map[string][]string{
		AgentRoleTransformation: {model.ID},
	})

	req := httptest.NewRequest(http.MethodGet, "/v0/capabilities", nil)
	rr := httptest.NewRecorder()
	service.capabilitiesHandler(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("expected capabilities 200, got %d", rr.Code)
	}
	var body ModelGatewayCapabilitiesResponse
	if err := json.Unmarshal(rr.Body.Bytes(), &body); err != nil {
		t.Fatalf("expected json: %v", err)
	}
	roleByName := map[string]RoleAvailability{}
	for _, role := range body.Roles {
		roleByName[role.Role] = role
	}
	repair := roleByName[AgentRoleVerificationRepair]
	if repair.Status != "unavailable" {
		t.Fatalf("expected unconfigured repair role unavailable, got %q", repair.Status)
	}
	if repair.Reason != "role is not configured in allowlist" {
		t.Fatalf("unexpected unconfigured role reason %q", repair.Reason)
	}
}

// TestCapabilitiesEndpoint_RejectsNonGET ensures the endpoint is a read-only
// surface — invocations must continue to go through /v0/invoke.
func TestCapabilitiesEndpoint_RejectsNonGET(t *testing.T) {
	now := time.Date(2026, 5, 14, 12, 0, 0, 0, time.UTC)
	model := activeModel("foundry-gpt", now)
	service := newGatewayServiceWithRoles(now, model, map[string][]string{
		AgentRoleTransformation: {model.ID},
	})
	req := httptest.NewRequest(http.MethodPost, "/v0/capabilities", nil)
	rr := httptest.NewRecorder()
	service.capabilitiesHandler(rr, req)
	if rr.Code != http.StatusMethodNotAllowed {
		t.Fatalf("expected 405, got %d", rr.Code)
	}
}

// TestFoundryAdapter_MissingCredentials enforces the issue's "missing
// credentials" negative test: the adapter constructor refuses configurations
// where neither a direct API key nor a key reference is provided.
func TestFoundryAdapter_MissingCredentials(t *testing.T) {
	_, err := NewFoundryAdapter(ProviderFoundryConfig{
		Endpoint:   "https://example.com",
		TimeoutMs:  1000,
		APIVersion: "2024-05-01-preview",
	})
	if err == nil {
		t.Fatalf("expected missing-credential error")
	}
	if !strings.Contains(err.Error(), "api key") {
		t.Fatalf("expected error message about api key, got %v", err)
	}
}

// TestFoundryAdapter_UsageExtraction covers the issue requirement that the
// Model Invocation Ledger record token counts where available. The adapter
// extracts the `usage` object from the chat-completions response and exposes
// it on the ModelInvocationOutput metadata; the gateway then propagates it
// onto the response and the ledger.
func TestFoundryAdapter_UsageExtraction(t *testing.T) {
	stub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{
			"choices": [{"message": {"content": "ok"}}],
			"usage": {"prompt_tokens": 12, "completion_tokens": 8, "total_tokens": 20}
		}`))
	}))
	defer stub.Close()

	adapter, err := NewFoundryAdapter(ProviderFoundryConfig{
		Endpoint:   stub.URL,
		ApiKey:     "test-key",
		APIVersion: "2024-05-01-preview",
		TimeoutMs:  5000,
	})
	if err != nil {
		t.Fatalf("unexpected adapter init error: %v", err)
	}
	model := ModelMetadata{
		ID:             "foundry-gpt",
		DeploymentName: "foundry-gpt",
		ModelName:      "foundry-gpt",
		Provider:       ModelProviderFoundryDevelopment,
	}
	out, err := adapter.Invoke(context.Background(), ModelInvocationRequest{
		RunID:                 "run",
		ModelID:               "foundry-gpt",
		PromptTemplateVersion: "v1",
		Prompt:                "Hi",
		Parameters:            map[string]any{},
		TimeoutMs:             5000,
	}, model)
	if err != nil {
		t.Fatalf("unexpected invoke error: %v", err)
	}
	usage, ok := out.Metadata["usage"].(map[string]any)
	if !ok {
		t.Fatalf("expected usage in metadata, got %#v", out.Metadata)
	}
	if usage["prompt_tokens"] != float64(12) {
		t.Fatalf("expected prompt_tokens=12, got %v", usage["prompt_tokens"])
	}
	if usage["completion_tokens"] != float64(8) {
		t.Fatalf("expected completion_tokens=8, got %v", usage["completion_tokens"])
	}
	if usage["total_tokens"] != float64(20) {
		t.Fatalf("expected total_tokens=20, got %v", usage["total_tokens"])
	}
}

// timeoutProvider deterministically returns context.DeadlineExceeded so the
// gateway can be tested for the provider_timeout error class without involving
// a live network.
type timeoutProvider struct{}

func (timeoutProvider) Name() string { return ModelProviderFoundryDevelopment }
func (timeoutProvider) Invoke(_ context.Context, _ ModelInvocationRequest, _ ModelMetadata) (ModelInvocationOutput, error) {
	return ModelInvocationOutput{}, context.DeadlineExceeded
}

// TestInvoke_ProviderTimeoutMapsToGatewayTimeout proves that a provider
// timeout surfaces as HTTP 504 with errorCode=model_provider_timeout and the
// ledger records errorClass=provider_timeout. Distinguishing provider
// timeouts from generic provider errors is an explicit acceptance criterion.
func TestInvoke_ProviderTimeoutMapsToGatewayTimeout(t *testing.T) {
	now := time.Date(2026, 5, 14, 12, 0, 0, 0, time.UTC)
	model := activeModel("foundry-gpt", now)
	service := newGatewayServiceWithRoles(now, model, nil)
	service.providers = map[string]ModelProvider{ModelProviderFoundryDevelopment: timeoutProvider{}}

	payload := ModelInvocationRequest{
		RunID:                 "run-timeout",
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

	if rr.Code != http.StatusGatewayTimeout {
		t.Fatalf("expected 504, got %d body=%s", rr.Code, rr.Body.String())
	}
	var resp map[string]any
	if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
		t.Fatalf("expected json: %v", err)
	}
	if resp["errorCode"] != errorCodeProviderTimeout {
		t.Fatalf("expected errorCode=%q, got %v", errorCodeProviderTimeout, resp["errorCode"])
	}
	ledger := service.ledger.(*inMemoryLedger).entries
	if len(ledger) != 1 || ledger[0].ErrorClass != errorClassProviderTimeout {
		t.Fatalf("expected provider_timeout ledger entry, got %+v", ledger)
	}
}

// errorProvider returns a generic non-timeout provider error so the gateway
// can distinguish provider_error from provider_timeout.
type errorProvider struct{}

func (errorProvider) Name() string { return ModelProviderFoundryDevelopment }
func (errorProvider) Invoke(_ context.Context, _ ModelInvocationRequest, _ ModelMetadata) (ModelInvocationOutput, error) {
	return ModelInvocationOutput{}, errors.New("foundry endpoint responded with 500")
}

func TestInvoke_ProviderErrorMapsToBadGateway(t *testing.T) {
	now := time.Date(2026, 5, 14, 12, 0, 0, 0, time.UTC)
	model := activeModel("foundry-gpt", now)
	service := newGatewayServiceWithRoles(now, model, nil)
	service.providers = map[string]ModelProvider{ModelProviderFoundryDevelopment: errorProvider{}}

	payload := ModelInvocationRequest{
		RunID:                 "run-err",
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
	if rr.Code != http.StatusBadGateway {
		t.Fatalf("expected 502, got %d", rr.Code)
	}
	var resp map[string]any
	if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
		t.Fatalf("expected json: %v", err)
	}
	if resp["errorCode"] != errorCodeProviderError {
		t.Fatalf("expected errorCode=%q got %v", errorCodeProviderError, resp["errorCode"])
	}
	if resp["error"] != "model provider error" {
		t.Fatalf("expected sanitized provider error, got %v", resp["error"])
	}
	ledger := service.ledger.(*inMemoryLedger).entries
	if len(ledger) != 1 || ledger[0].ErrorClass != errorClassProviderError {
		t.Fatalf("expected provider_error ledger entry, got %+v", ledger)
	}
	if ledger[0].ErrorMessage != "model provider error" {
		t.Fatalf("expected sanitized ledger error message, got %q", ledger[0].ErrorMessage)
	}
}

func TestInvoke_ProviderNotReadyMapsToUnavailable(t *testing.T) {
	now := time.Date(2026, 5, 14, 12, 0, 0, 0, time.UTC)
	model := activeModel("foundry-gpt", now)
	service := newGatewayServiceWithRoles(now, model, nil)
	service.providers = map[string]ModelProvider{}

	payload := ModelInvocationRequest{
		RunID:                 "run-no-provider",
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
	if rr.Code != http.StatusServiceUnavailable {
		t.Fatalf("expected 503, got %d body=%s", rr.Code, rr.Body.String())
	}
	var resp map[string]any
	if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
		t.Fatalf("expected json: %v", err)
	}
	if resp["errorCode"] != errorCodeProviderUnavailable {
		t.Fatalf("expected errorCode=%q got %v", errorCodeProviderUnavailable, resp["errorCode"])
	}
	if resp["validationCode"] != "provider_not_ready" {
		t.Fatalf("expected validationCode=provider_not_ready got %v", resp["validationCode"])
	}
	ledger := service.ledger.(*inMemoryLedger).entries
	if len(ledger) != 1 || ledger[0].ErrorCode != errorCodeProviderUnavailable {
		t.Fatalf("expected provider unavailable ledger entry, got %+v", ledger)
	}
}

// TestHealthEndpoint_ExposesPolicyID locks in the contract that GET
// /v0/health includes the resolved policyId so operators can confirm the
// gateway is running with the expected policy version.
func TestHealthEndpoint_ExposesPolicyID(t *testing.T) {
	now := time.Date(2026, 5, 14, 12, 0, 0, 0, time.UTC)
	model := activeModel("foundry-gpt", now)
	service := newGatewayServiceWithRoles(now, model, map[string][]string{
		AgentRoleTransformation: {model.ID},
	})

	req := httptest.NewRequest(http.MethodGet, "/v0/health", nil)
	rr := httptest.NewRecorder()
	service.healthHandler(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rr.Code)
	}
	var body ModelGatewayHealthResponse
	if err := json.Unmarshal(rr.Body.Bytes(), &body); err != nil {
		t.Fatalf("expected json: %v", err)
	}
	if body.PolicyID != "foundry-development-v0" {
		t.Fatalf("expected policyId %q got %q", "foundry-development-v0", body.PolicyID)
	}
	if body.Configured["policyId"] != "foundry-development-v0" {
		t.Fatalf("expected configured.policyId, got %q", body.Configured["policyId"])
	}
}

// TestConfig_PolicyIDEnvOverride exercises the new C2C_MODEL_POLICY_ID env
// var. The override must propagate from env → gatewayConfig → service.
func TestConfig_PolicyIDEnvOverride(t *testing.T) {
	t.Setenv("C2C_MODEL_POLICY_ID", "policy-override-v9")
	cfg, err := resolveGatewayConfigFromEnv()
	if err != nil {
		t.Fatalf("config resolve failed: %v", err)
	}
	if cfg.policyID != "policy-override-v9" {
		t.Fatalf("expected policyID override, got %q", cfg.policyID)
	}
}
