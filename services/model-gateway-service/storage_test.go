package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestRemoteHarnessEventSinkSendsHarnessAuthHeaders(t *testing.T) {
	var received EventEnvelopeV0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != "Bearer harness-token" {
			t.Fatalf("expected bearer harness token, got %q", got)
		}
		if got := r.Header.Get("X-Harness-Actor"); got != eventServiceName {
			t.Fatalf("expected model gateway actor, got %q", got)
		}
		if got := r.Header.Get("X-Harness-Role"); got != "service" {
			t.Fatalf("expected model gateway service role, got %q", got)
		}
		if err := json.NewDecoder(r.Body).Decode(&received); err != nil {
			t.Fatalf("decode event: %v", err)
		}
		w.WriteHeader(http.StatusAccepted)
	}))
	defer server.Close()

	sink, err := NewRemoteHarnessEventSink(server.URL, "harness-token")
	if err != nil {
		t.Fatalf("new remote sink: %v", err)
	}
	err = sink.Emit(EventEnvelopeV0{
		SchemaVersion:    gatewayEventSchemaVersion,
		EventID:          "evt-1",
		EventType:        "model-gateway.invocation.completed",
		Service:          eventServiceName,
		RunID:            "run-1",
		StepID:           1,
		Actor:            "scripts/foundry-smoke.sh",
		Capability:       "model-gateway",
		DataClass:        DataClassModelGateway,
		RedactionProfile: eventProfileControlledByHarness,
		PolicyDecision:   policyDecisionAllow,
		Status:           "completed",
		StateTransition:  "model.invocation.completed",
		InputRef:         DataReference{URI: "urn:test/input", SHA256: strings.Repeat("a", 64), ByteSize: 1},
		OutputRef:        DataReference{URI: "urn:test/output", SHA256: strings.Repeat("b", 64), ByteSize: 1},
		CreatedAt:        time.Date(2026, 5, 17, 9, 0, 0, 0, time.UTC),
	})
	if err != nil {
		t.Fatalf("emit remote event: %v", err)
	}
	if received.EventID != "evt-1" {
		t.Fatalf("expected event body to be forwarded")
	}
	if received.Actor != eventServiceName {
		t.Fatalf("expected remote event actor to be authenticated producer, got %q", received.Actor)
	}
	if received.Service != eventServiceName {
		t.Fatalf("expected remote event service to be authenticated producer, got %q", received.Service)
	}
	if got := received.Payload["requestActor"]; got != "scripts/foundry-smoke.sh" {
		t.Fatalf("expected original request actor in payload, got %#v", got)
	}
}
