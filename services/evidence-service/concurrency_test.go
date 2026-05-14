package main

import (
	"fmt"
	"sync"
	"testing"
)

// TestPackStoreConcurrentCreateUpdateGet exercises PackStore under parallel
// goroutines. Run with `-race` to assert no data races; assertions verify
// every Create succeeded and every PATCH landed exactly once.
func TestPackStoreConcurrentCreateUpdateGet(t *testing.T) {
	const workers = 32
	const opsPerWorker = 16

	store := NewPackStore()
	var wg sync.WaitGroup
	errs := make(chan error, workers*opsPerWorker)

	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func(workerID int) {
			defer wg.Done()
			for i := 0; i < opsPerWorker; i++ {
				runID := fmt.Sprintf("run-%d-%d", workerID, i)
				manifest, err := store.Create(CreateInput{
					RunID:     runID,
					Artifacts: completeArtifactsForConcurrency(),
				})
				if err != nil {
					errs <- fmt.Errorf("create: %w", err)
					return
				}
				summary := "concurrent"
				if _, err := store.Update(manifest.PackID, PatchInput{Summary: &summary}); err != nil {
					errs <- fmt.Errorf("update: %w", err)
					return
				}
				got, ok := store.Get(manifest.PackID)
				if !ok {
					errs <- fmt.Errorf("get %s missing", manifest.PackID)
					return
				}
				if got.Summary != "concurrent" {
					errs <- fmt.Errorf("summary not propagated for %s", manifest.PackID)
					return
				}
				// Mutate the returned clone — must not affect store.
				got.Summary = "tampered"
				again, _ := store.Get(manifest.PackID)
				if again.Summary == "tampered" {
					errs <- fmt.Errorf("store aliased clone for %s", manifest.PackID)
					return
				}
			}
		}(w)
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Fatal(err)
	}
	if got := len(store.List()); got != workers*opsPerWorker {
		t.Fatalf("expected %d packs, got %d", workers*opsPerWorker, got)
	}
}

// TestStepCounterConcurrent verifies the per-run monotonicity contract of
// stepCounter under concurrent callers — every call must hand back a
// unique, increasing integer for a given runId.
func TestStepCounterConcurrent(t *testing.T) {
	c := newStepCounter()
	const workers = 16
	const perWorker = 64

	results := make(chan int64, workers*perWorker)
	var wg sync.WaitGroup
	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := 0; i < perWorker; i++ {
				results <- c.next("shared-run")
			}
		}()
	}
	wg.Wait()
	close(results)

	seen := make(map[int64]struct{}, workers*perWorker)
	var max int64
	for r := range results {
		if _, dup := seen[r]; dup {
			t.Fatalf("duplicate step id %d under contention", r)
		}
		seen[r] = struct{}{}
		if r > max {
			max = r
		}
	}
	if want := int64(workers * perWorker); max != want {
		t.Fatalf("expected max step %d, got %d", want, max)
	}
}

// TestInMemoryEventSinkConcurrent emits many events from parallel
// goroutines and asserts the sink stays internally consistent.
func TestInMemoryEventSinkConcurrent(t *testing.T) {
	sink := NewInMemoryEventSink()
	const workers = 16
	const perWorker = 32
	var wg sync.WaitGroup
	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func(workerID int) {
			defer wg.Done()
			for i := 0; i < perWorker; i++ {
				event := HarnessEvent{
					EventType: "concurrency.test",
					RunID:     fmt.Sprintf("run-c-%d", workerID),
					Status:    StatusComplete,
				}
				if _, err := sink.Emit(event); err != nil {
					t.Errorf("emit: %v", err)
					return
				}
			}
		}(w)
	}
	wg.Wait()

	events, err := sink.List()
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if got := len(events); got != workers*perWorker {
		t.Fatalf("expected %d events, got %d", workers*perWorker, got)
	}
	// Every EventID is uniquely numbered via the atomic seq counter.
	seen := make(map[string]struct{}, len(events))
	for _, e := range events {
		if _, dup := seen[e.EventID]; dup {
			t.Fatalf("duplicate eventId %s", e.EventID)
		}
		seen[e.EventID] = struct{}{}
	}
}

func completeArtifactsForConcurrency() Artifacts {
	ref := DataReference{
		URI:      "urn:c2c/test/ref",
		SHA256:   "0000000000000000000000000000000000000000000000000000000000000000",
		ByteSize: 0,
		MIMEType: "application/json",
		Kind:     "test",
	}
	return Artifacts{
		SourceCobol:      []DataReference{ref},
		SemanticIR:       &DataReference{URI: "urn:semantic", SHA256: ref.SHA256},
		GeneratedJava:    &DataReference{URI: "urn:generated", SHA256: ref.SHA256},
		BuildTestResults: []DataReference{ref},
		HarnessEvents:    &DataReference{URI: "urn:events", SHA256: ref.SHA256},
		ModelInvocations: []ModelInvocationRef{{
			InvocationID: "inv",
			ModelID:      "m",
			LedgerRef:    ref,
		}},
	}
}
