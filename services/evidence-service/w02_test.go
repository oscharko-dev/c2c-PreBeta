package main

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
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
	sourceMetadataRef := mustRef(t, "urn:c2c/source-ref/HELLO", map[string]string{"sourceRef": "normalized"})
	parseOutputRef := mustRef(t, "urn:c2c/parse-output/HELLO", map[string]string{"status": "ok"})
	transformationLedgerRef := mustRef(t, "urn:c2c/trajectory/run-1/transformation", map[string]string{"role": "transformation"})
	verificationLedgerRef := mustRef(t, "urn:c2c/trajectory/run-1/verification", map[string]string{"role": "verification-repair"})
	transformationModelLedgerRef := mustRef(t, "urn:c2c/model-invocation/inv-run-1-transformation", map[string]string{"role": "transformation"})
	repairModelLedgerRef := mustRef(t, "urn:c2c/model-invocation/inv-run-1-repair-1", map[string]string{"role": "verification-repair"})
	oracleExpectedRef := mustRef(t, "urn:c2c/oracle/HELLO/expected", "Hello")
	oracleActualRef := mustRef(t, "urn:c2c/oracle/HELLO/actual", "Hello")
	transformationModelRef := ModelInvocationRef{
		InvocationID: "inv-run-1-transformation",
		ModelID:      "model-x",
		Provider:     "foundry-development",
		Status:       "completed",
		AgentRole:    AgentRoleTransformation,
		LedgerRef:    transformationModelLedgerRef,
	}
	repairModelRef := ModelInvocationRef{
		InvocationID: "inv-run-1-repair-1",
		ModelID:      "model-x",
		Provider:     "foundry-development",
		Status:       "completed",
		AgentRole:    AgentRoleVerificationRepair,
		LedgerRef:    repairModelLedgerRef,
	}

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
	base.GeneratedJava = &DataReference{
		URI:      final.URI,
		SHA256:   final.SHA256,
		ByteSize: final.ByteSize,
		MIMEType: final.MIMEType,
		Kind:     final.Kind,
	}
	base.FinalJavaArtifact = &final
	base.SourceMetadata = &sourceMetadataRef
	base.ParseOutput = &parseOutputRef
	base.RepairAttempts = []RepairAttempt{{
		AttemptNumber:       1,
		Decision:            RepairDecisionProposeCandidate,
		DecisionRef:         &repairDecisionRef,
		ModelInvocationRef:  &repairModelRef,
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
	base.ModelInvocations = []ModelInvocationRef{
		transformationModelRef,
		repairModelRef,
	}

	// Issue #217 (W0.3-6): every complete W0.2 fixture must carry the
	// assist-decision lineage and the bounded-budget summary so the
	// extended required-artifact set evaluates as OK. Budgets reflect the
	// W0.3-5 defaults: one assist activation consumed, two repair
	// iterations available with one used, six model invocations available
	// with two used (one transformation + one repair).
	base.AssistDecision = &AssistDecisionLineage{
		Outcome:                       AssistOutcomeRequired,
		ReasonCode:                    AssistReasonBaselineOpenAssumptions,
		DecidedAt:                     "2026-05-17T00:00:00Z",
		SelectedAgentRole:             AssistAgentRoleTransformation,
		Rationale:                     "deterministic baseline emitted openAssumptions; assist required",
		AssistBudgetSnapshot:          &BudgetSnapshot{Limit: 1, Used: 1, Remaining: 0},
		RepairBudgetSnapshot:          &BudgetSnapshot{Limit: 2, Used: 0, Remaining: 2},
		ModelInvocationBudgetSnapshot: &BudgetSnapshot{Limit: 6, Used: 1, Remaining: 5},
	}
	base.BudgetSummary = &BudgetSummary{
		Repair:          BudgetSnapshot{Limit: 2, Used: 1, Remaining: 1},
		Assist:          BudgetSnapshot{Limit: 1, Used: 1, Remaining: 0},
		ModelInvocation: BudgetSnapshot{Limit: 6, Used: 2, Remaining: 4},
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
		"sourceMetadata":         true,
		"parseOutput":            true,
		"semanticIr":             true,
		"generatedJava":          true,
		"generatedJavaArtifacts": true,
		"finalJavaArtifact":      true,
		"runtimeVersion":         true,
		"buildTestResults":       true,
		"oracleComparison":       true,
		"harnessEvents":          true,
		"modelInvocations":       true,
		"agentTrajectories":      true,
		// Issue #217 (W0.3-6):
		"assistDecision": true,
		"budgetSummary":  true,
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

func TestEvaluateValidationW02FailsClosedOnMissingGeneratedJava(t *testing.T) {
	a := completeW02Artifacts(t)
	a.GeneratedJava = nil

	v := EvaluateValidationForWave(&a, WaveW02)
	if v.OK {
		t.Fatalf("expected validation to fail when generatedJava is missing")
	}
	if v.CompletenessStatus != CompletenessStatusEvidenceIncomplete {
		t.Fatalf("expected completenessStatus=evidence_incomplete; got %s", v.CompletenessStatus)
	}
	if !containsString(v.MissingArtifacts, "generatedJava") {
		t.Fatalf("missingArtifacts must call out generatedJava; got %v", v.MissingArtifacts)
	}
}

func TestEvaluateValidationW02FailsClosedOnMissingSourceMetadataParseOutputRuntimeVersion(t *testing.T) {
	cases := []struct {
		name    string
		mutate  func(*Artifacts)
		missing string
	}{
		{
			name:    "sourceMetadata",
			mutate:  func(a *Artifacts) { a.SourceMetadata = nil },
			missing: "sourceMetadata",
		},
		{
			name:    "parseOutput",
			mutate:  func(a *Artifacts) { a.ParseOutput = nil },
			missing: "parseOutput",
		},
		{
			name:    "runtimeVersion",
			mutate:  func(a *Artifacts) { a.RuntimeVersion = nil },
			missing: "runtimeVersion",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			a := completeW02Artifacts(t)
			tc.mutate(&a)

			v := EvaluateValidationForWave(&a, WaveW02)
			if v.OK {
				t.Fatalf("expected validation to fail when %s is missing", tc.missing)
			}
			if v.CompletenessStatus != CompletenessStatusEvidenceIncomplete {
				t.Fatalf("expected completenessStatus=evidence_incomplete; got %s", v.CompletenessStatus)
			}
			if !containsString(v.MissingArtifacts, tc.missing) {
				t.Fatalf("missingArtifacts must call out %s; got %v", tc.missing, v.MissingArtifacts)
			}
		})
	}
}

func TestEvaluateValidationW02FailsClosedWhenLegacyGeneratedJavaDivergesFromFinal(t *testing.T) {
	a := completeW02Artifacts(t)
	mismatched := mustRef(t, "urn:c2c/generated/legacy-divergent.java", "legacy-divergent")
	a.GeneratedJava = &mismatched

	v := EvaluateValidationForWave(&a, WaveW02)
	if v.OK {
		t.Fatalf("expected validation to fail when generatedJava diverges from finalJavaArtifact")
	}
	if !containsString(v.MissingArtifacts, "generatedJava.finalJavaArtifact") {
		t.Fatalf("missingArtifacts must call out generated/final mismatch; got %v", v.MissingArtifacts)
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

func TestEvaluateValidationW02FailsClosedWhenProductiveInvocationRoleMissing(t *testing.T) {
	a := completeW02Artifacts(t)
	a.ModelInvocations = a.ModelInvocations[:1]

	v := EvaluateValidationForWave(&a, WaveW02)
	if v.OK {
		t.Fatalf("expected validation to fail when verification-repair model invocation is missing")
	}
	if !containsString(v.MissingArtifacts, "modelInvocations.verification-repair") {
		t.Fatalf("missingArtifacts must call out missing repair model invocation; got %v", v.MissingArtifacts)
	}
}

func TestEvaluateValidationW02FailsClosedWhenRepairAttemptMissingModelInvocation(t *testing.T) {
	a := completeW02Artifacts(t)
	a.RepairAttempts[0].ModelInvocationRef = nil

	v := EvaluateValidationForWave(&a, WaveW02)
	if v.OK {
		t.Fatalf("expected validation to fail when repair attempt lacks modelInvocationRef")
	}
	if !containsString(v.MissingArtifacts, "repairAttempts[0].modelInvocationRef") {
		t.Fatalf("missingArtifacts must call out repair attempt model invocation; got %v", v.MissingArtifacts)
	}
}

func TestEvaluateValidationW02FailsClosedWhenRepairAttemptReferencesWrongAgentRole(t *testing.T) {
	a := completeW02Artifacts(t)
	a.RepairAttempts[0].ModelInvocationRef = &a.ModelInvocations[0]

	v := EvaluateValidationForWave(&a, WaveW02)
	if v.OK {
		t.Fatalf("expected validation to fail when repair attempt references transformation invocation")
	}
	if !containsString(v.MissingArtifacts, "repairAttempts[0].modelInvocationRef.agentRole") {
		t.Fatalf("missingArtifacts must call out repair attempt model invocation role; got %v", v.MissingArtifacts)
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
	artifacts.GeneratedJava = nil
	artifacts.FinalJavaArtifact = nil
	for i := range artifacts.GeneratedJavaArtifacts {
		artifacts.GeneratedJavaArtifacts[i].Selected = false
	}

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

func TestCreatePackW02BlockedRunRejectsFinalJavaRefs(t *testing.T) {
	srv, _ := newTestServer(t)
	for _, tc := range []struct {
		name    string
		runID   string
		mutate  func(*Artifacts)
		message string
	}{
		{
			name:  "legacy generatedJava",
			runID: "run-w02-blocked-invalid-generated-java",
			mutate: func(a *Artifacts) {
				a.FinalJavaArtifact = nil
				for i := range a.GeneratedJavaArtifacts {
					a.GeneratedJavaArtifacts[i].Selected = false
				}
			},
			message: "generatedJava",
		},
		{
			name:  "finalJavaArtifact",
			runID: "run-w02-blocked-invalid-final-java",
			mutate: func(a *Artifacts) {
				a.GeneratedJava = nil
				for i := range a.GeneratedJavaArtifacts {
					a.GeneratedJavaArtifacts[i].Selected = false
				}
			},
			message: "finalJavaArtifact",
		},
		{
			name:  "selected candidate",
			runID: "run-w02-blocked-invalid-selected",
			mutate: func(a *Artifacts) {
				a.GeneratedJava = nil
				a.FinalJavaArtifact = nil
			},
			message: "selected",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			artifacts := completeW02Artifacts(t)
			tc.mutate(&artifacts)
			res := postJSON(t, srv.URL+"/v0/packs", CreateInput{
				RunID:     tc.runID,
				Wave:      WaveW02,
				Blocked:   true,
				Artifacts: artifacts,
			})
			if res.StatusCode != http.StatusBadRequest {
				t.Fatalf("expected 400 for blocked pack carrying %s; got %d", tc.message, res.StatusCode)
			}
			var body map[string]string
			_ = json.NewDecoder(res.Body).Decode(&body)
			_ = res.Body.Close()
			if !strings.Contains(body["error"], tc.message) {
				t.Fatalf("expected error to mention %s; got %v", tc.message, body)
			}
		})
	}
}

func TestPatchPackW02BlockedNormalizesFinalJavaRefs(t *testing.T) {
	srv, _ := newTestServer(t)
	res := postJSON(t, srv.URL+"/v0/packs", CreateInput{
		RunID:     "run-w02-patch-blocked",
		Wave:      WaveW02,
		Artifacts: completeW02Artifacts(t),
	})
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("expected 201; got %d", res.StatusCode)
	}
	var created EvidencePackManifest
	if err := json.NewDecoder(res.Body).Decode(&created); err != nil {
		t.Fatalf("decode create: %v", err)
	}
	_ = res.Body.Close()
	if created.Artifacts.GeneratedJava == nil || created.Artifacts.FinalJavaArtifact == nil {
		t.Fatalf("complete fixture should start with authoritative Java refs")
	}

	res = patchJSON(t, srv.URL+"/v0/packs/"+created.PackID, PatchInput{Blocked: ptr(true)})
	if res.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 after blocked patch; got %d", res.StatusCode)
	}
	var patched EvidencePackManifest
	if err := json.NewDecoder(res.Body).Decode(&patched); err != nil {
		t.Fatalf("decode patch: %v", err)
	}
	_ = res.Body.Close()

	if patched.Classification != ClassificationBlocked {
		t.Fatalf("expected classification=blocked; got %s", patched.Classification)
	}
	if patched.CompletenessStatus != CompletenessStatusBlocked {
		t.Fatalf("expected completenessStatus=blocked; got %s", patched.CompletenessStatus)
	}
	if patched.Artifacts.GeneratedJava != nil {
		t.Fatalf("blocked patch must clear generatedJava")
	}
	if patched.Artifacts.FinalJavaArtifact != nil {
		t.Fatalf("blocked patch must clear finalJavaArtifact")
	}
	for i, candidate := range patched.Artifacts.GeneratedJavaArtifacts {
		if candidate.Selected {
			t.Fatalf("blocked patch must clear selected candidate at index %d", i)
		}
	}
}

func TestCreatePackW02RejectsMissingModelInvocationMetadata(t *testing.T) {
	srv, _ := newTestServer(t)
	artifacts := completeW02Artifacts(t)
	artifacts.ModelInvocations[0].InvocationID = ""

	res := postJSON(t, srv.URL+"/v0/packs", CreateInput{
		RunID:     "run-w02-missing-model-invocation",
		Wave:      WaveW02,
		CreatedBy: "orchestrator",
		Artifacts: artifacts,
	})
	if res.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected 400 on missing model invocation metadata; got %d", res.StatusCode)
	}
	_ = res.Body.Close()
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

func TestSecretScrubRejectsEnvDerivedValueInModelInvocation(t *testing.T) {
	a := completeW02Artifacts(t)
	a.ModelInvocations[0].PolicyID = "AWS_SECRET_ACCESS_KEY=" + strings.Repeat("A", 24)
	err := a.ModelInvocations[0].Validate("artifacts.modelInvocations[0]")
	if err == nil {
		t.Fatalf("expected validation to reject env-derived credential-shaped value")
	}
	if !strings.Contains(err.Error(), "secret") {
		t.Fatalf("expected secret-rejection message; got %v", err)
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

// --- Issue #217 (W0.3-6) ---------------------------------------------------

func TestEvaluateValidationW02FailsClosedOnMissingAssistDecision(t *testing.T) {
	a := completeW02Artifacts(t)
	a.AssistDecision = nil

	v := EvaluateValidationForWave(&a, WaveW02)
	if v.OK {
		t.Fatalf("expected validation to fail when assistDecision is missing")
	}
	if !containsString(v.MissingArtifacts, "assistDecision") {
		t.Fatalf("missingArtifacts must call out assistDecision; got %v", v.MissingArtifacts)
	}
}

func TestEvaluateValidationW02FailsClosedOnMissingBudgetSummary(t *testing.T) {
	a := completeW02Artifacts(t)
	a.BudgetSummary = nil

	v := EvaluateValidationForWave(&a, WaveW02)
	if v.OK {
		t.Fatalf("expected validation to fail when budgetSummary is missing")
	}
	if !containsString(v.MissingArtifacts, "budgetSummary") {
		t.Fatalf("missingArtifacts must call out budgetSummary; got %v", v.MissingArtifacts)
	}
}

func TestAssistDecisionRejectsUnknownReasonCode(t *testing.T) {
	a := completeW02Artifacts(t)
	a.AssistDecision.ReasonCode = "totally_made_up"

	if err := validateArtifactsShape(&a); err == nil {
		t.Fatalf("expected validation to reject unknown assist-decision reason code")
	}
}

func TestAssistDecisionRequiresSelectedAgentRoleWhenRequired(t *testing.T) {
	a := completeW02Artifacts(t)
	a.AssistDecision.SelectedAgentRole = ""

	if err := validateArtifactsShape(&a); err == nil {
		t.Fatalf("expected assist_required without selectedAgentRole to fail validation")
	}
}

func TestAssistDecisionAssistBudgetExhaustedForcesNotRequired(t *testing.T) {
	a := completeW02Artifacts(t)
	a.AssistDecision.Outcome = AssistOutcomeRequired
	a.AssistDecision.ReasonCode = AssistReasonAssistBudgetExhausted
	a.AssistDecision.SelectedAgentRole = AssistAgentRoleTransformation

	if err := validateArtifactsShape(&a); err == nil {
		t.Fatalf("expected assist_budget_exhausted to force outcome=assist_not_required")
	}
}

func TestEvaluateValidationW02FlagsBudgetUsageRegression(t *testing.T) {
	a := completeW02Artifacts(t)
	// End-of-run consumption falls BELOW the assist gate-time snapshot.
	a.BudgetSummary.Assist = BudgetSnapshot{Limit: 1, Used: 0, Remaining: 1}

	v := EvaluateValidationForWave(&a, WaveW02)
	if v.OK {
		t.Fatalf("expected regression to fail validation")
	}
	if !containsString(v.MissingArtifacts, "budgetSummary.assist.usedRegression") {
		t.Fatalf("missingArtifacts must call out usedRegression; got %v", v.MissingArtifacts)
	}
}

func TestEvaluateValidationW02FlagsMissingTransformationInvocationWhenAssistSelectedTransformation(t *testing.T) {
	a := completeW02Artifacts(t)
	// Strip the transformation-role invocation, keep only the repair one.
	for i, inv := range a.ModelInvocations {
		if inv.AgentRole == AgentRoleTransformation {
			a.ModelInvocations = append(a.ModelInvocations[:i], a.ModelInvocations[i+1:]...)
			break
		}
	}

	v := EvaluateValidationForWave(&a, WaveW02)
	if v.OK {
		t.Fatalf("expected missing transformation invocation under assist_required to fail")
	}
	if !containsString(v.MissingArtifacts, "assistDecision.modelInvocations.transformation") {
		t.Fatalf("missingArtifacts must call out assistDecision.modelInvocations.transformation; got %v", v.MissingArtifacts)
	}
}

func TestBudgetSnapshotRejectsInconsistentRemaining(t *testing.T) {
	snap := BudgetSnapshot{Limit: 5, Used: 2, Remaining: 99}
	if err := snap.Validate("budget"); err == nil {
		t.Fatalf("expected mismatched remaining to fail validation")
	}
}

func TestCreatePackW02BlockedRunRelaxesAssistDecisionRequirementWhenPreGate(t *testing.T) {
	// A run blocked BEFORE the assist-decision gate fires (no productive
	// agent trajectories, no repair attempts, no transformation/repair
	// invocations) legitimately has no AssistDecision. budgetSummary stays
	// mandatory because the budgets always exist on a contract.
	srv, _ := newTestServer(t)
	artifacts := completeW02Artifacts(t)
	artifacts.OracleComparison.Matched = false
	artifacts.GeneratedJava = nil
	artifacts.FinalJavaArtifact = nil
	for i := range artifacts.GeneratedJavaArtifacts {
		artifacts.GeneratedJavaArtifacts[i].Selected = false
	}
	artifacts.AssistDecision = nil // legitimate: blocked before the gate
	// Clear all post-gate signals so runReachedAssistGate returns false.
	artifacts.RepairAttempts = nil
	artifacts.AgentTrajectories = []AgentTrajectoryRef{
		{AgentRole: AgentRoleOrchestrator, LedgerRef: mustRef(t, "urn:c2c/trajectory/run-pre-gate/orch", map[string]string{"role": "orchestrator"})},
	}
	// Strip productive model invocations; keep at least one entry so the
	// modelInvocations required-set check still passes.
	artifacts.ModelInvocations = []ModelInvocationRef{{
		InvocationID: "inv-pre-gate-skipped",
		ModelID:      "none",
		Status:       "skipped",
		LedgerRef:    mustRef(t, "urn:c2c/model-invocation/inv-pre-gate-skipped", map[string]string{"status": "skipped"}),
	}}

	res := postJSON(t, srv.URL+"/v0/packs", CreateInput{
		RunID:     "run-w02-blocked-pre-gate",
		Wave:      WaveW02,
		Blocked:   true,
		Artifacts: artifacts,
	})
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("expected 201 for blocked pre-gate pack; got %d", res.StatusCode)
	}
	var manifest EvidencePackManifest
	if err := json.NewDecoder(res.Body).Decode(&manifest); err != nil {
		t.Fatalf("decode: %v", err)
	}
	_ = res.Body.Close()
	if manifest.Classification != ClassificationBlocked {
		t.Fatalf("expected classification=blocked; got %s", manifest.Classification)
	}
	if manifest.CompletenessStatus != CompletenessStatusBlocked {
		t.Fatalf("expected completenessStatus=blocked; got %s", manifest.CompletenessStatus)
	}
	if containsString(manifest.Validation.MissingArtifacts, "assistDecision") {
		t.Fatalf("blocked pre-gate pack must not flag assistDecision as missing; got %v", manifest.Validation.MissingArtifacts)
	}
}

func TestCreatePackW02BlockedRunPostGateStillRequiresAssistDecision(t *testing.T) {
	// A blocked run that has post-gate signals (transformation trajectory,
	// repair attempts, or productive model invocations) MUST still record
	// the assist-decision — the gate fired, so the decision exists.
	srv, _ := newTestServer(t)
	artifacts := completeW02Artifacts(t)
	artifacts.OracleComparison.Matched = false
	artifacts.GeneratedJava = nil
	artifacts.FinalJavaArtifact = nil
	for i := range artifacts.GeneratedJavaArtifacts {
		artifacts.GeneratedJavaArtifacts[i].Selected = false
	}
	artifacts.AssistDecision = nil // illegitimate: gate fired (trajectories present)

	res := postJSON(t, srv.URL+"/v0/packs", CreateInput{
		RunID:     "run-w02-blocked-post-gate",
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
	if !containsString(manifest.Validation.MissingArtifacts, "assistDecision") {
		t.Fatalf("blocked post-gate pack without assistDecision must still flag it; got %v", manifest.Validation.MissingArtifacts)
	}
}

func TestAssistDecisionRequiresAllThreeBudgetSnapshots(t *testing.T) {
	// Issue #217: every recorded assist-decision must carry all three
	// gate-time budget snapshots (repair, assist, modelInvocation). The
	// orchestrator's gate samples all three before recording the decision.
	a := completeW02Artifacts(t)
	a.AssistDecision.AssistBudgetSnapshot = nil
	if err := validateArtifactsShape(&a); err == nil {
		t.Fatalf("expected validation to require assistBudgetSnapshot on assistDecision")
	}
}

func TestCreatePackW02BlockedRunStillRequiresBudgetSummary(t *testing.T) {
	srv, _ := newTestServer(t)
	artifacts := completeW02Artifacts(t)
	artifacts.OracleComparison.Matched = false
	artifacts.GeneratedJava = nil
	artifacts.FinalJavaArtifact = nil
	for i := range artifacts.GeneratedJavaArtifacts {
		artifacts.GeneratedJavaArtifacts[i].Selected = false
	}
	artifacts.AssistDecision = nil
	artifacts.BudgetSummary = nil

	res := postJSON(t, srv.URL+"/v0/packs", CreateInput{
		RunID:     "run-w02-blocked-no-budget",
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
	if !containsString(manifest.Validation.MissingArtifacts, "budgetSummary") {
		t.Fatalf("blocked pack without budgetSummary must still flag it; got %v", manifest.Validation.MissingArtifacts)
	}
}

// --- ADR 0007 (Issue #279) — manualEditOverlay ----------------------------

// mustManualEditOverlay builds a content-addressed overlay reference for tests.
// The payload mirrors the ADR 0007 §3 shape; evidence-service does not crack
// the JSON body apart so the helper keeps it minimal.
func mustManualEditOverlay(t *testing.T, runID string, regionCount int) ManualEditOverlayRef {
	t.Helper()
	overlay := map[string]any{
		"schemaVersion": SchemaVersionV0,
		"regions":       []any{},
	}
	ref, err := NewDataReference(
		"urn:c2c/manual-edit-overlay/"+runID,
		overlay,
		"application/json",
		"manual-edit-overlay",
	)
	if err != nil {
		t.Fatalf("build overlay reference: %v", err)
	}
	return ManualEditOverlayRef{
		URI:           ref.URI,
		SHA256:        ref.SHA256,
		ByteSize:      ref.ByteSize,
		MIMEType:      ref.MIMEType,
		Kind:          ref.Kind,
		SchemaVersion: SchemaVersionV0,
		RegionCount:   regionCount,
	}
}

func TestManualEditOverlayRefValidateRejectsZeroRegionCount(t *testing.T) {
	overlay := mustManualEditOverlay(t, "run-mer-1", 0)
	if err := overlay.Validate("artifacts.manualEditOverlay"); err == nil {
		t.Fatalf("expected validation to reject overlay with regionCount=0")
	} else if !strings.Contains(err.Error(), "regionCount") {
		t.Fatalf("expected regionCount-targeted error; got %v", err)
	}
}

func TestManualEditOverlayRefValidateRejectsForeignSchemaVersion(t *testing.T) {
	overlay := mustManualEditOverlay(t, "run-mer-2", 1)
	overlay.SchemaVersion = "v1"
	if err := overlay.Validate("artifacts.manualEditOverlay"); err == nil {
		t.Fatalf("expected validation to reject non-v0 schemaVersion")
	} else if !strings.Contains(err.Error(), "schemaVersion") {
		t.Fatalf("expected schemaVersion-targeted error; got %v", err)
	}
}

func TestManualEditOverlayRefValidateRejectsSecretBearingURI(t *testing.T) {
	overlay := mustManualEditOverlay(t, "run-mer-3", 1)
	overlay.URI = "https://artifacts.example/overlay?token=" + "s" + "k-" + strings.Repeat("A", 20)
	err := overlay.Validate("artifacts.manualEditOverlay")
	if err == nil {
		t.Fatalf("expected validation to reject secret-bearing overlay URI")
	}
	if !strings.Contains(err.Error(), "secret") {
		t.Fatalf("expected secret rejection; got %v", err)
	}
}

func TestCreatePackW02PersistsManualEditOverlayWhenCarriedOver(t *testing.T) {
	srv, _ := newTestServer(t)
	artifacts := completeW02Artifacts(t)
	overlay := mustManualEditOverlay(t, "run-w02-overlay-1", 3)
	artifacts.ManualEditOverlay = &overlay

	res := postJSON(t, srv.URL+"/v0/packs", CreateInput{
		RunID:                  "run-w02-overlay-1",
		Wave:                   WaveW02,
		CreatedBy:              "orchestrator",
		Artifacts:              artifacts,
		ManualEditsCarriedOver: true,
		ManualDriftRegionCount: 3,
	})
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("expected 201; got %d", res.StatusCode)
	}
	var manifest EvidencePackManifest
	if err := json.NewDecoder(res.Body).Decode(&manifest); err != nil {
		t.Fatalf("decode: %v", err)
	}
	_ = res.Body.Close()
	if !manifest.ManualEditsCarriedOver {
		t.Fatalf("expected manifest to record manualEditsCarriedOver=true")
	}
	if manifest.ManualDriftRegionCount != 3 {
		t.Fatalf("expected manualDriftRegionCount=3; got %d", manifest.ManualDriftRegionCount)
	}
	if manifest.Artifacts.ManualEditOverlay == nil {
		t.Fatalf("expected artifacts.manualEditOverlay to be persisted")
	}
	if manifest.Artifacts.ManualEditOverlay.RegionCount != 3 {
		t.Fatalf("expected persisted overlay.regionCount=3; got %d", manifest.Artifacts.ManualEditOverlay.RegionCount)
	}
	if manifest.Artifacts.ManualEditOverlay.SHA256 != overlay.SHA256 {
		t.Fatalf("expected persisted overlay sha256 to match submitted ref")
	}
	if manifest.Classification != ClassificationSuccess {
		t.Fatalf("expected classification=success on complete run; got %s", manifest.Classification)
	}
	if manifest.CompletenessStatus != CompletenessStatusComplete {
		t.Fatalf("expected completenessStatus=complete; got %s", manifest.CompletenessStatus)
	}
}

func TestCreatePackW02RejectsCarriedOverWithoutOverlay(t *testing.T) {
	srv, _ := newTestServer(t)
	artifacts := completeW02Artifacts(t)

	res := postJSON(t, srv.URL+"/v0/packs", CreateInput{
		RunID:                  "run-w02-overlay-missing",
		Wave:                   WaveW02,
		Artifacts:              artifacts,
		ManualEditsCarriedOver: true,
		ManualDriftRegionCount: 2,
	})
	if res.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected 400 when carried_over=true and overlay missing; got %d", res.StatusCode)
	}
	var body map[string]string
	_ = json.NewDecoder(res.Body).Decode(&body)
	_ = res.Body.Close()
	if !strings.Contains(body["error"], "manualEditOverlay") {
		t.Fatalf("expected error to call out manualEditOverlay; got %q", body["error"])
	}
}

func TestCreatePackW02RejectsOverlayWithoutCarriedOver(t *testing.T) {
	srv, _ := newTestServer(t)
	artifacts := completeW02Artifacts(t)
	overlay := mustManualEditOverlay(t, "run-w02-overlay-orphan", 1)
	artifacts.ManualEditOverlay = &overlay

	res := postJSON(t, srv.URL+"/v0/packs", CreateInput{
		RunID:     "run-w02-overlay-orphan",
		Wave:      WaveW02,
		Artifacts: artifacts,
		// ManualEditsCarriedOver intentionally false / unset.
	})
	if res.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected 400 when overlay present but carried_over=false; got %d", res.StatusCode)
	}
	var body map[string]string
	_ = json.NewDecoder(res.Body).Decode(&body)
	_ = res.Body.Close()
	if !strings.Contains(body["error"], "manualEditOverlay") {
		t.Fatalf("expected error to call out manualEditOverlay; got %q", body["error"])
	}
}

func TestCreatePackW02RejectsRegionCountMismatch(t *testing.T) {
	srv, _ := newTestServer(t)
	artifacts := completeW02Artifacts(t)
	overlay := mustManualEditOverlay(t, "run-w02-overlay-mismatch", 5)
	artifacts.ManualEditOverlay = &overlay

	res := postJSON(t, srv.URL+"/v0/packs", CreateInput{
		RunID:                  "run-w02-overlay-mismatch",
		Wave:                   WaveW02,
		Artifacts:              artifacts,
		ManualEditsCarriedOver: true,
		ManualDriftRegionCount: 2, // overlay claims 5
	})
	if res.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected 400 on regionCount mismatch; got %d", res.StatusCode)
	}
	var body map[string]string
	_ = json.NewDecoder(res.Body).Decode(&body)
	_ = res.Body.Close()
	if !strings.Contains(body["error"], "regionCount") {
		t.Fatalf("expected error to call out regionCount; got %q", body["error"])
	}
}

func TestCreatePackW02RejectsCarriedOverWithZeroDrift(t *testing.T) {
	srv, _ := newTestServer(t)
	artifacts := completeW02Artifacts(t)
	overlay := mustManualEditOverlay(t, "run-w02-overlay-empty", 1)
	artifacts.ManualEditOverlay = &overlay

	res := postJSON(t, srv.URL+"/v0/packs", CreateInput{
		RunID:                  "run-w02-overlay-empty",
		Wave:                   WaveW02,
		Artifacts:              artifacts,
		ManualEditsCarriedOver: true,
		ManualDriftRegionCount: 0,
	})
	if res.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected 400 when carried_over=true and drift=0; got %d", res.StatusCode)
	}
	_ = res.Body.Close()
}

func TestEvaluateValidationForManifestFlagsMissingOverlayWhenCarriedOver(t *testing.T) {
	m := &EvidencePackManifest{
		Wave:                   WaveW02,
		Artifacts:              completeW02Artifacts(t),
		ManualEditsCarriedOver: true,
		ManualDriftRegionCount: 4,
	}
	result := EvaluateValidationForManifest(m)
	if result.OK {
		t.Fatalf("expected validation to fail when carried_over=true but overlay missing")
	}
	if !containsString(result.MissingArtifacts, "manualEditOverlay") {
		t.Fatalf("missingArtifacts must call out manualEditOverlay; got %v", result.MissingArtifacts)
	}
	if result.CompletenessStatus != CompletenessStatusEvidenceIncomplete {
		t.Fatalf("expected completenessStatus=evidence_incomplete; got %s", result.CompletenessStatus)
	}
}

func TestEvaluateValidationForManifestPassesWhenOverlayOmittedAndNotCarriedOver(t *testing.T) {
	m := &EvidencePackManifest{
		Wave:                   WaveW02,
		Artifacts:              completeW02Artifacts(t),
		ManualEditsCarriedOver: false,
		ManualDriftRegionCount: 0,
	}
	result := EvaluateValidationForManifest(m)
	if !result.OK {
		t.Fatalf("expected validation to pass when no manual edits; got missing=%v", result.MissingArtifacts)
	}
	if containsString(result.MissingArtifacts, "manualEditOverlay") {
		t.Fatalf("missingArtifacts must not list manualEditOverlay; got %v", result.MissingArtifacts)
	}
}

func TestPatchPackW02CanAddManualEditOverlay(t *testing.T) {
	srv, _ := newTestServer(t)
	// Create a complete W0.2 pack with no manual edits.
	res := postJSON(t, srv.URL+"/v0/packs", CreateInput{
		RunID:     "run-w02-patch-overlay",
		Wave:      WaveW02,
		Artifacts: completeW02Artifacts(t),
	})
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("expected 201; got %d", res.StatusCode)
	}
	var created EvidencePackManifest
	if err := json.NewDecoder(res.Body).Decode(&created); err != nil {
		t.Fatalf("decode create: %v", err)
	}
	_ = res.Body.Close()
	if created.ManualEditsCarriedOver {
		t.Fatalf("baseline must start with carried_over=false")
	}

	// PATCH adds the overlay and the carried-over signal.
	overlay := mustManualEditOverlay(t, "run-w02-patch-overlay", 2)
	carriedTrue := true
	driftTwo := 2
	patchRes := patchJSON(t, srv.URL+"/v0/packs/"+created.PackID, PatchInput{
		Artifacts:              &Artifacts{ManualEditOverlay: &overlay},
		ManualEditsCarriedOver: &carriedTrue,
		ManualDriftRegionCount: &driftTwo,
	})
	if patchRes.StatusCode != http.StatusOK {
		t.Fatalf("expected 200; got %d", patchRes.StatusCode)
	}
	var patched EvidencePackManifest
	if err := json.NewDecoder(patchRes.Body).Decode(&patched); err != nil {
		t.Fatalf("decode patch: %v", err)
	}
	_ = patchRes.Body.Close()
	if !patched.ManualEditsCarriedOver {
		t.Fatalf("expected patched.ManualEditsCarriedOver=true")
	}
	if patched.ManualDriftRegionCount != 2 {
		t.Fatalf("expected patched.ManualDriftRegionCount=2; got %d", patched.ManualDriftRegionCount)
	}
	if patched.Artifacts.ManualEditOverlay == nil {
		t.Fatalf("expected overlay to be persisted via PATCH")
	}
	if patched.Artifacts.ManualEditOverlay.RegionCount != 2 {
		t.Fatalf("expected persisted overlay.regionCount=2; got %d", patched.Artifacts.ManualEditOverlay.RegionCount)
	}
	if patched.Classification != ClassificationSuccess {
		t.Fatalf("expected classification=success after PATCH; got %s", patched.Classification)
	}
}

func TestPatchPackW02ClearsOverlayWhenCarriedOverFlippedToFalse(t *testing.T) {
	srv, _ := newTestServer(t)
	// Create a complete W0.2 pack WITH manual edits.
	artifacts := completeW02Artifacts(t)
	overlay := mustManualEditOverlay(t, "run-w02-overlay-flip", 1)
	artifacts.ManualEditOverlay = &overlay

	res := postJSON(t, srv.URL+"/v0/packs", CreateInput{
		RunID:                  "run-w02-overlay-flip",
		Wave:                   WaveW02,
		Artifacts:              artifacts,
		ManualEditsCarriedOver: true,
		ManualDriftRegionCount: 1,
	})
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("expected 201; got %d", res.StatusCode)
	}
	var created EvidencePackManifest
	_ = json.NewDecoder(res.Body).Decode(&created)
	_ = res.Body.Close()
	if created.Artifacts.ManualEditOverlay == nil {
		t.Fatalf("baseline must carry overlay")
	}

	// PATCH flips carried_over back to false; overlay must be cleared.
	carriedFalse := false
	patchRes := patchJSON(t, srv.URL+"/v0/packs/"+created.PackID, PatchInput{
		ManualEditsCarriedOver: &carriedFalse,
	})
	if patchRes.StatusCode != http.StatusOK {
		t.Fatalf("expected 200; got %d", patchRes.StatusCode)
	}
	var patched EvidencePackManifest
	_ = json.NewDecoder(patchRes.Body).Decode(&patched)
	_ = patchRes.Body.Close()
	if patched.ManualEditsCarriedOver {
		t.Fatalf("expected ManualEditsCarriedOver=false after PATCH")
	}
	if patched.ManualDriftRegionCount != 0 {
		t.Fatalf("expected ManualDriftRegionCount=0 after PATCH; got %d", patched.ManualDriftRegionCount)
	}
	if patched.Artifacts.ManualEditOverlay != nil {
		t.Fatalf("expected overlay to be cleared after PATCH; still present")
	}
}

func TestValidatePackEndpointSurfacesMissingOverlayWhenCarriedOver(t *testing.T) {
	srv, _ := newTestServer(t)
	// Create a complete W0.2 pack with no manual edits.
	res := postJSON(t, srv.URL+"/v0/packs", CreateInput{
		RunID:     "run-w02-validate-overlay",
		Wave:      WaveW02,
		Artifacts: completeW02Artifacts(t),
	})
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("expected 201; got %d", res.StatusCode)
	}
	var created EvidencePackManifest
	_ = json.NewDecoder(res.Body).Decode(&created)
	_ = res.Body.Close()

	// Flip carried_over true via PATCH WITHOUT the overlay — the store must
	// refuse. (Adding only the signal without the artifact violates the
	// consistency contract.)
	carriedTrue := true
	driftOne := 1
	patchRes := patchJSON(t, srv.URL+"/v0/packs/"+created.PackID, PatchInput{
		ManualEditsCarriedOver: &carriedTrue,
		ManualDriftRegionCount: &driftOne,
	})
	if patchRes.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected 400 when PATCH adds carried_over without overlay; got %d", patchRes.StatusCode)
	}
	_ = patchRes.Body.Close()
}

func TestManifestSchemaCarriesManualEditOverlayContract(t *testing.T) {
	body, err := os.ReadFile(filepath.Join("..", "..", "schemas", "evidence-pack-manifest-v0.json"))
	if err != nil {
		t.Fatalf("read manifest schema: %v", err)
	}
	doc := map[string]any{}
	if err := json.Unmarshal(body, &doc); err != nil {
		t.Fatalf("parse manifest schema: %v", err)
	}
	properties, _ := doc["properties"].(map[string]any)
	if _, ok := properties["manualEditsCarriedOver"]; !ok {
		t.Fatalf("schema must expose manualEditsCarriedOver at top level")
	}
	if _, ok := properties["manualDriftRegionCount"]; !ok {
		t.Fatalf("schema must expose manualDriftRegionCount at top level")
	}
	artifacts, _ := properties["artifacts"].(map[string]any)
	artifactsProps, _ := artifacts["properties"].(map[string]any)
	if _, ok := artifactsProps["manualEditOverlay"]; !ok {
		t.Fatalf("schema artifacts.manualEditOverlay missing")
	}
	defs, _ := doc["$defs"].(map[string]any)
	if _, ok := defs["manualEditOverlayRef"]; !ok {
		t.Fatalf("schema $defs/manualEditOverlayRef missing")
	}
}

func TestOpenAPICarriesManualEditOverlayContract(t *testing.T) {
	body, err := os.ReadFile("openapi.yaml")
	if err != nil {
		t.Fatalf("read openapi.yaml: %v", err)
	}
	text := string(body)
	for _, want := range []string{
		"manualEditsCarriedOver",
		"manualDriftRegionCount",
		"ManualEditOverlayRef",
		"manualEditOverlay:",
	} {
		if !strings.Contains(text, want) {
			t.Fatalf("openapi.yaml missing %q", want)
		}
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
