package main

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

// completeW02Artifacts returns an artifact set that satisfies every
// requiredArtifactsW02 entry. Reusing completeArtifacts as the W0 baseline
// keeps the W0 fields in sync.
func completeW02Artifacts(t *testing.T) Artifacts {
	t.Helper()
	base := completeArtifacts(t)

	javaRef := mustRef(t, "urn:c2c/generated/HELLO.java", "Hello")
	repairCandidateRef := mustRef(t, "urn:c2c/generated/HELLO-repair-1.java", "HelloRepaired")
	repairDecisionRef := mustRef(t, "urn:c2c/agent/repair-decision/HELLO/1", map[string]string{"decision": "propose_candidate"})
	transformationLedgerRef := mustRef(t, "urn:c2c/trajectory/run-1/transformation", map[string]string{"role": "transformation"})
	verificationLedgerRef := mustRef(t, "urn:c2c/trajectory/run-1/verification", map[string]string{"role": "verification-repair"})
	oracleExpectedRef := mustRef(t, "urn:c2c/oracle/HELLO/expected", "Hello")
	oracleActualRef := mustRef(t, "urn:c2c/oracle/HELLO/actual", "Hello")

	base.GeneratedJavaArtifacts = []JavaCandidateRef{
		{
			URI:           javaRef.URI,
			SHA256:        javaRef.SHA256,
			ByteSize:      javaRef.ByteSize,
			MIMEType:      javaRef.MIMEType,
			Kind:          javaRef.Kind,
			Origin:        JavaCandidateOriginBaseline,
			AttemptNumber: 0,
		},
		{
			URI:           repairCandidateRef.URI,
			SHA256:        repairCandidateRef.SHA256,
			ByteSize:      repairCandidateRef.ByteSize,
			MIMEType:      repairCandidateRef.MIMEType,
			Kind:          repairCandidateRef.Kind,
			Origin:        JavaCandidateOriginVerificationRepair,
			AttemptNumber: 1,
			Selected:      true,
		},
	}
	final := base.GeneratedJavaArtifacts[1]
	base.FinalJavaArtifact = &final
	base.RepairAttempts = []RepairAttempt{{
		AttemptNumber:       1,
		Decision:            RepairDecisionProposeCandidate,
		DecisionRef:         &repairDecisionRef,
		NewJavaCandidateRef: &final,
		BuildTestResultRef:  base.BuildTestResults[0],
	}}
	base.AgentTrajectories = []AgentTrajectoryRef{
		{AgentRole: AgentRoleTransformation, LedgerRef: transformationLedgerRef},
		{AgentRole: AgentRoleVerificationRepair, LedgerRef: verificationLedgerRef},
	}
	base.OracleComparison = &OracleComparison{
		Matched:        true,
		OracleKind:     OracleKindCobolRuntime,
		ExpectedRef:    &oracleExpectedRef,
		ActualRef:      &oracleActualRef,
		ExpectedSHA256: oracleExpectedRef.SHA256,
		ActualSHA256:   oracleActualRef.SHA256,
		Summary:        "actual output matches COBOL runtime oracle",
	}

	return base
}

func TestEvaluateValidationW02Complete(t *testing.T) {
	a := completeW02Artifacts(t)
	v := EvaluateValidationForWave(&a, WaveW02)
	if !v.OK {
		t.Fatalf("expected W0.2 validation OK; got missing=%v messages=%v", v.MissingArtifacts, v.Messages)
	}
	if v.CompletenessStatus != CompletenessStatusComplete {
		t.Fatalf("expected completenessStatus=complete; got %s", v.CompletenessStatus)
	}
	// Spot-check the required set covers every named W0.2 contract field.
	want := map[string]bool{
		"sourceCobol":            true,
		"semanticIr":             true,
		"generatedJava":          true,
		"generatedJavaArtifacts": true,
		"finalJavaArtifact":      true,
		"buildTestResults":       true,
		"oracleComparison":       true,
		"harnessEvents":          true,
		"modelInvocations":       true,
		"agentTrajectories":      true,
	}
	for _, req := range v.RequiredArtifacts {
		delete(want, req)
	}
	if len(want) != 0 {
		t.Fatalf("required W0.2 artifact set missing entries: %v", want)
	}
}

// TestEvaluateValidationW02FailsClosedOnMissingFinalJava verifies the
// fail-closed semantic for Issue #171: a run that looks successful but is
// missing the final Java artifact must be classified as evidence_incomplete.
func TestEvaluateValidationW02FailsClosedOnMissingFinalJava(t *testing.T) {
	a := completeW02Artifacts(t)
	a.FinalJavaArtifact = nil

	v := EvaluateValidationForWave(&a, WaveW02)
	if v.OK {
		t.Fatalf("expected validation to fail when finalJavaArtifact is missing")
	}
	if v.CompletenessStatus != CompletenessStatusEvidenceIncomplete {
		t.Fatalf("expected completenessStatus=evidence_incomplete; got %s", v.CompletenessStatus)
	}
	if !containsString(v.MissingArtifacts, "finalJavaArtifact") {
		t.Fatalf("missingArtifacts must call out finalJavaArtifact; got %v", v.MissingArtifacts)
	}
}

func TestEvaluateValidationW02FailsClosedWhenFinalJavaDoesNotMatchCandidateHistory(t *testing.T) {
	a := completeW02Artifacts(t)
	mismatched := mustRef(t, "urn:c2c/generated/untracked.java", "untracked")
	a.FinalJavaArtifact = &JavaCandidateRef{
		URI:           mismatched.URI,
		SHA256:        mismatched.SHA256,
		ByteSize:      mismatched.ByteSize,
		MIMEType:      mismatched.MIMEType,
		Kind:          mismatched.Kind,
		Origin:        JavaCandidateOriginVerificationRepair,
		AttemptNumber: 1,
		Selected:      true,
	}

	v := EvaluateValidationForWave(&a, WaveW02)
	if v.OK {
		t.Fatalf("expected validation to fail when finalJavaArtifact is not in generatedJavaArtifacts")
	}
	if !containsString(v.MissingArtifacts, "finalJavaArtifact.generatedJavaArtifacts") {
		t.Fatalf("missingArtifacts must call out final/candidate mismatch; got %v", v.MissingArtifacts)
	}
	if v.CompletenessStatus != CompletenessStatusEvidenceIncomplete {
		t.Fatalf("expected completenessStatus=evidence_incomplete; got %s", v.CompletenessStatus)
	}
}

func TestEvaluateValidationW02FailsClosedWhenRepairBuildTestRefIsNotReal(t *testing.T) {
	a := completeW02Artifacts(t)
	a.RepairAttempts[0].BuildTestResultRef = mustRef(t, "urn:c2c/build-test/fabricated", "fabricated")

	v := EvaluateValidationForWave(&a, WaveW02)
	if v.OK {
		t.Fatalf("expected validation to fail when repair buildTestResultRef is not in buildTestResults")
	}
	if !containsString(v.MissingArtifacts, "repairAttempts[0].buildTestResultRef") {
		t.Fatalf("missingArtifacts must call out repair build-test mismatch; got %v", v.MissingArtifacts)
	}
}

func TestEvaluateValidationW02FailsClosedWhenVerificationRepairHasNoAttempts(t *testing.T) {
	a := completeW02Artifacts(t)
	a.RepairAttempts = nil

	v := EvaluateValidationForWave(&a, WaveW02)
	if v.OK {
		t.Fatalf("expected validation to fail when verification-repair trajectory has no repairAttempts")
	}
	if !containsString(v.MissingArtifacts, "repairAttempts") {
		t.Fatalf("missingArtifacts must call out repairAttempts; got %v", v.MissingArtifacts)
	}
}

func TestEvaluateValidationW02FailsClosedOnMissingModelInvocations(t *testing.T) {
	a := completeW02Artifacts(t)
	a.ModelInvocations = nil

	v := EvaluateValidationForWave(&a, WaveW02)
	if v.OK {
		t.Fatalf("expected validation to fail when modelInvocations is empty")
	}
	if !containsString(v.MissingArtifacts, "modelInvocations") {
		t.Fatalf("missingArtifacts must call out modelInvocations; got %v", v.MissingArtifacts)
	}
}

func TestEvaluateValidationW02FailsClosedOnMissingAgentTrajectories(t *testing.T) {
	a := completeW02Artifacts(t)
	a.AgentTrajectories = nil

	v := EvaluateValidationForWave(&a, WaveW02)
	if v.OK {
		t.Fatalf("expected validation to fail when agentTrajectories is empty")
	}
	if !containsString(v.MissingArtifacts, "agentTrajectories") {
		t.Fatalf("missingArtifacts must call out agentTrajectories; got %v", v.MissingArtifacts)
	}
}

func TestEvaluateValidationW02FailsClosedOnMissingOracleComparison(t *testing.T) {
	a := completeW02Artifacts(t)
	a.OracleComparison = nil

	v := EvaluateValidationForWave(&a, WaveW02)
	if v.OK {
		t.Fatalf("expected validation to fail when oracleComparison is missing")
	}
	if !containsString(v.MissingArtifacts, "oracleComparison") {
		t.Fatalf("missingArtifacts must call out oracleComparison; got %v", v.MissingArtifacts)
	}
}

func TestCreatePackW02StampsCompletenessAndClassification(t *testing.T) {
	srv, _ := newTestServer(t)
	res := postJSON(t, srv.URL+"/v0/packs", CreateInput{
		RunID:     "run-w02-1",
		Wave:      WaveW02,
		CreatedBy: "orchestrator",
		Artifacts: completeW02Artifacts(t),
	})
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("expected 201; got %d", res.StatusCode)
	}
	var manifest EvidencePackManifest
	if err := json.NewDecoder(res.Body).Decode(&manifest); err != nil {
		t.Fatalf("decode: %v", err)
	}
	_ = res.Body.Close()
	if manifest.Wave != WaveW02 {
		t.Fatalf("expected wave=w0.2; got %s", manifest.Wave)
	}
	if manifest.Status != StatusComplete {
		t.Fatalf("expected status=complete; got %s", manifest.Status)
	}
	if manifest.CompletenessStatus != CompletenessStatusComplete {
		t.Fatalf("expected completenessStatus=complete; got %s", manifest.CompletenessStatus)
	}
	if manifest.Classification != ClassificationSuccess {
		t.Fatalf("expected classification=success; got %s", manifest.Classification)
	}
	if manifest.Validation.CompletenessStatus != CompletenessStatusComplete {
		t.Fatalf("expected validation.completenessStatus=complete; got %s", manifest.Validation.CompletenessStatus)
	}
}

func TestCreatePackW02RefusesSuccessOnEvidenceIncomplete(t *testing.T) {
	srv, _ := newTestServer(t)
	artifacts := completeW02Artifacts(t)
	artifacts.FinalJavaArtifact = nil

	res := postJSON(t, srv.URL+"/v0/packs", CreateInput{
		RunID:     "run-w02-2",
		Wave:      WaveW02,
		Artifacts: artifacts,
	})
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("expected 201 (pack stored even when incomplete); got %d", res.StatusCode)
	}
	var manifest EvidencePackManifest
	if err := json.NewDecoder(res.Body).Decode(&manifest); err != nil {
		t.Fatalf("decode: %v", err)
	}
	_ = res.Body.Close()
	if manifest.Classification == ClassificationSuccess {
		t.Fatalf("classification must NOT be success when finalJavaArtifact is missing")
	}
	if manifest.Classification != ClassificationEvidenceIncomplete {
		t.Fatalf("expected classification=evidence_incomplete; got %s", manifest.Classification)
	}
	if manifest.CompletenessStatus != CompletenessStatusEvidenceIncomplete {
		t.Fatalf("expected completenessStatus=evidence_incomplete; got %s", manifest.CompletenessStatus)
	}
}

func TestCreatePackW02BlockedRunClassifiedAsBlocked(t *testing.T) {
	srv, _ := newTestServer(t)
	artifacts := completeW02Artifacts(t)
	artifacts.OracleComparison.Matched = false

	res := postJSON(t, srv.URL+"/v0/packs", CreateInput{
		RunID:     "run-w02-3",
		Wave:      WaveW02,
		Blocked:   true,
		Artifacts: artifacts,
	})
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("expected 201; got %d", res.StatusCode)
	}
	var manifest EvidencePackManifest
	if err := json.NewDecoder(res.Body).Decode(&manifest); err != nil {
		t.Fatalf("decode: %v", err)
	}
	_ = res.Body.Close()
	if manifest.CompletenessStatus != CompletenessStatusBlocked {
		t.Fatalf("expected completenessStatus=blocked; got %s", manifest.CompletenessStatus)
	}
	if manifest.Classification != ClassificationBlocked {
		t.Fatalf("expected classification=blocked; got %s", manifest.Classification)
	}
}

func TestSecretScrubRejectsAPIKeyInModelInvocation(t *testing.T) {
	srv, _ := newTestServer(t)
	artifacts := completeW02Artifacts(t)
	// Smuggle a credential-shaped value into the reason field. The service
	// must refuse. The prefix is built at runtime so the literal does not
	// trigger upstream secret scanners on this test file itself.
	skPrefix := "s" + "k-"
	artifacts.ModelInvocations[0].Reason = "model returned key " + skPrefix + "ABCDEFGHIJ1234567890XYZ"

	res := postJSON(t, srv.URL+"/v0/packs", CreateInput{
		RunID:     "run-w02-secret",
		Wave:      WaveW02,
		Artifacts: artifacts,
	})
	if res.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected 400 on secret; got %d", res.StatusCode)
	}
	var body map[string]any
	if err := json.NewDecoder(res.Body).Decode(&body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	_ = res.Body.Close()
	errStr, _ := body["error"].(string)
	if !strings.Contains(errStr, "secret") {
		t.Fatalf("expected error to mention secret; got %q", errStr)
	}
}

func TestSecretScrubRejectsBearerToken(t *testing.T) {
	a := completeW02Artifacts(t)
	a.ModelInvocations[0].PolicyDecision = "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyMSJ9.signature_value_here"
	err := a.ModelInvocations[0].Validate("artifacts.modelInvocations[0]")
	if err == nil {
		t.Fatalf("expected validation to reject a bearer-token-shaped value")
	}
	if !strings.Contains(err.Error(), "secret") {
		t.Fatalf("expected secret-rejection message; got %v", err)
	}
}

func TestSecretScrubAcceptsBenignValues(t *testing.T) {
	cases := []string{
		"",
		"model-foundry-development-v0",
		"foundry-development",
		"completed",
		"v0",
		"orchestrator",
		"transformation",
		"propose_candidate",
		"inv-run-1-00",
	}
	for _, value := range cases {
		if ContainsSecretLike(value) {
			t.Fatalf("benign value %q incorrectly flagged as secret-like", value)
		}
	}
}

func TestSecretScrubFlagsCommonSecretFormats(t *testing.T) {
	// Build credential-shaped fixtures from prefix + body at runtime so the
	// raw literals never appear in the source. Repository-level secret
	// scanners flag the full literal even when it is plainly a unit-test
	// fixture (see GitHub Push Protection rule for AKIA-prefixed strings).
	cases := []string{
		"s" + "k-" + "ABCDEFGHIJ1234567890XYZ",
		"s" + "k_live_" + "ABCDEFGHIJ1234",
		"AK" + "IA" + "ABCDEFGHIJKLMNOP",
		"gh" + "p_" + "ABCDEFGHIJ12345678901234",
		"h" + "f_" + "ABCDEFGHIJ12345678901234567890",
		"Bearer " + "eyJ123456789.ABCDEFGHIJ.signature_a_b_c",
		"api_key: " + "1234567890abcdefABCDEFG",
		"-----BEGIN " + "RSA PRIVATE KEY-----",
	}
	for _, value := range cases {
		if !ContainsSecretLike(value) {
			t.Fatalf("expected ContainsSecretLike to flag %q", value)
		}
	}
}

func TestRepairAttemptRequiresCandidateOnProposeDecision(t *testing.T) {
	r := RepairAttempt{
		AttemptNumber:      1,
		Decision:           RepairDecisionProposeCandidate,
		BuildTestResultRef: mustRef(t, "urn:c2c/build-test/x", "x"),
	}
	if err := r.Validate("artifacts.repairAttempts[0]"); err == nil {
		t.Fatalf("expected propose_candidate without newJavaCandidateRef to fail validation")
	}
}

func TestRepairAttemptRequiresRefusalCodeOnRefuse(t *testing.T) {
	r := RepairAttempt{
		AttemptNumber:      1,
		Decision:           RepairDecisionRefuse,
		BuildTestResultRef: mustRef(t, "urn:c2c/build-test/x", "x"),
	}
	if err := r.Validate("artifacts.repairAttempts[0]"); err == nil {
		t.Fatalf("expected refuse without refusalCode to fail validation")
	}
}

func TestJavaCandidateRefRejectsInvalidOrigin(t *testing.T) {
	c := JavaCandidateRef{
		URI:           "urn:x",
		SHA256:        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
		ByteSize:      1,
		Origin:        "made-up-origin",
		AttemptNumber: 0,
	}
	if err := c.Validate("artifacts.generatedJavaArtifacts[0]"); err == nil {
		t.Fatalf("expected unknown origin to fail validation")
	}
}

func TestPatchPropagatesW02CompletenessAndClassification(t *testing.T) {
	srv, _ := newTestServer(t)
	// Create with a missing oracle so the run is initially incomplete.
	incomplete := completeW02Artifacts(t)
	incomplete.OracleComparison = nil

	res := postJSON(t, srv.URL+"/v0/packs", CreateInput{
		RunID:     "run-w02-patch",
		Wave:      WaveW02,
		Artifacts: incomplete,
	})
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("expected 201; got %d", res.StatusCode)
	}
	var created EvidencePackManifest
	if err := json.NewDecoder(res.Body).Decode(&created); err != nil {
		t.Fatalf("decode: %v", err)
	}
	_ = res.Body.Close()
	if created.CompletenessStatus != CompletenessStatusEvidenceIncomplete {
		t.Fatalf("baseline expected evidence_incomplete; got %s", created.CompletenessStatus)
	}

	// PATCH with the oracle and the run becomes complete + success.
	full := completeW02Artifacts(t)
	patchRes := patchJSON(t, srv.URL+"/v0/packs/"+created.PackID, PatchInput{
		Artifacts: &Artifacts{OracleComparison: full.OracleComparison},
	})
	if patchRes.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 on PATCH; got %d", patchRes.StatusCode)
	}
	var patched EvidencePackManifest
	if err := json.NewDecoder(patchRes.Body).Decode(&patched); err != nil {
		t.Fatalf("decode: %v", err)
	}
	_ = patchRes.Body.Close()
	if patched.CompletenessStatus != CompletenessStatusComplete {
		t.Fatalf("expected completenessStatus=complete after PATCH; got %s", patched.CompletenessStatus)
	}
	if patched.Classification != ClassificationSuccess {
		t.Fatalf("expected classification=success after PATCH; got %s", patched.Classification)
	}
}

func containsString(haystack []string, needle string) bool {
	for _, s := range haystack {
		if s == needle {
			return true
		}
	}
	return false
}
