package main

import (
	"fmt"
	"sort"
	"sync"
	"time"
)

const (
	StatusStarting  = "starting"
	StatusUpdating  = "updating"
	StatusCompleted = "completed"
	StatusFailed    = "failed"
)

type RunStore struct {
	mu   sync.RWMutex
	runs map[string]RunState
	seq  int
}

func NewRunStore() *RunStore {
	return &RunStore{
		runs: make(map[string]RunState),
	}
}

func (r *RunStore) Create(request RunCreateRequest, actorRole string, decision string) (RunState, error) {
	if request.WorkflowID == "" {
		return RunState{}, fmt.Errorf("workflowId is required")
	}
	if actorRole == "" {
		return RunState{}, fmt.Errorf("actor role is required")
	}

	r.mu.Lock()
	defer r.mu.Unlock()
	r.seq++
	runID := fmt.Sprintf("run-%d", r.seq)
	now := time.Now().UTC()
	state := RunState{
		RunID:          runID,
		WorkflowID:     request.WorkflowID,
		Status:         StatusStarting,
		CreatedAt:      now,
		StartedAt:      now,
		LastUpdatedAt:   now,
		EvidenceRefs:   append([]string{}, request.EvidenceRefs...),
		PolicyDecision: decision,
		UpdatedBy:      request.Requester,
	}
	r.runs[runID] = state
	return state, nil
}

func (r *RunStore) Get(runID string) (RunState, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	run, ok := r.runs[runID]
	return run, ok
}

func (r *RunStore) List() []RunState {
	r.mu.RLock()
	defer r.mu.RUnlock()
	runs := make([]RunState, 0, len(r.runs))
	ids := make([]string, 0, len(r.runs))
	for _, run := range r.runs {
		runs = append(runs, run)
		ids = append(ids, run.RunID)
	}
	sort.Strings(ids)
	byID := make(map[string]RunState, len(runs))
	for _, run := range runs {
		byID[run.RunID] = run
	}
	sorted := make([]RunState, 0, len(runs))
	for _, id := range ids {
		sorted = append(sorted, byID[id])
	}
	return sorted
}

func (r *RunStore) Update(runID string, request RunUpdateRequest, actorRole string, decision string) (RunState, string, error) {
	if actorRole == "" {
		return RunState{}, "", fmt.Errorf("actor role is required")
	}
	if request.Status == "" {
		return RunState{}, "", fmt.Errorf("status is required")
	}

	r.mu.Lock()
	defer r.mu.Unlock()
	run, ok := r.runs[runID]
	if !ok {
		return RunState{}, "", fmt.Errorf("run %s not found", runID)
	}
	previous := run.Status
	if err := validateRunTransition(run.Status, request.Status); err != nil {
		return RunState{}, "", err
	}

	run.Status = request.Status
	run.Message = request.Message
	run.EvidenceRefs = append([]string{}, request.EvidenceRefs...)
	run.PolicyDecision = decision
	run.UpdatedBy = request.UpdatedBy
	run.LastUpdatedAt = time.Now().UTC()
	r.runs[runID] = run
	return run, previous, nil
}

func validateRunTransition(current string, next string) error {
	switch current {
	case StatusStarting:
		switch next {
		case StatusUpdating, StatusCompleted, StatusFailed:
			return nil
		}
	case StatusUpdating:
		switch next {
		case StatusUpdating, StatusCompleted, StatusFailed:
			return nil
		}
	case StatusCompleted, StatusFailed:
		return fmt.Errorf("run is already terminal: %s", current)
	default:
		return fmt.Errorf("unknown run state: %s", current)
	}
	return fmt.Errorf("invalid run transition %s -> %s", current, next)
}
