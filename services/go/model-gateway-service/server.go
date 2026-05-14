package main

import (
	"context"
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
	invocationLedgerEnabled      bool
	harnessEventEmissionEnabled  bool
	azureFoundryEndpoint         string
	azureFoundryAPIKey           string
	azureFoundryAPIKeyRef        string
	azureFoundryAPIResource      string
	azureFoundryAPIResourceGroup string
	azureFoundryAPIVersion       string
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

func NewModelGatewayServiceFromFiles(
	registryPath string,
	allowlistPath string,
	ledgerPath string,
	eventSink EventSink,
) (*ModelGatewayService, error) {
	registry, err := LoadModelRegistry(registryPath)
	if err != nil {
		return nil, err
	}
	allowlist, err := LoadFoundryAllowlist(allowlistPath)
	if err != nil {
		return nil, err
	}
	if ledgerPath == "" {
		ledgerPath = defaultLedgerPath
	}
	ledger, err := NewJSONLModelInvocationLedger(ledgerPath)
	if err != nil {
		return nil, err
	}
	if eventSink == nil {
		return nil, fmt.Errorf("event sink is required")
	}
	return NewModelGatewayService(registry, allowlist, ledger, eventSink, func() time.Time { return time.Now().UTC() })
}

func (s *ModelGatewayService) Routes() *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("/v0/health", s.healthHandler)
	mux.HandleFunc("/v0/models", s.modelsHandler)
	mux.HandleFunc("/v0/models/", s.modelsHandler)
	mux.HandleFunc("/v0/invoke", s.invokeHandler)
	return mux
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
		Configured: map[string]string{
			"mode":                        s.allowlist.Mode,
			"modelProvider":               s.modelProvider,
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
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	if request.Parameters == nil {
		request.Parameters = map[string]any{}
	}

	requestRef, err := ComputeSHA256Ref(request)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request payload"})
		return
	}

	now := s.now()
	start := now
	invocationID := newInvocationID(now)

	validated, err := s.validateInvocation(request, requestRef)
	if err != nil {
		record := validated.record
		record.InvocationID = invocationID
		record.RunID = request.RunID
		if strings.TrimSpace(record.RunID) == "" {
			record.RunID = "unknown-run"
		}
		if strings.TrimSpace(record.ModelID) == "" {
			record.ModelID = "unknown-model"
		}
		if strings.TrimSpace(record.DataClass) == "" {
			record.DataClass = DataClassModelGateway
		}
		record.PolicyDecision = policyDecisionDeny
		record.Status = statusRejected
		record.ErrorClass = "validation"
		record.ErrorMessage = err.Error()
		outputRef, outputRefErr := ComputeSHA256Ref(map[string]any{
			"invocationId": invocationID,
			"error":        err.Error(),
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
			ErrorClass:       "validation",
			LatencyMs:        int64(time.Since(start) / time.Millisecond),
			CreatedAt:        now,
			Payload: map[string]any{
				"invocationId": invocationID,
				"modelId":      request.ModelID,
				"mode":         s.allowlist.Mode,
				"reason":       err.Error(),
			},
			RelatedRecords: []string{fmt.Sprintf("run:%s", request.RunID)},
		})
		writeJSON(w, statusForValidationErr(err), map[string]string{"error": err.Error()})
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
	errorMessage := ""
	if invokeErr != nil {
		errorClass = "provider"
		errorMessage = invokeErr.Error()
	} else {
		outputStatus = normalizeInvocationStatus(output.Status)
		if output.Data != nil {
			outputData = output.Data
		}
		if _, hasStatus := outputData["status"]; !hasStatus {
			outputData["status"] = outputStatus
		}
		outputData["invocationId"] = invocationID
	}

	outputRef, outErr := ComputeSHA256Ref(outputData)
	if outErr != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to compute output hash"})
		return
	}

	record := validated.record
	record.InvocationID = invocationID
	record.RunID = request.RunID
	record.Provider = validated.model.Provider
	record.OutputRef = outputRef
	record.Status = outputStatus
	record.LatencyMs = latencyMs
	record.ErrorClass = errorClass
	record.ErrorMessage = errorMessage
	record.CreatedAt = now

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
			"mode":         s.allowlist.Mode,
		},
		RelatedRecords: []string{fmt.Sprintf("run:%s", request.RunID)},
	})

	if invokeErr != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{
			"error":        invokeErr.Error(),
			"invocationId": invocationID,
		})
		return
	}
	writeJSON(w, http.StatusOK, ModelInvocationResponse{
		InvocationID: invocationID,
		RunID:        request.RunID,
		ModelID:      request.ModelID,
		Status:       outputStatus,
		LatencyMs:    latencyMs,
		Output:       outputData,
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

func (s *ModelGatewayService) validateInvocation(request ModelInvocationRequest, requestRef DataReference) (validatedInvocation, error) {
	result := validatedInvocation{
		request: request,
		record: ModelInvocationLedgerV0{
			SchemaVersion:    gatewayEventSchemaVersion,
			RequestRef:       requestRef,
			DataClass:        request.DataClass,
			PromptTemplate:   request.PromptTemplateVersion,
			Parameters:       request.Parameters,
			StructuredOutput: request.StructuredOutput,
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
		case "forbidden_model", "forbidden_data_class", "disallowed_model_endpoint", "inactive_model", "timeout_exceeded_provider", "timeout_exceeded_model_default":
			return http.StatusForbidden
		}
	}
	return http.StatusBadRequest
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
