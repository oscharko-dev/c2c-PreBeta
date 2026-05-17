package main

import (
	"context"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync/atomic"
	"time"
)

var invocationCounter atomic.Uint64

type ModelGatewayService struct {
	registry                    ModelRegistry
	allowlist                   FoundryDevelopmentAllowlist
	ledger                      ModelInvocationLedgerSink
	events                      EventSink
	now                         func() time.Time
	providers                   map[string]ModelProvider
	providerTimeouts            map[string]int64
	defaultModelDeployment      string
	fallbackModelDeployments    []string
	allowedModelDeployments     []string
	dataPolicy                  string
	invocationLedgerEnabled     bool
	harnessEventEmissionEnabled bool
	modelProvider               string
	azureAPIVersion             string
	policyID                    string
	controlToken                string
}

type gatewayConfig struct {
	registryPath                 string
	allowlistPath                string
	ledgerPath                   string
	eventLogPath                 string
	harnessEventURL              string
	modelProvider                string
	defaultModelDeployment       string
	fallbackModelDeployments     []string
	allowedModelDeployments      []string
	dataPolicy                   string
	policyID                     string
	invocationLedgerEnabled      bool
	harnessEventEmissionEnabled  bool
	harnessEventToken            string
	azureFoundryEndpoint         string
	azureFoundryAPIKey           string
	azureFoundryAPIKeyRef        string
	azureFoundryAPIResource      string
	azureFoundryAPIResourceGroup string
	azureFoundryAPIVersion       string
	controlToken                 string
}

type validatedInvocation struct {
	request        ModelInvocationRequest
	model          ModelMetadata
	provider       ModelProvider
	policyDecision string
	record         ModelInvocationLedgerV0
}

func NewModelGatewayService(registry ModelRegistry, allowlist FoundryDevelopmentAllowlist, ledger ModelInvocationLedgerSink, events EventSink, now func() time.Time) (*ModelGatewayService, error) {
	if err := registry.Validate(); err != nil {
		return nil, err
	}
	if err := allowlist.Validate(); err != nil {
		return nil, err
	}
	if ledger == nil {
		return nil, fmt.Errorf("ledger sink is required")
	}
	if events == nil {
		return nil, fmt.Errorf("event sink is required")
	}
	if now == nil {
		now = time.Now
	}

	providers := make(map[string]ModelProvider)
	timeouts := make(map[string]int64)

	switch allowlist.Mode {
	case ModelProviderFoundryDevelopment:
		foundry, err := NewFoundryAdapter(allowlist.Foundry)
		if err != nil {
			return nil, err
		}
		providers[foundry.Name()] = foundry
		timeouts[foundry.Name()] = allowlist.Foundry.TimeoutMs
	case ModelProviderCustomerInternalMock:
		mock, err := NewCustomerInternalMockAdapter(allowlist.CustomerInternal)
		if err != nil {
			return nil, err
		}
		providers[mock.Name()] = mock
		timeouts[mock.Name()] = allowlist.CustomerInternal.TimeoutMs
	default:
		return nil, fmt.Errorf("unsupported endpoint mode: %s", allowlist.Mode)
	}

	return &ModelGatewayService{
		registry:         registry,
		allowlist:        allowlist,
		ledger:           ledger,
		events:           events,
		now:              now,
		providers:        providers,
		providerTimeouts: timeouts,
	}, nil
}

func (s *ModelGatewayService) applyGatewayRuntimeConfig(cfg gatewayConfig) error {
	if cfg.modelProvider != "" {
		s.modelProvider = cfg.modelProvider
	} else {
		s.modelProvider = s.allowlist.Mode
	}

	s.invocationLedgerEnabled = cfg.invocationLedgerEnabled
	s.harnessEventEmissionEnabled = cfg.harnessEventEmissionEnabled
	s.azureAPIVersion = strings.TrimSpace(cfg.azureFoundryAPIVersion)

	s.defaultModelDeployment = strings.TrimSpace(cfg.defaultModelDeployment)
	s.fallbackModelDeployments = dedupeAndTrimNonEmptyStringSlice(cfg.fallbackModelDeployments)
	s.allowedModelDeployments = dedupeAndTrimNonEmptyStringSlice(cfg.allowedModelDeployments)
	if len(s.allowedModelDeployments) == 0 {
		s.allowedModelDeployments = dedupeAndTrimNonEmptyStringSlice(s.allowlist.AllowedModelIDs)
	}

	if s.defaultModelDeployment == "" && len(s.allowedModelDeployments) > 0 {
		s.defaultModelDeployment = s.allowedModelDeployments[0]
	}

	s.dataPolicy = strings.TrimSpace(cfg.dataPolicy)
	if s.dataPolicy == "" {
		s.dataPolicy = "public_synthetic_only"
	}

	s.policyID = strings.TrimSpace(cfg.policyID)
	if s.policyID == "" {
		s.policyID = s.allowlist.ResolvedPolicyID()
	}
	s.controlToken = strings.TrimSpace(cfg.controlToken)

	if err := validateDeploymentPolicyActive(s.registry, s.now, s.allowedModelDeployments); err != nil {
		return err
	}
	if s.defaultModelDeployment != "" && !stringInSlice(s.defaultModelDeployment, s.allowedModelDeployments) {
		return fmt.Errorf("default model deployment %q is not in allowed deployments", s.defaultModelDeployment)
	}
	if err := validateDeploymentPolicyActive(s.registry, s.now, s.fallbackModelDeployments); err != nil {
		return err
	}

	return nil
}

func (s *ModelGatewayService) Routes() *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("/v0/health", s.healthHandler)
	mux.HandleFunc("/v0/models", s.modelsHandler)
	mux.HandleFunc("/v0/models/", s.modelsHandler)
	mux.HandleFunc("/v0/capabilities", s.capabilitiesHandler)
	mux.HandleFunc("/v0/invoke", s.requireControlToken(s.invokeHandler))
	return mux
}

func (s *ModelGatewayService) requireControlToken(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if s.authorized(r) {
			next(w, r)
			return
		}
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
	}
}

func (s *ModelGatewayService) authorized(r *http.Request) bool {
	expected := strings.TrimSpace(s.controlToken)
	if expected == "" {
		return false
	}
	presented := presentedControlToken(r)
	return subtle.ConstantTimeCompare([]byte(presented), []byte(expected)) == 1
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

// resolvedPolicyID returns the active policy id, preferring the runtime
// override applied via gatewayConfig and falling back to the allowlist value.
func (s *ModelGatewayService) resolvedPolicyID() string {
	if strings.TrimSpace(s.policyID) != "" {
		return s.policyID
	}
	return s.allowlist.ResolvedPolicyID()
}

func (s *ModelGatewayService) closeSinks() {
	if closer, ok := s.ledger.(interface{ Close() error }); ok {
		_ = closer.Close()
	}
	if closer, ok := s.events.(interface{ Close() error }); ok {
		_ = closer.Close()
	}
}

func (s *ModelGatewayService) healthHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}
	providers := make([]string, 0, len(s.providers))
	for name := range s.providers {
		providers = append(providers, name)
	}
	writeJSON(w, http.StatusOK, ModelGatewayHealthResponse{
		Status:      "ok",
		Service:     eventServiceName,
		Schema:      gatewayEventSchemaVersion,
		Providers:   providers,
		ActiveModel: len(s.activeModels()),
		PolicyID:    s.resolvedPolicyID(),
		Configured: map[string]string{
			"mode":                        s.allowlist.Mode,
			"modelProvider":               s.modelProvider,
			"policyId":                    s.resolvedPolicyID(),
			"defaultModelDeployment":      s.defaultModelDeployment,
			"fallbackModelDeployments":    strings.Join(s.fallbackModelDeployments, ","),
			"allowedModelDeployments":     strings.Join(s.allowedModelDeployments, ","),
			"dataPolicy":                  s.dataPolicy,
			"invocationLedgerEnabled":     strconv.FormatBool(s.invocationLedgerEnabled),
			"harnessEventEmissionEnabled": strconv.FormatBool(s.harnessEventEmissionEnabled),
			"azureAPIVersion":             s.azureAPIVersion,
		},
	})
}

// capabilitiesHandler reports which W0.2 agent roles have an approved, active,
// allowlisted model available. The Orchestrator consults this view before
// invoking the gateway so it can fail early with model_gateway_unavailable
// when no approved model is reachable for the requested role. The endpoint
// always returns the configured roles (transformation, verification-repair)
// plus any additional roles defined in the allowlist.
func (s *ModelGatewayService) capabilitiesHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}

	roleSet := make(map[string]struct{})
	for _, role := range w02AgentRoles {
		roleSet[role] = struct{}{}
	}
	for role := range s.allowlist.Roles {
		if strings.TrimSpace(role) != "" {
			roleSet[role] = struct{}{}
		}
	}
	roles := make([]string, 0, len(roleSet))
	for role := range roleSet {
		roles = append(roles, role)
	}
	sortStrings(roles)

	availabilities := make([]RoleAvailability, 0, len(roles))
	overallStatus := "ok"
	for _, role := range roles {
		availabilities = append(availabilities, s.roleAvailability(role))
	}
	for _, role := range availabilities {
		if role.Status != "ok" {
			overallStatus = "degraded"
			break
		}
	}

	writeJSON(w, http.StatusOK, ModelGatewayCapabilitiesResponse{
		Schema:   gatewayEventSchemaVersion,
		Service:  eventServiceName,
		Status:   overallStatus,
		Provider: s.allowlist.Mode,
		PolicyID: s.resolvedPolicyID(),
		Roles:    availabilities,
	})
}

func (s *ModelGatewayService) roleAvailability(role string) RoleAvailability {
	configured := s.allowlist.AllowedModelsForRole(role)
	now := s.now()
	available := make([]string, 0)
	if configured == nil {
		return RoleAvailability{
			Role:             role,
			Status:           "unavailable",
			PolicyID:         s.resolvedPolicyID(),
			AvailableModels:  nil,
			ConfiguredModels: nil,
			Reason:           "role is not configured in allowlist",
		}
	}
	configuredCopy := append([]string{}, configured...)
	for _, modelID := range configured {
		model, ok := s.registry.Get(modelID)
		if !ok {
			continue
		}
		if !model.IsActive(now) {
			continue
		}
		if !s.isModelDeploymentAllowed(modelID) {
			continue
		}
		if model.Provider != s.allowlist.Mode {
			continue
		}
		if _, providerReady := s.providers[model.Provider]; !providerReady {
			continue
		}
		available = append(available, modelID)
	}
	status := "ok"
	reason := ""
	if len(available) == 0 {
		status = "unavailable"
		reason = "no approved active model for role"
	}
	return RoleAvailability{
		Role:             role,
		Status:           status,
		PolicyID:         s.resolvedPolicyID(),
		AvailableModels:  available,
		ConfiguredModels: configuredCopy,
		Reason:           reason,
	}
}

func sortStrings(values []string) {
	for i := 1; i < len(values); i++ {
		for j := i; j > 0 && values[j-1] > values[j]; j-- {
			values[j-1], values[j] = values[j], values[j-1]
		}
	}
}

func (s *ModelGatewayService) modelsHandler(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		if r.URL.Path == "/v0/models" {
			writeJSON(w, http.StatusOK, s.registry.Models)
			return
		}
		s.modelItemHandler(w, r)
	default:
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
	}
}

func (s *ModelGatewayService) modelItemHandler(w http.ResponseWriter, r *http.Request) {
	segments := strings.Split(strings.TrimPrefix(r.URL.Path, "/v0/models/"), "/")
	if len(segments) == 0 || segments[0] == "" {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "model id required"})
		return
	}
	if len(segments) != 1 {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "invalid model operation"})
		return
	}
	if strings.Contains(segments[0], "/") {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "invalid model id"})
		return
	}
	model, ok := s.registry.Get(segments[0])
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "model not found"})
		return
	}
	writeJSON(w, http.StatusOK, model)
}

func (s *ModelGatewayService) invokeHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}

	var request ModelInvocationRequest
	if err := decodeJSON(r, &request); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"error":     err.Error(),
			"errorCode": errorCodeMalformedRequest,
		})
		return
	}
	if request.Parameters == nil {
		request.Parameters = map[string]any{}
	}

	requestRef, err := ComputeSHA256Ref(request)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"error":     "invalid request payload",
			"errorCode": errorCodeMalformedRequest,
		})
		return
	}

	now := s.now()
	start := now
	invocationID := newInvocationID(now)

	//noinspection GoDfaErrorMayBeNotNil,GoDfaInspectionRunner
	validated, err := s.validateInvocation(request, requestRef)
	// validateInvocation always returns a fully populated validatedInvocation
	// value (record pre-seeded) even on error, so accessing validated.record
	// on the err != nil path is safe.
	//noinspection GoDfaErrorMayBeNotNil,GoDfaInspectionRunner
	record := validated.record
	if err != nil {
		record.InvocationID = invocationID
		record.RunID = request.RunID
		record.Provider = s.allowlist.Mode
		if strings.TrimSpace(record.PolicyID) == "" {
			record.PolicyID = s.resolvedPolicyID()
		}
		if strings.TrimSpace(record.RunID) == "" {
			record.RunID = "unknown-run"
		}
		if strings.TrimSpace(record.ModelID) == "" {
			record.ModelID = "unknown-model"
		}
		if strings.TrimSpace(record.DataClass) == "" {
			record.DataClass = DataClassModelGateway
		}
		if strings.TrimSpace(record.PromptTemplate) == "" {
			record.PromptTemplate = defaultTemplateVersion
		}
		record.PolicyDecision = policyDecisionDeny
		record.Status = statusRejected
		record.ErrorClass = errorClassValidation
		record.ErrorMessage = err.Error()
		var validationErr ModelGatewayValidationError
		_ = errors.As(err, &validationErr)
		errorCode := errorCodeForValidationErr(validationErr.Code)
		record.ErrorCode = errorCode
		outputRef, outputRefErr := ComputeSHA256Ref(map[string]any{
			"invocationId": invocationID,
			"error":        err.Error(),
			"errorCode":    errorCode,
			"status":       statusRejected,
		})
		if outputRefErr != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to compute validation output hash"})
			return
		}
		record.OutputRef = outputRef
		record.LatencyMs = int64(time.Since(start) / time.Millisecond)
		record.CreatedAt = now
		if appendErr := s.appendLedgerRecord(record); appendErr != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": appendErr.Error()})
			return
		}
		s.emitEvent(EventEnvelopeV0{
			EventID:          fmt.Sprintf("mgv-%s", invocationID),
			EventType:        eventTypeModelInvocationFailed,
			SchemaVersion:    gatewayEventSchemaVersion,
			Service:          eventServiceName,
			RunID:            request.RunID,
			StepID:           int64(invocationCounter.Load()),
			Actor:            defaultActor(request.Actor),
			Capability:       actorModelGateway,
			DataClass:        eventDataClassModelGateway,
			RedactionProfile: eventProfileControlledByHarness,
			PolicyDecision:   policyDecisionDeny,
			Status:           statusRejected,
			StateTransition:  "validate.rejected",
			InputRef:         requestRef,
			OutputRef:        outputRef,
			ErrorClass:       errorClassValidation,
			LatencyMs:        int64(time.Since(start) / time.Millisecond),
			CreatedAt:        now,
			Payload: map[string]any{
				"invocationId": invocationID,
				"modelId":      request.ModelID,
				"agentRole":    strings.TrimSpace(request.AgentRole),
				"policyId":     s.resolvedPolicyID(),
				"errorCode":    errorCode,
				"mode":         s.allowlist.Mode,
				"reason":       err.Error(),
			},
			RelatedRecords: []string{fmt.Sprintf("run:%s", request.RunID)},
		})
		writeJSON(w, statusForValidationErr(err), map[string]any{
			"error":          err.Error(),
			"errorCode":      errorCode,
			"validationCode": validationErr.Code,
			"invocationId":   invocationID,
			"policyId":       s.resolvedPolicyID(),
		})
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), time.Duration(request.TimeoutMs)*time.Millisecond)
	defer cancel()

	output, invokeErr := validated.provider.Invoke(ctx, request, validated.model)
	latencyMs := int64(time.Since(start) / time.Millisecond)
	outputData := map[string]any{
		"invocationId": invocationID,
		"status":       statusFailed,
	}
	outputStatus := statusCompleted
	errorClass := ""
	errorCode := ""
	errorMessage := ""
	var usage map[string]any
	if invokeErr != nil {
		outputStatus = statusFailed
		switch {
		case errors.Is(invokeErr, context.DeadlineExceeded), errors.Is(ctx.Err(), context.DeadlineExceeded):
			errorClass = errorClassProviderTimeout
			errorCode = errorCodeProviderTimeout
		default:
			errorClass = errorClassProviderError
			errorCode = errorCodeProviderError
		}
		errorMessage = safeProviderFailureMessage(errorCode)
	} else {
		outputStatus = normalizeInvocationStatus(output.Status)
		if output.Data != nil {
			outputData = output.Data
		}
		if _, hasStatus := outputData["status"]; !hasStatus {
			outputData["status"] = outputStatus
		}
		outputData["invocationId"] = invocationID
		if output.Metadata != nil {
			if rawUsage, ok := output.Metadata["usage"].(map[string]any); ok && len(rawUsage) > 0 {
				usage = rawUsage
			}
		}
	}

	outputRef, outErr := ComputeSHA256Ref(outputData)
	if outErr != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to compute output hash"})
		return
	}

	record = validated.record
	record.InvocationID = invocationID
	record.RunID = request.RunID
	record.Provider = validated.model.Provider
	record.OutputRef = outputRef
	record.Status = outputStatus
	record.LatencyMs = latencyMs
	record.Usage = usage
	record.ErrorClass = errorClass
	record.ErrorCode = errorCode
	record.ErrorMessage = errorMessage
	record.CreatedAt = now
	if strings.TrimSpace(record.PolicyID) == "" {
		record.PolicyID = s.resolvedPolicyID()
	}

	ledgerRef, refErr := ComputeSHA256RefWithURI(fmt.Sprintf("urn:model-gateway/invocations/%s", invocationID), record)
	if refErr != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to compute ledger hash"})
		return
	}

	if err := s.appendLedgerRecord(record); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}

	eventType := eventTypeModelInvocationDone
	eventTransition := "invoke.completed"
	if invokeErr != nil {
		eventType = eventTypeModelInvocationFailed
		eventTransition = "invoke.failed"
	}
	s.emitEvent(EventEnvelopeV0{
		EventID:          fmt.Sprintf("mgv-%s", invocationID),
		EventType:        eventType,
		SchemaVersion:    gatewayEventSchemaVersion,
		Service:          eventServiceName,
		RunID:            request.RunID,
		StepID:           int64(invocationCounter.Load()),
		Actor:            defaultActor(request.Actor),
		Capability:       actorModelGateway,
		DataClass:        eventDataClassModelGateway,
		RedactionProfile: eventProfileControlledByHarness,
		PolicyDecision:   validated.policyDecision,
		Status:           outputStatus,
		StateTransition:  eventTransition,
		InputRef:         requestRef,
		OutputRef:        outputRef,
		ErrorClass:       errorClass,
		LatencyMs:        latencyMs,
		CreatedAt:        now,
		Payload: map[string]any{
			"invocationId": invocationID,
			"modelId":      request.ModelID,
			"provider":     validated.model.Provider,
			"agentRole":    strings.TrimSpace(request.AgentRole),
			"policyId":     record.PolicyID,
			"errorCode":    errorCode,
			"mode":         s.allowlist.Mode,
			"usage":        usage,
		},
		RelatedRecords: []string{fmt.Sprintf("run:%s", request.RunID)},
	})

	if invokeErr != nil {
		statusCode := http.StatusBadGateway
		if errorClass == errorClassProviderTimeout {
			statusCode = http.StatusGatewayTimeout
		}
		writeJSON(w, statusCode, map[string]any{
			"error":        errorMessage,
			"errorCode":    errorCode,
			"errorClass":   errorClass,
			"invocationId": invocationID,
			"policyId":     record.PolicyID,
		})
		return
	}
	writeJSON(w, http.StatusOK, ModelInvocationResponse{
		InvocationID:          invocationID,
		RunID:                 request.RunID,
		ModelID:               request.ModelID,
		Provider:              validated.model.Provider,
		PolicyID:              record.PolicyID,
		AgentRole:             strings.TrimSpace(request.AgentRole),
		PromptTemplateVersion: request.PromptTemplateVersion,
		PolicyDecision:        validated.policyDecision,
		Status:                outputStatus,
		LatencyMs:             latencyMs,
		Usage:                 usage,
		LedgerRef:             ledgerRef,
		Output:                outputData,
	})
}

func normalizeInvocationStatus(status string) string {
	switch strings.TrimSpace(status) {
	case statusCompleted, statusFailed, statusRejected:
		return status
	default:
		return statusCompleted
	}
}

func safeProviderFailureMessage(errorCode string) string {
	if errorCode == errorCodeProviderTimeout {
		return "model provider timed out"
	}
	if errorCode == errorCodeProviderUnavailable {
		return "model provider unavailable"
	}
	return "model provider error"
}

func (s *ModelGatewayService) validateInvocation(request ModelInvocationRequest, requestRef DataReference) (validatedInvocation, error) {
	result := validatedInvocation{
		request: request,
		record: ModelInvocationLedgerV0{
			SchemaVersion:    gatewayEventSchemaVersion,
			RequestRef:       requestRef,
			DataClass:        request.DataClass,
			PromptTemplate:   request.PromptTemplateVersion,
			Parameters:       sanitizeLedgerParameters(request.Parameters),
			StructuredOutput: request.StructuredOutput,
			PolicyID:         s.resolvedPolicyID(),
			AgentRole:        strings.TrimSpace(request.AgentRole),
		},
	}

	if strings.TrimSpace(result.request.RunID) == "" {
		return result, ModelGatewayValidationError{
			Code:    "missing_run_id",
			Message: "runId is required",
		}
	}
	if strings.TrimSpace(result.request.Actor) == "" {
		result.request.Actor = actorModelGateway
	}
	if strings.TrimSpace(result.request.ModelID) == "" {
		return result, ModelGatewayValidationError{
			Code:    "missing_model_id",
			Message: "modelId is required",
		}
	}
	if strings.TrimSpace(result.request.DataClass) == "" {
		return result, ModelGatewayValidationError{
			Code:    "missing_data_class",
			Message: "dataClass is required",
		}
	}
	if strings.TrimSpace(result.request.PromptTemplateVersion) == "" {
		return result, ModelGatewayValidationError{
			Code:    "missing_prompt_template",
			Message: "promptTemplateVersion is required",
		}
	}
	if result.request.TimeoutMs <= 0 {
		return result, ModelGatewayValidationError{
			Code:    "invalid_timeout",
			Message: "timeoutMs must be greater than zero",
		}
	}
	model, ok := s.registry.Get(result.request.ModelID)
	if !ok {
		return result, ModelGatewayValidationError{
			Code:    "unknown_model",
			Message: "unknown modelId",
		}
	}
	if !model.IsActive(s.now()) {
		return result, ModelGatewayValidationError{
			Code:    "inactive_model",
			Message: "model is not active",
		}
	}
	if model.Provider != s.allowlist.Mode {
		return result, ModelGatewayValidationError{
			Code:    "disallowed_model_endpoint",
			Message: "model endpoint mode is not allowed for this gateway",
		}
	}
	if !s.isModelDeploymentAllowed(model.ID) {
		return result, ModelGatewayValidationError{
			Code:    "forbidden_model",
			Message: "modelId is not in allowlist",
		}
	}
	if !s.allowlist.IsRoleAllowed(result.request.AgentRole, model.ID) {
		return result, ModelGatewayValidationError{
			Code:    "forbidden_role",
			Message: fmt.Sprintf("modelId %q is not allowed for agentRole %q", model.ID, result.request.AgentRole),
		}
	}
	if _, ok := allowedDataClasses[result.request.DataClass]; !ok {
		return result, ModelGatewayValidationError{
			Code:    "unsupported_data_class",
			Message: "unsupported data class",
		}
	}
	if !model.IsDataClassAllowed(result.request.DataClass) {
		return result, ModelGatewayValidationError{
			Code:    "forbidden_data_class",
			Message: "data class is not allowed for model",
		}
	}
	if !model.SupportsTemplate(result.request.PromptTemplateVersion) {
		return result, ModelGatewayValidationError{
			Code:    "unsupported_prompt_template",
			Message: "unsupported promptTemplateVersion",
		}
	}
	if result.request.StructuredOutput {
		if !model.SupportsStructuredOutput {
			return result, ModelGatewayValidationError{
				Code:    "unsupported_structured_output",
				Message: "model does not support structured output",
			}
		}
		if len(result.request.StructuredOutputSchema) == 0 {
			return result, ModelGatewayValidationError{
				Code:    "missing_structured_output_schema",
				Message: "structuredOutputSchema is required when structuredOutput=true",
			}
		}
	}
	if model.DefaultTimeoutMs > 0 && result.request.TimeoutMs > model.DefaultTimeoutMs {
		return result, ModelGatewayValidationError{
			Code:    "timeout_exceeded_model_default",
			Message: "timeoutMs exceeds model default timeout",
		}
	}
	maxTimeout := s.providerTimeouts[model.Provider]
	if maxTimeout > 0 && result.request.TimeoutMs > maxTimeout {
		return result, ModelGatewayValidationError{
			Code:    "timeout_exceeded_provider",
			Message: "timeoutMs exceeds provider timeout",
		}
	}

	provider, ok := s.providers[model.Provider]
	if !ok {
		return result, ModelGatewayValidationError{
			Code:    "provider_not_ready",
			Message: "provider is not configured",
		}
	}

	result.model = model
	result.provider = provider
	result.policyDecision = policyDecisionAllow
	result.record.ModelID = model.ID
	result.record.PolicyDecision = result.policyDecision
	return result, nil
}

func sanitizeLedgerParameters(parameters map[string]any) map[string]any {
	out := make(map[string]any)
	for key, value := range parameters {
		switch key {
		case "temperature", "max_tokens", "attemptNumber", "repairBudgetRemaining":
			if number, ok := ledgerNumber(value); ok {
				out[key] = number
			}
		case "runId", "promptTemplateId", "failureCategory":
			if text, ok := value.(string); ok && isSafeLedgerString(text) {
				out[key] = text
			}
		case "sourceRef", "semanticIrRef", "baselineJavaRef", "oracleRef", "previousJavaCandidateRef", "buildTestResultRef":
			if ref, ok := sanitizeLedgerReference(value); ok {
				out[key] = ref
			}
		case "previousRepairDecisionRefs":
			if refs, ok := sanitizeLedgerReferenceList(value); ok {
				out[key] = refs
			}
		}
	}
	return out
}

func ledgerNumber(value any) (any, bool) {
	switch typed := value.(type) {
	case int:
		return typed, true
	case int64:
		return typed, true
	case float64:
		return typed, true
	case float32:
		return typed, true
	default:
		return nil, false
	}
}

func sanitizeLedgerReference(value any) (map[string]any, bool) {
	raw, ok := value.(map[string]any)
	if !ok {
		return nil, false
	}
	ref := make(map[string]any)
	if uri, ok := raw["uri"].(string); ok && isSafeLedgerURI(uri) {
		ref["uri"] = uri
	}
	if sha, ok := raw["sha256"].(string); ok && len(sha) == 64 {
		if _, err := hex.DecodeString(sha); err == nil {
			ref["sha256"] = sha
		}
	}
	if byteSize, ok := ledgerNumber(raw["byteSize"]); ok {
		ref["byteSize"] = byteSize
	}
	if kind, ok := raw["kind"].(string); ok && isSafeLedgerString(kind) {
		ref["kind"] = kind
	}
	return ref, len(ref) > 0
}

func sanitizeLedgerReferenceList(value any) ([]map[string]any, bool) {
	raw, ok := value.([]any)
	if !ok {
		return nil, false
	}
	refs := make([]map[string]any, 0, len(raw))
	for _, item := range raw {
		if ref, ok := sanitizeLedgerReference(item); ok {
			refs = append(refs, ref)
		}
	}
	return refs, len(refs) > 0
}

func isSafeLedgerURI(value string) bool {
	value = strings.TrimSpace(value)
	return strings.HasPrefix(value, "urn:") && isSafeLedgerString(value)
}

func isSafeLedgerString(value string) bool {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" || len(trimmed) > 256 {
		return false
	}
	if strings.ContainsAny(trimmed, "\r\n\t") || strings.Contains(trimmed, "://") {
		return false
	}
	lower := strings.ToLower(trimmed)
	for _, marker := range []string{"api_key", "apikey", "authorization", "bearer ", "secret", "token", "password", "sk-"} {
		if strings.Contains(lower, marker) {
			return false
		}
	}
	return true
}

func (s *ModelGatewayService) activeModels() []ModelMetadata {
	active := make([]ModelMetadata, 0, len(s.registry.Models))
	now := s.now()
	for _, model := range s.registry.Models {
		if model.IsActive(now) {
			active = append(active, model)
		}
	}
	return active
}

func (s *ModelGatewayService) appendLedgerRecord(record ModelInvocationLedgerV0) error {
	if !s.invocationLedgerEnabled {
		return nil
	}
	if s.ledger == nil {
		return nil
	}
	return s.ledger.Append(record)
}

func (s *ModelGatewayService) emitEvent(event EventEnvelopeV0) {
	if !s.harnessEventEmissionEnabled {
		return
	}
	if s.events == nil {
		return
	}
	if err := event.Validate(); err != nil {
		log.Printf("event validation failed: %v", err)
		return
	}
	if err := s.events.Emit(event); err != nil {
		log.Printf("event emission failed: %v", err)
	}
}

func (s *ModelGatewayService) isModelDeploymentAllowed(modelID string) bool {
	if len(s.allowedModelDeployments) == 0 {
		return s.allowlist.IsModelAllowed(modelID)
	}
	return stringInSlice(modelID, s.allowedModelDeployments)
}

func statusForValidationErr(err error) int {
	var typedErr ModelGatewayValidationError
	if errors.As(err, &typedErr) {
		switch typedErr.Code {
		case "forbidden_model", "forbidden_data_class", "forbidden_role", "disallowed_model_endpoint", "inactive_model", "timeout_exceeded_provider", "timeout_exceeded_model_default":
			return http.StatusForbidden
		case "provider_not_ready":
			return http.StatusServiceUnavailable
		}
	}
	return http.StatusBadRequest
}

func errorCodeForValidationErr(code string) string {
	if isPolicyValidationCode(code) {
		return errorCodePolicyDenied
	}
	if code == "provider_not_ready" {
		return errorCodeProviderUnavailable
	}
	return errorCodeMalformedRequest
}

// isPolicyValidationCode reports whether the validation code represents a
// policy denial (as opposed to a malformed request). Policy denials surface
// the model_policy_denied error code so the Orchestrator can map them to
// FAILURE_MODEL_POLICY_DENIED.
func isPolicyValidationCode(code string) bool {
	switch code {
	case "forbidden_model", "forbidden_data_class", "forbidden_role",
		"disallowed_model_endpoint", "inactive_model",
		"timeout_exceeded_provider", "timeout_exceeded_model_default",
		"unsupported_structured_output":
		return true
	}
	return false
}

func newInvocationID(now time.Time) string {
	return fmt.Sprintf("mg-%s-%s", now.Format("20060102150405"), strconv.FormatUint(invocationCounter.Add(1), 10))
}

func defaultActor(actor string) string {
	trimmed := strings.TrimSpace(actor)
	if trimmed == "" {
		return actorModelGateway
	}
	return trimmed
}

func decodeJSON(r *http.Request, target any) error {
	if !strings.Contains(r.Header.Get("content-type"), "application/json") {
		return fmt.Errorf("content-type must be application/json")
	}
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	return decoder.Decode(target)
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	body, err := json.Marshal(value)
	if err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(`{"error":"response serialization failed"}`))
		return
	}
	w.Header().Set("content-type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write(body)
}

func resolveGatewayConfigFromEnv() (gatewayConfig, error) {
	cfg := gatewayConfig{
		registryPath:    os.Getenv("MODEL_GATEWAY_MODEL_REGISTRY_PATH"),
		allowlistPath:   os.Getenv("MODEL_GATEWAY_ALLOWLIST_PATH"),
		ledgerPath:      os.Getenv("MODEL_GATEWAY_LEDGER_PATH"),
		eventLogPath:    os.Getenv("MODEL_GATEWAY_EVENT_LOG_PATH"),
		harnessEventURL: os.Getenv("HARNESS_EVENT_URL"),
	}

	cfg.modelProvider = firstNonEmptyEnv("C2C_MODEL_PROVIDER", "MODEL_GATEWAY_PROVIDER")
	if cfg.modelProvider != "" {
		providerMode, err := normalizeModelGatewayProvider(cfg.modelProvider)
		if err != nil {
			return cfg, err
		}
		cfg.modelProvider = providerMode
	}

	cfg.defaultModelDeployment = firstNonEmptyEnv("C2C_MODEL_DEFAULT_DEPLOYMENT")
	cfg.fallbackModelDeployments = parseCommaSeparatedIDs(firstNonEmptyEnv("C2C_MODEL_FALLBACK_DEPLOYMENTS"))
	cfg.allowedModelDeployments = parseCommaSeparatedIDs(firstNonEmptyEnv("C2C_MODEL_ALLOWED_DEPLOYMENTS"))
	cfg.dataPolicy = firstNonEmptyEnv("C2C_MODEL_DATA_POLICY")
	cfg.policyID = firstNonEmptyEnv("C2C_MODEL_POLICY_ID", "MODEL_GATEWAY_POLICY_ID")
	cfg.controlToken = firstNonEmptyEnv("MODEL_GATEWAY_CONTROL_TOKEN", "C2C_INTERNAL_CONTROL_TOKEN")
	cfg.harnessEventToken = firstNonEmptyEnv("HARNESS_EVENT_TOKEN", "HARNESS_CONTROL_PLANE_TOKEN", "C2C_LOCAL_HARNESS_TOKEN")

	invocationLedgerEnabled, hasInvocationLedgerFlag, err := parseBoolEnv("C2C_MODEL_INVOCATION_LEDGER_ENABLED", "MODEL_GATEWAY_INVOCATION_LEDGER_ENABLED")
	if err != nil {
		return cfg, err
	}
	if hasInvocationLedgerFlag {
		cfg.invocationLedgerEnabled = invocationLedgerEnabled
	}
	harnessEventEmissionEnabled, hasHarnessEventEmissionFlag, err := parseBoolEnv("C2C_HARNESS_EVENT_EMISSION_ENABLED", "MODEL_GATEWAY_HARNESS_EVENT_EMISSION_ENABLED")
	if err != nil {
		return cfg, err
	}
	if hasHarnessEventEmissionFlag {
		cfg.harnessEventEmissionEnabled = harnessEventEmissionEnabled
	}

	cfg.azureFoundryEndpoint = firstNonEmptyEnv("AZURE_FOUNDRY_ENDPOINT")
	cfg.azureFoundryAPIKey = firstNonEmptyEnv("AZURE_FOUNDRY_API_KEY")
	cfg.azureFoundryAPIKeyRef = firstNonEmptyEnv("AZURE_FOUNDRY_API_KEY_REF")
	cfg.azureFoundryAPIResource = firstNonEmptyEnv("AZURE_FOUNDRY_API_RESOURCE")
	cfg.azureFoundryAPIResourceGroup = firstNonEmptyEnv("AZURE_FOUNDRY_API_RESOURCE_GROUP")
	cfg.azureFoundryAPIVersion = firstNonEmptyEnv("AZURE_FOUNDRY_API_VERSION")

	if cfg.azureFoundryEndpoint == "" {
		cfg.azureFoundryEndpoint = firstNonEmptyEnv("MODEL_GATEWAY_FOUNDRY_ENDPOINT")
	}
	if cfg.azureFoundryAPIKeyRef == "" {
		cfg.azureFoundryAPIKeyRef = firstNonEmptyEnv("MODEL_GATEWAY_FOUNDRY_API_KEY_REF")
	}

	if cfg.registryPath == "" {
		cfg.registryPath = defaultModelRegistryPath
	}
	if cfg.allowlistPath == "" {
		cfg.allowlistPath = defaultAllowlistPath
	}
	if cfg.ledgerPath == "" {
		cfg.ledgerPath = defaultLedgerPath
	}
	if cfg.eventLogPath == "" {
		cfg.eventLogPath = defaultEventLogPath
	}
	if !hasInvocationLedgerFlag {
		cfg.invocationLedgerEnabled = true
	}
	if !hasHarnessEventEmissionFlag {
		cfg.harnessEventEmissionEnabled = true
	}

	return cfg, nil
}

func validateDeploymentPolicyActive(registry ModelRegistry, now func() time.Time, modelIDs []string) error {
	for _, modelID := range modelIDs {
		model, ok := registry.Get(modelID)
		if !ok {
			return fmt.Errorf("model deployment %q not found", modelID)
		}
		if !model.IsActive(now()) {
			return fmt.Errorf("model deployment %q is not active", modelID)
		}
	}
	return nil
}

func stringInSlice(value string, values []string) bool {
	for _, candidate := range values {
		if candidate == value {
			return true
		}
	}
	return false
}

func parseCommaSeparatedIDs(raw string) []string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil
	}
	parts := strings.Split(raw, ",")
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		value := strings.TrimSpace(part)
		if value != "" {
			out = append(out, value)
		}
	}
	return out
}

func dedupeAndTrimNonEmptyStringSlice(values []string) []string {
	seen := map[string]struct{}{}
	out := make([]string, 0, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" {
			continue
		}
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		out = append(out, value)
	}
	return out
}

func firstNonEmptyEnv(keys ...string) string {
	for _, key := range keys {
		if value := strings.TrimSpace(os.Getenv(key)); value != "" {
			return value
		}
	}
	return ""
}

func normalizeModelGatewayProvider(value string) (string, error) {
	normalizedProvider := strings.ToLower(strings.TrimSpace(value))
	normalizedProvider = strings.ReplaceAll(normalizedProvider, "-", "_")
	switch normalizedProvider {
	case "azure_foundry", "foundry_development", "foundry", "azurefoundry", "foundrydevelopment":
		return ModelProviderFoundryDevelopment, nil
	case "customer_internal_mock", "customerinternalmock", "customer_internal", "customer-internal", "customer", "mock":
		return ModelProviderCustomerInternalMock, nil
	default:
		return "", fmt.Errorf("unsupported C2C_MODEL_PROVIDER value: %s", value)
	}
}

func parseBoolEnv(keys ...string) (bool, bool, error) {
	for _, key := range keys {
		value, ok := os.LookupEnv(key)
		if !ok {
			continue
		}
		value = strings.TrimSpace(value)
		if value == "" {
			continue
		}
		parsed, err := strconv.ParseBool(value)
		if err != nil {
			return false, false, fmt.Errorf("%s must be true or false", key)
		}
		return parsed, true, nil
	}
	return false, false, nil
}
