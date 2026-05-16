package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestExporterRefusesSymlinkEscape drops a symlink under the export root
// that points outside it, then attempts to use the symlink as the export
// destination. The exporter must refuse rather than follow the link.
func TestExporterRefusesSymlinkEscape(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()

	// Create a symlink inside the export root that points outside it.
	linkName := "trap"
	linkPath := filepath.Join(root, linkName)
	if err := os.Symlink(outside, linkPath); err != nil {
		t.Fatalf("create symlink: %v", err)
	}

	exporter := NewExporter(root)
	// Targeting `trap/manifest-dir` would resolve to a path under `outside`.
	_, err := exporter.resolveDestination("epk-x-0001", ExportFormatDirectory, filepath.Join(linkName, "manifest-dir"))
	if err == nil {
		t.Fatalf("expected error for symlink-based escape")
	}
	if !strings.Contains(err.Error(), "export root") {
		t.Fatalf("unexpected error: %v", err)
	}
}

// TestCloneManifestIsolatesPointerFields verifies the deep-copy guarantee
// in cloneManifest: mutating a returned manifest's pointer-backed fields
// must not affect a subsequently fetched copy from the store.
func TestCloneManifestIsolatesPointerFields(t *testing.T) {
	store := NewPackStore()
	manifest, err := store.Create(CreateInput{
		RunID:     "run-clone",
		Artifacts: completeArtifacts(t),
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}

	// Mutate through pointer fields on the returned clone.
	manifest.Artifacts.SemanticIR.URI = "urn:mutated/semantic"
	manifest.Artifacts.SourceMetadata.URI = "urn:mutated/source-metadata"
	manifest.Artifacts.ParseOutput.URI = "urn:mutated/parse-output"
	manifest.Artifacts.GeneratedJava.SHA256 = strings.Repeat("0", 64)
	manifest.Artifacts.RuntimeVersion.ID = "mutated-runtime"
	if manifest.Artifacts.RuntimeVersion.Ref != nil {
		manifest.Artifacts.RuntimeVersion.Ref.URI = "urn:mutated/runtime"
	}
	if len(manifest.Artifacts.TransformationPasses) > 0 && manifest.Artifacts.TransformationPasses[0].InputRef != nil {
		manifest.Artifacts.TransformationPasses[0].InputRef.URI = "urn:mutated/transform-input"
	}

	again, ok := store.Get(manifest.PackID)
	if !ok {
		t.Fatalf("re-fetch failed")
	}
	if again.Artifacts.SemanticIR.URI == "urn:mutated/semantic" {
		t.Fatalf("SemanticIR pointer aliased the store")
	}
	if again.Artifacts.SourceMetadata.URI == "urn:mutated/source-metadata" {
		t.Fatalf("SourceMetadata pointer aliased the store")
	}
	if again.Artifacts.ParseOutput.URI == "urn:mutated/parse-output" {
		t.Fatalf("ParseOutput pointer aliased the store")
	}
	if again.Artifacts.GeneratedJava.SHA256 == strings.Repeat("0", 64) {
		t.Fatalf("GeneratedJava pointer aliased the store")
	}
	if again.Artifacts.RuntimeVersion.ID == "mutated-runtime" {
		t.Fatalf("RuntimeVersion pointer aliased the store")
	}
	if again.Artifacts.RuntimeVersion.Ref != nil && again.Artifacts.RuntimeVersion.Ref.URI == "urn:mutated/runtime" {
		t.Fatalf("RuntimeVersion.Ref pointer aliased the store")
	}
	if len(again.Artifacts.TransformationPasses) > 0 &&
		again.Artifacts.TransformationPasses[0].InputRef != nil &&
		again.Artifacts.TransformationPasses[0].InputRef.URI == "urn:mutated/transform-input" {
		t.Fatalf("TransformationPass.InputRef pointer aliased the store")
	}
}

// TestUpdateManifestIsolatesPatchedPointerFields verifies mergeArtifacts makes
// defensive copies of newly patched pointer-backed fields before storing them.
func TestUpdateManifestIsolatesPatchedPointerFields(t *testing.T) {
	store := NewPackStore()
	manifest, err := store.Create(CreateInput{
		RunID:     "run-patch-clone",
		Artifacts: completeArtifacts(t),
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}

	sourceMetadata := mustRef(t, "urn:mutated/source-metadata", map[string]string{"source": "mutated"})
	parseOutput := mustRef(t, "urn:mutated/parse-output", map[string]string{"status": "mutated"})
	runtimeRef := mustRef(t, "urn:mutated/runtime", map[string]string{"runtime": "mutated"})
	patchArtifacts := &Artifacts{
		SourceMetadata: &sourceMetadata,
		ParseOutput:    &parseOutput,
		RuntimeVersion: &RuntimeVersion{
			ID:  "mutated-runtime",
			Ref: &runtimeRef,
		},
	}
	updated, err := store.Update(manifest.PackID, PatchInput{Artifacts: patchArtifacts})
	if err != nil {
		t.Fatalf("update: %v", err)
	}

	// Mutate the patch payload after the update. The stored manifest must not
	// observe these changes.
	patchArtifacts.SourceMetadata.URI = "urn:tampered/source-metadata"
	patchArtifacts.ParseOutput.URI = "urn:tampered/parse-output"
	patchArtifacts.RuntimeVersion.ID = "tampered-runtime"
	patchArtifacts.RuntimeVersion.Ref.URI = "urn:tampered/runtime"

	stored, ok := store.Get(manifest.PackID)
	if !ok {
		t.Fatalf("expected patched manifest to remain in store")
	}

	if updated.Artifacts.SourceMetadata.URI == "urn:tampered/source-metadata" {
		t.Fatalf("SourceMetadata pointer aliased the patch input")
	}
	if stored.Artifacts.SourceMetadata.URI == "urn:tampered/source-metadata" {
		t.Fatalf("stored SourceMetadata pointer aliased the patch input")
	}
	if updated.Artifacts.ParseOutput.URI == "urn:tampered/parse-output" {
		t.Fatalf("ParseOutput pointer aliased the patch input")
	}
	if stored.Artifacts.ParseOutput.URI == "urn:tampered/parse-output" {
		t.Fatalf("stored ParseOutput pointer aliased the patch input")
	}
	if updated.Artifacts.RuntimeVersion.ID == "tampered-runtime" {
		t.Fatalf("RuntimeVersion pointer aliased the patch input")
	}
	if stored.Artifacts.RuntimeVersion.ID == "tampered-runtime" {
		t.Fatalf("stored RuntimeVersion pointer aliased the patch input")
	}
	if updated.Artifacts.RuntimeVersion.Ref != nil && updated.Artifacts.RuntimeVersion.Ref.URI == "urn:tampered/runtime" {
		t.Fatalf("RuntimeVersion.Ref pointer aliased the patch input")
	}
	if stored.Artifacts.RuntimeVersion.Ref != nil && stored.Artifacts.RuntimeVersion.Ref.URI == "urn:tampered/runtime" {
		t.Fatalf("stored RuntimeVersion.Ref pointer aliased the patch input")
	}
}

func TestUpdateManifestIsAtomicOnValidationError(t *testing.T) {
	store := NewPackStore()
	manifest, err := store.Create(CreateInput{
		RunID:     "run-patch-atomic",
		Artifacts: completeArtifacts(t),
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	original, ok := store.Get(manifest.PackID)
	if !ok {
		t.Fatalf("expected manifest to be stored")
	}

	invalidRef := *original.Artifacts.SourceMetadata
	invalidRef.URI = "https://artifacts.example/source-ref.json?signature=abc"
	_, err = store.Update(manifest.PackID, PatchInput{
		Artifacts: &Artifacts{SourceMetadata: &invalidRef},
	})
	if err == nil {
		t.Fatalf("expected validation error for query-bearing URI")
	}

	stored, ok := store.Get(manifest.PackID)
	if !ok {
		t.Fatalf("expected manifest to remain stored")
	}
	if stored.Artifacts.SourceMetadata.URI != original.Artifacts.SourceMetadata.URI {
		t.Fatalf("failed patch mutated stored manifest: got %q want %q", stored.Artifacts.SourceMetadata.URI, original.Artifacts.SourceMetadata.URI)
	}
}

// TestEmittedEventPayloadIsTyped asserts the emitted Harness event payload
// matches the EvidenceEventPayload contract, not a free-form map.
func TestEmittedEventPayloadIsTyped(t *testing.T) {
	sink := NewInMemoryEventSink()
	service := &Service{
		store:    NewPackStore(),
		exporter: NewExporter(t.TempDir()),
		events:   sink,
		stepSeq:  newStepCounter(),
	}
	manifest, err := service.store.Create(CreateInput{
		RunID:     "run-typed",
		Artifacts: completeArtifacts(t),
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if err := service.emitPackEvent(manifest, EventTypePackCreated, "pack.created"); err != nil {
		t.Fatalf("emit: %v", err)
	}
	events, err := sink.List()
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(events) != 1 {
		t.Fatalf("expected 1 event, got %d", len(events))
	}
	if events[0].Payload == nil {
		t.Fatalf("expected typed payload, got nil")
	}
	if events[0].Payload.PackID != manifest.PackID {
		t.Fatalf("payload packId mismatch: %s != %s", events[0].Payload.PackID, manifest.PackID)
	}
	if events[0].Payload.RunID != "run-typed" {
		t.Fatalf("payload runId mismatch: %s", events[0].Payload.RunID)
	}
}
