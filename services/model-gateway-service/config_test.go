package main

import (
	"testing"
	"time"
)

func TestExampleModelRegistrySupportsW02PromptTemplates(t *testing.T) {
	registry, err := LoadModelRegistry("../../config/model-registry.example.yaml")
	if err != nil {
		t.Fatalf("LoadModelRegistry() error = %v", err)
	}

	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	for _, model := range registry.Models {
		if model.Provider != ModelProviderFoundryDevelopment || model.Capability != "model-generation" {
			continue
		}
		if !model.IsActive(now) {
			t.Fatalf("registry model %q is not active for W0.2 validation", model.ID)
		}
		if !model.SupportsStructuredOutput {
			t.Fatalf("registry model %q does not support structured output", model.ID)
		}
		if model.DefaultTimeoutMs < 60000 {
			t.Fatalf("registry model %q default timeout %d is below W0.2 agent deadline", model.ID, model.DefaultTimeoutMs)
		}
		for _, templateVersion := range []string{"v0", "v1"} {
			if !model.SupportsTemplate(templateVersion) {
				t.Fatalf("registry model %q does not support prompt template %s", model.ID, templateVersion)
			}
		}
	}
}
