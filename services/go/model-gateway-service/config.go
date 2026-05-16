package main

import (
	"errors"
	"fmt"
	"os"
	"strings"
	"time"

	"gopkg.in/yaml.v3"
)

const (
	defaultTemplateVersion = "v1"
	defaultPolicyID        = "foundry-development-v0"
)

const (
	AgentRoleTransformation      = "transformation"
	AgentRoleVerificationRepair  = "verification-repair"
)

var w02AgentRoles = []string{AgentRoleTransformation, AgentRoleVerificationRepair}

type ModelRegistry struct {
	Models []ModelMetadata `yaml:"models"`
}

type ModelMetadata struct {
	ID                        string   `yaml:"id"`
	DisplayName               string   `yaml:"displayName"`
	Provider                  string   `yaml:"provider"`
	DeploymentName            string   `yaml:"deploymentName"`
	ModelName                 string   `yaml:"modelName"`
	Version                   string   `yaml:"version"`
	Region                    string   `yaml:"region"`
	CatalogAssetID            string   `yaml:"catalogAssetId"`
	LifecycleStatus           string   `yaml:"lifecycleStatus"`
	LicenseStatus             string   `yaml:"licenseStatus"`
	ApprovalExpiry            string   `yaml:"approvalExpiry"`
	AllowedDataClasses        []string `yaml:"allowedDataClasses"`
	SupportedTemplateVersions []string `yaml:"supportedTemplateVersions"`
	SupportsStructuredOutput  bool     `yaml:"supportsStructuredOutput"`
	DefaultTimeoutMs          int64    `yaml:"defaultTimeoutMs"`
	Capability                string   `yaml:"capability"`
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
	Mode             string                 `yaml:"mode"`
	PolicyID         string                 `yaml:"policyId"`
	AllowedModelIDs  []string               `yaml:"allowedModelIds"`
	Roles            map[string][]string    `yaml:"roles"`
	Foundry          ProviderFoundryConfig  `yaml:"foundry"`
	CustomerInternal CustomerInternalConfig `yaml:"customerInternalMock"`
}

type ProviderFoundryConfig struct {
	Endpoint   string `yaml:"endpoint"`
	ApiKeyRef  string `yaml:"apiKeyRef"`
	ApiKey     string `yaml:"apiKey"`
	APIVersion string `yaml:"apiVersion"`
	TimeoutMs  int64  `yaml:"timeoutMs"`
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
	if strings.TrimSpace(cfg.PolicyID) == "" {
		cfg.PolicyID = defaultPolicyID
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

// IsRoleConfigured reports whether the role appears in the role-to-model policy.
// An unconfigured role is treated as "no role-specific restriction": invocations
// without an explicit role bypass the role check.
func (c FoundryDevelopmentAllowlist) IsRoleConfigured(role string) bool {
	if c.Roles == nil {
		return false
	}
	_, ok := c.Roles[role]
	return ok
}

// IsRoleAllowed reports whether the role may invoke the given modelID.
// If no role is configured, all models that pass the general allowlist are allowed.
func (c FoundryDevelopmentAllowlist) IsRoleAllowed(role, modelID string) bool {
	if strings.TrimSpace(role) == "" {
		return true
	}
	models, ok := c.Roles[role]
	if !ok {
		return true
	}
	for _, id := range models {
		if id == modelID {
			return true
		}
	}
	return false
}

// AllowedModelsForRole returns the models configured for the role, or nil if
// the role is not configured. Callers must treat nil as "no role restriction".
func (c FoundryDevelopmentAllowlist) AllowedModelsForRole(role string) []string {
	if c.Roles == nil {
		return nil
	}
	models, ok := c.Roles[role]
	if !ok {
		return nil
	}
	out := make([]string, len(models))
	copy(out, models)
	return out
}

// ResolvedPolicyID returns the configured policy id or the default.
func (c FoundryDevelopmentAllowlist) ResolvedPolicyID() string {
	id := strings.TrimSpace(c.PolicyID)
	if id == "" {
		return defaultPolicyID
	}
	return id
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
	if c.Mode == ModelProviderFoundryDevelopment && len(c.AllowedModelIDs) == 0 {
		return errors.New("allowedModelIds must contain at least one model in foundry-development mode")
	}
	for role, models := range c.Roles {
		if strings.TrimSpace(role) == "" {
			return errors.New("role name must not be empty in roles map")
		}
		if len(models) == 0 {
			return fmt.Errorf("role %q must list at least one model", role)
		}
		for _, modelID := range models {
			if !c.IsModelAllowed(modelID) {
				return fmt.Errorf("role %q references model %q which is not in allowedModelIds", role, modelID)
			}
		}
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
