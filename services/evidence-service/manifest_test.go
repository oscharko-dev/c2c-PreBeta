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

func TestManifestValidateRequiresCompletenessContract(t *testing.T) {
	m := newCompleteManifest(t)
	m.CompletenessStatus = ""
	if err := m.Validate(); err == nil || !strings.Contains(err.Error(), "completenessStatus") {
		t.Fatalf("expected completenessStatus validation error, got %v", err)
	}

	m = newCompleteManifest(t)
	m.Classification = ""
	if err := m.Validate(); err == nil || !strings.Contains(err.Error(), "classification") {
		t.Fatalf("expected classification validation error, got %v", err)
	}

	m = newCompleteManifest(t)
	m.Validation.CompletenessStatus = ""
	if err := m.Validate(); err == nil || !strings.Contains(err.Error(), "validation.completenessStatus") {
		t.Fatalf("expected validation.completenessStatus validation error, got %v", err)
	}

	m = newCompleteManifest(t)
	m.Validation.CompletenessStatus = CompletenessStatusEvidenceIncomplete
	if err := m.Validate(); err == nil || !strings.Contains(err.Error(), "must match") {
		t.Fatalf("expected validation.completenessStatus mismatch error, got %v", err)
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

func TestDataReferenceValidateRejectsSecretOrQueryBearingURI(t *testing.T) {
	ref := DataReference{
		URI:      "https://artifacts.example/object?token=" + "s" + "k-" + strings.Repeat("A", 20),
		SHA256:   strings.Repeat("0", 64),
		ByteSize: 1,
	}
	err := ref.Validate("ref")
	if err == nil {
		t.Fatalf("expected validation error for secret-bearing uri")
	}
	if !strings.Contains(err.Error(), "secret") {
		t.Fatalf("expected secret rejection; got %v", err)
	}

	ref.URI = "https://artifacts.example/object?signature=abc"
	err = ref.Validate("ref")
	if err == nil {
		t.Fatalf("expected validation error for query-bearing http uri")
	}
	if !strings.Contains(err.Error(), "query") {
		t.Fatalf("expected query rejection; got %v", err)
	}
}

func TestJavaCandidateRefValidateRejectsSecretOrQueryBearingURI(t *testing.T) {
	candidate := JavaCandidateRef{
		URI:           "https://artifacts.example/generated?token=" + "s" + "k-" + strings.Repeat("A", 20),
		SHA256:        strings.Repeat("0", 64),
		ByteSize:      1,
		Origin:        JavaCandidateOriginTransformationAgent,
		AttemptNumber: 0,
	}
	err := candidate.Validate("candidate")
	if err == nil {
		t.Fatalf("expected validation error for secret-bearing candidate uri")
	}
	if !strings.Contains(err.Error(), "secret") {
		t.Fatalf("expected secret rejection; got %v", err)
	}

	candidate.URI = "https://artifacts.example/generated?signature=abc"
	err = candidate.Validate("candidate")
	if err == nil {
		t.Fatalf("expected validation error for query-bearing candidate uri")
	}
	if !strings.Contains(err.Error(), "query") {
		t.Fatalf("expected query rejection; got %v", err)
	}
}

func TestOracleComparisonValidateRejectsOversizeDiffSummary(t *testing.T) {
	o := OracleComparison{
		OracleKind:  OracleKindCobolRuntime,
		Status:      "failed",
		DiffSummary: strings.Repeat("x", maxOracleComparisonTextLength+1),
	}
	err := o.Validate("oracleComparison")
	if err == nil {
		t.Fatalf("expected validation error for oversize diffSummary")
	}
	if !strings.Contains(err.Error(), "diffSummary") {
		t.Fatalf("expected diffSummary in error, got %v", err)
	}
}

func TestOracleComparisonValidateRejectsOversizeSummary(t *testing.T) {
	o := OracleComparison{
		OracleKind: OracleKindCobolRuntime,
		Status:     "passed",
		Summary:    strings.Repeat("y", maxOracleComparisonTextLength+1),
	}
	err := o.Validate("oracleComparison")
	if err == nil {
		t.Fatalf("expected validation error for oversize summary")
	}
	if !strings.Contains(err.Error(), "summary") {
		t.Fatalf("expected summary in error, got %v", err)
	}
}

func TestOracleComparisonValidateAcceptsDiffSummaryAtCeiling(t *testing.T) {
	o := OracleComparison{
		OracleKind:  OracleKindCobolRuntime,
		Status:      "failed",
		DiffSummary: strings.Repeat("z", maxOracleComparisonTextLength),
		Summary:     strings.Repeat("w", maxOracleComparisonTextLength),
	}
	if err := o.Validate("oracleComparison"); err != nil {
		t.Fatalf("expected exact-ceiling diffSummary/summary to validate, got %v", err)
	}
}

// TestOracleComparisonValidateCountsCharactersNotBytes guards the rune-aware
// length check (JSON Schema maxLength is defined in Unicode characters, not
// bytes). The "é" rune is two UTF-8 bytes, so a 4000-rune string occupies
// 8000 bytes; a byte-count guard would have falsely rejected this schema-
// conformant input.
func TestOracleComparisonValidateCountsCharactersNotBytes(t *testing.T) {
	multiByteAtCeiling := strings.Repeat("é", maxOracleComparisonTextLength)
	o := OracleComparison{
		OracleKind:  OracleKindCobolRuntime,
		Status:      "failed",
		DiffSummary: multiByteAtCeiling,
		Summary:     multiByteAtCeiling,
	}
	if err := o.Validate("oracleComparison"); err != nil {
		t.Fatalf("expected 4000-rune non-ASCII diffSummary/summary to validate, got %v", err)
	}

	overCeiling := strings.Repeat("é", maxOracleComparisonTextLength+1)
	o.DiffSummary = overCeiling
	if err := o.Validate("oracleComparison"); err == nil {
		t.Fatalf("expected rejection at 4001 runes")
	}
}

func TestManifestRoundTripsJSON(t *testing.T) {
	m := newCompleteManifest(t)
	m.Artifacts.ModelInvocations[0].PolicyDecision = "policy allow"
	m.Artifacts.ModelInvocations[0].PolicyVersion = "v0"
	m.Artifacts.ModelInvocations[0].Reason = "deterministic workflow did not require model assistance"
	m.Artifacts.ModelInvocations[0].Timestamp = "2026-05-15T12:00:00Z"
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
	if decoded.Artifacts.ModelInvocations[0].PolicyVersion != "v0" {
		t.Fatalf("expected model policy version to round-trip, got %+v", decoded.Artifacts.ModelInvocations[0])
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

func TestManifestSchemaRequiresCompletenessContract(t *testing.T) {
	body, err := os.ReadFile(filepath.Join("..", "..", "schemas", "evidence-pack-manifest-v0.json"))
	if err != nil {
		t.Fatalf("read manifest schema: %v", err)
	}
	var doc map[string]any
	if err := json.Unmarshal(body, &doc); err != nil {
		t.Fatalf("parse manifest schema: %v", err)
	}
	requireSchemaField(t, doc["required"], "completenessStatus")
	requireSchemaField(t, doc["required"], "classification")

	properties, ok := doc["properties"].(map[string]any)
	if !ok {
		t.Fatalf("schema properties missing or invalid")
	}
	validation, ok := properties["validation"].(map[string]any)
	if !ok {
		t.Fatalf("validation schema missing or invalid")
	}
	requireSchemaField(t, validation["required"], "completenessStatus")
}

func TestOpenAPIRequiresCompletenessContract(t *testing.T) {
	body, err := os.ReadFile("openapi.yaml")
	if err != nil {
		t.Fatalf("read openapi.yaml: %v", err)
	}
	text := string(body)
	for _, want := range []string{
		"required: [ok, requiredArtifacts, missingArtifacts, completenessStatus]",
		"- completenessStatus",
		"- classification",
	} {
		if !strings.Contains(text, want) {
			t.Fatalf("openapi.yaml missing %q", want)
		}
	}
}

func requireSchemaField(t *testing.T, required any, field string) {
	t.Helper()
	fields, ok := required.([]any)
	if !ok {
		t.Fatalf("schema required list missing or invalid")
	}
	for _, value := range fields {
		if value == field {
			return
		}
	}
	t.Fatalf("schema required list missing %q: %v", field, fields)
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
	sourceMetadataRef := mustRef(t, "urn:c2c/source-ref/HELLO", map[string]string{"sourceRef": "normalized"})
	parseOutputRef := mustRef(t, "urn:c2c/parse-output/HELLO", map[string]string{"status": "ok"})
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
		SourceMetadata: &sourceMetadataRef,
		CorpusMetadata: &corpusRef,
		ParseOutput:    &parseOutputRef,
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
