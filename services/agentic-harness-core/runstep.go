package main

import "sync"

const (
	systemRunID = "system"
)

type RunStepTracker struct {
	mu    sync.Mutex
	steps map[string]int64
}

func NewRunStepTracker() *RunStepTracker {
	return &RunStepTracker{
		steps: make(map[string]int64),
	}
}

func (t *RunStepTracker) Next(runID string) int64 {
	if runID == "" {
		runID = systemRunID
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	t.steps[runID]++
	return t.steps[runID]
}
