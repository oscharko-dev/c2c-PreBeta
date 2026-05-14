package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"strings"

	"gopkg.in/yaml.v3"
)

type DetectionPolicy struct {
	MinOccurrencesRepeatAction int     `yaml:"minOccurrencesRepeatAction"`
	MinOccurrencesRepeatedFail int     `yaml:"minOccurrencesRepeatedFailure"`
	MinConfidence              float64 `yaml:"minConfidence"`
	MinConfidenceRepeatAction  float64 `yaml:"minConfidenceRepeatAction"`
	MinConfidenceFailure       float64 `yaml:"minConfidenceFailure"`
	IncludeBuildTestFailures   bool    `yaml:"includeBuildTestFailures"`
}

type LearningPolicy struct {
	SchemaVersion           string          `yaml:"schemaVersion"`
	PolicyVersion           string          `yaml:"policyVersion"`
	Mode                    string          `yaml:"mode"`
	ObservationOnly         bool            `yaml:"observationOnly"`
	RequireReviewerApproval bool            `yaml:"requireReviewerApproval"`
	BlockPromptChanges      bool            `yaml:"blockPromptChanges"`
	BlockModelChanges       bool            `yaml:"blockModelChanges"`
	BlockGeneratorChanges   bool            `yaml:"blockGeneratorChanges"`
	BlockRuntimeChanges     bool            `yaml:"blockRuntimeChanges"`
	BlockPolicyChanges      bool            `yaml:"blockPolicyChanges"`
	Detection               DetectionPolicy `yaml:"detection"`
	PolicyFingerprint       string          `json:"-"`
}

func DefaultLearningPolicy() LearningPolicy {
	policy := LearningPolicy{
		SchemaVersion:           experienceSchemaVersion,
		PolicyVersion:           "v0.1.0",
		Mode:                    defaultPolicyMode,
		ObservationOnly:         true,
		RequireReviewerApproval: true,
		BlockPromptChanges:      true,
		BlockModelChanges:       true,
		BlockGeneratorChanges:   true,
		BlockRuntimeChanges:     true,
		BlockPolicyChanges:      true,
		Detection: DetectionPolicy{
			MinOccurrencesRepeatAction: 2,
			MinOccurrencesRepeatedFail: 2,
			MinConfidence:              0.80,
			MinConfidenceRepeatAction:  0.85,
			MinConfidenceFailure:       0.90,
			IncludeBuildTestFailures:   true,
		},
	}
	policy.PolicyFingerprint = policy.fingerprint()
	return policy
}

func LoadLearningPolicy(path string) (LearningPolicy, error) {
	if strings.TrimSpace(path) == "" {
		return DefaultLearningPolicy(), nil
	}
	content, err := os.ReadFile(path)
	if err != nil {
		return LearningPolicy{}, fmt.Errorf("read policy failed: %w", err)
	}
	var policy LearningPolicy
	if err := yaml.Unmarshal(content, &policy); err != nil {
		return LearningPolicy{}, fmt.Errorf("parse policy failed: %w", err)
	}
	if err := policy.Validate(); err != nil {
		return LearningPolicy{}, err
	}
	policy.PolicyFingerprint = policy.fingerprint()
	return policy, nil
}

func LoadLearningPolicyWithDefault(path string) LearningPolicy {
	policy, err := LoadLearningPolicy(path)
	if err == nil {
		return policy
	}
	return DefaultLearningPolicy()
}

func (p LearningPolicy) Validate() error {
	if strings.TrimSpace(p.SchemaVersion) == "" {
		return fmt.Errorf("policy schemaVersion is required")
	}
	if p.SchemaVersion != experienceSchemaVersion {
		return fmt.Errorf("policy schemaVersion must be v0")
	}
	if strings.TrimSpace(p.PolicyVersion) == "" {
		return fmt.Errorf("policyVersion is required")
	}
	if _, ok := allowedPolicyModes[p.Mode]; !ok {
		return fmt.Errorf("mode must be observation")
	}
	if !p.ObservationOnly {
		return fmt.Errorf("observationOnly must be true in v0")
	}
	if !p.BlockPromptChanges || !p.BlockModelChanges || !p.BlockGeneratorChanges || !p.BlockRuntimeChanges || !p.BlockPolicyChanges {
		return fmt.Errorf("all runtime mutation pathways must be blocked in v0")
	}
	if p.Detection.MinOccurrencesRepeatAction < 2 {
		return fmt.Errorf("minOccurrencesRepeatAction must be >= 2")
	}
	if p.Detection.MinOccurrencesRepeatedFail < 2 {
		return fmt.Errorf("minOccurrencesRepeatedFailure must be >= 2")
	}
	if p.Detection.MinConfidence < 0 || p.Detection.MinConfidence > 1 {
		return fmt.Errorf("minConfidence must be within [0,1]")
	}
	if p.Detection.MinConfidenceRepeatAction < 0 || p.Detection.MinConfidenceRepeatAction > 1 {
		return fmt.Errorf("minConfidenceRepeatAction must be within [0,1]")
	}
	if p.Detection.MinConfidenceFailure < 0 || p.Detection.MinConfidenceFailure > 1 {
		return fmt.Errorf("minConfidenceFailure must be within [0,1]")
	}
	return nil
}

func (p LearningPolicy) fingerprint() string {
	raw, err := json.Marshal(p)
	if err != nil {
		return ""
	}
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])
}

func (p LearningPolicy) Decision() PolicyDecision {
	return PolicyDecision{
		Mode:    p.Mode,
		Reason:  p.PolicyVersion,
		Allowed: p.ObservationOnly && p.BlockPromptChanges && p.BlockModelChanges && p.BlockGeneratorChanges && p.BlockRuntimeChanges && p.BlockPolicyChanges,
	}
}
