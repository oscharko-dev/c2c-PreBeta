package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

type fakeProvider struct {
	t       *testing.T
	output  map[string]any
	err     error
	status  string
	calls   int
	mu      sync.Mutex
}

func (f *fakeProvider) Name() string {
	return ModelProviderFoundryDevelopment
}

func (f *fakeProvider) Invoke(_ context.Context, _ ModelInvocationRequest, _ ModelMetadata) (ModelInvocationOutput, error) {
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
	} else {
		allowlist.AllowedModelIDs = []string{model.ID}
	}
	return &ModelGatewayService{
		registry:         registry,
		allowlist:        allowlist,
		ledger:           ledger,
		events:           events,
		now:              func() time.Time { return now },
		providers:        map[string]ModelProvider{provider.Name(): provider},
		providerTimeouts: map[string]int64{provider.Name(): 30000},
	}
}

func TestModelGatewayService_InvokeSuccessCreatesLedgerAndEvent(t *testing.T) {
	now := time.Date(2026, 5, 14, 12, 0, 0, 0, time.UTC)
	provider := &fakeProvider{
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
		SupportedTemplateVersions:  []string{"v1"},
		SupportsStructuredOutput:   false,
	}, true)

	payload := ModelInvocationRequest{
		RunID:                 "run-1",
		ModelID:               "foundry-gpt",
		Actor:                 "agent-1",
		DataClass:             "model",
		PromptTemplateVersion:  "v1",
		Prompt:                "Hello",
		TimeoutMs:             1000,
		Parameters:            map[string]any{"temperature": 0.2},
	}
	body, _ := json.Marshal(payload)
	req := httptest.NewRequest(http.MethodPost, "/v0/invoke", strings.NewReader(string(body)))
	req.Header.Set("content-type", "application/json")
	rr := httptest.NewRecorder()

	service.invokeHandler(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d", rr.Code)
	}
	ledger := service.ledger.(*inMemoryLedger)
	if len(ledger.entries) != 1 {
		t.Fatalf("expected one ledger entry, got %d", len(ledger.entries))
	}
	if ledger.entries[0].Status != "completed" {
		t.Fatalf("expected ledger status completed, got %s", ledger.entries[0].Status)
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

func TestModelGatewayService_RejectsModelNotInAllowlist(t *testing.T) {
	now := time.Date(2026, 5, 14, 12, 0, 0, 0, time.UTC)
	provider := &fakeProvider{
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
		SupportedTemplateVersions:  []string{"v1"},
		SupportsStructuredOutput:   false,
	}, false)

	payload := ModelInvocationRequest{
		RunID:                 "run-1",
		ModelID:               "foundry-gpt",
		Actor:                 "agent-1",
		DataClass:             "model",
		PromptTemplateVersion:  "v1",
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
}
