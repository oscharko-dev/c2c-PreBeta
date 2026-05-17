package main

import (
	"bytes"
	"net/http"
	"strings"
	"testing"
)

func TestDecodeJSONRejectsOversizedBody(t *testing.T) {
	srv, _ := newTestServer(t)
	body := bytes.NewReader(bytes.Repeat([]byte("a"), maxRequestBodyBytes+1024))
	req, err := http.NewRequest(http.MethodPost, srv.URL+"/v0/packs", body)
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+testControlToken)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("POST: %v", err)
	}
	defer func() { _ = res.Body.Close() }()
	if res.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected 400 for oversized body, got %d", res.StatusCode)
	}
}

func TestDecodeJSONRejectsNonJSONContentType(t *testing.T) {
	srv, _ := newTestServer(t)
	req, err := http.NewRequest(http.MethodPost, srv.URL+"/v0/packs", strings.NewReader(`{"runId":"run-ct"}`))
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	req.Header.Set("Content-Type", "text/html")
	req.Header.Set("Authorization", "Bearer "+testControlToken)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("do: %v", err)
	}
	defer func() { _ = res.Body.Close() }()
	if res.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected 400 for non-json content-type, got %d", res.StatusCode)
	}
}

func TestExporterRejectsAbsoluteDestination(t *testing.T) {
	exporter := NewExporter(t.TempDir())
	_, err := exporter.resolveDestination("epk-x-0001", ExportFormatDirectory, "/etc/passwd-evidence")
	if err == nil {
		t.Fatalf("expected error for absolute destination")
	}
	if !strings.Contains(err.Error(), "relative path") && !strings.Contains(err.Error(), "destination") {
		t.Fatalf("unexpected error message: %v", err)
	}
}

func TestStatusForValidationErrorReturns500ForNonFieldError(t *testing.T) {
	if got := statusForValidationError(errBoringInternal{}); got != http.StatusInternalServerError {
		t.Fatalf("expected 500 for non-field error, got %d", got)
	}
	if got := statusForValidationError(&FieldValidationError{Path: "x", Reason: "y"}); got != http.StatusBadRequest {
		t.Fatalf("expected 400 for field error, got %d", got)
	}
}

type errBoringInternal struct{}

func (errBoringInternal) Error() string { return "internal failure unrelated to client input" }
