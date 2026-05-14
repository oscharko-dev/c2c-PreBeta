package main

import (
	"fmt"
	"sort"
	"strings"
	"sync/atomic"
	"time"
)

type PatternAnalyzer struct {
	policy LearningPolicy
	now    func() time.Time
	seq    atomic.Uint64
}

func NewPatternAnalyzer(policy LearningPolicy, now func() time.Time) *PatternAnalyzer {
	if now == nil {
		now = time.Now().UTC
	}
	return &PatternAnalyzer{
		policy: policy,
		now:    now,
	}
}

func (a *PatternAnalyzer) AnalyzeRun(runID string, events []EventEnvelopeV0, ledgers []AgentTrajectoryLedgerV0) ([]ExperienceEventV0, RunLearningSummary, error) {
	if strings.TrimSpace(runID) == "" {
		return nil, RunLearningSummary{}, fmt.Errorf("runID is required")
	}

	now := a.now()
	summary := RunLearningSummary{
		RunID:              runID,
		ObservedAt:         now,
		CandidateByPattern: make(map[string]int),
		ObservationOnly:    a.policy.ObservationOnly,
		PolicyVersion:      a.policy.PolicyVersion,
		PolicyFingerprint:  a.policy.PolicyFingerprint,
	}

	eventsForRun := filterEventsByRun(events, runID)
	summary.SourceEventCount = len(eventsForRun)
	summary.SourceLedgerCount = len(filterLedgersByRun(ledgers, runID))

	sort.Slice(eventsForRun, func(i, j int) bool {
		if eventsForRun[i].CreatedAt.Equal(eventsForRun[j].CreatedAt) {
			return eventsForRun[i].StepID < eventsForRun[j].StepID
		}
		return eventsForRun[i].CreatedAt.Before(eventsForRun[j].CreatedAt)
	})

	combined := []ExperienceEventV0{}
	buckets := make(map[PatternKey][]EventEnvelopeV0)
	for _, ev := range eventsForRun {
		if strings.TrimSpace(ev.Actor) == "" || strings.TrimSpace(ev.Capability) == "" {
			continue
		}
		if strings.TrimSpace(ev.InputRef.SHA256) == "" || strings.TrimSpace(ev.OutputRef.SHA256) == "" {
			continue
		}
		key := PatternKey{
			Actor:        ev.Actor,
			Capability:   ev.Capability,
			InputHash:    ev.InputRef.SHA256,
			OutputHash:   ev.OutputRef.SHA256,
			Status:       normalizeStatus(ev.Status),
			BuildOutcome: classifyBuildOutcome(ev),
		}
		buckets[key] = append(buckets[key], ev)
	}

	for key, bucket := range buckets {
		candidates := analyzeBucket(a, runID, key, bucket)
		combined = append(combined, candidates...)
	}
	combined = append(combined, analyzeRetrySequences(a, runID, eventsForRun)...)

	for _, ledger := range filterLedgersByRun(ledgers, runID) {
		combined = append(combined, analyzeLedger(ledger, runID, a)...)
	}

	for _, ev := range eventsForRun {
		if isAcceptedArtifact(ev) {
			combined = append(combined, ExperienceEventV0{
				SchemaVersion:      experienceSchemaVersion,
				EventID:            a.nextEventID(),
				EventType:          patternAcceptedPattern,
				Service:            serviceName,
				RunID:              runID,
				Actor:              ev.Actor,
				Capability:         ev.Capability,
				DataClass:          ev.DataClass,
				RedactionProfile:   ev.RedactionProfile,
				PolicyDecision:     policyDecisionAllow(),
				Status:             statusObserved,
				StateTransition:    "analysis.detected",
				InputHash:          ev.InputRef.SHA256,
				OutputHash:         ev.OutputRef.SHA256,
				Pattern:            patternAcceptedPattern,
				PatternFingerprint: PatternKey{Actor: ev.Actor, Capability: ev.Capability, InputHash: ev.InputRef.SHA256, OutputHash: ev.OutputRef.SHA256, Status: normalizeStatus(ev.Status), BuildOutcome: classifyBuildOutcome(ev)}.Fingerprint(),
				Occurrences:        1,
				Confidence:         a.clamp(a.policy.Detection.MinConfidenceFailure, a.policy.Detection.MinConfidence, 1.0),
				FirstStepID:        ev.StepID,
				LastStepID:         ev.StepID,
				RelatedRecords:     []string{ev.EventID},
				EvidenceRefs:       []string{ev.EventID},
				ObservationOnly:    true,
				PolicyVersion:      a.policy.PolicyVersion,
				BuildTestOutcome:   classifyBuildOutcome(ev),
				Payload: map[string]any{
					"evidenceRunId": runID,
					"eventId":       ev.EventID,
					"pattern":       patternAcceptedPattern,
					"reason":        "accepted artifacts are marked as deterministic candidates",
				},
				CreatedAt:  now,
				ObservedAt: now,
			})
		}
	}

	combined = dedupeCandidates(combined)
	combined = applyPolicyGating(a.policy, combined)

	for _, candidate := range combined {
		summary.CandidateByPattern[candidate.Pattern]++
		summary.ExperienceEventIDs = append(summary.ExperienceEventIDs, candidate.EventID)
	}
	summary.CandidateCount = len(combined)
	summary.ObservedPatterns = sortedPatternKeys(summary.CandidateByPattern)
	return combined, summary, nil
}

func analyzeBucket(analyzer *PatternAnalyzer, runID string, key PatternKey, items []EventEnvelopeV0) []ExperienceEventV0 {
	now := analyzer.now()
	if len(items) == 0 {
		return nil
	}
	out := make([]ExperienceEventV0, 0)

	minOccurrences := analyzer.policy.Detection.MinOccurrencesRepeatAction
	minFailures := analyzer.policy.Detection.MinOccurrencesRepeatedFail
	includeFailures := analyzer.policy.Detection.IncludeBuildTestFailures
	outputHashes := make(map[string]struct{}, len(items))
	failed := make([]EventEnvelopeV0, 0)
	for _, item := range items {
		outputHashes[item.OutputRef.SHA256] = struct{}{}
		if strings.EqualFold(item.Status, "failed") {
			failed = append(failed, item)
		}
	}

	if len(items) >= minOccurrences {
		out = append(out, buildExperienceEvent(ExperienceEventV0{
			SchemaVersion:      experienceSchemaVersion,
			EventID:            analyzer.nextEventID(),
			EventType:          eventTypeObservation,
			Service:            serviceName,
			RunID:              runID,
			Actor:              key.Actor,
			Capability:         key.Capability,
			DataClass:          items[0].DataClass,
			RedactionProfile:   items[0].RedactionProfile,
			PolicyDecision:     policyDecisionAllow(),
			Status:             statusObserved,
			StateTransition:    "analysis.detected",
			InputHash:          key.InputHash,
			OutputHash:         key.OutputHash,
			Pattern:            patternRepeatAction,
			PatternFingerprint: key.Fingerprint(),
			BuildTestOutcome:   key.BuildOutcome,
			Occurrences:        len(items),
			Confidence:         analyzer.clamp(analyzer.policy.Detection.MinConfidenceRepeatAction, analyzer.policy.Detection.MinConfidence, 1.0),
			FirstStepID:        items[0].StepID,
			LastStepID:         items[len(items)-1].StepID,
			RelatedRecords:     extractEventIDs(items),
			EvidenceRefs:       extractEventIDs(items),
			ObservationOnly:    true,
			PolicyVersion:      analyzer.policy.PolicyVersion,
			CreatedAt:          now,
			ObservedAt:         now,
			Payload: map[string]any{
				"evidenceRunId": runID,
				"pattern":       patternRepeatAction,
				"reason":        "repeated deterministic action with same actor/capability/input/output context",
				"key":           key.String(),
			},
		}))
	}

	if len(items) >= minOccurrences && len(outputHashes) == 1 {
		out = append(out, buildExperienceEvent(ExperienceEventV0{
			SchemaVersion:      experienceSchemaVersion,
			EventID:            analyzer.nextEventID(),
			EventType:          eventTypeObservation,
			Service:            serviceName,
			RunID:              runID,
			Actor:              key.Actor,
			Capability:         key.Capability,
			DataClass:          items[0].DataClass,
			RedactionProfile:   items[0].RedactionProfile,
			PolicyDecision:     policyDecisionAllow(),
			Status:             statusObserved,
			StateTransition:    "analysis.detected",
			InputHash:          key.InputHash,
			OutputHash:         key.OutputHash,
			Pattern:            patternUnchangedOutput,
			PatternFingerprint: key.Fingerprint(),
			BuildTestOutcome:   key.BuildOutcome,
			Occurrences:        len(items),
			Confidence:         analyzer.clamp(0.88, analyzer.policy.Detection.MinConfidence, 1.0),
			FirstStepID:        items[0].StepID,
			LastStepID:         items[len(items)-1].StepID,
			RelatedRecords:     extractEventIDs(items),
			EvidenceRefs:       extractEventIDs(items),
			ObservationOnly:    true,
			PolicyVersion:      analyzer.policy.PolicyVersion,
			CreatedAt:          now,
			ObservedAt:         now,
			Payload: map[string]any{
				"evidenceRunId": runID,
				"pattern":       patternUnchangedOutput,
				"reason":        "stable output for repeated action",
				"key":           key.String(),
			},
		}))
	}

	if len(failed) >= minFailures {
		out = append(out, buildExperienceEvent(ExperienceEventV0{
			SchemaVersion:      experienceSchemaVersion,
			EventID:            analyzer.nextEventID(),
			EventType:          eventTypeObservation,
			Service:            serviceName,
			RunID:              runID,
			Actor:              key.Actor,
			Capability:         key.Capability,
			DataClass:          items[0].DataClass,
			RedactionProfile:   items[0].RedactionProfile,
			PolicyDecision:     policyDecisionAllow(),
			Status:             statusObserved,
			StateTransition:    "analysis.detected",
			InputHash:          key.InputHash,
			OutputHash:         key.OutputHash,
			Pattern:            patternRepeatedFailure,
			PatternFingerprint: key.Fingerprint(),
			BuildTestOutcome:   key.BuildOutcome,
			Occurrences:        len(failed),
			Confidence:         analyzer.clamp(analyzer.policy.Detection.MinConfidenceFailure, analyzer.policy.Detection.MinConfidence, 1.0),
			FirstStepID:        failed[0].StepID,
			LastStepID:         failed[len(failed)-1].StepID,
			RelatedRecords:     extractEventIDs(failed),
			EvidenceRefs:       extractEventIDs(failed),
			ObservationOnly:    true,
			PolicyVersion:      analyzer.policy.PolicyVersion,
			CreatedAt:          now,
			ObservedAt:         now,
			Payload: map[string]any{
				"evidenceRunId": runID,
				"pattern":       patternRepeatedFailure,
				"reason":        "deterministic repeated failures in same action context",
				"key":           key.String(),
				"outcome":       key.BuildOutcome,
			},
		}))
	}

	if includeFailures {
		if key.BuildOutcome == "compile" && len(failed) > 0 {
			out = append(out, buildExperienceEvent(ExperienceEventV0{
				SchemaVersion:      experienceSchemaVersion,
				EventID:            analyzer.nextEventID(),
				EventType:          eventTypeObservation,
				Service:            serviceName,
				RunID:              runID,
				Actor:              key.Actor,
				Capability:         key.Capability,
				DataClass:          items[0].DataClass,
				RedactionProfile:   items[0].RedactionProfile,
				PolicyDecision:     policyDecisionAllow(),
				Status:             statusObserved,
				StateTransition:    "analysis.detected",
				InputHash:          key.InputHash,
				OutputHash:         key.OutputHash,
				Pattern:            patternCompileFailure,
				PatternFingerprint: "compile:" + key.Fingerprint(),
				BuildTestOutcome:   key.BuildOutcome,
				Occurrences:        len(failed),
				Confidence:         analyzer.clamp(0.93, analyzer.policy.Detection.MinConfidence, 1.0),
				FirstStepID:        failed[0].StepID,
				LastStepID:         failed[len(failed)-1].StepID,
				RelatedRecords:     extractEventIDs(failed),
				EvidenceRefs:       extractEventIDs(failed),
				ObservationOnly:    true,
				PolicyVersion:      analyzer.policy.PolicyVersion,
				CreatedAt:          now,
				ObservedAt:         now,
				Payload: map[string]any{
					"evidenceRunId": runID,
					"pattern":       patternCompileFailure,
					"reason":        "deterministic compile failures",
					"key":           key.String(),
				},
			}))
		}
		if key.BuildOutcome == "test" && len(failed) > 0 {
			out = append(out, buildExperienceEvent(ExperienceEventV0{
				SchemaVersion:      experienceSchemaVersion,
				EventID:            analyzer.nextEventID(),
				EventType:          eventTypeObservation,
				Service:            serviceName,
				RunID:              runID,
				Actor:              key.Actor,
				Capability:         key.Capability,
				DataClass:          items[0].DataClass,
				RedactionProfile:   items[0].RedactionProfile,
				PolicyDecision:     policyDecisionAllow(),
				Status:             statusObserved,
				StateTransition:    "analysis.detected",
				InputHash:          key.InputHash,
				OutputHash:         key.OutputHash,
				Pattern:            patternTestFailure,
				PatternFingerprint: "test:" + key.Fingerprint(),
				BuildTestOutcome:   key.BuildOutcome,
				Occurrences:        len(failed),
				Confidence:         analyzer.clamp(0.93, analyzer.policy.Detection.MinConfidence, 1.0),
				FirstStepID:        failed[0].StepID,
				LastStepID:         failed[len(failed)-1].StepID,
				RelatedRecords:     extractEventIDs(failed),
				EvidenceRefs:       extractEventIDs(failed),
				ObservationOnly:    true,
				PolicyVersion:      analyzer.policy.PolicyVersion,
				CreatedAt:          now,
				ObservedAt:         now,
				Payload: map[string]any{
					"evidenceRunId": runID,
					"pattern":       patternTestFailure,
					"reason":        "deterministic test failures",
					"key":           key.String(),
				},
			}))
		}
	}

	hasFailure := false
	hasRecovery := false
	for _, item := range items {
		if strings.EqualFold(item.Status, "failed") {
			hasFailure = true
		}
		if hasFailure && strings.EqualFold(item.Status, "completed") {
			hasRecovery = true
			break
		}
	}
	if hasRecovery {
		out = append(out, buildExperienceEvent(ExperienceEventV0{
			SchemaVersion:      experienceSchemaVersion,
			EventID:            analyzer.nextEventID(),
			EventType:          eventTypeObservation,
			Service:            serviceName,
			RunID:              runID,
			Actor:              key.Actor,
			Capability:         key.Capability,
			DataClass:          items[0].DataClass,
			RedactionProfile:   items[0].RedactionProfile,
			PolicyDecision:     policyDecisionAllow(),
			Status:             statusObserved,
			StateTransition:    "analysis.detected",
			InputHash:          key.InputHash,
			OutputHash:         key.OutputHash,
			Pattern:            patternRetry,
			PatternFingerprint: "retry:" + key.Fingerprint(),
			BuildTestOutcome:   key.BuildOutcome,
			Occurrences:        len(items),
			Confidence:         analyzer.clamp(0.89, analyzer.policy.Detection.MinConfidence, 1.0),
			FirstStepID:        items[0].StepID,
			LastStepID:         items[len(items)-1].StepID,
			RelatedRecords:     extractEventIDs(items),
			EvidenceRefs:       extractEventIDs(items),
			ObservationOnly:    true,
			PolicyVersion:      analyzer.policy.PolicyVersion,
			CreatedAt:          now,
			ObservedAt:         now,
			Payload: map[string]any{
				"evidenceRunId": runID,
				"pattern":       patternRetry,
				"reason":        "failure followed by completion in same action context",
				"key":           key.String(),
			},
		}))
	}
	return out
}

type retrySequenceKey struct {
	Actor        string
	Capability   string
	InputHash    string
	OutputHash   string
	BuildOutcome string
}

func analyzeRetrySequences(analyzer *PatternAnalyzer, runID string, events []EventEnvelopeV0) []ExperienceEventV0 {
	now := analyzer.now()
	groups := make(map[retrySequenceKey][]EventEnvelopeV0)
	for _, event := range events {
		if strings.TrimSpace(event.Actor) == "" || strings.TrimSpace(event.Capability) == "" {
			continue
		}
		if strings.TrimSpace(event.InputRef.SHA256) == "" || strings.TrimSpace(event.OutputRef.SHA256) == "" {
			continue
		}
		key := retrySequenceKey{
			Actor:        event.Actor,
			Capability:   event.Capability,
			InputHash:    event.InputRef.SHA256,
			OutputHash:   event.OutputRef.SHA256,
			BuildOutcome: classifyBuildOutcome(event),
		}
		groups[key] = append(groups[key], event)
	}

	out := make([]ExperienceEventV0, 0)
	for key, items := range groups {
		failedIndex := -1
		recoveredIndex := -1
		for i := range items {
			if failedIndex == -1 && strings.EqualFold(items[i].Status, "failed") {
				failedIndex = i
				continue
			}
			if failedIndex != -1 && strings.EqualFold(items[i].Status, "completed") {
				recoveredIndex = i
				break
			}
		}
		if failedIndex == -1 || recoveredIndex == -1 {
			continue
		}
		failed := items[failedIndex]
		recovered := items[recoveredIndex]
		fingerprint := PatternKey{
			Actor:        key.Actor,
			Capability:   key.Capability,
			InputHash:    key.InputHash,
			OutputHash:   key.OutputHash,
			Status:       "retry",
			BuildOutcome: key.BuildOutcome,
		}.Fingerprint()
		out = append(out, buildExperienceEvent(ExperienceEventV0{
			SchemaVersion:      experienceSchemaVersion,
			EventID:            analyzer.nextEventID(),
			EventType:          eventTypeObservation,
			Service:            serviceName,
			RunID:              runID,
			Actor:              key.Actor,
			Capability:         key.Capability,
			DataClass:          failed.DataClass,
			RedactionProfile:   failed.RedactionProfile,
			PolicyDecision:     policyDecisionAllow(),
			Status:             statusObserved,
			StateTransition:    "analysis.detected",
			InputHash:          key.InputHash,
			OutputHash:         key.OutputHash,
			Pattern:            patternRetry,
			PatternFingerprint: "retry:" + fingerprint,
			BuildTestOutcome:   key.BuildOutcome,
			Occurrences:        2,
			Confidence:         analyzer.clamp(0.89, analyzer.policy.Detection.MinConfidence, 1.0),
			FirstStepID:        failed.StepID,
			LastStepID:         recovered.StepID,
			RelatedRecords:     []string{failed.EventID, recovered.EventID},
			EvidenceRefs:       []string{failed.EventID, recovered.EventID},
			ObservationOnly:    true,
			PolicyVersion:      analyzer.policy.PolicyVersion,
			CreatedAt:          now,
			ObservedAt:         now,
			Payload: map[string]any{
				"evidenceRunId": runID,
				"pattern":       patternRetry,
				"reason":        "failure followed by completion in same action context",
			},
		}))
	}
	return out
}

func analyzeLedger(ledger AgentTrajectoryLedgerV0, runID string, analyzer *PatternAnalyzer) []ExperienceEventV0 {
	out := make([]ExperienceEventV0, 0)
	now := analyzer.now()
	for _, step := range ledger.Steps {
		lower := strings.ToLower(step.Status)
		if lower == "aborted" {
			out = append(out, buildExperienceEvent(ExperienceEventV0{
				SchemaVersion:      experienceSchemaVersion,
				EventID:            analyzer.nextEventID(),
				EventType:          eventTypeObservation,
				Service:            serviceName,
				RunID:              runID,
				Actor:              step.Actor,
				Capability:         step.Capability,
				DataClass:          stepDataClass(step.DataClass),
				RedactionProfile:   redactionProfileControlled,
				PolicyDecision:     policyDecisionAllow(),
				Status:             statusObserved,
				StateTransition:    "analysis.detected",
				Pattern:            patternAbort,
				PatternFingerprint: "abort:" + ledger.RunID + ":" + step.EventID,
				BuildTestOutcome:   "",
				Occurrences:        1,
				Confidence:         analyzer.clamp(0.98, analyzer.policy.Detection.MinConfidence, 1.0),
				FirstStepID:        step.StepID,
				LastStepID:         step.StepID,
				RelatedRecords:     []string{step.EventID},
				EvidenceRefs:       []string{step.EventID},
				ObservationOnly:    true,
				PolicyVersion:      analyzer.policy.PolicyVersion,
				CreatedAt:          now,
				ObservedAt:         now,
				Payload: map[string]any{
					"evidenceRunId": runID,
					"pattern":       patternAbort,
					"reason":        "trajectory ledger contains aborted step",
					"stepId":        step.StepID,
					"stepEventId":   step.EventID,
				},
			}))
		}
		if strings.Contains(strings.ToLower(step.EventType), "budget") ||
			strings.Contains(strings.ToLower(step.StateTransition), "budget") ||
			strings.Contains(strings.ToLower(step.Status), "budget") {
			out = append(out, buildExperienceEvent(ExperienceEventV0{
				SchemaVersion:      experienceSchemaVersion,
				EventID:            analyzer.nextEventID(),
				EventType:          eventTypeObservation,
				Service:            serviceName,
				RunID:              runID,
				Actor:              step.Actor,
				Capability:         step.Capability,
				DataClass:          stepDataClass(step.DataClass),
				RedactionProfile:   redactionProfileControlled,
				PolicyDecision:     policyDecisionAllow(),
				Status:             statusObserved,
				StateTransition:    "analysis.detected",
				InputHash:          "",
				OutputHash:         "",
				Pattern:            patternBudgetOverrun,
				PatternFingerprint: "budget:" + ledger.RunID + ":" + step.EventID,
				BuildTestOutcome:   "",
				Occurrences:        1,
				Confidence:         analyzer.clamp(0.95, analyzer.policy.Detection.MinConfidence, 1.0),
				FirstStepID:        step.StepID,
				LastStepID:         step.StepID,
				RelatedRecords:     []string{step.EventID},
				EvidenceRefs:       []string{step.EventID},
				ObservationOnly:    true,
				PolicyVersion:      analyzer.policy.PolicyVersion,
				CreatedAt:          now,
				ObservedAt:         now,
				Payload: map[string]any{
					"evidenceRunId": runID,
					"pattern":       patternBudgetOverrun,
					"reason":        "budget overrun detected in trajectory state",
					"stepId":        step.StepID,
					"stepEventId":   step.EventID,
				},
			}))
		}
	}
	return out
}

func buildExperienceEvent(event ExperienceEventV0) ExperienceEventV0 {
	if event.DataClass == "" {
		event.DataClass = dataClassOther
	}
	if event.Pattern == "" {
		event.Pattern = patternAcceptedPattern
	}
	return event
}

func stepDataClass(dataClass string) string {
	if dataClass == "" {
		return dataClassOther
	}
	if _, ok := allowedDataClasses[dataClass]; ok {
		return dataClass
	}
	return dataClassOther
}

func policyDecisionAllow() string {
	return "policy allow"
}

func filterEventsByRun(events []EventEnvelopeV0, runID string) []EventEnvelopeV0 {
	out := make([]EventEnvelopeV0, 0)
	for _, event := range events {
		if event.RunID == runID {
			out = append(out, event)
		}
	}
	return out
}

func filterLedgersByRun(ledgers []AgentTrajectoryLedgerV0, runID string) []AgentTrajectoryLedgerV0 {
	out := make([]AgentTrajectoryLedgerV0, 0)
	for _, item := range ledgers {
		if item.RunID == runID {
			out = append(out, item)
		}
	}
	return out
}

func extractEventIDs(events []EventEnvelopeV0) []string {
	ids := make([]string, 0, len(events))
	for _, item := range events {
		ids = append(ids, item.EventID)
	}
	return ids
}

func classifyBuildOutcome(event EventEnvelopeV0) string {
	eventType := strings.ToLower(event.EventType)
	dataClass := strings.ToLower(event.DataClass)
	outcome := strings.ToLower(payloadText(event.Payload, []string{"outcome", "phase", "stage"}, ""))
	if strings.Contains(eventType, "test") || dataClass == dataClassTest || outcome == "test" {
		return "test"
	}
	if strings.Contains(eventType, "compile") || strings.Contains(eventType, "build") || dataClass == dataClassBuildTest || outcome == "compile" {
		return "compile"
	}
	return ""
}

func isAcceptedArtifact(event EventEnvelopeV0) bool {
	if strings.EqualFold(event.Status, "accepted") {
		return true
	}
	if payloadTextBool(event.Payload, "accepted") {
		return true
	}
	if strings.Contains(strings.ToLower(event.StateTransition), "accept") {
		return true
	}
	if strings.Contains(strings.ToLower(event.EventType), "accept") {
		return true
	}
	return false
}

func normalizeStatus(status string) string {
	return strings.ToLower(strings.TrimSpace(status))
}

func payloadText(payload map[string]any, keys []string, fallback string) string {
	for _, key := range keys {
		if value, ok := payload[key]; ok {
			if s, ok := value.(string); ok && strings.TrimSpace(s) != "" {
				return strings.ToLower(strings.TrimSpace(s))
			}
		}
	}
	return fallback
}

func payloadTextBool(payload map[string]any, key string) bool {
	value, ok := payload[key]
	if !ok {
		return false
	}
	switch typed := value.(type) {
	case bool:
		return typed
	case string:
		return strings.EqualFold(strings.TrimSpace(typed), "true") || strings.EqualFold(strings.TrimSpace(typed), "yes")
	default:
		return false
	}
}

func dedupeCandidates(candidates []ExperienceEventV0) []ExperienceEventV0 {
	byKey := map[string]ExperienceEventV0{}
	for _, candidate := range candidates {
		key := candidate.PatternFingerprint
		if candidate.Pattern != "" {
			key = candidate.Pattern + ":" + key
		}
		if _, exists := byKey[key]; !exists {
			byKey[key] = candidate
		}
	}
	out := make([]ExperienceEventV0, 0, len(byKey))
	for _, candidate := range byKey {
		out = append(out, candidate)
	}
	return out
}

func applyPolicyGating(policy LearningPolicy, candidates []ExperienceEventV0) []ExperienceEventV0 {
	if policy.ObservationOnly {
		return candidates
	}
	out := make([]ExperienceEventV0, 0, len(candidates))
	for _, candidate := range candidates {
		candidate.Status = statusIgnored
		if candidate.Payload == nil {
			candidate.Payload = map[string]any{}
		}
		candidate.Payload["blockedByPolicy"] = "policy requires observation-only mode"
		out = append(out, candidate)
	}
	return out
}

func (a *PatternAnalyzer) nextEventID() string {
	now := a.now()
	return fmt.Sprintf("xel-%s-%d", now.Format("20060102"), a.seq.Add(1))
}

func (a *PatternAnalyzer) clamp(value, min, max float64) float64 {
	if value < min {
		return min
	}
	if value > max {
		return max
	}
	return value
}
