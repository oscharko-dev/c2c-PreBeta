package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"time"
)

const (
	SchemaVersionV0    = "v0"
	WaveW0             = "w0"
	CapabilityEvidence = "evidence.pack"
	ServiceName        = "evidence-service"

	StatusComplete   = "complete"
	StatusIncomplete = "incomplete"
	StatusInvalid    = "invalid"

	ExportFormatDirectory = "directory"
	ExportFormatTar       = "tar"
)

var packIDPattern = regexp.MustCompile(`^epk-[A-Za-z0-9._-]+$`)

var sha256Pattern = regexp.MustCompile(`^[0-9a-fA-F]{64}$`)

// requiredArtifacts lists the W0 minimum artifact set. The manifest is
// considered "complete" only when every entry here resolves to a non-empty
// reference. Anything missing is recorded in validation.missingArtifacts and
// the status flips to "incomplete".
var requiredArtifacts = []string{
	"sourceCobol",
	"semanticIr",
	"generatedJava",
	"buildTestResults",
	"harnessEvents",
	"modelInvocations",
}

// DataReference matches the dataReference $def in
// schemas/evidence-pack-manifest-v0.json and across the other v0 schemas in
// this repository. URI + sha256 lets the bundle stay machine-readable without
// shipping raw payloads.
type DataReference struct {
	URI      string `json:"uri"`
	SHA256   string `json:"sha256"`
	ByteSize int64  `json:"byteSize"`
	MIMEType string `json:"mimeType,omitempty"`
	Kind     string `json:"kind,omitempty"`
}

func (r DataReference) IsZero() bool {
	return r.URI == "" && r.SHA256 == "" && r.ByteSize == 0
}

func (r DataReference) Validate(path string) error {
	if r.URI == "" {
		return fieldError(path+".uri", "uri is required")
	}
	if r.SHA256 == "" {
		return fieldError(path+".sha256", "sha256 is required")
	}
	if !sha256Pattern.MatchString(r.SHA256) {
		return fieldError(path+".sha256", "sha256 must be 64 hex chars")
	}
	if _, err := hex.DecodeString(r.SHA256); err != nil {
		return fieldError(path+".sha256", "sha256 must be valid hex")
	}
	if r.ByteSize < 0 {
		return fieldError(path+".byteSize", "byteSize must be non-negative")
	}
	return nil
}

type TransformationPass struct {
	Name           string         `json:"name"`
	Order          int            `json:"order,omitempty"`
	InputRef       *DataReference `json:"inputRef,omitempty"`
	OutputRef      DataReference  `json:"outputRef"`
	PolicyDecision string         `json:"policyDecision,omitempty"`
}

func (p TransformationPass) Validate(path string) error {
	if p.Name == "" {
		return fieldError(path+".name", "name is required")
	}
	if err := p.OutputRef.Validate(path + ".outputRef"); err != nil {
		return err
	}
	if p.InputRef != nil {
		if err := p.InputRef.Validate(path + ".inputRef"); err != nil {
			return err
		}
	}
	return nil
}

type ModelInvocationRef struct {
	InvocationID          string        `json:"invocationId"`
	ModelID               string        `json:"modelId"`
	Provider              string        `json:"provider,omitempty"`
	PromptTemplateVersion string        `json:"promptTemplateVersion,omitempty"`
	Status                string        `json:"status,omitempty"`
	LedgerRef             DataReference `json:"ledgerRef"`
}

func (m ModelInvocationRef) Validate(path string) error {
	if m.InvocationID == "" {
		return fieldError(path+".invocationId", "invocationId is required")
	}
	if m.ModelID == "" {
		return fieldError(path+".modelId", "modelId is required")
	}
	return m.LedgerRef.Validate(path + ".ledgerRef")
}

type RuntimeVersion struct {
	ID  string         `json:"id"`
	Ref *DataReference `json:"ref,omitempty"`
}

func (rv RuntimeVersion) IsZero() bool {
	return rv.ID == "" && (rv.Ref == nil || rv.Ref.IsZero())
}

type Artifacts struct {
	SourceCobol          []DataReference      `json:"sourceCobol,omitempty"`
	CorpusMetadata       *DataReference       `json:"corpusMetadata,omitempty"`
	SemanticIR           *DataReference       `json:"semanticIr,omitempty"`
	TransformationPasses []TransformationPass `json:"transformationPasses,omitempty"`
	GeneratedJava        *DataReference       `json:"generatedJava,omitempty"`
	RuntimeVersion       *RuntimeVersion      `json:"runtimeVersion,omitempty"`
	ModelInvocations     []ModelInvocationRef `json:"modelInvocations,omitempty"`
	BuildTestResults     []DataReference      `json:"buildTestResults,omitempty"`
	SBOM                 []DataReference      `json:"sbom,omitempty"`
	LicenseReports       []DataReference      `json:"licenseReports,omitempty"`
	HarnessEvents        *DataReference       `json:"harnessEvents,omitempty"`
	TrajectoryLedger     *DataReference       `json:"trajectoryLedger,omitempty"`
	ExperienceEvents     []DataReference      `json:"experienceEvents,omitempty"`
}

type OpenAssumption struct {
	ID          string `json:"id"`
	Description string `json:"description"`
	Owner       string `json:"owner,omitempty"`
}

type UnsupportedFeature struct {
	Feature   string         `json:"feature"`
	Context   string         `json:"context,omitempty"`
	SourceRef *DataReference `json:"sourceRef,omitempty"`
}

type ValidationResult struct {
	OK                bool     `json:"ok"`
	RequiredArtifacts []string `json:"requiredArtifacts"`
	MissingArtifacts  []string `json:"missingArtifacts"`
	Messages          []string `json:"messages,omitempty"`
}

type ExportRecord struct {
	Format    string    `json:"format"`
	URI       string    `json:"uri"`
	SHA256    string    `json:"sha256,omitempty"`
	ByteSize  int64     `json:"byteSize,omitempty"`
	CreatedAt time.Time `json:"createdAt"`
}

// EvidencePackManifest matches the JSON schema at
// schemas/evidence-pack-manifest-v0.json. The "wave" field is pinned to "w0"
// to keep deserializers honest about which contract they're consuming.
type EvidencePackManifest struct {
	SchemaVersion       string               `json:"schemaVersion"`
	Capability          string               `json:"capability"`
	Service             string               `json:"service"`
	PackID              string               `json:"packId"`
	RunID               string               `json:"runId"`
	WorkflowID          string               `json:"workflowId,omitempty"`
	Wave                string               `json:"wave"`
	Status              string               `json:"status"`
	Summary             string               `json:"summary,omitempty"`
	CreatedAt           time.Time            `json:"createdAt"`
	CreatedBy           string               `json:"createdBy,omitempty"`
	Artifacts           Artifacts            `json:"artifacts"`
	OpenAssumptions     []OpenAssumption     `json:"openAssumptions,omitempty"`
	UnsupportedFeatures []UnsupportedFeature `json:"unsupportedFeatures,omitempty"`
	Validation          ValidationResult     `json:"validation"`
	Exports             []ExportRecord       `json:"exports,omitempty"`
}

func fieldError(path, reason string) error {
	return &FieldValidationError{Path: path, Reason: reason}
}

type FieldValidationError struct {
	Path   string `json:"path"`
	Reason string `json:"reason"`
}

func (e *FieldValidationError) Error() string {
	return fmt.Sprintf("%s: %s", e.Path, e.Reason)
}

func IsFieldValidationError(err error) bool {
	var fve *FieldValidationError
	return errors.As(err, &fve)
}

func (m *EvidencePackManifest) Validate() error {
	if m.SchemaVersion != SchemaVersionV0 {
		return fieldError("schemaVersion", "schemaVersion must be v0")
	}
	if m.Capability != CapabilityEvidence {
		return fieldError("capability", "capability must be evidence.pack")
	}
	if m.Service == "" {
		return fieldError("service", "service is required")
	}
	if !packIDPattern.MatchString(m.PackID) {
		return fieldError("packId", "packId must match epk-[A-Za-z0-9._-]+")
	}
	if m.RunID == "" {
		return fieldError("runId", "runId is required")
	}
	if m.Wave != WaveW0 {
		return fieldError("wave", "wave must be w0")
	}
	switch m.Status {
	case StatusComplete, StatusIncomplete, StatusInvalid:
	default:
		return fieldError("status", "status must be complete|incomplete|invalid")
	}
	if m.CreatedAt.IsZero() {
		return fieldError("createdAt", "createdAt is required")
	}
	return validateArtifactsShape(&m.Artifacts)
}

// validateArtifactsShape enforces structural rules on individual references
// without re-running the "is the required set populated?" check (that lives
// in EvaluateValidation and is reflected in manifest.validation).
func validateArtifactsShape(a *Artifacts) error {
	for i, ref := range a.SourceCobol {
		if err := ref.Validate(fmt.Sprintf("artifacts.sourceCobol[%d]", i)); err != nil {
			return err
		}
	}
	if a.CorpusMetadata != nil {
		if err := a.CorpusMetadata.Validate("artifacts.corpusMetadata"); err != nil {
			return err
		}
	}
	if a.SemanticIR != nil {
		if err := a.SemanticIR.Validate("artifacts.semanticIr"); err != nil {
			return err
		}
	}
	for i, pass := range a.TransformationPasses {
		if err := pass.Validate(fmt.Sprintf("artifacts.transformationPasses[%d]", i)); err != nil {
			return err
		}
	}
	if a.GeneratedJava != nil {
		if err := a.GeneratedJava.Validate("artifacts.generatedJava"); err != nil {
			return err
		}
	}
	if a.RuntimeVersion != nil {
		if a.RuntimeVersion.ID == "" {
			return fieldError("artifacts.runtimeVersion.id", "id is required")
		}
		if a.RuntimeVersion.Ref != nil {
			if err := a.RuntimeVersion.Ref.Validate("artifacts.runtimeVersion.ref"); err != nil {
				return err
			}
		}
	}
	for i, inv := range a.ModelInvocations {
		if err := inv.Validate(fmt.Sprintf("artifacts.modelInvocations[%d]", i)); err != nil {
			return err
		}
	}
	for i, ref := range a.BuildTestResults {
		if err := ref.Validate(fmt.Sprintf("artifacts.buildTestResults[%d]", i)); err != nil {
			return err
		}
	}
	for i, ref := range a.SBOM {
		if err := ref.Validate(fmt.Sprintf("artifacts.sbom[%d]", i)); err != nil {
			return err
		}
	}
	for i, ref := range a.LicenseReports {
		if err := ref.Validate(fmt.Sprintf("artifacts.licenseReports[%d]", i)); err != nil {
			return err
		}
	}
	if a.HarnessEvents != nil {
		if err := a.HarnessEvents.Validate("artifacts.harnessEvents"); err != nil {
			return err
		}
	}
	if a.TrajectoryLedger != nil {
		if err := a.TrajectoryLedger.Validate("artifacts.trajectoryLedger"); err != nil {
			return err
		}
	}
	for i, ref := range a.ExperienceEvents {
		if err := ref.Validate(fmt.Sprintf("artifacts.experienceEvents[%d]", i)); err != nil {
			return err
		}
	}
	return nil
}

// EvaluateValidation walks the W0 required artifact set and reports any
// missing references. The result is purely informative — the manifest can
// still serialize, but consumers (orchestrator, BFF) should refuse to treat
// the bundle as "complete" unless ok=true.
func EvaluateValidation(a *Artifacts) ValidationResult {
	missing := make([]string, 0)
	if len(a.SourceCobol) == 0 {
		missing = append(missing, "sourceCobol")
	}
	if a.SemanticIR == nil || a.SemanticIR.IsZero() {
		missing = append(missing, "semanticIr")
	}
	if a.GeneratedJava == nil || a.GeneratedJava.IsZero() {
		missing = append(missing, "generatedJava")
	}
	if len(a.BuildTestResults) == 0 {
		missing = append(missing, "buildTestResults")
	}
	if a.HarnessEvents == nil || a.HarnessEvents.IsZero() {
		missing = append(missing, "harnessEvents")
	}
	if len(a.ModelInvocations) == 0 {
		missing = append(missing, "modelInvocations")
	}

	required := append([]string{}, requiredArtifacts...)
	messages := make([]string, 0)
	if len(missing) > 0 {
		messages = append(messages, fmt.Sprintf("missing required W0 artifacts: %v", missing))
	}
	return ValidationResult{
		OK:                len(missing) == 0,
		RequiredArtifacts: required,
		MissingArtifacts:  missing,
		Messages:          messages,
	}
}

func ComputeSHA256Hex(value []byte) string {
	sum := sha256.Sum256(value)
	return hex.EncodeToString(sum[:])
}

// NewDataReference hashes the canonical-JSON form of payload and packs it
// into a DataReference. Use this for in-memory references; for on-disk files
// callers should pre-hash the bytes and construct the struct directly.
func NewDataReference(uri string, payload any, mimeType, kind string) (DataReference, error) {
	raw, err := json.Marshal(payload)
	if err != nil {
		return DataReference{}, err
	}
	return DataReference{
		URI:      uri,
		SHA256:   ComputeSHA256Hex(raw),
		ByteSize: int64(len(raw)),
		MIMEType: mimeType,
		Kind:     kind,
	}, nil
}
