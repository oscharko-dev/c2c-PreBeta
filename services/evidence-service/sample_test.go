package main

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func createdSampleTimestamp() time.Time {
	return time.Date(2026, 5, 14, 12, 0, 0, 0, time.UTC)
}

// TestRegenerateSampleEvidencePack regenerates the worked sample evidence
// pack under docs/evidence-service/. The test asserts the on-disk sample
// stays in sync with what the service actually produces today; set
// EVIDENCE_WRITE_SAMPLE=1 to update the fixture on purpose.
func TestRegenerateSampleEvidencePack(t *testing.T) {
	srv, _ := newTestServer(t)

	res := postJSON(t, srv.URL+"/v0/packs", CreateInput{
		RunID:      "run-w0-hello",
		WorkflowID: "wf-w0-hello",
		Summary:    "Hello-world W0 walking-skeleton evidence pack",
		CreatedBy:  "orchestrator",
		Artifacts:  completeArtifacts(t),
		OpenAssumptions: []OpenAssumption{{
			ID:          "OA-W0-01",
			Description: "Golden Master comparison is synthetic for the HELLO program until GnuCOBOL fixtures are generated in-tree.",
			Owner:       "build-test-runner-service",
		}},
		UnsupportedFeatures: []UnsupportedFeature{{
			Feature: "COBOL CALL chains across multiple programs",
			Context: "W0 single-program corpus only.",
		}},
	})
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("create sample pack: expected 201, got %d", res.StatusCode)
	}
	var created EvidencePackManifest
	if err := json.NewDecoder(res.Body).Decode(&created); err != nil {
		t.Fatalf("decode: %v", err)
	}
	res.Body.Close()

	// Normalize non-deterministic fields so the fixture is stable on disk.
	created.PackID = "epk-run-w0-hello-0001"
	created.CreatedAt = createdSampleTimestamp()
	for i := range created.Exports {
		created.Exports[i].CreatedAt = created.CreatedAt
	}

	body, err := json.MarshalIndent(&created, "", "  ")
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	body = append(body, '\n')

	target := filepath.Join("..", "..", "docs", "evidence-service", "sample-evidence-pack-manifest.json")
	if os.Getenv("EVIDENCE_WRITE_SAMPLE") == "1" {
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			t.Fatalf("mkdir: %v", err)
		}
		if err := os.WriteFile(target, body, 0o644); err != nil {
			t.Fatalf("write sample: %v", err)
		}
		return
	}
	onDisk, err := os.ReadFile(target)
	if err != nil {
		t.Skipf("sample fixture not yet present at %s (set EVIDENCE_WRITE_SAMPLE=1 to generate)", target)
		return
	}
	if strings.TrimSpace(string(onDisk)) != strings.TrimSpace(string(body)) {
		t.Fatalf("sample evidence pack is out of date; re-run with EVIDENCE_WRITE_SAMPLE=1 to refresh")
	}
}
