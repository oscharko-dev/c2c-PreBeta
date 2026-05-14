package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestNewFoundryAdapter_ConfigurationValidation(t *testing.T) {
	tests := []struct {
		name    string
		cfg     ProviderFoundryConfig
		wantErr bool
	}{
		{
			name:    "missing endpoint",
			cfg:     ProviderFoundryConfig{ApiKeyRef: "ref", TimeoutMs: 1000},
			wantErr: true,
		},
		{
			name:    "missing api key reference",
			cfg:     ProviderFoundryConfig{Endpoint: "https://foundry.example", TimeoutMs: 1000},
			wantErr: true,
		},
		{
			name:    "valid config with api-key",
			cfg:     ProviderFoundryConfig{Endpoint: "https://foundry.example", ApiKey: "abc", TimeoutMs: 1000},
			wantErr: false,
		},
		{
			name:    "invalid timeout",
			cfg:     ProviderFoundryConfig{Endpoint: "https://foundry.example", ApiKeyRef: "ref", TimeoutMs: 0},
			wantErr: true,
		},
		{
			name:    "valid config",
			cfg:     ProviderFoundryConfig{Endpoint: "https://foundry.example", ApiKeyRef: "ref", TimeoutMs: 1000},
			wantErr: false,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			_, err := NewFoundryAdapter(tc.cfg)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("expected error")
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
		})
	}
}

func TestFoundryAdapter_Invoke(t *testing.T) {
	var received []byte
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Fatalf("expected POST, got %s", r.Method)
		}
		if r.URL.Path != "/openai/deployments/deployment-1/chat/completions" {
			t.Fatalf("expected Azure chat completions path, got %s", r.URL.Path)
		}
		if got := r.URL.Query().Get("api-version"); got != "2024-05-01-preview" {
			t.Fatalf("expected api-version query, got %s", got)
		}
		if got := r.Header.Get("x-api-key-ref"); got != "api-key-ref-123" {
			t.Fatalf("expected api-key-ref-123 header, got %s", got)
		}
		body := make(map[string]any, 8)
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatalf("decode request body: %v", err)
		}
		var err error
		received, err = json.Marshal(body)
		if err != nil {
			t.Fatalf("marshal for assertion: %v", err)
		}
		w.Header().Set("content-type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"choices": []map[string]any{
				{"message": map[string]string{"content": "ok"}},
			},
		})
	}))
	defer server.Close()

	adapter, err := NewFoundryAdapter(ProviderFoundryConfig{
		Endpoint:  server.URL,
		ApiKeyRef: "api-key-ref-123",
		TimeoutMs: 2000,
	})
	if err != nil {
		t.Fatalf("unexpected adapter error: %v", err)
	}

	output, err := adapter.Invoke(context.Background(), ModelInvocationRequest{
		ModelID:                "m-1",
		Prompt:                 "hello",
		TimeoutMs:              1000,
		PromptTemplateVersion:  "v1",
		StructuredOutput:       true,
		StructuredOutputSchema: map[string]any{"type": "object"},
		Parameters: map[string]any{
			"temperature": 0.2,
		},
	}, ModelMetadata{
		ID:             "m-1",
		DeploymentName: "deployment-1",
		ModelName:      "foundry-gpt",
		Version:        "1",
	})

	if err != nil {
		t.Fatalf("unexpected invoke error: %v", err)
	}
	if output.Status != "ok" {
		t.Fatalf("expected status ok, got %s", output.Status)
	}
	if output.Data["text"] != "ok" {
		t.Fatalf("expected output text")
	}
	if _, ok := output.Metadata["provider"]; !ok {
		t.Fatalf("expected output metadata to include provider")
	}
	if len(received) == 0 {
		t.Fatalf("expected non-empty request body")
	}
}

func TestFoundryAdapter_Invoke_UsesApiKeyWhenProvided(t *testing.T) {
	var seen string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/openai/deployments/dep/chat/completions" {
			t.Fatalf("expected Azure chat completions path, got %s", r.URL.Path)
		}
		if got := r.Header.Get("api-key"); got != "direct-secret" {
			t.Fatalf("expected api-key header, got %s", got)
		}
		if got := r.Header.Get("x-api-key-ref"); got != "" {
			t.Fatalf("unexpected x-api-key-ref header: %s", got)
		}
		seen = r.Header.Get("api-key")
		w.Header().Set("content-type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"status": "ok"})
	}))
	defer server.Close()

	adapter, err := NewFoundryAdapter(ProviderFoundryConfig{
		Endpoint:  server.URL,
		ApiKey:    "direct-secret",
		ApiKeyRef: "should-be-ignored",
		TimeoutMs: 2000,
	})
	if err != nil {
		t.Fatalf("unexpected adapter error: %v", err)
	}

	_, err = adapter.Invoke(context.Background(), ModelInvocationRequest{
		ModelID:               "m-1",
		Prompt:                "hello",
		TimeoutMs:             1000,
		PromptTemplateVersion: "v1",
		StructuredOutput:      false,
		Parameters:            map[string]any{},
	}, ModelMetadata{
		ID:             "m-1",
		DeploymentName: "dep",
		ModelName:      "foundry-gpt",
		Version:        "1",
	})
	if err != nil {
		t.Fatalf("unexpected invoke error: %v", err)
	}
	if seen == "" {
		t.Fatalf("expected api-key header to be sent")
	}
}

func TestNewCustomerInternalMockAdapter_ConfigurationValidation(t *testing.T) {
	_, err := NewCustomerInternalMockAdapter(CustomerInternalConfig{
		BaseURL:   "",
		ApiKeyRef: "k",
		TimeoutMs: 1000,
	})
	if err == nil {
		t.Fatalf("expected error for missing base URL")
	}

	_, err = NewCustomerInternalMockAdapter(CustomerInternalConfig{
		BaseURL:   "https://customer.example",
		ApiKeyRef: "",
		TimeoutMs: 1000,
	})
	if err == nil {
		t.Fatalf("expected error for missing api key reference")
	}
}

func TestCustomerInternalMockAdapter_Invoke(t *testing.T) {
	adapter, err := NewCustomerInternalMockAdapter(CustomerInternalConfig{
		BaseURL:                "https://customer.internal",
		ApiKeyRef:              "k",
		TimeoutMs:              1000,
		RequireStructuredInput: true,
	})
	if err != nil {
		t.Fatalf("unexpected adapter error: %v", err)
	}

	output, err := adapter.Invoke(context.Background(), ModelInvocationRequest{
		Prompt:                 "hello",
		StructuredOutput:       true,
		StructuredOutputSchema: map[string]any{"type": "object"},
		TimeoutMs:              1000,
	}, ModelMetadata{
		ID:                       "cust-1",
		SupportsStructuredOutput: true,
	})

	if err != nil {
		t.Fatalf("unexpected invoke error: %v", err)
	}
	if output.Status != "ok" {
		t.Fatalf("expected status ok, got %s", output.Status)
	}
	if output.Data["provider"] != ModelProviderCustomerInternalMock {
		t.Fatalf("expected provider in payload")
	}

	_, err = adapter.Invoke(context.Background(), ModelInvocationRequest{
		Prompt:           "hello",
		StructuredOutput: true,
		TimeoutMs:        1000,
	}, ModelMetadata{
		ID:                       "cust-1",
		SupportsStructuredOutput: true,
	})
	if err == nil {
		t.Fatalf("expected schema requirement error")
	}
}
