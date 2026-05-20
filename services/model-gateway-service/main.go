package main

import (
	"log"
	"net/http"
	"os"
	"strings"
	"time"
)

func main() {
	cfg, err := resolveGatewayConfigFromEnv()
	if err != nil {
		log.Fatalf("resolve configuration failed: %v", err)
	}
	log.Printf("loading model registry from %s", cfg.registryPath)
	log.Printf("loading allowlist from %s", cfg.allowlistPath)

	allowed, err := LoadFoundryAllowlist(cfg.allowlistPath)
	if err != nil {
		log.Fatalf("load allowlist failed: %v", err)
	}
	if cfg.modelProvider != "" {
		allowed.Mode = cfg.modelProvider
	}
	if cfg.azureFoundryEndpoint != "" {
		allowed.Foundry.Endpoint = cfg.azureFoundryEndpoint
	}
	if cfg.azureFoundryAPIKey != "" {
		allowed.Foundry.ApiKey = cfg.azureFoundryAPIKey
	}
	if cfg.azureFoundryAPIKeyRef != "" {
		allowed.Foundry.ApiKeyRef = cfg.azureFoundryAPIKeyRef
	}
	if cfg.azureFoundryAPIVersion != "" {
		allowed.Foundry.APIVersion = cfg.azureFoundryAPIVersion
	}
	if allowed.Mode == "" {
		allowed.Mode = ModelProviderFoundryDevelopment
	}
	if len(cfg.allowedModelDeployments) > 0 {
		allowed.AllowedModelIDs = cfg.allowedModelDeployments
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
		remoteSink, err := NewRemoteHarnessEventSink(cfg.harnessEventURL, cfg.harnessEventToken)
		if err != nil {
			log.Fatalf("init remote event sink failed: %v", err)
		}
		if remoteSink != nil {
			sinks = append(sinks, remoteSink)
		}
	}
	compositeSink := NewCompositeEventSink(sinks...)

	service, err := NewModelGatewayService(registry, allowed, ledger, compositeSink, func() time.Time { return time.Now().UTC() })
	if err != nil {
		log.Fatalf("initialize service failed: %v", err)
	}
	if err := service.applyGatewayRuntimeConfig(cfg); err != nil {
		log.Fatalf("configure model gateway runtime failed: %v", err)
	}
	defer service.closeSinks()

	addr := strings.TrimSpace(os.Getenv("MODEL_GATEWAY_LISTEN_ADDR"))
	if addr == "" {
		addr = defaultModelListenAddr
	}
	if strings.HasPrefix(addr, ":") {
		addr = "127.0.0.1" + addr
	} else if !strings.Contains(addr, ":") {
		addr = "127.0.0.1:" + addr
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
