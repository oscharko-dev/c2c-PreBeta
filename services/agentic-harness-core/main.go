package main

import (
	"log"
	"net/http"
	"os"
)

const (
	defaultPort = "8080"
)

func main() {
	addr := os.Getenv("HARNESS_PORT")
	if addr == "" {
		addr = ":" + defaultPort
	}
	if addr[0] != ':' {
		addr = ":" + addr
	}

	service := NewHarnessService()
	server := &http.Server{
		Addr:    addr,
		Handler: service.Routes(),
	}

	log.Printf("agentic-harness-core listening on %s", addr)
	if err := server.ListenAndServe(); err != nil {
		log.Fatalf("server failed: %v", err)
	}
}
