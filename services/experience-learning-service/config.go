package main

import (
	"fmt"
	"os"
	"strings"
)

const (
	defaultExperienceListenAddr   = ":8084"
	defaultPolicyPath             = "policies/learning-policy-v0.yaml"
	defaultHarnessEventLogPath    = "data/experience-service-harness-events-v0.jsonl"
	defaultTrajectoryLedgerPath   = "data/agent-trajectory-ledger-v0.jsonl"
	defaultExperienceEventLogPath = "data/experience-events-v0.jsonl"
	defaultArtifactRegistryPath   = "data/learning-artifact-registry-v0.json"
)

type experienceLearningConfig struct {
	listenAddr           string
	policyPath           string
	harnessEventPath     string
	trajectoryPath       string
	experienceEventPath  string
	artifactRegistryPath string
	autoAnalyzeOnIngest  bool
}

func resolveExperienceConfig() (experienceLearningConfig, error) {
	cfg := experienceLearningConfig{
		listenAddr:           normalizeListenAddress(strings.TrimSpace(os.Getenv("EXPERIENCE_LEARNING_LISTEN_ADDR"))),
		policyPath:           strings.TrimSpace(os.Getenv("EXPERIENCE_LEARNING_POLICY_PATH")),
		harnessEventPath:     strings.TrimSpace(os.Getenv("EXPERIENCE_LEARNING_HARNESS_EVENTS_PATH")),
		trajectoryPath:       strings.TrimSpace(os.Getenv("EXPERIENCE_LEARNING_TRAJECTORY_LEDGER_PATH")),
		experienceEventPath:  strings.TrimSpace(os.Getenv("EXPERIENCE_LEARNING_EVENTS_PATH")),
		artifactRegistryPath: strings.TrimSpace(os.Getenv("EXPERIENCE_LEARNING_ARTIFACT_REGISTRY_PATH")),
		autoAnalyzeOnIngest:  true,
	}

	if cfg.policyPath == "" {
		cfg.policyPath = defaultPolicyPath
	}
	if cfg.harnessEventPath == "" {
		cfg.harnessEventPath = defaultHarnessEventLogPath
	}
	if cfg.trajectoryPath == "" {
		cfg.trajectoryPath = defaultTrajectoryLedgerPath
	}
	if cfg.experienceEventPath == "" {
		cfg.experienceEventPath = defaultExperienceEventLogPath
	}
	if cfg.artifactRegistryPath == "" {
		cfg.artifactRegistryPath = defaultArtifactRegistryPath
	}
	if cfg.listenAddr == "" {
		cfg.listenAddr = defaultExperienceListenAddr
	}

	autoAnalyzeRaw := strings.TrimSpace(strings.ToLower(os.Getenv("EXPERIENCE_LEARNING_AUTO_ANALYZE")))
	if autoAnalyzeRaw != "" {
		switch autoAnalyzeRaw {
		case "false", "0", "no", "off":
			cfg.autoAnalyzeOnIngest = false
		case "true", "1", "yes", "on":
			cfg.autoAnalyzeOnIngest = true
		default:
			return cfg, fmt.Errorf("invalid EXPERIENCE_LEARNING_AUTO_ANALYZE value: %s", autoAnalyzeRaw)
		}
	}

	if strings.HasSuffix(cfg.harnessEventPath, ".json") {
		return cfg, fmt.Errorf("harness event path must be jsonl")
	}
	if strings.HasSuffix(cfg.trajectoryPath, ".json") {
		return cfg, fmt.Errorf("trajectory ledger path must be jsonl")
	}
	if strings.HasSuffix(cfg.experienceEventPath, ".json") {
		return cfg, fmt.Errorf("experience event path must be jsonl")
	}

	return cfg, nil
}

func normalizeListenAddress(input string) string {
	value := strings.TrimSpace(input)
	if value == "" {
		return defaultExperienceListenAddr
	}
	if value[0] == ':' || strings.HasPrefix(value, "http://") || strings.HasPrefix(value, "https://") {
		return value
	}
	return ":" + value
}
