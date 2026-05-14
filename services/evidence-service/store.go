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
// accrues artifacts.
type CreateInput struct {
	RunID               string               `json:"runId"`
	WorkflowID          string               `json:"workflowId,omitempty"`
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
		Wave:                WaveW0,
		Summary:             input.Summary,
		CreatedAt:           s.clock(),
		CreatedBy:           input.CreatedBy,
		Artifacts:           input.Artifacts,
		OpenAssumptions:     input.OpenAssumptions,
		UnsupportedFeatures: input.UnsupportedFeatures,
	}
	manifest.Validation = EvaluateValidation(&manifest.Artifacts)
	manifest.Status = deriveStatus(manifest.Validation)
	if err := manifest.Validate(); err != nil {
		return nil, err
	}
	s.packs[packID] = manifest
	return cloneManifest(manifest), nil
}

// PatchInput captures the additive update surface exposed by PATCH
// /v0/packs/{packId}. Slices are appended; non-nil pointer fields override.
type PatchInput struct {
	Summary             *string              `json:"summary,omitempty"`
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
	manifest.Validation = EvaluateValidation(&manifest.Artifacts)
	manifest.Status = deriveStatus(manifest.Validation)
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

func cloneManifest(m *EvidencePackManifest) *EvidencePackManifest {
	if m == nil {
		return nil
	}
	copyManifest := *m
	if m.Artifacts.SourceCobol != nil {
		copyManifest.Artifacts.SourceCobol = append([]DataReference{}, m.Artifacts.SourceCobol...)
	}
	if m.Artifacts.TransformationPasses != nil {
		copyManifest.Artifacts.TransformationPasses = append([]TransformationPass{}, m.Artifacts.TransformationPasses...)
	}
	if m.Artifacts.ModelInvocations != nil {
		copyManifest.Artifacts.ModelInvocations = append([]ModelInvocationRef{}, m.Artifacts.ModelInvocations...)
	}
	if m.Artifacts.BuildTestResults != nil {
		copyManifest.Artifacts.BuildTestResults = append([]DataReference{}, m.Artifacts.BuildTestResults...)
	}
	if m.Artifacts.SBOM != nil {
		copyManifest.Artifacts.SBOM = append([]DataReference{}, m.Artifacts.SBOM...)
	}
	if m.Artifacts.LicenseReports != nil {
		copyManifest.Artifacts.LicenseReports = append([]DataReference{}, m.Artifacts.LicenseReports...)
	}
	if m.Artifacts.ExperienceEvents != nil {
		copyManifest.Artifacts.ExperienceEvents = append([]DataReference{}, m.Artifacts.ExperienceEvents...)
	}
	if m.OpenAssumptions != nil {
		copyManifest.OpenAssumptions = append([]OpenAssumption{}, m.OpenAssumptions...)
	}
	if m.UnsupportedFeatures != nil {
		copyManifest.UnsupportedFeatures = append([]UnsupportedFeature{}, m.UnsupportedFeatures...)
	}
	if m.Exports != nil {
		copyManifest.Exports = append([]ExportRecord{}, m.Exports...)
	}
	copyManifest.Validation.RequiredArtifacts = append([]string{}, m.Validation.RequiredArtifacts...)
	copyManifest.Validation.MissingArtifacts = append([]string{}, m.Validation.MissingArtifacts...)
	copyManifest.Validation.Messages = append([]string{}, m.Validation.Messages...)
	return &copyManifest
}
