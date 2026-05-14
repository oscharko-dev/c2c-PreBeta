package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"
)

var (
	_ = ModelProviderFoundryDevelopment
	_ = ModelProviderCustomerInternalMock
)

type ModelProvider interface {
	Name() string
	Invoke(ctx context.Context, request ModelInvocationRequest, model ModelMetadata) (ModelInvocationOutput, error)
}

type FoundryAdapter struct {
	Endpoint  string
	ApiKeyRef string
	ApiKey    string
	TimeoutMs int64
	Client    *http.Client
}

func NewFoundryAdapter(cfg ProviderFoundryConfig) (*FoundryAdapter, error) {
	if strings.TrimSpace(cfg.Endpoint) == "" {
		return nil, fmt.Errorf("foundry endpoint required")
	}
	hasApiKeyRef := strings.TrimSpace(cfg.ApiKeyRef) != ""
	hasApiKey := strings.TrimSpace(cfg.ApiKey) != ""
	if !hasApiKeyRef && !hasApiKey {
		return nil, fmt.Errorf("foundry api key reference required")
	}
	if cfg.TimeoutMs <= 0 {
		return nil, fmt.Errorf("foundry timeout must be greater than zero")
	}
	reqURL, err := url.Parse(cfg.Endpoint)
	if err != nil || reqURL.Scheme == "" || reqURL.Host == "" {
		return nil, fmt.Errorf("foundry endpoint must be a valid absolute URL")
	}
	return &FoundryAdapter{
		Endpoint:  cfg.Endpoint,
		ApiKeyRef: cfg.ApiKeyRef,
		ApiKey:    cfg.ApiKey,
		TimeoutMs: cfg.TimeoutMs,
		Client:    &http.Client{},
	}, nil
}

func (f *FoundryAdapter) Name() string {
	return ModelProviderFoundryDevelopment
}

func (f *FoundryAdapter) Invoke(ctx context.Context, request ModelInvocationRequest, model ModelMetadata) (ModelInvocationOutput, error) {
	ctx, cancel := context.WithTimeout(ctx, time.Duration(f.TimeoutMs)*time.Millisecond)
	defer cancel()

	payload := map[string]any{
		"modelId": model.ID,
		"deployment": model.DeploymentName,
		"version": model.Version,
		"prompt": request.Prompt,
		"timeoutMs": request.TimeoutMs,
		"templateVersion": request.PromptTemplateVersion,
		"structuredOutput": request.StructuredOutput,
		"parameters": request.Parameters,
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		return ModelInvocationOutput{}, fmt.Errorf("marshal foundry request: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, f.Endpoint+"/v1/invoke", bytes.NewReader(raw))
	if err != nil {
		return ModelInvocationOutput{}, fmt.Errorf("build foundry request: %w", err)
	}
	req.Header.Set("content-type", "application/json")
	if strings.TrimSpace(f.ApiKey) != "" {
		req.Header.Set("api-key", f.ApiKey)
	} else {
		req.Header.Set("x-api-key-ref", f.ApiKeyRef)
	}

	resp, err := f.Client.Do(req)
	if err != nil {
		return ModelInvocationOutput{}, fmt.Errorf("call foundry endpoint failed: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return ModelInvocationOutput{}, fmt.Errorf("foundry endpoint responded with %d", resp.StatusCode)
	}
	var parsed map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&parsed); err != nil {
		return ModelInvocationOutput{}, fmt.Errorf("decode foundry response: %w", err)
	}
	status := "ok"
	if s, ok := parsed["status"].(string); ok && s != "" {
		status = s
	}
	return ModelInvocationOutput{Data: parsed, Status: status, Metadata: map[string]any{"provider": f.Name()}}, nil
}

type CustomerInternalMockAdapter struct {
	BaseURL                string
	ApiKeyRef              string
	TimeoutMs              int64
	RequireStructuredInput bool
}

func NewCustomerInternalMockAdapter(cfg CustomerInternalConfig) (*CustomerInternalMockAdapter, error) {
	if strings.TrimSpace(cfg.BaseURL) == "" {
		return nil, fmt.Errorf("customer mock base URL required")
	}
	if strings.TrimSpace(cfg.ApiKeyRef) == "" {
		return nil, fmt.Errorf("customer mock api key reference required")
	}
	if cfg.TimeoutMs <= 0 {
		return nil, fmt.Errorf("customer mock timeout must be greater than zero")
	}
	parsed, err := url.Parse(cfg.BaseURL)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return nil, fmt.Errorf("customer mock base URL must be a valid absolute URL")
	}
	return &CustomerInternalMockAdapter{
		BaseURL:                strings.TrimRight(cfg.BaseURL, "/"),
		ApiKeyRef:              cfg.ApiKeyRef,
		TimeoutMs:              cfg.TimeoutMs,
		RequireStructuredInput: cfg.RequireStructuredInput,
	}, nil
}

func (c *CustomerInternalMockAdapter) Name() string {
	return ModelProviderCustomerInternalMock
}

func (c *CustomerInternalMockAdapter) Invoke(ctx context.Context, request ModelInvocationRequest, model ModelMetadata) (ModelInvocationOutput, error) {
	if request.StructuredOutput {
		if !model.SupportsStructuredOutput || c.RequireStructuredInput {
			if len(request.StructuredOutputSchema) == 0 {
				return ModelInvocationOutput{}, fmt.Errorf("structured output schema required")
			}
		}
	}
	_ = ctx
	output := map[string]any{
		"provider": c.Name(),
		"modelId":  model.ID,
		"endpoint": c.BaseURL,
		"echo":     request.Prompt,
	}
	if request.StructuredOutput {
		output["structured"] = true
		output["payload"] = map[string]any{"modelOutput": request.Prompt, "templateVersion": request.PromptTemplateVersion}
	}
	return ModelInvocationOutput{
		Data:     output,
		Status:   "ok",
		Metadata: map[string]any{"apiKeyRef": c.ApiKeyRef, "timeoutMs": c.TimeoutMs},
	}, nil
}
