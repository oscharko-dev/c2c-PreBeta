package main

import (
	"errors"
	"fmt"
	"os"
	"strings"
	"time"

	yaml "gopkg.in/yaml.v3"
)

const (
	defaultTemplateVersion = "v1"
)

type ModelRegistry struct {
	Models []ModelMetadata `yaml:"models"`
}

type ModelMetadata struct {
	ID                         string   `yaml:"id"`
	DisplayName                string   `yaml:"displayName"`
	Provider                   string   `yaml:"provider"`
	DeploymentName             string   `yaml:"deploymentName"`
	ModelName                  string   `yaml:"modelName"`
	Version                    string   `yaml:"version"`
	Region                     string   `yaml:"region"`
	CatalogAssetID             string   `yaml:"catalogAssetId"`
	LifecycleStatus            string   `yaml:"lifecycleStatus"`
	LicenseStatus              string   `yaml:"licenseStatus"`
	ApprovalExpiry             string   `yaml:"approvalExpiry"`
	AllowedDataClasses         []string `yaml:"allowedDataClasses"`
	SupportedTemplateVersions  []string `yaml:"supportedTemplateVersions"`
	SupportsStructuredOutput   bool     `yaml:"supportsStructuredOutput"`
	DefaultTimeoutMs           int64    `yaml:"defaultTimeoutMs"`
	Capability                 string   `yaml:"capability"`
}

func (m ModelMetadata) IsActive(now time.Time) bool {
	if m.ID == "" || m.DeploymentName == "" || m.ModelName == "" {
		return false
	}
	if _, ok := allowedModelStatuses[m.LifecycleStatus]; !ok {
		return false
	}
	if _, ok := allowedLicenseStatuses[m.LicenseStatus]; !ok {
		return false
	}
	if m.ApprovalExpiry == "" {
		return false
	}
	approval, err := time.Parse(time.RFC3339, m.ApprovalExpiry)
	if err != nil {
		return false
	}
	if now.After(approval) {
		return false
	}
	return true
}

func (m ModelMetadata) SupportsTemplate(templateVersion string) bool {
	if templateVersion == "" {
		return false
	}
	if len(m.SupportedTemplateVersions) == 0 {
		return templateVersion == defaultTemplateVersion
	}
	for _, item := range m.SupportedTemplateVersions {
		if item == templateVersion {
			return true
		}
	}
	return false
}

func (m ModelMetadata) IsDataClassAllowed(dataClass string) bool {
	if len(m.AllowedDataClasses) == 0 {
		return m.Provider == ModelProviderCustomerInternalMock || dataClass == DataClassModelGateway
	}
	for _, d := range m.AllowedDataClasses {
		if d == dataClass {
			return true
		}
	}
	return false
}

type FoundryDevelopmentAllowlist struct {
	Mode             string `yaml:"mode"`
	AllowedModelIDs  []string               `yaml:"allowedModelIds"`
	Foundry          ProviderFoundryConfig    `yaml:"foundry"`
	CustomerInternal CustomerInternalConfig `yaml:"customerInternalMock"`
}

type ProviderFoundryConfig struct {
	Endpoint  string `yaml:"endpoint"`
	ApiKeyRef string `yaml:"apiKeyRef"`
	TimeoutMs int64  `yaml:"timeoutMs"`
}

type CustomerInternalConfig struct {
	BaseURL                string `yaml:"baseURL"`
	ApiKeyRef              string `yaml:"apiKeyRef"`
	TimeoutMs              int64  `yaml:"timeoutMs"`
	RequireStructuredInput bool   `yaml:"requireStructuredOutput"`
}

func LoadModelRegistry(path string) (ModelRegistry, error) {
	if path == "" {
		path = defaultModelRegistryPath
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return ModelRegistry{}, fmt.Errorf("read model registry failed: %w", err)
	}
	var registry ModelRegistry
	if err := yaml.Unmarshal(raw, &registry); err != nil {
		return ModelRegistry{}, fmt.Errorf("parse model registry failed: %w", err)
	}
	if len(registry.Models) == 0 {
		return ModelRegistry{}, fmt.Errorf("model registry has no entries")
	}
	return registry, nil
}

func LoadFoundryAllowlist(path string) (FoundryDevelopmentAllowlist, error) {
	if path == "" {
		path = defaultAllowlistPath
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return FoundryDevelopmentAllowlist{}, fmt.Errorf("read allowlist failed: %w", err)
	}
	var cfg FoundryDevelopmentAllowlist
	if err := yaml.Unmarshal(raw, &cfg); err != nil {
		return FoundryDevelopmentAllowlist{}, fmt.Errorf("parse allowlist failed: %w", err)
	}
	if cfg.Mode == "" {
		cfg.Mode = ModelProviderFoundryDevelopment
	}
	return cfg, nil
}

func (c FoundryDevelopmentAllowlist) IsModelAllowed(modelID string) bool {
	if len(c.AllowedModelIDs) == 0 {
		return true
	}
	for _, id := range c.AllowedModelIDs {
		if id == modelID {
			return true
		}
	}
	return false
}

func (c FoundryDevelopmentAllowlist) Validate() error {
	if strings.TrimSpace(c.Mode) == "" {
		return errors.New("allowlist mode is required")
	}
	switch c.Mode {
	case ModelProviderFoundryDevelopment, ModelProviderCustomerInternalMock:
	default:
		return fmt.Errorf("unsupported endpoint mode: %s", c.Mode)
	}
	return nil
}

func (r ModelRegistry) Get(modelID string) (ModelMetadata, bool) {
	for _, model := range r.Models {
		if model.ID == modelID {
			return model, true
		}
	}
	return ModelMetadata{}, false
}

func (m ModelMetadata) Validate() error {
	if strings.TrimSpace(m.ID) == "" {
		return fmt.Errorf("model id is required")
	}
	if strings.TrimSpace(m.Provider) == "" {
		return fmt.Errorf("model provider is required")
	}
	if strings.TrimSpace(m.DeploymentName) == "" {
		return fmt.Errorf("deployment name is required")
	}
	if strings.TrimSpace(m.ModelName) == "" {
		return fmt.Errorf("model name is required")
	}
	if strings.TrimSpace(m.LifecycleStatus) == "" {
		return fmt.Errorf("lifecycle status is required")
	}
	if strings.TrimSpace(m.LicenseStatus) == "" {
		return fmt.Errorf("license status is required")
	}
	if strings.TrimSpace(m.ApprovalExpiry) == "" {
		return fmt.Errorf("approval expiry is required")
	}
	if _, err := time.Parse(time.RFC3339, m.ApprovalExpiry); err != nil {
		return fmt.Errorf("approval expiry must be RFC3339 timestamp")
	}
	return nil
}

func (r ModelRegistry) Validate() error {
	if len(r.Models) == 0 {
		return fmt.Errorf("model registry has no models")
	}
	for _, model := range r.Models {
		if err := model.Validate(); err != nil {
			return fmt.Errorf("model %s invalid: %w", model.ID, err)
		}
	}
	return nil
}
