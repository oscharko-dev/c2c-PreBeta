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
