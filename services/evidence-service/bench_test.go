package main

import (
	"path/filepath"
	"testing"
)

// BenchmarkPackStoreCreate captures throughput of the create path. Failure
// mode is a regression in lock contention or the validation walker — both
// would show up as latency-per-op climbing across commits.
func BenchmarkPackStoreCreate(b *testing.B) {
	store := NewPackStore()
	arts := completeArtifactsForConcurrency()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if _, err := store.Create(CreateInput{RunID: "run-bench", Artifacts: arts}); err != nil {
			b.Fatalf("create: %v", err)
		}
	}
}

// BenchmarkPackStoreGet exercises cloneManifest at read time.
func BenchmarkPackStoreGet(b *testing.B) {
	store := NewPackStore()
	manifest, err := store.Create(CreateInput{RunID: "run-bench", Artifacts: completeArtifactsForConcurrency()})
	if err != nil {
		b.Fatalf("create: %v", err)
	}
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if _, ok := store.Get(manifest.PackID); !ok {
			b.Fatalf("get missing")
		}
	}
}

// BenchmarkExportDirectory measures the cost of writing a manifest to disk
// in directory format.
func BenchmarkExportDirectory(b *testing.B) {
	dir := b.TempDir()
	exporter := NewExporter(dir)
	store := NewPackStore()
	manifest, err := store.Create(CreateInput{RunID: "run-bench", Artifacts: completeArtifactsForConcurrency()})
	if err != nil {
		b.Fatalf("create: %v", err)
	}
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		_, err := exporter.Export(manifest, ExportRequest{
			Format:      ExportFormatDirectory,
			Destination: filepath.Join("dir-", manifest.PackID),
		})
		if err != nil {
			b.Fatalf("export: %v", err)
		}
	}
}

// BenchmarkEvaluateValidation isolates the validation walker so any
// regression in field-by-field checks is visible.
func BenchmarkEvaluateValidation(b *testing.B) {
	arts := completeArtifactsForConcurrency()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		_ = EvaluateValidation(&arts)
	}
}
