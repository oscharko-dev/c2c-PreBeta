package main

import (
	"archive/tar"
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestHealthAndReady(t *testing.T) {
	srv, _ := newTestServer(t)
	for _, path := range []string{"/v0/health", "/v0/ready"} {
		res, err := http.Get(srv.URL + path)
		if err != nil {
			t.Fatalf("GET %s: %v", path, err)
		}
		if res.StatusCode != http.StatusOK {
			t.Fatalf("GET %s: expected 200, got %d", path, res.StatusCode)
		}
		res.Body.Close()
	}
}

func TestCreateIncompletePackReportsMissingArtifacts(t *testing.T) {
	srv, _ := newTestServer(t)
	payload := CreateInput{RunID: "run-1"}
	res := postJSON(t, srv.URL+"/v0/packs", payload)
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("expected 201, got %d", res.StatusCode)
	}
	var manifest EvidencePackManifest
	if err := json.NewDecoder(res.Body).Decode(&manifest); err != nil {
		t.Fatalf("decode: %v", err)
	}
	res.Body.Close()
	if manifest.Status != StatusIncomplete {
		t.Fatalf("expected status=incomplete, got %s", manifest.Status)
	}
	if manifest.Validation.OK {
		t.Fatalf("expected validation.ok=false")
	}
	if len(manifest.Validation.MissingArtifacts) == 0 {
		t.Fatalf("expected missing artifact list, got empty")
	}
}

func TestCreatePackEmitsHarnessEvent(t *testing.T) {
	srv, svc := newTestServer(t)
	res := postJSON(t, srv.URL+"/v0/packs", CreateInput{
		RunID:     "run-1",
		Artifacts: completeArtifacts(t),
	})
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("expected 201, got %d", res.StatusCode)
	}
	res.Body.Close()

	events, err := svc.events.List()
	if err != nil {
		t.Fatalf("list events: %v", err)
	}
	if len(events) != 1 {
		t.Fatalf("expected 1 harness event, got %d", len(events))
	}
	event := events[0]
	if event.EventType != EventTypePackCreated {
		t.Fatalf("unexpected event type: %s", event.EventType)
	}
	if event.DataClass != DataClassEvidence {
		t.Fatalf("unexpected data class: %s", event.DataClass)
	}
	if event.Capability != CapabilityEvidence {
		t.Fatalf("unexpected capability: %s", event.Capability)
	}
	if event.RunID != "run-1" {
		t.Fatalf("unexpected runId: %s", event.RunID)
	}
	if event.SchemaVersion != SchemaVersionV0 {
		t.Fatalf("unexpected schemaVersion: %s", event.SchemaVersion)
	}
}

func TestPatchAccruesArtifactsAndStatusFlipsToComplete(t *testing.T) {
	srv, _ := newTestServer(t)
	res := postJSON(t, srv.URL+"/v0/packs", CreateInput{RunID: "run-2"})
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("create: expected 201, got %d", res.StatusCode)
	}
	var initial EvidencePackManifest
	if err := json.NewDecoder(res.Body).Decode(&initial); err != nil {
		t.Fatalf("decode: %v", err)
	}
	res.Body.Close()

	artifacts := completeArtifacts(t)
	patch := PatchInput{Artifacts: &artifacts}
	res = patchJSON(t, srv.URL+"/v0/packs/"+initial.PackID, patch)
	if res.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(res.Body)
		t.Fatalf("patch: expected 200, got %d body=%s", res.StatusCode, string(body))
	}
	var updated EvidencePackManifest
	if err := json.NewDecoder(res.Body).Decode(&updated); err != nil {
		t.Fatalf("decode: %v", err)
	}
	res.Body.Close()
	if updated.Status != StatusComplete {
		t.Fatalf("expected status=complete, got %s", updated.Status)
	}
	if !updated.Validation.OK {
		t.Fatalf("expected validation.ok=true, got %+v", updated.Validation)
	}
}

func TestExportRefusedWhenIncomplete(t *testing.T) {
	srv, _ := newTestServer(t)
	res := postJSON(t, srv.URL+"/v0/packs", CreateInput{RunID: "run-3"})
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("create: expected 201, got %d", res.StatusCode)
	}
	var manifest EvidencePackManifest
	_ = json.NewDecoder(res.Body).Decode(&manifest)
	res.Body.Close()

	res = postJSON(t, srv.URL+"/v0/packs/"+manifest.PackID+"/export", ExportRequest{Format: ExportFormatDirectory})
	if res.StatusCode != http.StatusUnprocessableEntity {
		body, _ := io.ReadAll(res.Body)
		t.Fatalf("expected 422 when incomplete, got %d body=%s", res.StatusCode, string(body))
	}
	res.Body.Close()
}

func TestExportDirectoryAndTar(t *testing.T) {
	srv, svc := newTestServer(t)
	res := postJSON(t, srv.URL+"/v0/packs", CreateInput{
		RunID:     "run-4",
		Artifacts: completeArtifacts(t),
	})
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("create: expected 201, got %d", res.StatusCode)
	}
	var manifest EvidencePackManifest
	_ = json.NewDecoder(res.Body).Decode(&manifest)
	res.Body.Close()

	// directory export
	res = postJSON(t, srv.URL+"/v0/packs/"+manifest.PackID+"/export", ExportRequest{Format: ExportFormatDirectory})
	if res.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(res.Body)
		t.Fatalf("directory export: expected 200, got %d body=%s", res.StatusCode, string(body))
	}
	var dirResp struct {
		Pack   EvidencePackManifest `json:"pack"`
		Export ExportRecord         `json:"export"`
	}
	_ = json.NewDecoder(res.Body).Decode(&dirResp)
	res.Body.Close()
	if len(dirResp.Pack.Exports) != 1 {
		t.Fatalf("expected 1 export record in response pack, got %d", len(dirResp.Pack.Exports))
	}
	if dirResp.Pack.Exports[0].SHA256 == "" {
		t.Fatalf("expected non-empty export sha256")
	}
	if strings.HasPrefix(dirResp.Export.URI, "file://") {
		t.Fatalf("export URI must not expose host-local file paths: %s", dirResp.Export.URI)
	}
	dirPath := filepath.Join(svc.exporter.baseDir, manifest.PackID)
	if _, err := os.Stat(filepath.Join(dirPath, "manifest.json")); err != nil {
		t.Fatalf("expected manifest.json on disk, got %v", err)
	}

	// tar export
	res = postJSON(t, srv.URL+"/v0/packs/"+manifest.PackID+"/export", ExportRequest{Format: ExportFormatTar})
	if res.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(res.Body)
		t.Fatalf("tar export: expected 200, got %d body=%s", res.StatusCode, string(body))
	}
	var tarResp struct {
		Export ExportRecord `json:"export"`
	}
	_ = json.NewDecoder(res.Body).Decode(&tarResp)
	res.Body.Close()
	if strings.HasPrefix(tarResp.Export.URI, "file://") {
		t.Fatalf("tar export URI must not expose host-local file paths: %s", tarResp.Export.URI)
	}
	tarPath := filepath.Join(svc.exporter.baseDir, manifest.PackID+".tar")
	f, err := os.Open(tarPath)
	if err != nil {
		t.Fatalf("open tar: %v", err)
	}
	defer f.Close()
	tr := tar.NewReader(f)
	header, err := tr.Next()
	if err != nil {
		t.Fatalf("read tar header: %v", err)
	}
	if header.Name != "manifest.json" {
		t.Fatalf("unexpected tar entry name: %s", header.Name)
	}

	events, _ := svc.events.List()
	exportedCount := 0
	for _, e := range events {
		if e.EventType == EventTypePackExported {
			exportedCount++
		}
	}
	if exportedCount != 2 {
		t.Fatalf("expected 2 exported events, got %d", exportedCount)
	}
}

func TestExportRefusesEscapeOfBaseDir(t *testing.T) {
	srv, _ := newTestServer(t)
	res := postJSON(t, srv.URL+"/v0/packs", CreateInput{
		RunID:     "run-5",
		Artifacts: completeArtifacts(t),
	})
	var manifest EvidencePackManifest
	_ = json.NewDecoder(res.Body).Decode(&manifest)
	res.Body.Close()

	res = postJSON(t, srv.URL+"/v0/packs/"+manifest.PackID+"/export", ExportRequest{
		Format:      ExportFormatDirectory,
		Destination: "/etc/passwd-evidence",
	})
	if res.StatusCode != http.StatusBadRequest {
		body, _ := io.ReadAll(res.Body)
		t.Fatalf("expected 400 for escape attempt, got %d body=%s", res.StatusCode, string(body))
	}
	res.Body.Close()
}

func TestPackNotFound(t *testing.T) {
	srv, _ := newTestServer(t)
	res, err := http.Get(srv.URL + "/v0/packs/epk-missing-0001")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusNotFound {
		t.Fatalf("expected 404, got %d", res.StatusCode)
	}
}

func TestValidateEndpointReportsMissing(t *testing.T) {
	srv, _ := newTestServer(t)
	res := postJSON(t, srv.URL+"/v0/packs", CreateInput{RunID: "run-6"})
	var manifest EvidencePackManifest
	_ = json.NewDecoder(res.Body).Decode(&manifest)
	res.Body.Close()

	res = postJSON(t, srv.URL+"/v0/packs/"+manifest.PackID+"/validate", map[string]string{})
	if res.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("expected 422 for incomplete validate, got %d", res.StatusCode)
	}
	res.Body.Close()
}

func TestPatchPackNotFound(t *testing.T) {
	srv, _ := newTestServer(t)
	res := patchJSON(t, srv.URL+"/v0/packs/epk-missing-0001", PatchInput{Summary: ptr("missing")})
	defer res.Body.Close()
	if res.StatusCode != http.StatusNotFound {
		t.Fatalf("expected 404, got %d", res.StatusCode)
	}
}

func TestEventsEndpointReturnsEmittedEvents(t *testing.T) {
	srv, _ := newTestServer(t)
	res := postJSON(t, srv.URL+"/v0/packs", CreateInput{
		RunID:     "run-events",
		Artifacts: completeArtifacts(t),
	})
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("expected 201, got %d", res.StatusCode)
	}
	res.Body.Close()

	res, err := http.Get(srv.URL + "/v0/events")
	if err != nil {
		t.Fatalf("get events: %v", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", res.StatusCode)
	}
	var events []HarnessEvent
	if err := json.NewDecoder(res.Body).Decode(&events); err != nil {
		t.Fatalf("decode events: %v", err)
	}
	if len(events) == 0 {
		t.Fatalf("expected at least one event")
	}
	if events[0].EventType != EventTypePackCreated {
		t.Fatalf("unexpected event type: %s", events[0].EventType)
	}
}

func TestJSONLEventSinkPersistsEvents(t *testing.T) {
	dir := t.TempDir()
	logPath := filepath.Join(dir, "events.jsonl")
	service := NewService(logPath, dir)
	srv := httptest.NewServer(service.Routes())
	t.Cleanup(srv.Close)

	res := postJSON(t, srv.URL+"/v0/packs", CreateInput{
		RunID:     "run-persist",
		Artifacts: completeArtifacts(t),
	})
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("expected 201, got %d", res.StatusCode)
	}
	res.Body.Close()
	if info, err := os.Stat(logPath); err != nil {
		t.Fatalf("expected events.jsonl, got %v", err)
	} else if info.Size() == 0 {
		t.Fatalf("expected non-empty events.jsonl")
	}
}

func newTestServer(t *testing.T) (*httptest.Server, *Service) {
	t.Helper()
	exportDir := t.TempDir()
	service := NewService("", exportDir)
	srv := httptest.NewServer(service.Routes())
	t.Cleanup(srv.Close)
	return srv, service
}

func postJSON(t *testing.T, url string, payload any) *http.Response {
	t.Helper()
	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	res, err := http.Post(url, "application/json", bytes.NewReader(raw))
	if err != nil {
		t.Fatalf("POST %s: %v", url, err)
	}
	return res
}

func patchJSON(t *testing.T, url string, payload any) *http.Response {
	t.Helper()
	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	req, err := http.NewRequest(http.MethodPatch, url, bytes.NewReader(raw))
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	req.Header.Set("Content-Type", "application/json")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("PATCH %s: %v", url, err)
	}
	return res
}

func ptr[T any](v T) *T { return &v }
