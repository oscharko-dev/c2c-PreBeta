package main

import (
	"archive/tar"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const (
	manifestFileName = "manifest.json"
	archiveExtension = ".tar"
)

type ExportRequest struct {
	Format string `json:"format"`
	// Destination is optional. When omitted, the service writes into the
	// directory named by EVIDENCE_EXPORT_DIR (or ./data/evidence-exports as a
	// last-resort default). Callers may supply an absolute path or a path
	// underneath the configured base directory.
	Destination string `json:"destination,omitempty"`
}

type Exporter struct {
	baseDir string
	clock   func() time.Time
}

func NewExporter(baseDir string) *Exporter {
	if strings.TrimSpace(baseDir) == "" {
		baseDir = filepath.Join("data", "evidence-exports")
	}
	return &Exporter{baseDir: baseDir, clock: func() time.Time { return time.Now().UTC() }}
}

// Export materializes the manifest as either a directory layout (manifest.json
// at the root) or a deterministic tar archive. The base directory is created
// on demand. Destinations are constrained to baseDir to keep callers from
// writing outside the configured export root.
func (e *Exporter) Export(manifest *EvidencePackManifest, req ExportRequest) (ExportRecord, error) {
	format := strings.ToLower(strings.TrimSpace(req.Format))
	if format == "" {
		format = ExportFormatDirectory
	}
	if format != ExportFormatDirectory && format != ExportFormatTar {
		return ExportRecord{}, fieldError("format", "format must be directory|tar")
	}

	target, err := e.resolveDestination(manifest.PackID, format, req.Destination)
	if err != nil {
		return ExportRecord{}, err
	}

	switch format {
	case ExportFormatDirectory:
		return e.exportDirectory(manifest, target)
	case ExportFormatTar:
		return e.exportTar(manifest, target)
	default:
		return ExportRecord{}, fieldError("format", "unsupported format")
	}
}

func (e *Exporter) resolveDestination(packID, format, requested string) (string, error) {
	if err := os.MkdirAll(e.baseDir, 0o755); err != nil {
		return "", fmt.Errorf("create export base directory: %w", err)
	}
	absBase, err := filepath.Abs(e.baseDir)
	if err != nil {
		return "", fmt.Errorf("resolve export base directory: %w", err)
	}

	var candidate string
	if strings.TrimSpace(requested) == "" {
		name := packID
		if format == ExportFormatTar {
			name = packID + archiveExtension
		}
		candidate = filepath.Join(absBase, name)
	} else {
		// Defense-in-depth: refuse absolute paths outright. Callers should
		// supply a relative name that lives under the export root.
		if filepath.IsAbs(requested) {
			return "", fieldError("destination", "destination must be a relative path under the configured export root")
		}
		candidate = filepath.Join(absBase, requested)
	}

	absCandidate, err := filepath.Abs(candidate)
	if err != nil {
		return "", fmt.Errorf("resolve export destination: %w", err)
	}
	if !strings.HasPrefix(absCandidate+string(os.PathSeparator), absBase+string(os.PathSeparator)) && absCandidate != absBase {
		return "", fieldError("destination", "destination must stay inside the configured export root")
	}
	return absCandidate, nil
}

func (e *Exporter) exportDirectory(manifest *EvidencePackManifest, dir string) (ExportRecord, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return ExportRecord{}, fmt.Errorf("create export directory: %w", err)
	}
	body, err := marshalCanonical(manifest)
	if err != nil {
		return ExportRecord{}, err
	}
	manifestPath := filepath.Join(dir, manifestFileName)
	if err := os.WriteFile(manifestPath, body, 0o644); err != nil {
		return ExportRecord{}, fmt.Errorf("write manifest file: %w", err)
	}
	return ExportRecord{
		Format:    ExportFormatDirectory,
		URI:       "file://" + dir,
		SHA256:    ComputeSHA256Hex(body),
		ByteSize:  int64(len(body)),
		CreatedAt: e.clock(),
	}, nil
}

func (e *Exporter) exportTar(manifest *EvidencePackManifest, path string) (ExportRecord, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return ExportRecord{}, fmt.Errorf("create export parent directory: %w", err)
	}
	body, err := marshalCanonical(manifest)
	if err != nil {
		return ExportRecord{}, err
	}
	f, err := os.Create(path)
	if err != nil {
		return ExportRecord{}, fmt.Errorf("create archive file: %w", err)
	}
	defer f.Close()

	hash := sha256.New()
	writer := io.MultiWriter(f, hash)
	tw := tar.NewWriter(writer)
	header := &tar.Header{
		Name:    manifestFileName,
		Mode:    0o644,
		Size:    int64(len(body)),
		ModTime: e.clock(),
		Format:  tar.FormatPAX,
	}
	if err := tw.WriteHeader(header); err != nil {
		return ExportRecord{}, fmt.Errorf("write tar header: %w", err)
	}
	if _, err := tw.Write(body); err != nil {
		return ExportRecord{}, fmt.Errorf("write tar body: %w", err)
	}
	if err := tw.Close(); err != nil {
		return ExportRecord{}, fmt.Errorf("close tar writer: %w", err)
	}
	info, err := f.Stat()
	if err != nil {
		return ExportRecord{}, fmt.Errorf("stat archive: %w", err)
	}
	return ExportRecord{
		Format:    ExportFormatTar,
		URI:       "file://" + path,
		SHA256:    hex.EncodeToString(hash.Sum(nil)),
		ByteSize:  info.Size(),
		CreatedAt: e.clock(),
	}, nil
}

func marshalCanonical(manifest *EvidencePackManifest) ([]byte, error) {
	body, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		return nil, fmt.Errorf("marshal manifest: %w", err)
	}
	return append(body, '\n'), nil
}
