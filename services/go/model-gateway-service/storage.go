package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

type ModelInvocationLedgerSink interface {
	Append(record ModelInvocationLedgerV0) error
	List() ([]ModelInvocationLedgerV0, error)
}

type EventSink interface {
	Emit(event EventEnvelopeV0) error
}

type InMemoryModelInvocationLedger struct {
	mu      sync.RWMutex
	records []ModelInvocationLedgerV0
}

func NewInMemoryModelInvocationLedger() *InMemoryModelInvocationLedger {
	return &InMemoryModelInvocationLedger{records: make([]ModelInvocationLedgerV0, 0)}
}

func (l *InMemoryModelInvocationLedger) Append(record ModelInvocationLedgerV0) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	if err := record.Validate(); err != nil {
		return err
	}
	l.records = append(l.records, record)
	return nil
}

func (l *InMemoryModelInvocationLedger) List() ([]ModelInvocationLedgerV0, error) {
	l.mu.RLock()
	defer l.mu.RUnlock()
	records := make([]ModelInvocationLedgerV0, 0, len(l.records))
	records = append(records, l.records...)
	return records, nil
}

type JSONLModelInvocationLedger struct {
	mu      sync.RWMutex
	records []ModelInvocationLedgerV0
	path    string
	file    *os.File
}

func NewJSONLModelInvocationLedger(path string) (*JSONLModelInvocationLedger, error) {
	if strings.TrimSpace(path) == "" {
		return nil, fmt.Errorf("model ledger path is required")
	}
	if dir := filepath.Dir(path); dir != "." {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return nil, fmt.Errorf("create model ledger directory failed: %w", err)
		}
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR|os.O_APPEND, 0o644)
	if err != nil {
		return nil, fmt.Errorf("open model invocation ledger failed: %w", err)
	}
	sink := &JSONLModelInvocationLedger{
		records: make([]ModelInvocationLedgerV0, 0),
		path:    path,
		file:    file,
	}
	if err := sink.restoreFromDisk(); err != nil {
		_ = file.Close()
		return nil, err
	}
	return sink, nil
}

func (l *JSONLModelInvocationLedger) restoreFromDisk() error {
	_, err := l.file.Seek(0, 0)
	if err != nil {
		return fmt.Errorf("seek model ledger file failed: %w", err)
	}
	scanner := bufio.NewScanner(l.file)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		var record ModelInvocationLedgerV0
		if err := json.Unmarshal([]byte(line), &record); err != nil {
			return fmt.Errorf("invalid model ledger line: %w", err)
		}
		l.records = append(l.records, record)
	}
	if err := scanner.Err(); err != nil {
		return fmt.Errorf("read model ledger failed: %w", err)
	}
	_, err = l.file.Seek(0, 2)
	return err
}

func (l *JSONLModelInvocationLedger) Append(record ModelInvocationLedgerV0) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	if err := record.Validate(); err != nil {
		return err
	}
	line, err := json.Marshal(record)
	if err != nil {
		return err
	}
	if _, err := l.file.Write(append(line, '\n')); err != nil {
		return fmt.Errorf("append model ledger failed: %w", err)
	}
	if err := l.file.Sync(); err != nil {
		return fmt.Errorf("sync model ledger failed: %w", err)
	}
	l.records = append(l.records, record)
	return nil
}

func (l *JSONLModelInvocationLedger) List() ([]ModelInvocationLedgerV0, error) {
	l.mu.RLock()
	defer l.mu.RUnlock()
	records := make([]ModelInvocationLedgerV0, 0, len(l.records))
	records = append(records, l.records...)
	return records, nil
}

func (l *JSONLModelInvocationLedger) Close() error {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.file == nil {
		return nil
	}
	err := l.file.Close()
	l.file = nil
	return err
}

type JSONLHarnessEventSink struct {
	mu   sync.Mutex
	path string
	file *os.File
	seq  atomic.Uint64
}

func NewJSONLHarnessEventSink(path string) (*JSONLHarnessEventSink, error) {
	if strings.TrimSpace(path) == "" {
		return nil, fmt.Errorf("model event log path is required")
	}
	if dir := filepath.Dir(path); dir != "." {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return nil, fmt.Errorf("create event log directory failed: %w", err)
		}
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR|os.O_APPEND, 0o644)
	if err != nil {
		return nil, fmt.Errorf("open model gateway event log failed: %w", err)
	}
	sink := &JSONLHarnessEventSink{path: path, file: file}
	if err := sink.restoreFromDisk(); err != nil {
		_ = file.Close()
		return nil, err
	}
	return sink, nil
}

func (s *JSONLHarnessEventSink) restoreFromDisk() error {
	_, err := s.file.Seek(0, 0)
	if err != nil {
		return fmt.Errorf("seek event log failed: %w", err)
	}
	scanner := bufio.NewScanner(s.file)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		var event EventEnvelopeV0
		if err := json.Unmarshal([]byte(line), &event); err != nil {
			return fmt.Errorf("invalid event log line: %w", err)
		}
		if event.EventID != "" {
			s.seq.Add(1)
		}
	}
	_, err = s.file.Seek(0, 2)
	return err
}

func (s *JSONLHarnessEventSink) Emit(event EventEnvelopeV0) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := event.Validate(); err != nil {
		return err
	}
	event = normalizeEventForSink(event, s.seq.Add(1), timeNowUTC)
	line, err := json.Marshal(event)
	if err != nil {
		return err
	}
	if _, err := s.file.Write(append(line, '\n')); err != nil {
		return fmt.Errorf("append event log failed: %w", err)
	}
	if err := s.file.Sync(); err != nil {
		return fmt.Errorf("sync event log failed: %w", err)
	}
	return nil
}

func (s *JSONLHarnessEventSink) List() ([]EventEnvelopeV0, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, err := s.file.Seek(0, 0); err != nil {
		return nil, fmt.Errorf("rewind event log failed: %w", err)
	}
	scanner := bufio.NewScanner(s.file)
	events := make([]EventEnvelopeV0, 0)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		var envelope EventEnvelopeV0
		if err := json.Unmarshal([]byte(line), &envelope); err != nil {
			return nil, fmt.Errorf("invalid event log line: %w", err)
		}
		events = append(events, envelope)
	}
	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("read event log failed: %w", err)
	}
	if _, err := s.file.Seek(0, 2); err != nil {
		return nil, fmt.Errorf("seek event log end failed: %w", err)
	}
	return events, nil
}

func (s *JSONLHarnessEventSink) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.file == nil {
		return nil
	}
	err := s.file.Close()
	s.file = nil
	return err
}

type RemoteHarnessEventSink struct {
	Endpoint string
	Client   *http.Client
}

func NewRemoteHarnessEventSink(endpoint string) (*RemoteHarnessEventSink, error) {
	endpoint = strings.TrimSpace(endpoint)
	if endpoint == "" {
		return nil, nil
	}
	if !strings.Contains(endpoint, "://") {
		return nil, fmt.Errorf("harness endpoint must include scheme")
	}
	return &RemoteHarnessEventSink{
		Endpoint: strings.TrimRight(endpoint, "/"),
		Client:   &http.Client{},
	}, nil
}

func (r *RemoteHarnessEventSink) Emit(event EventEnvelopeV0) error {
	raw, err := json.Marshal(event)
	if err != nil {
		return fmt.Errorf("marshal harness event: %w", err)
	}
	req, err := http.NewRequest(http.MethodPost, r.Endpoint, bytes.NewReader(raw))
	if err != nil {
		return fmt.Errorf("build harness event request: %w", err)
	}
	req.Header.Set("content-type", "application/json")
	resp, err := r.Client.Do(req)
	if err != nil {
		return fmt.Errorf("post harness event failed: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("harness event API responded with %d", resp.StatusCode)
	}
	return nil
}

type CompositeEventSink struct {
	sinks []EventSink
}

func NewCompositeEventSink(sinks ...EventSink) EventSink {
	active := make([]EventSink, 0, len(sinks))
	for _, sink := range sinks {
		if sink != nil {
			active = append(active, sink)
		}
	}
	return &CompositeEventSink{sinks: active}
}

func (s *CompositeEventSink) Emit(event EventEnvelopeV0) error {
	var lastErr error
	for _, sink := range s.sinks {
		if err := sink.Emit(event); err != nil {
			lastErr = err
		}
	}
	return lastErr
}

func timeNowUTC() time.Time {
	return time.Now().UTC()
}

func normalizeEventForSink(event EventEnvelopeV0, nextSeq uint64, now func() time.Time) EventEnvelopeV0 {
	nowAt := now()
	if strings.TrimSpace(event.SchemaVersion) == "" {
		event.SchemaVersion = gatewayEventSchemaVersion
	}
	if strings.TrimSpace(event.EventID) == "" {
		event.EventID = fmt.Sprintf("mgm-%s-%d", nowAt.Format("20060102150405"), nextSeq)
	}
	if event.CreatedAt.IsZero() {
		event.CreatedAt = nowAt
	}
	if event.Payload == nil {
		event.Payload = map[string]any{}
	}
	if event.RedactionProfile == "" {
		event.RedactionProfile = eventProfileControlledByHarness
	}
	return event
}

var _ EventSink = (*JSONLHarnessEventSink)(nil)
var _ EventSink = (*RemoteHarnessEventSink)(nil)
var _ EventSink = (*CompositeEventSink)(nil)
var _ ModelInvocationLedgerSink = (*JSONLModelInvocationLedger)(nil)
var _ ModelInvocationLedgerSink = (*InMemoryModelInvocationLedger)(nil)
