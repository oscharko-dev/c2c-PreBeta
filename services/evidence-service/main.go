package main

import (
	"log"
	"net/http"
	"os"
	"strings"
)

const defaultPort = "8080"

func main() {
	port := strings.TrimSpace(os.Getenv("EVIDENCE_PORT"))
	if port == "" {
		port = defaultPort
	}
	addr := port
	if !strings.HasPrefix(addr, ":") {
		addr = ":" + addr
	}

	eventLogPath := strings.TrimSpace(os.Getenv(envEventLogPath))
	if eventLogPath == "" {
		eventLogPath = defaultEventLogPath
	}
	exportRoot := strings.TrimSpace(os.Getenv(envExportRoot))
	if exportRoot == "" {
		exportRoot = defaultExportRoot
	}

	service := NewService(eventLogPath, exportRoot)
	server := &http.Server{
		Addr:    addr,
		Handler: service.Routes(),
	}
	log.Printf("evidence-service listening on %s (exportRoot=%s)", addr, exportRoot)
	if err := server.ListenAndServe(); err != nil {
		log.Fatalf("server failed: %v", err)
	}
}
