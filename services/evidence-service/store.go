package main

import (
	"fmt"
	"sort"
	"sync"
	"sync/atomic"
	"time"
)

type PackStore struct {
	mu    sync.RWMutex
	packs map[string]*EvidencePackManifest
	seq   atomic.Uint64
	clock func() time.Time
}

func NewPackStore() *PackStore {
	return &PackStore{
		packs: make(map[string]*EvidencePackManifest),
		clock: func() time.Time { return time.Now().UTC() },
	}
}

// CreateInput is the orchestrator-facing payload for /v0/packs. RunID is the
// only hard requirement; other fields can be filled in via PATCH as a W0 run
// accrues artifacts. Wave defaults to "w0" when omitted; orchestrators that
// run the W0.2 workflow MUST stamp wave="w0.2" so the W0.2 completeness
// rules apply (Issue #171). Blocked=true lets the orchestrator signal a
// known-failed run so classification becomes "blocked" rather than
// "evidence_incomplete".
type CreateInput struct {
	RunID               string               `json:"runId"`
	WorkflowID          string               `json:"workflowId,omitempty"`
	Wave                string               `json:"wave,omitempty"`
	Blocked             bool                 `json:"blocked,omitempty"`
	Summary             string               `json:"summary,omitempty"`
	CreatedBy           string               `json:"createdBy,omitempty"`
	Artifacts           Artifacts            `json:"artifacts"`
	OpenAssumptions     []OpenAssumption     `json:"openAssumptions,omitempty"`
	UnsupportedFeatures []UnsupportedFeature `json:"unsupportedFeatures,omitempty"`
}

func (s *PackStore) Create(input CreateInput) (*EvidencePackManifest, error) {
	if input.RunID == "" {
		return nil, fieldError("runId", "runId is required")
	}
	wave := input.Wave
	if wave == "" {
		wave = WaveW0
	}
	switch wave {
	case WaveW0, WaveW02:
	default:
		return nil, fieldError("wave", "wave must be w0 or w0.2")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	id := s.seq.Add(1)
	packID := fmt.Sprintf("epk-%s-%04d", input.RunID, id)
	manifest := &EvidencePackManifest{
		SchemaVersion:       SchemaVersionV0,
		Capability:          CapabilityEvidence,
		Service:             ServiceName,
		PackID:              packID,
		RunID:               input.RunID,
		WorkflowID:          input.WorkflowID,
		Wave:                wave,
		Summary:             input.Summary,
		CreatedAt:           s.clock(),
		CreatedBy:           input.CreatedBy,
		Artifacts:           input.Artifacts,
		OpenAssumptions:     input.OpenAssumptions,
		UnsupportedFeatures: input.UnsupportedFeatures,
	}
	manifest.Validation = EvaluateValidationForWave(&manifest.Artifacts, wave)
	if input.Blocked && wave == WaveW02 {
		manifest.Validation = relaxBlockedW02Validation(manifest.Validation)
	}
	manifest.Status = deriveStatus(manifest.Validation)
	manifest.CompletenessStatus = deriveCompletenessStatus(manifest.Validation, input.Blocked)
	manifest.Classification = deriveClassification(manifest.Validation, input.Blocked)
	manifest.Validation.CompletenessStatus = manifest.CompletenessStatus
	if input.Blocked && wave == WaveW02 {
		if err := validateBlockedW02Artifacts(manifest.Artifacts); err != nil {
			return nil, err
		}
	}
	if err := manifest.Validate(); err != nil {
		return nil, err
	}
	s.packs[packID] = manifest
	return cloneManifest(manifest), nil
}

// PatchInput captures the additive update surface exposed by PATCH
// /v0/packs/{packId}. Slices are appended; non-nil pointer fields override.
// Blocked is a tri-state hint from the orchestrator: nil means "leave the
// existing blocked classification untouched", non-nil overrides it
// (Issue #171).
type PatchInput struct {
	Summary             *string              `json:"summary,omitempty"`
	Blocked             *bool                `json:"blocked,omitempty"`
	Artifacts           *Artifacts           `json:"artifacts,omitempty"`
	OpenAssumptions     []OpenAssumption     `json:"openAssumptions,omitempty"`
	UnsupportedFeatures []UnsupportedFeature `json:"unsupportedFeatures,omitempty"`
}

func (s *PackStore) Update(packID string, patch PatchInput) (*EvidencePackManifest, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	current, ok := s.packs[packID]
	if !ok {
		return nil, fmt.Errorf("pack not found: %s", packID)
	}
	manifest := cloneManifest(current)
	if patch.Summary != nil {
		manifest.Summary = *patch.Summary
	}
	if patch.Artifacts != nil {
		mergeArtifacts(&manifest.Artifacts, patch.Artifacts)
	}
	if len(patch.OpenAssumptions) > 0 {
		manifest.OpenAssumptions = append(manifest.OpenAssumptions, patch.OpenAssumptions...)
	}
	if len(patch.UnsupportedFeatures) > 0 {
		manifest.UnsupportedFeatures = append(manifest.UnsupportedFeatures, patch.UnsupportedFeatures...)
	}
	blocked := manifest.Classification == ClassificationBlocked
	if patch.Blocked != nil {
		blocked = *patch.Blocked
	}
	if patch.Blocked != nil && *patch.Blocked && manifest.Wave == WaveW02 {
		normalizeBlockedW02Artifacts(&manifest.Artifacts)
	}
	manifest.Validation = EvaluateValidationForWave(&manifest.Artifacts, manifest.Wave)
	if blocked && manifest.Wave == WaveW02 {
		manifest.Validation = relaxBlockedW02Validation(manifest.Validation)
	}
	manifest.Status = deriveStatus(manifest.Validation)
	manifest.CompletenessStatus = deriveCompletenessStatus(manifest.Validation, blocked)
	manifest.Classification = deriveClassification(manifest.Validation, blocked)
	manifest.Validation.CompletenessStatus = manifest.CompletenessStatus
	if blocked && manifest.Wave == WaveW02 {
		if err := validateBlockedW02Artifacts(manifest.Artifacts); err != nil {
			return nil, err
		}
	}
	if err := manifest.Validate(); err != nil {
		return nil, err
	}
	s.packs[packID] = manifest
	return cloneManifest(manifest), nil
}

func (s *PackStore) Get(packID string) (*EvidencePackManifest, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	manifest, ok := s.packs[packID]
	if !ok {
		return nil, false
	}
	return cloneManifest(manifest), true
}

func (s *PackStore) List() []*EvidencePackManifest {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]*EvidencePackManifest, 0, len(s.packs))
	for _, p := range s.packs {
		out = append(out, cloneManifest(p))
	}
	sort.Slice(out, func(i, j int) bool {
		return out[i].PackID < out[j].PackID
	})
	return out
}

func (s *PackStore) RecordExport(packID string, record ExportRecord) (*EvidencePackManifest, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	manifest, ok := s.packs[packID]
	if !ok {
		return nil, fmt.Errorf("pack not found: %s", packID)
	}
	manifest.Exports = append(manifest.Exports, record)
	return cloneManifest(manifest), nil
}

func deriveStatus(v ValidationResult) string {
	if v.OK {
		return StatusComplete
	}
	return StatusIncomplete
}

// deriveCompletenessStatus (Issue #171) projects the validation result and
// the orchestrator's blocked signal into the W0.2 completenessStatus enum.
// Blocked runs are always "blocked"; missing-evidence runs are
// "evidence_incomplete"; otherwise "complete".
func deriveCompletenessStatus(v ValidationResult, blocked bool) string {
	if blocked {
		return CompletenessStatusBlocked
	}
	if v.OK {
		return CompletenessStatusComplete
	}
	return CompletenessStatusEvidenceIncomplete
}

// mergeArtifacts is additive on slices and replaces non-nil pointer/value
// fields. This matches the "PATCH accrues evidence" model the orchestrator
// expects across the W0 run lifecycle.
func mergeArtifacts(dst, src *Artifacts) {
	if len(src.SourceCobol) > 0 {
		dst.SourceCobol = append(dst.SourceCobol, src.SourceCobol...)
	}
	if src.SourceMetadata != nil {
		ref := *src.SourceMetadata
		dst.SourceMetadata = &ref
	}
	if src.CorpusMetadata != nil {
		ref := *src.CorpusMetadata
		dst.CorpusMetadata = &ref
	}
	if src.ParseOutput != nil {
		ref := *src.ParseOutput
		dst.ParseOutput = &ref
	}
	if src.SemanticIR != nil {
		ref := *src.SemanticIR
		dst.SemanticIR = &ref
	}
	if len(src.TransformationPasses) > 0 {
		dst.TransformationPasses = append(dst.TransformationPasses, src.TransformationPasses...)
	}
	if src.GeneratedJava != nil {
		ref := *src.GeneratedJava
		dst.GeneratedJava = &ref
	}
	if len(src.GeneratedJavaArtifacts) > 0 {
		dst.GeneratedJavaArtifacts = append(dst.GeneratedJavaArtifacts, src.GeneratedJavaArtifacts...)
	}
	if src.FinalJavaArtifact != nil {
		candidate := *src.FinalJavaArtifact
		dst.FinalJavaArtifact = &candidate
	}
	if len(src.RepairAttempts) > 0 {
		dst.RepairAttempts = append(dst.RepairAttempts, src.RepairAttempts...)
	}
	if len(src.AgentTrajectories) > 0 {
		dst.AgentTrajectories = append(dst.AgentTrajectories, src.AgentTrajectories...)
	}
	if src.OracleComparison != nil {
		comparison := *src.OracleComparison
		if comparison.ExpectedRef != nil {
			ref := *comparison.ExpectedRef
			comparison.ExpectedRef = &ref
		}
		if comparison.ActualRef != nil {
			ref := *comparison.ActualRef
			comparison.ActualRef = &ref
		}
		if comparison.BuildTestResultRef != nil {
			ref := *comparison.BuildTestResultRef
			comparison.BuildTestResultRef = &ref
		}
		dst.OracleComparison = &comparison
	}
	if src.RuntimeVersion != nil {
		version := *src.RuntimeVersion
		if version.Ref != nil {
			ref := *version.Ref
			version.Ref = &ref
		}
		dst.RuntimeVersion = &version
	}
	if len(src.ModelInvocations) > 0 {
		dst.ModelInvocations = append(dst.ModelInvocations, src.ModelInvocations...)
	}
	if len(src.BuildTestResults) > 0 {
		dst.BuildTestResults = append(dst.BuildTestResults, src.BuildTestResults...)
	}
	if len(src.SBOM) > 0 {
		dst.SBOM = append(dst.SBOM, src.SBOM...)
	}
	if len(src.LicenseReports) > 0 {
		dst.LicenseReports = append(dst.LicenseReports, src.LicenseReports...)
	}
	if src.HarnessEvents != nil {
		ref := *src.HarnessEvents
		dst.HarnessEvents = &ref
	}
	if src.TrajectoryLedger != nil {
		ref := *src.TrajectoryLedger
		dst.TrajectoryLedger = &ref
	}
	if len(src.ExperienceEvents) > 0 {
		dst.ExperienceEvents = append(dst.ExperienceEvents, src.ExperienceEvents...)
	}
	if src.AssistDecision != nil {
		dst.AssistDecision = cloneAssistDecision(src.AssistDecision)
	}
	if src.BudgetSummary != nil {
		summary := *src.BudgetSummary
		dst.BudgetSummary = &summary
	}
}

func validateBlockedW02Artifacts(a Artifacts) error {
	if a.GeneratedJava != nil && !a.GeneratedJava.IsZero() {
		return fieldError("artifacts.generatedJava", "blocked W0.2 packs must not declare generatedJava")
	}
	if a.FinalJavaArtifact != nil && !a.FinalJavaArtifact.IsZero() {
		return fieldError("artifacts.finalJavaArtifact", "blocked W0.2 packs must not declare finalJavaArtifact")
	}
	for i, candidate := range a.GeneratedJavaArtifacts {
		if candidate.Selected {
			return fieldError(fmt.Sprintf("artifacts.generatedJavaArtifacts[%d].selected", i), "blocked W0.2 packs must not mark a Java candidate as selected")
		}
	}
	return nil
}

// blockedW02RelaxedRequirements (Issue #217) lists the W0.2 required-artifact
// names that are LEGITIMATELY absent on a blocked pack: a run can terminate
// before the deterministic generator, the build/test gate, or the assist-
// decision gate ever runs. The blocked pack still records its lineage via
// budgetSummary and (when available) assistDecision, but absence of these
// other fields does not force evidence_incomplete on top of "blocked".
//
// budgetSummary stays mandatory on every W0.2 pack so reviewers can always
// see the bounded budgets observed during the run.
var blockedW02RelaxedRequirements = map[string]struct{}{
	"generatedJava":          {},
	"generatedJavaArtifacts": {},
	"finalJavaArtifact":      {},
	"buildTestResults":       {},
	"oracleComparison":       {},
	"assistDecision":         {},
}

// relaxBlockedW02Validation drops "missingArtifacts" entries that are
// legitimately absent on a blocked W0.2 pack (Issue #217). The validation
// stays "OK=false" if any other artifact is missing, but absence of pre-gate
// artifacts on a blocked run no longer forces a second-degree
// "evidence_incomplete" label on top of "blocked".
func relaxBlockedW02Validation(v ValidationResult) ValidationResult {
	filtered := make([]string, 0, len(v.MissingArtifacts))
	for _, name := range v.MissingArtifacts {
		if _, relaxed := blockedW02RelaxedRequirements[name]; relaxed {
			continue
		}
		filtered = append(filtered, name)
	}
	v.MissingArtifacts = filtered
	v.OK = len(filtered) == 0
	if v.OK {
		v.Messages = nil
		v.CompletenessStatus = CompletenessStatusComplete
	}
	return v
}

func normalizeBlockedW02Artifacts(a *Artifacts) {
	a.GeneratedJava = nil
	a.FinalJavaArtifact = nil
	for i := range a.GeneratedJavaArtifacts {
		a.GeneratedJavaArtifacts[i].Selected = false
	}
}

// cloneManifest produces a deep-enough copy that callers can safely mutate
// any returned manifest without affecting the store. Slice fields are
// re-allocated, pointer fields are re-allocated, and inner slices on
// referenced structs (TransformationPass.InputRef, RuntimeVersion.Ref) are
// also cloned. DataReference itself contains only value-typed fields so a
// struct copy is sufficient there.
func cloneManifest(m *EvidencePackManifest) *EvidencePackManifest {
	if m == nil {
		return nil
	}
	copyManifest := *m
	copyManifest.Artifacts = cloneArtifacts(m.Artifacts)
	if m.OpenAssumptions != nil {
		copyManifest.OpenAssumptions = append([]OpenAssumption{}, m.OpenAssumptions...)
	}
	if m.UnsupportedFeatures != nil {
		copyManifest.UnsupportedFeatures = make([]UnsupportedFeature, len(m.UnsupportedFeatures))
		for i, uf := range m.UnsupportedFeatures {
			copyManifest.UnsupportedFeatures[i] = uf
			if uf.SourceRef != nil {
				ref := *uf.SourceRef
				copyManifest.UnsupportedFeatures[i].SourceRef = &ref
			}
		}
	}
	if m.Exports != nil {
		copyManifest.Exports = append([]ExportRecord{}, m.Exports...)
	}
	copyManifest.Validation.RequiredArtifacts = append([]string{}, m.Validation.RequiredArtifacts...)
	copyManifest.Validation.MissingArtifacts = append([]string{}, m.Validation.MissingArtifacts...)
	copyManifest.Validation.Messages = append([]string{}, m.Validation.Messages...)
	return &copyManifest
}

func cloneArtifacts(a Artifacts) Artifacts {
	out := Artifacts{}
	if a.SourceCobol != nil {
		out.SourceCobol = append([]DataReference{}, a.SourceCobol...)
	}
	if a.SourceMetadata != nil {
		ref := *a.SourceMetadata
		out.SourceMetadata = &ref
	}
	if a.CorpusMetadata != nil {
		ref := *a.CorpusMetadata
		out.CorpusMetadata = &ref
	}
	if a.ParseOutput != nil {
		ref := *a.ParseOutput
		out.ParseOutput = &ref
	}
	if a.SemanticIR != nil {
		ref := *a.SemanticIR
		out.SemanticIR = &ref
	}
	if a.TransformationPasses != nil {
		out.TransformationPasses = make([]TransformationPass, len(a.TransformationPasses))
		for i, p := range a.TransformationPasses {
			out.TransformationPasses[i] = p
			if p.InputRef != nil {
				ref := *p.InputRef
				out.TransformationPasses[i].InputRef = &ref
			}
		}
	}
	if a.GeneratedJava != nil {
		ref := *a.GeneratedJava
		out.GeneratedJava = &ref
	}
	if a.GeneratedJavaArtifacts != nil {
		out.GeneratedJavaArtifacts = append([]JavaCandidateRef{}, a.GeneratedJavaArtifacts...)
	}
	if a.FinalJavaArtifact != nil {
		c := *a.FinalJavaArtifact
		out.FinalJavaArtifact = &c
	}
	if a.RepairAttempts != nil {
		out.RepairAttempts = make([]RepairAttempt, len(a.RepairAttempts))
		for i, r := range a.RepairAttempts {
			out.RepairAttempts[i] = r
			if r.DecisionRef != nil {
				ref := *r.DecisionRef
				out.RepairAttempts[i].DecisionRef = &ref
			}
			if r.ModelInvocationRef != nil {
				ref := *r.ModelInvocationRef
				out.RepairAttempts[i].ModelInvocationRef = &ref
			}
			if r.NewJavaCandidateRef != nil {
				c := *r.NewJavaCandidateRef
				out.RepairAttempts[i].NewJavaCandidateRef = &c
			}
		}
	}
	if a.AgentTrajectories != nil {
		out.AgentTrajectories = append([]AgentTrajectoryRef{}, a.AgentTrajectories...)
	}
	if a.OracleComparison != nil {
		oc := *a.OracleComparison
		if oc.ExpectedRef != nil {
			ref := *oc.ExpectedRef
			oc.ExpectedRef = &ref
		}
		if oc.ActualRef != nil {
			ref := *oc.ActualRef
			oc.ActualRef = &ref
		}
		if oc.BuildTestResultRef != nil {
			ref := *oc.BuildTestResultRef
			oc.BuildTestResultRef = &ref
		}
		out.OracleComparison = &oc
	}
	if a.RuntimeVersion != nil {
		rv := *a.RuntimeVersion
		if rv.Ref != nil {
			ref := *rv.Ref
			rv.Ref = &ref
		}
		out.RuntimeVersion = &rv
	}
	if a.ModelInvocations != nil {
		out.ModelInvocations = append([]ModelInvocationRef{}, a.ModelInvocations...)
	}
	if a.BuildTestResults != nil {
		out.BuildTestResults = append([]DataReference{}, a.BuildTestResults...)
	}
	if a.SBOM != nil {
		out.SBOM = append([]DataReference{}, a.SBOM...)
	}
	if a.LicenseReports != nil {
		out.LicenseReports = append([]DataReference{}, a.LicenseReports...)
	}
	if a.HarnessEvents != nil {
		ref := *a.HarnessEvents
		out.HarnessEvents = &ref
	}
	if a.TrajectoryLedger != nil {
		ref := *a.TrajectoryLedger
		out.TrajectoryLedger = &ref
	}
	if a.ExperienceEvents != nil {
		out.ExperienceEvents = append([]DataReference{}, a.ExperienceEvents...)
	}
	if a.AssistDecision != nil {
		out.AssistDecision = cloneAssistDecision(a.AssistDecision)
	}
	if a.BudgetSummary != nil {
		summary := *a.BudgetSummary
		out.BudgetSummary = &summary
	}
	return out
}

func cloneAssistDecision(src *AssistDecisionLineage) *AssistDecisionLineage {
	if src == nil {
		return nil
	}
	dst := *src
	if src.RepairBudgetSnapshot != nil {
		snap := *src.RepairBudgetSnapshot
		dst.RepairBudgetSnapshot = &snap
	}
	if src.AssistBudgetSnapshot != nil {
		snap := *src.AssistBudgetSnapshot
		dst.AssistBudgetSnapshot = &snap
	}
	if src.ModelInvocationBudgetSnapshot != nil {
		snap := *src.ModelInvocationBudgetSnapshot
		dst.ModelInvocationBudgetSnapshot = &snap
	}
	if src.AffectedArtifactRefs != nil {
		dst.AffectedArtifactRefs = append([]DataReference{}, src.AffectedArtifactRefs...)
	}
	return &dst
}
