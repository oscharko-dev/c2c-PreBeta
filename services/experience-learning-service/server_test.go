package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestHarnessEventsHandler_PostAcceptsRawHarnessStatuses(t *testing.T) {
	cfgNow := time.Date(2026, 5, 14, 12, 0, 0, 0, time.UTC)
	service := NewExperienceLearningService(
		experienceLearningConfig{autoAnalyzeOnIngest: true},
		NewInMemoryHarnessEventStore(),
		NewInMemoryTrajectoryLedgerStore(),
		NewInMemoryExperienceEventStore(),
		DefaultLearningPolicy(),
		func() time.Time { return cfgNow },
	)

	runID := "run-raw-status-post"
	starting := testHarnessEvent(t, runID, "starting")
	starting.EventID = "evt-starting-post"
	starting.StepID = 1
	starting.EventType = "run.started"
	starting.StateTransition = "created"
	updating := testHarnessEvent(t, runID, "updating")
	updating.EventID = "evt-updating-post"
	updating.StepID = 2
	updating.EventType = "run.updated"
	updating.StateTransition = "starting->updating"
	divergence := testHarnessEvent(t, runID, "output-divergence")
	divergence.EventID = "evt-output-divergence-post"
	divergence.StepID = 3
	divergence.EventType = "build-test.output-divergence"
	divergence.StateTransition = "build-test->output-divergence"
	compileFailed := testHarnessEvent(t, runID, "compile-failed")
	compileFailed.EventID = "evt-compile-failed-post"
	compileFailed.StepID = 4
	compileFailed.EventType = "build-test.compile-failed"
	compileFailed.StateTransition = "build-test->compile-failed"
	runFailed := testHarnessEvent(t, runID, "run-failed")
	runFailed.EventID = "evt-run-failed-post"
	runFailed.StepID = 5
	runFailed.EventType = "build-test.run-failed"
	runFailed.StateTransition = "build-test->run-failed"
	producerCustom := testHarnessEvent(t, runID, "producer-custom-status")
	producerCustom.EventID = "evt-producer-custom-post"
	producerCustom.StepID = 6
	producerCustom.EventType = "producer.custom-status"
	producerCustom.StateTransition = "producer->custom-status"

	body, err := json.Marshal([]EventEnvelopeV0{starting, updating, divergence, compileFailed, runFailed, producerCustom})
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "/v0/harness-events", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	res := httptest.NewRecorder()

	service.Routes().ServeHTTP(res, req)
	if res.Code != http.StatusCreated {
		t.Fatalf("expected HTTP 201, got %d with body %s", res.Code, res.Body.String())
	}

	stored, err := service.harnessEvents.ByRun(runID)
	if err != nil {
		t.Fatal(err)
	}
	if len(stored) != 6 {
		t.Fatalf("expected 6 stored harness events, got %d", len(stored))
	}
	expectedStatuses := []string{"starting", "updating", "output-divergence", "compile-failed", "run-failed", "producer-custom-status"}
	for i, expected := range expectedStatuses {
		if stored[i].Status != expected {
			t.Fatalf("expected raw status %q at index %d, got %q", expected, i, stored[i].Status)
		}
	}

	events, err := service.experienceEvents.ByRun(runID)
	if err != nil {
		t.Fatal(err)
	}
	hasFailurePattern := false
	hasCompilePattern := false
	for _, event := range events {
		if event.Pattern == patternTestFailure {
			hasFailurePattern = true
			if event.Status != statusObserved {
				t.Fatalf("expected compatible experience event status %q, got %q", statusObserved, event.Status)
			}
		}
		if event.Pattern == patternCompileFailure {
			hasCompilePattern = true
		}
	}
	if !hasFailurePattern {
		t.Fatalf("expected %s experience event from raw failure statuses", patternTestFailure)
	}
	if !hasCompilePattern {
		t.Fatalf("expected %s experience event from raw compile-failed status", patternCompileFailure)
	}
}
