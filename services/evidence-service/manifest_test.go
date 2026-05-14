package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestEvaluateValidationReportsEachMissingArtifact(t *testing.T) {
	result := EvaluateValidation(&Artifacts{})
	if result.OK {
		t.Fatalf("expected ok=false on empty artifacts")
	}
	wanted := map[string]bool{
		"sourceCobol":      true,
		"semanticIr":       true,
		"generatedJava":    true,
		"buildTestResults": true,
		"harnessEvents":    true,
		"modelInvocations": true,
	}
	for _, m := range result.MissingArtifacts {
		if !wanted[m] {
			t.Fatalf("unexpected missing artifact %q", m)
		}
		delete(wanted, m)
	}
	if len(wanted) != 0 {
		t.Fatalf("required artifacts not reported as missing: %v", wanted)
	}
}

func TestEvaluateValidationOKOnFullW0Set(t *testing.T) {
	a := completeArtifacts(t)
	result := EvaluateValidation(&a)
	if !result.OK {
		t.Fatalf("expected ok=true on complete artifact set, got missing=%v", result.MissingArtifacts)
	}
	if len(result.MissingArtifacts) != 0 {
		t.Fatalf("expected zero missing artifacts, got %v", result.MissingArtifacts)
	}
}

func TestManifestValidateRejectsBadPackID(t *testing.T) {
	m := newCompleteManifest(t)
	m.PackID = "not-a-pack-id"
	if err := m.Validate(); err == nil {
		t.Fatalf("expected validation error for bad packId")
	}
}

func TestManifestValidateRejectsBadHash(t *testing.T) {
	m := newCompleteManifest(t)
	m.Artifacts.SemanticIR.SHA256 = "deadbeef"
	if err := m.Validate(); err == nil {
		t.Fatalf("expected validation error for short sha256")
	}
}

func TestDataReferenceValidateAcceptsValid(t *testing.T) {
	ref := DataReference{
		URI:      "urn:test/abc",
		SHA256:   strings.Repeat("a", 64),
		ByteSize: 1,
	}
	if err := ref.Validate("ref"); err != nil {
		t.Fatalf("expected valid reference, got %v", err)
	}
}

func TestDataReferenceValidateRejectsMissingURI(t *testing.T) {
	ref := DataReference{SHA256: strings.Repeat("0", 64), ByteSize: 1}
	if err := ref.Validate("ref"); err == nil {
		t.Fatalf("expected validation error for missing uri")
	}
}

func TestManifestRoundTripsJSON(t *testing.T) {
	m := newCompleteManifest(t)
	body, err := json.Marshal(m)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var decoded EvidencePackManifest
	if err := json.Unmarshal(body, &decoded); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if decoded.PackID != m.PackID || decoded.Wave != WaveW0 {
		t.Fatalf("round-trip lost fields: %+v", decoded)
	}
}

// TestSchemaPresence ensures the schema artifact ships alongside the service
// and keeps the canonical $id used by orchestrator and BFF consumers.
func TestSchemaPresence(t *testing.T) {
	for _, candidate := range []string{
		filepath.Join("..", "..", "schemas", "evidence-pack-manifest-v0.json"),
	} {
		body, err := os.ReadFile(candidate)
		if err != nil {
			continue
		}
		if !strings.Contains(string(body), "evidence-pack-manifest-v0.json") {
			t.Fatalf("schema file present but missing canonical $id: %s", candidate)
		}
		return
	}
	t.Fatalf("schemas/evidence-pack-manifest-v0.json not found relative to service module")
}

func newCompleteManifest(t *testing.T) *EvidencePackManifest {
	t.Helper()
	store := NewPackStore()
	store.clock = func() time.Time { return time.Date(2026, 5, 14, 12, 0, 0, 0, time.UTC) }
	manifest, err := store.Create(CreateInput{
		RunID:      "run-1",
		WorkflowID: "wf-1",
		CreatedBy:  "orchestrator",
		Artifacts:  completeArtifacts(t),
	})
	if err != nil {
		t.Fatalf("create manifest: %v", err)
	}
	return manifest
}

func completeArtifacts(t *testing.T) Artifacts {
	t.Helper()
	cobolRef := mustRef(t, "urn:c2c/cobol/HELLO.cob", "HELLO")
	corpusRef := mustRef(t, "urn:c2c/corpus/index", map[string]string{"index": "v0"})
	semanticRef := mustRef(t, "urn:c2c/semantic-ir/HELLO", map[string]string{"ir": "v0"})
	transformRef := mustRef(t, "urn:c2c/transform/HELLO/lower", map[string]string{"lower": "v0"})
	javaRef := mustRef(t, "urn:c2c/generated/HELLO.java", "Hello")
	runtimeRef := mustRef(t, "urn:c2c/runtime/v0", map[string]string{"runtime": "v0"})
	ledgerRef := mustRef(t, "urn:c2c/model-invocation/inv-1", map[string]string{"id": "inv-1"})
	buildResultRef := mustRef(t, "urn:c2c/build-test/HELLO/result-1", map[string]string{"result": "ok"})
	sbomRef := mustRef(t, "urn:c2c/sbom/HELLO", map[string]string{"sbom": "v0"})
	licenseRef := mustRef(t, "urn:c2c/license/HELLO", map[string]string{"license": "v0"})
	harnessRef := mustRef(t, "urn:c2c/harness-events/run-1", map[string]string{"events": "v0"})
	trajectoryRef := mustRef(t, "urn:c2c/trajectory/run-1", map[string]string{"trajectory": "v0"})
	experienceRef := mustRef(t, "urn:c2c/experience/run-1/evt-1", map[string]string{"experience": "v0"})

	return Artifacts{
		SourceCobol:    []DataReference{cobolRef},
		CorpusMetadata: &corpusRef,
		SemanticIR:     &semanticRef,
		TransformationPasses: []TransformationPass{{
			Name:      "lower",
			Order:     1,
			InputRef:  &semanticRef,
			OutputRef: transformRef,
		}},
		GeneratedJava: &javaRef,
		RuntimeVersion: &RuntimeVersion{
			ID:  "c2c-target-java-runtime:v0",
			Ref: &runtimeRef,
		},
		ModelInvocations: []ModelInvocationRef{{
			InvocationID:          "inv-1",
			ModelID:               "model-x",
			Provider:              "foundry-development",
			PromptTemplateVersion: "p-v0",
			Status:                "completed",
			LedgerRef:             ledgerRef,
		}},
		BuildTestResults: []DataReference{buildResultRef},
		SBOM:             []DataReference{sbomRef},
		LicenseReports:   []DataReference{licenseRef},
		HarnessEvents:    &harnessRef,
		TrajectoryLedger: &trajectoryRef,
		ExperienceEvents: []DataReference{experienceRef},
	}
}

func mustRef(t *testing.T, uri string, payload any) DataReference {
	t.Helper()
	ref, err := NewDataReference(uri, payload, "application/json", "evidence-input")
	if err != nil {
		t.Fatalf("build reference: %v", err)
	}
	return ref
}
