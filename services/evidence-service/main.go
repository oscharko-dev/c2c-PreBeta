package main

import (
	"log"
	"net/http"
	"os"
	"strings"
)

const defaultPort = "8080"

func main() {
	addr := strings.TrimSpace(os.Getenv("EVIDENCE_LISTEN_ADDR"))
	if addr == "" {
		port := strings.TrimSpace(os.Getenv("EVIDENCE_PORT"))
		if port == "" {
			port = defaultPort
		}
		addr = port
	}
	if strings.HasPrefix(addr, ":") {
		addr = "127.0.0.1" + addr
	} else if !strings.Contains(addr, ":") {
		addr = "127.0.0.1:" + addr
	}

	eventLogPath := strings.TrimSpace(os.Getenv(envEventLogPath))
	if eventLogPath == "" {
		eventLogPath = defaultEventLogPath
	}
	exportRoot := strings.TrimSpace(os.Getenv(envExportRoot))
	if exportRoot == "" {
		exportRoot = defaultExportRoot
	}

	controlToken := strings.TrimSpace(os.Getenv("EVIDENCE_CONTROL_TOKEN"))
	if controlToken == "" {
		controlToken = strings.TrimSpace(os.Getenv("C2C_INTERNAL_CONTROL_TOKEN"))
	}

	service := NewService(eventLogPath, exportRoot)
	service.SetControlToken(controlToken)
	server := &http.Server{
		Addr:    addr,
		Handler: service.Routes(),
	}
	log.Printf("evidence-service listening on %s (exportRoot=%s)", addr, exportRoot)
	if err := server.ListenAndServe(); err != nil {
		log.Fatalf("server failed: %v", err)
	}
}
