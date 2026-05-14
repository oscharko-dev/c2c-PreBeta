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
