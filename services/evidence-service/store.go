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
	manifest.Status = deriveStatus(manifest.Validation)
	manifest.CompletenessStatus = deriveCompletenessStatus(manifest.Validation, input.Blocked)
	manifest.Classification = deriveClassification(manifest.Validation, input.Blocked)
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
	manifest, ok := s.packs[packID]
	if !ok {
		return nil, fmt.Errorf("pack not found: %s", packID)
	}
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
	manifest.Validation = EvaluateValidationForWave(&manifest.Artifacts, manifest.Wave)
	manifest.Status = deriveStatus(manifest.Validation)
	manifest.CompletenessStatus = deriveCompletenessStatus(manifest.Validation, blocked)
	manifest.Classification = deriveClassification(manifest.Validation, blocked)
	if err := manifest.Validate(); err != nil {
		return nil, err
	}
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
	if src.CorpusMetadata != nil {
		dst.CorpusMetadata = src.CorpusMetadata
	}
	if src.SemanticIR != nil {
		dst.SemanticIR = src.SemanticIR
	}
	if len(src.TransformationPasses) > 0 {
		dst.TransformationPasses = append(dst.TransformationPasses, src.TransformationPasses...)
	}
	if src.GeneratedJava != nil {
		dst.GeneratedJava = src.GeneratedJava
	}
	if len(src.GeneratedJavaArtifacts) > 0 {
		dst.GeneratedJavaArtifacts = append(dst.GeneratedJavaArtifacts, src.GeneratedJavaArtifacts...)
	}
	if src.FinalJavaArtifact != nil {
		dst.FinalJavaArtifact = src.FinalJavaArtifact
	}
	if len(src.RepairAttempts) > 0 {
		dst.RepairAttempts = append(dst.RepairAttempts, src.RepairAttempts...)
	}
	if len(src.AgentTrajectories) > 0 {
		dst.AgentTrajectories = append(dst.AgentTrajectories, src.AgentTrajectories...)
	}
	if src.OracleComparison != nil {
		dst.OracleComparison = src.OracleComparison
	}
	if src.RuntimeVersion != nil {
		dst.RuntimeVersion = src.RuntimeVersion
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
		dst.HarnessEvents = src.HarnessEvents
	}
	if src.TrajectoryLedger != nil {
		dst.TrajectoryLedger = src.TrajectoryLedger
	}
	if len(src.ExperienceEvents) > 0 {
		dst.ExperienceEvents = append(dst.ExperienceEvents, src.ExperienceEvents...)
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
	if a.CorpusMetadata != nil {
		ref := *a.CorpusMetadata
		out.CorpusMetadata = &ref
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
	return out
}
