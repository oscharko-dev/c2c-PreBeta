package main

import (
	"log"
	"net/http"
	"os"
	"strings"
	"time"
)

func main() {
	cfg := resolveGatewayConfigFromEnv()
	log.Printf("loading model registry from %s", cfg.registryPath)
	log.Printf("loading allowlist from %s", cfg.allowlistPath)

	allowed, err := LoadFoundryAllowlist(cfg.allowlistPath)
	if err != nil {
		log.Fatalf("load allowlist failed: %v", err)
	}
	if allowed.Mode == "" {
		allowed.Mode = ModelProviderFoundryDevelopment
	}

	registry, err := LoadModelRegistry(cfg.registryPath)
	if err != nil {
		log.Fatalf("load model registry failed: %v", err)
	}
	ledger, err := NewJSONLModelInvocationLedger(cfg.ledgerPath)
	if err != nil {
		log.Fatalf("init ledger failed: %v", err)
	}

	eventSink, err := NewJSONLHarnessEventSink(cfg.eventLogPath)
	if err != nil {
		log.Fatalf("init event sink failed: %v", err)
	}
	sinks := []EventSink{eventSink}

	if strings.TrimSpace(cfg.harnessEventURL) != "" {
		remoteSink, err := NewRemoteHarnessEventSink(cfg.harnessEventURL)
		if err != nil {
			log.Fatalf("init remote event sink failed: %v", err)
		}
		if remoteSink != nil {
			sinks = append(sinks, remoteSink)
		}
	}
	compositeSink := NewCompositeEventSink(sinks...)

	service, err := NewModelGatewayService(registry, allowed, ledger, compositeSink, time.Now().UTC)
	if err != nil {
		log.Fatalf("initialize service failed: %v", err)
	}
	defer service.closeSinks()

	addr := strings.TrimSpace(os.Getenv("MODEL_GATEWAY_LISTEN_ADDR"))
	if addr == "" {
		addr = defaultModelListenAddr
	}
	if addr[0] != ':' && !strings.HasPrefix(addr, "http") {
		addr = ":" + addr
	}

	server := &http.Server{
		Addr:    addr,
		Handler: service.Routes(),
	}
	log.Printf("model-gateway-service listening on %s", addr)
	if err := server.ListenAndServe(); err != nil {
		log.Fatalf("server failed: %v", err)
	}
}
