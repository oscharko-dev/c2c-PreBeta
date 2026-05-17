package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
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
	Endpoint   string
	ApiKeyRef  string
	ApiKey     string
	APIVersion string
	TimeoutMs  int64
	Client     *http.Client
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
	apiVersion := strings.TrimSpace(cfg.APIVersion)
	if apiVersion == "" {
		apiVersion = "2024-05-01-preview"
	}
	return &FoundryAdapter{
		Endpoint:   strings.TrimRight(cfg.Endpoint, "/"),
		ApiKeyRef:  cfg.ApiKeyRef,
		ApiKey:     cfg.ApiKey,
		APIVersion: apiVersion,
		TimeoutMs:  cfg.TimeoutMs,
		Client:     &http.Client{},
	}, nil
}

func (f *FoundryAdapter) Name() string {
	return ModelProviderFoundryDevelopment
}

func (f *FoundryAdapter) Invoke(ctx context.Context, request ModelInvocationRequest, model ModelMetadata) (ModelInvocationOutput, error) {
	ctx, cancel := context.WithTimeout(ctx, time.Duration(f.TimeoutMs)*time.Millisecond)
	defer cancel()

	systemMessage := "Provide concise, audit-safe migration guidance. Do not include secrets or raw source payloads."
	if request.StructuredOutput {
		systemMessage += " Return only a single JSON object matching the requested output contract. Do not wrap it in Markdown."
	}
	payload := map[string]any{
		"messages": []map[string]string{
			{
				"role":    "system",
				"content": systemMessage,
			},
			{
				"role":    "user",
				"content": request.Prompt,
			},
		},
	}
	if temperature, ok := request.Parameters["temperature"]; ok {
		payload["temperature"] = temperature
	}
	if maxTokens, ok := request.Parameters["max_tokens"]; ok {
		payload["max_tokens"] = maxTokens
	}
	if request.StructuredOutput {
		payload["response_format"] = map[string]any{"type": "json_object"}
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		return ModelInvocationOutput{}, fmt.Errorf("marshal foundry request: %w", err)
	}
	invokeURL, err := f.invokeURL(model)
	if err != nil {
		return ModelInvocationOutput{}, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, invokeURL, bytes.NewReader(raw))
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
		// Preserve context.DeadlineExceeded through errors.Is so the gateway
		// can surface model_provider_timeout instead of a generic provider
		// error. The Go http client wraps DeadlineExceeded inside *url.Error
		// but errors.Is unwraps correctly.
		return ModelInvocationOutput{}, fmt.Errorf("call foundry endpoint failed: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
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
	output := map[string]any{
		"provider":   f.Name(),
		"modelId":    model.ID,
		"deployment": model.DeploymentName,
	}
	if text := firstChatCompletionText(parsed); text != "" {
		if request.StructuredOutput {
			structured, err := decodeStructuredCompletionText(text)
			if err != nil {
				return ModelInvocationOutput{}, err
			}
			output = structured
		} else {
			output["text"] = text
		}
	}
	metadata := map[string]any{"provider": f.Name()}
	if usage := extractChatCompletionUsage(parsed); len(usage) > 0 {
		metadata["usage"] = usage
	}
	return ModelInvocationOutput{Data: output, Status: status, Metadata: metadata}, nil
}

func decodeStructuredCompletionText(text string) (map[string]any, error) {
	clean := strings.TrimSpace(text)
	if clean == "" {
		return nil, fmt.Errorf("foundry structured response was empty")
	}
	if strings.HasPrefix(clean, "```") {
		lines := strings.Split(clean, "\n")
		if len(lines) < 2 || !strings.HasPrefix(strings.TrimSpace(lines[len(lines)-1]), "```") {
			return nil, fmt.Errorf("foundry structured response contained an unterminated markdown fence")
		}
		clean = strings.TrimSpace(strings.Join(lines[1:len(lines)-1], "\n"))
	}

	var output map[string]any
	decoder := json.NewDecoder(strings.NewReader(clean))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&output); err != nil {
		return nil, fmt.Errorf("decode foundry structured response: %w", err)
	}
	if len(output) == 0 {
		return nil, fmt.Errorf("foundry structured response was an empty object")
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		return nil, fmt.Errorf("foundry structured response contained multiple JSON values")
	}
	return output, nil
}

// extractChatCompletionUsage normalises the optional `usage` object returned by
// the OpenAI-compatible chat-completions endpoint. The gateway records token
// counts on the Model Invocation Ledger when they are present, never persists
// raw prompt or completion content here.
func extractChatCompletionUsage(payload map[string]any) map[string]any {
	rawUsage, ok := payload["usage"].(map[string]any)
	if !ok || len(rawUsage) == 0 {
		return nil
	}
	out := make(map[string]any, len(rawUsage))
	for _, key := range []string{"prompt_tokens", "completion_tokens", "total_tokens"} {
		if value, present := rawUsage[key]; present {
			out[key] = value
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

func (f *FoundryAdapter) invokeURL(model ModelMetadata) (string, error) {
	parsed, err := url.Parse(f.Endpoint)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return "", fmt.Errorf("foundry endpoint must be a valid absolute URL")
	}
	path := strings.TrimRight(parsed.Path, "/")
	deployment := url.PathEscape(model.DeploymentName)
	if deployment == "" {
		return "", fmt.Errorf("foundry deployment name required")
	}
	if strings.Contains(path, "/openai/deployments") {
		parsed.Path = path + "/" + deployment + "/chat/completions"
	} else {
		parsed.Path = path + "/openai/deployments/" + deployment + "/chat/completions"
	}
	query := parsed.Query()
	if strings.TrimSpace(f.APIVersion) != "" {
		query.Set("api-version", f.APIVersion)
	}
	parsed.RawQuery = query.Encode()
	return parsed.String(), nil
}

func firstChatCompletionText(payload map[string]any) string {
	choices, ok := payload["choices"].([]any)
	if !ok || len(choices) == 0 {
		return ""
	}
	first, ok := choices[0].(map[string]any)
	if !ok {
		return ""
	}
	message, ok := first["message"].(map[string]any)
	if !ok {
		return ""
	}
	content, ok := message["content"].(string)
	if !ok {
		return ""
	}
	return content
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
