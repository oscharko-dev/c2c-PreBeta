package main

import (
	"strings"
	"testing"
	"time"
)

func TestExperienceEventValidateRejectsInvalidHashes(t *testing.T) {
	base := ExperienceEventV0{
		SchemaVersion:    experienceSchemaVersion,
		EventID:          "evt-1",
		EventType:        eventTypeObservation,
		Service:          serviceName,
		RunID:            "run-1",
		Actor:            "coder-agent",
		Capability:       "build-tool",
		DataClass:        dataClassBuildTest,
		RedactionProfile: redactionProfileControlled,
		PolicyDecision:   policyDecisionAllow(),
		Status:           statusObserved,
		StateTransition:  "analysis.detected",
		Occurrences:      1,
		Confidence:       0.9,
		CreatedAt:        time.Now().UTC(),
		ObservedAt:       time.Now().UTC(),
	}

	badHex := base
	badHex.InputHash = strings.Repeat("z", 64)
	if err := badHex.Validate(); err == nil {
		t.Fatalf("expected invalid hex inputHash to fail validation")
	}

	badLength := base
	badLength.OutputHash = strings.Repeat("a", 65)
	if err := badLength.Validate(); err == nil {
		t.Fatalf("expected 65-char outputHash to fail validation")
	}
}

func TestStatusValidationSeparatesHarnessAndExperienceDomains(t *testing.T) {
	harness := testHarnessEvent(t, "run-status-validation", "starting")
	harnessStatuses := []string{
		"starting",
		"updating",
		"output-divergence",
		"compile-failed",
		"run-failed",
		"golden-master-reproduction-failed",
		"missing-golden-master",
		"producer-custom-status",
		"ok",
	}
	for _, status := range harnessStatuses {
		item := harness
		item.Status = status
		item.EventID = "evt-" + status
		if err := item.Validate(); err != nil {
			t.Fatalf("expected harness status %q to validate: %v", status, err)
		}
	}

	experience := ExperienceEventV0{
		SchemaVersion:    experienceSchemaVersion,
		EventID:          "experience-status-validation",
		EventType:        eventTypeObservation,
		Service:          serviceName,
		RunID:            "run-status-validation",
		Actor:            "coder-agent",
		Capability:       "build-tool",
		DataClass:        dataClassBuildTest,
		RedactionProfile: redactionProfileControlled,
		PolicyDecision:   policyDecisionAllow(),
		Status:           statusObserved,
		StateTransition:  "analysis.detected",
		Occurrences:      1,
		Confidence:       0.9,
		CreatedAt:        time.Now().UTC(),
		ObservedAt:       time.Now().UTC(),
	}
	for _, status := range []string{statusObserved, statusIgnored} {
		item := experience
		item.Status = status
		if err := item.Validate(); err != nil {
			t.Fatalf("expected experience status %q to validate: %v", status, err)
		}
	}
	for _, status := range []string{"starting", "output-divergence", "failed"} {
		item := experience
		item.Status = status
		if err := item.Validate(); err == nil {
			t.Fatalf("expected experience status %q to be rejected", status)
		}
	}

	blankHarness := harness
	blankHarness.Status = " "
	if err := blankHarness.Validate(); err == nil {
		t.Fatalf("expected blank harness status to be rejected")
	}
}
