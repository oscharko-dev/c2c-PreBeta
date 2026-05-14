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

