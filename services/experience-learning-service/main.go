package main

import (
	"log"
	"net/http"
	"time"
)

func main() {
	cfg, err := resolveExperienceConfig()
	if err != nil {
		log.Fatalf("invalid configuration: %v", err)
	}

	policy := LoadLearningPolicyWithDefault(cfg.policyPath)
	log.Printf(
		"loaded learning policy: mode=%s version=%s observationOnly=%t fingerprint=%s",
		policy.Mode,
		policy.PolicyVersion,
		policy.ObservationOnly,
		policy.PolicyFingerprint,
	)

	harnessEventStore, err := NewJSONLHarnessEventStore(cfg.harnessEventPath)
	if err != nil {
		log.Fatalf("init harness event store failed: %v", err)
	}

	trajectoryStore, err := NewJSONLTrajectoryLedgerStore(cfg.trajectoryPath)
	if err != nil {
		log.Fatalf("init trajectory ledger store failed: %v", err)
	}

	experienceEventStore, err := NewJSONLExperienceEventStore(cfg.experienceEventPath)
	if err != nil {
		log.Fatalf("init experience event store failed: %v", err)
	}
	defer func() {
		if err := experienceEventStore.Close(); err != nil {
			log.Printf("close experience event store failed: %v", err)
		}
	}()

	service := NewExperienceLearningService(
		cfg,
		harnessEventStore,
		trajectoryStore,
		experienceEventStore,
		policy,
		time.Now().UTC,
	)
	server := &http.Server{
		Addr:    cfg.listenAddr,
		Handler: service.Routes(),
	}

	log.Printf("experience-learning-service listening on %s", cfg.listenAddr)
	if err := server.ListenAndServe(); err != nil {
		log.Fatalf("server failed: %v", err)
	}
}
