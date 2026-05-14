package main

import (
	"testing"
	"time"
)

func TestPatternAnalyzer_RepeatActionDetection(t *testing.T) {
	cfgNow := time.Date(2026, 5, 14, 8, 0, 0, 0, time.UTC)
	now := func() time.Time { return cfgNow }

	harnessStore := NewInMemoryHarnessEventStore()
	ledgerStore := NewInMemoryTrajectoryLedgerStore()
	experienceStore := NewInMemoryExperienceEventStore()
	policy := DefaultLearningPolicy()

	service := NewExperienceLearningService(
		experienceLearningConfig{
			autoAnalyzeOnIngest: false,
		},
		harnessStore,
		ledgerStore,
		experienceStore,
		policy,
		now,
	)

	runID := "run-repeat-action"
	refInput, err := NewEventReference("urn:experience-learning/input/repeat", map[string]any{"prompt": "build once"})
	if err != nil {
		t.Fatal(err)
	}
	refOutput, err := NewEventReference("urn:experience-learning/output/repeat", map[string]any{"result": "ok"})
	if err != nil {
		t.Fatal(err)
	}

	for i := int64(1); i <= 3; i++ {
		if err := harnessStore.Append(EventEnvelopeV0{
			SchemaVersion:    experienceSchemaVersion,
			EventID:          "evt-repeat-" + t.Name(),
			EventType:        "agent.capability.invoked",
			Service:          serviceName,
			RunID:            runID,
			StepID:           i,
			Actor:            "coder-agent",
			Capability:       "build-tool",
			DataClass:        dataClassBuildTest,
			RedactionProfile: redactionProfileControlled,
			PolicyDecision:   "policy allow",
			Status:           "completed",
			StateTransition:  "invocation.completed",
			CreatedAt:        cfgNow,
			InputRef:         refInput,
			OutputRef:        refOutput,
			Payload: map[string]any{
				"phase": "compile",
			},
		}); err != nil {
			t.Fatalf("append event: %v", err)
		}
	}

	summary, err := service.RunLearningSummary(runID)
	if err != nil {
		t.Fatalf("run summary: %v", err)
	}

	if got := summary.CandidateByPattern[patternRepeatAction]; got != 1 {
		t.Fatalf("expected repeat_action candidate count 1, got %d", got)
	}

	items, err := experienceStore.List()
	if err != nil {
		t.Fatal(err)
	}
	if len(items) < 2 {
		t.Fatalf("expected at least 2 experience events, got %d", len(items))
	}

	hasRepeatAction := false
	hasUnchangedOutput := false
	for _, item := range items {
		switch item.Pattern {
		case patternRepeatAction:
			hasRepeatAction = true
		case patternUnchangedOutput:
			hasUnchangedOutput = true
		}
	}
	if !hasRepeatAction {
		t.Fatalf("expected pattern %s in generated events", patternRepeatAction)
	}
	if !hasUnchangedOutput {
		t.Fatalf("expected pattern %s in generated events", patternUnchangedOutput)
	}
}

func TestPatternAnalyzer_RepeatedFailureDetection(t *testing.T) {
	cfgNow := time.Date(2026, 5, 14, 9, 0, 0, 0, time.UTC)
	now := func() time.Time { return cfgNow }

	harnessStore := NewInMemoryHarnessEventStore()
	ledgerStore := NewInMemoryTrajectoryLedgerStore()
	experienceStore := NewInMemoryExperienceEventStore()
	policy := DefaultLearningPolicy()

	service := NewExperienceLearningService(
		experienceLearningConfig{
			autoAnalyzeOnIngest: false,
		},
		harnessStore,
		ledgerStore,
		experienceStore,
		policy,
		now,
	)

	runID := "run-repeated-failure"
	refInput, err := NewEventReference("urn:experience-learning/input/failure", map[string]any{"prompt": "compile fail"})
	if err != nil {
		t.Fatal(err)
	}
	refOutputFailure, err := NewEventReference("urn:experience-learning/output/failure", map[string]any{"status": "failure"})
	if err != nil {
		t.Fatal(err)
	}

	for i := int64(1); i <= 2; i++ {
		if err := harnessStore.Append(EventEnvelopeV0{
			SchemaVersion:    experienceSchemaVersion,
			EventID:          "evt-fail-" + t.Name(),
			EventType:        "build.compile.failed",
			Service:          serviceName,
			RunID:            runID,
			StepID:           i,
			Actor:            "coder-agent",
			Capability:       "build-tool",
			DataClass:        dataClassBuildTest,
			RedactionProfile: redactionProfileControlled,
			PolicyDecision:   "policy allow",
			Status:           "failed",
			StateTransition:  "compilation.failed",
			CreatedAt:        cfgNow,
			InputRef:         refInput,
			OutputRef:        refOutputFailure,
			Payload: map[string]any{
				"outcome": "compile",
			},
		}); err != nil {
			t.Fatalf("append event: %v", err)
		}
	}

	summary, err := service.RunLearningSummary(runID)
	if err != nil {
		t.Fatalf("run summary: %v", err)
	}

	if got := summary.CandidateByPattern[patternRepeatedFailure]; got < 1 {
		t.Fatalf("expected repeated_failure candidate count >=1, got %d", got)
	}

	events, err := experienceStore.List()
	if err != nil {
		t.Fatal(err)
	}

	hasRepeatedFailure := false
	for _, event := range events {
		if event.Pattern == patternRepeatedFailure {
			hasRepeatedFailure = true
			if event.Occurrences != 2 {
				t.Fatalf("expected occurrences 2 for repeated failure, got %d", event.Occurrences)
			}
		}
	}
	if !hasRepeatedFailure {
		t.Fatalf("expected pattern %s in generated events", patternRepeatedFailure)
	}
}

func TestPatternAnalyzer_RetryDetectionIgnoresStatusInGrouping(t *testing.T) {
	cfgNow := time.Date(2026, 5, 14, 10, 0, 0, 0, time.UTC)
	now := func() time.Time { return cfgNow }

	harnessStore := NewInMemoryHarnessEventStore()
	ledgerStore := NewInMemoryTrajectoryLedgerStore()
	experienceStore := NewInMemoryExperienceEventStore()

	service := NewExperienceLearningService(
		experienceLearningConfig{
			autoAnalyzeOnIngest: false,
		},
		harnessStore,
		ledgerStore,
		experienceStore,
		DefaultLearningPolicy(),
		now,
	)

	runID := "run-retry"
	refInput, err := NewEventReference("urn:experience-learning/input/retry", map[string]any{"operation": "export"})
	if err != nil {
		t.Fatal(err)
	}
	refOutput, err := NewEventReference("urn:experience-learning/output/retry", map[string]any{"artifact": "pack"})
	if err != nil {
		t.Fatal(err)
	}

	statuses := []string{"failed", "completed"}
	for i, status := range statuses {
		if err := harnessStore.Append(EventEnvelopeV0{
			SchemaVersion:    experienceSchemaVersion,
			EventID:          "evt-retry-" + status,
			EventType:        "evidence.export." + status,
			Service:          serviceName,
			RunID:            runID,
			StepID:           int64(i + 1),
			Actor:            "orchestrator-service",
			Capability:       "evidence.writer",
			DataClass:        dataClassEvidence,
			RedactionProfile: redactionProfileControlled,
			PolicyDecision:   "policy allow",
			Status:           status,
			StateTransition:  "export." + status,
			CreatedAt:        cfgNow.Add(time.Duration(i) * time.Second),
			InputRef:         refInput,
			OutputRef:        refOutput,
		}); err != nil {
			t.Fatalf("append event: %v", err)
		}
	}

	summary, err := service.RunLearningSummary(runID)
	if err != nil {
		t.Fatalf("run summary: %v", err)
	}
	if got := summary.CandidateByPattern[patternRetry]; got != 1 {
		t.Fatalf("expected retry candidate count 1, got %d", got)
	}
}

func TestIngestHarnessEvents_AcceptsOutputDivergenceAndAnalyzesFailure(t *testing.T) {
	cfgNow := time.Date(2026, 5, 14, 11, 0, 0, 0, time.UTC)
	service := NewExperienceLearningService(
		experienceLearningConfig{autoAnalyzeOnIngest: false},
		NewInMemoryHarnessEventStore(),
		NewInMemoryTrajectoryLedgerStore(),
		NewInMemoryExperienceEventStore(),
		DefaultLearningPolicy(),
		func() time.Time { return cfgNow },
	)

	runID := "run-output-divergence"
	event := testHarnessEvent(t, runID, "output-divergence")
	event.EventType = "build-test.output-divergence"
	event.StateTransition = "build-test->output-divergence"
	event.Payload = map[string]any{
		"classification": "divergence-known-w0-coverage-gap",
	}

	runIDs, err := service.ingestHarnessEvents([]EventEnvelopeV0{event})
	if err != nil {
		t.Fatalf("ingest raw output-divergence harness event: %v", err)
	}
	if len(runIDs) != 1 || runIDs[0] != runID {
		t.Fatalf("expected runIds [%s], got %v", runID, runIDs)
	}

	stored, err := service.harnessEvents.ByRun(runID)
	if err != nil {
		t.Fatal(err)
	}
	if len(stored) != 1 {
		t.Fatalf("expected 1 stored harness event, got %d", len(stored))
	}
	if stored[0].Status != "output-divergence" {
		t.Fatalf("expected raw status to be preserved, got %q", stored[0].Status)
	}

	summary, err := service.RunLearningSummary(runID)
	if err != nil {
		t.Fatalf("run summary: %v", err)
	}
	if got := summary.CandidateByPattern[patternTestFailure]; got != 1 {
		t.Fatalf("expected %s candidate count 1, got %d", patternTestFailure, got)
	}

	events, err := service.experienceEvents.ByRun(runID)
	if err != nil {
		t.Fatal(err)
	}
	hasTestFailure := false
	for _, event := range events {
		if event.Pattern == patternTestFailure {
			hasTestFailure = true
			if event.Status != statusObserved {
				t.Fatalf("expected experience event status %q, got %q", statusObserved, event.Status)
			}
			if event.BuildTestOutcome != "test" {
				t.Fatalf("expected build test outcome test, got %q", event.BuildTestOutcome)
			}
		}
	}
	if !hasTestFailure {
		t.Fatalf("expected generated %s experience event", patternTestFailure)
	}
}

func TestIngestHarnessEvents_MapsRawBuildTestFailureStatuses(t *testing.T) {
	cases := []struct {
		name            string
		status          string
		expectedPattern string
		expectedOutcome string
	}{
		{
			name:            "compile failure",
			status:          "compile-failed",
			expectedPattern: patternCompileFailure,
			expectedOutcome: "compile",
		},
		{
			name:            "run failure",
			status:          "run-failed",
			expectedPattern: patternTestFailure,
			expectedOutcome: "test",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			cfgNow := time.Date(2026, 5, 14, 11, 15, 0, 0, time.UTC)
			service := NewExperienceLearningService(
				experienceLearningConfig{autoAnalyzeOnIngest: false},
				NewInMemoryHarnessEventStore(),
				NewInMemoryTrajectoryLedgerStore(),
				NewInMemoryExperienceEventStore(),
				DefaultLearningPolicy(),
				func() time.Time { return cfgNow },
			)

			runID := "run-" + tc.status
			event := testHarnessEvent(t, runID, tc.status)
			event.EventType = "build-test." + tc.status
			event.StateTransition = "build-test->" + tc.status

			if _, err := service.ingestHarnessEvents([]EventEnvelopeV0{event}); err != nil {
				t.Fatalf("ingest raw %s harness event: %v", tc.status, err)
			}
			stored, err := service.harnessEvents.ByRun(runID)
			if err != nil {
				t.Fatal(err)
			}
			if len(stored) != 1 {
				t.Fatalf("expected 1 stored harness event, got %d", len(stored))
			}
			if stored[0].Status != tc.status {
				t.Fatalf("expected raw status to be preserved, got %q", stored[0].Status)
			}

			summary, err := service.RunLearningSummary(runID)
			if err != nil {
				t.Fatalf("run summary: %v", err)
			}
			if got := summary.CandidateByPattern[tc.expectedPattern]; got != 1 {
				t.Fatalf("expected %s candidate count 1, got %d", tc.expectedPattern, got)
			}

			events, err := service.experienceEvents.ByRun(runID)
			if err != nil {
				t.Fatal(err)
			}
			for _, event := range events {
				if event.Pattern == tc.expectedPattern {
					if event.BuildTestOutcome != tc.expectedOutcome {
						t.Fatalf("expected build test outcome %q, got %q", tc.expectedOutcome, event.BuildTestOutcome)
					}
					return
				}
			}
			t.Fatalf("expected generated %s experience event", tc.expectedPattern)
		})
	}
}

func TestIngestHarnessEvents_AcceptsStartingAndPreservesRawStatus(t *testing.T) {
	cfgNow := time.Date(2026, 5, 14, 11, 30, 0, 0, time.UTC)
	service := NewExperienceLearningService(
		experienceLearningConfig{autoAnalyzeOnIngest: false},
		NewInMemoryHarnessEventStore(),
		NewInMemoryTrajectoryLedgerStore(),
		NewInMemoryExperienceEventStore(),
		DefaultLearningPolicy(),
		func() time.Time { return cfgNow },
	)

	runID := "run-starting"
	event := testHarnessEvent(t, runID, "starting")
	event.EventType = "run.started"
	event.StateTransition = "created"

	if _, err := service.ingestHarnessEvents([]EventEnvelopeV0{event}); err != nil {
		t.Fatalf("ingest raw starting harness event: %v", err)
	}

	stored, err := service.harnessEvents.ByRun(runID)
	if err != nil {
		t.Fatal(err)
	}
	if len(stored) != 1 {
		t.Fatalf("expected 1 stored harness event, got %d", len(stored))
	}
	if stored[0].Status != "starting" {
		t.Fatalf("expected raw status to be preserved, got %q", stored[0].Status)
	}
	if got := harnessStatusForAnalysis(stored[0].Status); got != "started" {
		t.Fatalf("expected starting to map to started for analysis, got %q", got)
	}
}

func TestHarnessStatusForAnalysis(t *testing.T) {
	cases := map[string]string{
		"starting":                          "started",
		" output-divergence ":               "failed",
		"compile-failed":                    "failed",
		"run-failed":                        "failed",
		"golden-master-reproduction-failed": "failed",
		"updating":                          "updating",
		"COMPLETED":                         "completed",
		"ok":                                "ok",
	}

	for input, expected := range cases {
		if got := harnessStatusForAnalysis(input); got != expected {
			t.Fatalf("harnessStatusForAnalysis(%q) = %q, want %q", input, got, expected)
		}
	}
}

func TestClassifyBuildOutcome_DoesNotTreatGenericRunFailureAsTest(t *testing.T) {
	event := testHarnessEvent(t, "run-control-plane-failure", "failed")
	event.EventType = "run.failed"
	event.DataClass = dataClassOther
	event.Capability = "agentic-harness-core"
	event.StateTransition = "starting->failed"

	if got := classifyBuildOutcome(event); got != "" {
		t.Fatalf("expected generic run.failed to have no build outcome, got %q", got)
	}
}

func testHarnessEvent(t *testing.T, runID, status string) EventEnvelopeV0 {
	t.Helper()
	refInput, err := NewEventReference("urn:experience-learning/input/"+status, map[string]any{"status": status, "direction": "input"})
	if err != nil {
		t.Fatal(err)
	}
	refOutput, err := NewEventReference("urn:experience-learning/output/"+status, map[string]any{"status": status, "direction": "output"})
	if err != nil {
		t.Fatal(err)
	}
	return EventEnvelopeV0{
		SchemaVersion:    experienceSchemaVersion,
		EventID:          "evt-" + status,
		EventType:        "build-test." + status,
		Service:          "build-test-runner-service",
		RunID:            runID,
		StepID:           1,
		Actor:            "orchestrator-service",
		Capability:       "build-test.run",
		DataClass:        dataClassBuildTest,
		RedactionProfile: redactionProfileControlled,
		PolicyDecision:   "policy allow",
		Status:           status,
		StateTransition:  "build-test->" + status,
		CreatedAt:        time.Date(2026, 5, 14, 11, 0, 0, 0, time.UTC),
		InputRef:         refInput,
		OutputRef:        refOutput,
	}
}
