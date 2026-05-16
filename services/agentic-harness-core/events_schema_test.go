package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestEventEnvelopeValidation(t *testing.T) {
	event, err := NewEventReference("urn:input", map[string]string{"x": "input"})
	if err != nil {
		t.Fatalf("build input reference failed: %v", err)
	}
	output, err := NewEventReference("urn:output", map[string]string{"x": "output"})
	if err != nil {
		t.Fatalf("build output reference failed: %v", err)
	}

	envelope := EventEnvelopeV0{
		SchemaVersion:    EventSchemaVersionV0,
		EventID:          "evt-validate-1",
		EventType:        "parser.executed",
		Service:          "w0-parser",
		RunID:            "run-1",
		StepID:           3,
		Actor:            "parser",
		Capability:       "parser-service",
		DataClass:        DataClassParser,
		RedactionProfile: ProfileAgentManaged,
		PolicyDecision:   "policy allow",
		Status:           "ok",
		StateTransition:  "parse->next",
		InputRef:         event,
		OutputRef:        output,
		CreatedAt:        time.Now().UTC(),
	}
	if err := envelope.Validate(); err != nil {
		t.Fatalf("expected valid envelope, got: %v", err)
	}

	invalid := envelope
	invalid.SchemaVersion = "bad"
	if err := invalid.Validate(); err == nil {
		t.Fatalf("expected schemaVersion v0 validation failure")
	}
}

func TestComputeSHA256Hex(t *testing.T) {
	got := ComputeSHA256Hex([]byte("abc"))
	const expected = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
	if got != expected {
		t.Fatalf("unexpected hash result: %s != %s", got, expected)
	}
}

func TestBuildAgentTrajectoryLedger(t *testing.T) {
	events := []EventEnvelopeV0{
		{
			SchemaVersion:    EventSchemaVersionV0,
			EventID:          "evt-2",
			EventType:        eventTypeRunUpdated,
			Service:          "agentic-harness-core",
			RunID:            "run-1",
			StepID:           2,
			Actor:            "orchestrator",
			Capability:       "agentic-harness-core",
			DataClass:        DataClassOther,
			RedactionProfile: ProfileControlledByHarness,
			PolicyDecision:   "policy allow",
			Status:           StatusUpdating,
			StateTransition:  "starting->updating",
			InputRef:         mustRef(t, "urn:harness/1"),
			OutputRef:        mustRef(t, "urn:harness/1"),
			CreatedAt:        time.Now().UTC().Add(10 * time.Second),
		},
		{
			SchemaVersion:    EventSchemaVersionV0,
			EventID:          "evt-1",
			EventType:        eventTypeRunStarted,
			Service:          "agentic-harness-core",
			RunID:            "run-1",
			StepID:           1,
			Actor:            "orchestrator",
			Capability:       "agentic-harness-core",
			DataClass:        DataClassOther,
			RedactionProfile: ProfileControlledByHarness,
			PolicyDecision:   "policy allow",
			Status:           StatusStarting,
			StateTransition:  "created",
			InputRef:         mustRef(t, "urn:harness/2"),
			OutputRef:        mustRef(t, "urn:harness/2"),
			CreatedAt:        time.Now().UTC(),
		},
	}
	ledger, err := BuildAgentTrajectoryLedger("run-1", events)
	if err != nil {
		t.Fatalf("expected ledger build to succeed, got %v", err)
	}
	if len(ledger.Steps) != 2 {
		t.Fatalf("expected 2 steps, got %d", len(ledger.Steps))
	}
	if ledger.Steps[0].StepID != 1 || ledger.Steps[1].StepID != 2 {
		t.Fatalf("expected sorted steps [1,2], got [%d,%d]", ledger.Steps[0].StepID, ledger.Steps[1].StepID)
	}
}

func TestBuildAgentTrajectoryLedgerRenumbersDuplicateEventStepIDs(t *testing.T) {
	now := time.Now().UTC()
	events := []EventEnvelopeV0{
		{
			SchemaVersion:    EventSchemaVersionV0,
			EventID:          "evt-parse",
			EventType:        "parser.executed",
			Service:          "cobol-parser-service",
			RunID:            "run-dup",
			StepID:           1,
			Actor:            "parser",
			Capability:       "cobol.parse",
			DataClass:        DataClassParser,
			RedactionProfile: ProfileAgentManaged,
			PolicyDecision:   "policy allow",
			Status:           "ok",
			StateTransition:  "parse->ready",
			InputRef:         mustRef(t, "urn:input/parse"),
			OutputRef:        mustRef(t, "urn:output/parse"),
			CreatedAt:        now,
		},
		{
			SchemaVersion:    EventSchemaVersionV0,
			EventID:          "evt-ir",
			EventType:        "semantic-ir.generated",
			Service:          "semantic-ir-service",
			RunID:            "run-dup",
			StepID:           1,
			Actor:            "semantic-ir",
			Capability:       "semantic-ir.generate",
			DataClass:        DataClassParser,
			RedactionProfile: ProfileAgentManaged,
			PolicyDecision:   "policy allow",
			Status:           "ok",
			StateTransition:  "parse->ir",
			InputRef:         mustRef(t, "urn:input/ir"),
			OutputRef:        mustRef(t, "urn:output/ir"),
			CreatedAt:        now.Add(time.Second),
		},
		{
			SchemaVersion:    EventSchemaVersionV0,
			EventID:          "evt-generate",
			EventType:        "target-java.generated",
			Service:          "target-java-generation-service",
			RunID:            "run-dup",
			StepID:           1,
			Actor:            "generator",
			Capability:       "target.java.generate",
			DataClass:        DataClassGenerator,
			RedactionProfile: ProfileAgentManaged,
			PolicyDecision:   "policy allow",
			Status:           "ok",
			StateTransition:  "ir->java",
			InputRef:         mustRef(t, "urn:input/generate"),
			OutputRef:        mustRef(t, "urn:output/generate"),
			CreatedAt:        now.Add(2 * time.Second),
		},
	}

	ledger, err := BuildAgentTrajectoryLedger("run-dup", events)
	if err != nil {
		t.Fatalf("expected ledger build to tolerate duplicate event step IDs, got %v", err)
	}
	if len(ledger.Steps) != 3 {
		t.Fatalf("expected 3 steps, got %d", len(ledger.Steps))
	}
	for i, step := range ledger.Steps {
		expected := int64(i + 1)
		if step.StepID != expected {
			t.Fatalf("expected ledger step %d to be renumbered to %d, got %d", i, expected, step.StepID)
		}
	}
}

func TestEventsIngestionAndLedgerRoute(t *testing.T) {
	tmp := t.TempDir()
	sink := filepath.Join(tmp, "events.jsonl")
	t.Setenv("HARNESS_EVENT_LOG_PATH", sink)

	service := newTestHarnessService(t)
	server := httptest.NewServer(service.Routes())
	defer server.Close()

	create := RunCreateRequest{
		WorkflowID: "w0-migration-run",
		Requester:  "orchestrator",
	}
	res, err := authPostJSON(server.URL+"/v0/runs", mustJSON(create), "orchestrator-service", "orchestrator")
	if err != nil {
		t.Fatalf("create run failed: %v", err)
	}
	defer func() { _ = res.Body.Close() }()
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("expected run create 201, got %d", res.StatusCode)
	}

	var run RunState
	if err := json.NewDecoder(res.Body).Decode(&run); err != nil {
		t.Fatalf("decode run failed: %v", err)
	}

	ref := EventReference{
		URI:      "urn:test/input",
		SHA256:   "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
		ByteSize: 0,
	}
	payload := map[string]any{
		"artifact": "unit-test",
	}
	envelope := EventEnvelopeV0{
		SchemaVersion:    EventSchemaVersionV0,
		EventID:          "evt-ingest-1",
		EventType:        "model.invoke",
		Service:          "w0-model-gateway",
		RunID:            run.RunID,
		Actor:            "w0-model-gateway",
		Capability:       "model-gateway",
		DataClass:        DataClassModelGateway,
		RedactionProfile: ProfileAgentManaged,
		PolicyDecision:   "policy allow",
		Status:           "ok",
		StateTransition:  "run->modeling",
		InputRef:         ref,
		OutputRef:        ref,
		Payload:          payload,
	}
	raw, _ := json.Marshal(envelope)
	res, err = authPostJSON(server.URL+"/v0/events", raw, "w0-model-gateway", "service")
	if err != nil {
		t.Fatalf("emit event failed: %v", err)
	}
	defer func() { _ = res.Body.Close() }()
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("expected event ingest 201, got %d", res.StatusCode)
	}
	if _, err := os.Stat(sink); err != nil {
		t.Fatalf("expected persistent sink at %s, got %v", sink, err)
	}
}

func TestEventsRejectActorMismatch(t *testing.T) {
	service := newTestHarnessService(t)
	server := httptest.NewServer(service.Routes())
	defer server.Close()

	res, err := authPostJSON(server.URL+"/v0/runs", mustJSON(RunCreateRequest{
		WorkflowID: "w0-auth-run",
		Requester:  "orchestrator",
	}), "orchestrator-service", "orchestrator")
	if err != nil {
		t.Fatalf("create run failed: %v", err)
	}
	defer func() { _ = res.Body.Close() }()
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("expected run create 201, got %d", res.StatusCode)
	}

	var run RunState
	if err := json.NewDecoder(res.Body).Decode(&run); err != nil {
		t.Fatalf("decode run failed: %v", err)
	}

	ref := EventReference{
		URI:      "urn:test/input",
		SHA256:   "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
		ByteSize: 0,
	}
	envelope := EventEnvelopeV0{
		SchemaVersion:    EventSchemaVersionV0,
		EventID:          "evt-forged-1",
		EventType:        "parser.executed",
		Service:          "cobol-parser-service",
		RunID:            run.RunID,
		Actor:            "cobol-parser-service",
		Capability:       "cobol.parse",
		DataClass:        DataClassParser,
		RedactionProfile: ProfileAgentManaged,
		PolicyDecision:   "policy allow",
		Status:           "ok",
		StateTransition:  "run->parse",
		InputRef:         ref,
		OutputRef:        ref,
	}
	raw, _ := json.Marshal(envelope)
	res, err = authPostJSON(server.URL+"/v0/events", raw, "target-java-generation-service", "service")
	if err != nil {
		t.Fatalf("emit forged event failed: %v", err)
	}
	defer func() { _ = res.Body.Close() }()
	if res.StatusCode != http.StatusForbidden {
		t.Fatalf("expected forged actor mismatch to return 403, got %d", res.StatusCode)
	}
}

func mustRef(t *testing.T, uri string) EventReference {
	t.Helper()
	ref, err := NewEventReference(uri, map[string]string{"sample": "value"})
	if err != nil {
		t.Fatalf("create test reference failed: %v", err)
	}
	return ref
}
