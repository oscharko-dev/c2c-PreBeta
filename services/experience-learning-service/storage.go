package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

type InMemoryHarnessEventStore struct {
	mu     sync.RWMutex
	events []EventEnvelopeV0
}

func NewInMemoryHarnessEventStore() *InMemoryHarnessEventStore {
	return &InMemoryHarnessEventStore{
		events: make([]EventEnvelopeV0, 0),
	}
}

func (s *InMemoryHarnessEventStore) List() ([]EventEnvelopeV0, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]EventEnvelopeV0, 0, len(s.events))
	out = append(out, s.events...)
	return out, nil
}

func (s *InMemoryHarnessEventStore) Append(event EventEnvelopeV0) error {
	if err := event.Validate(); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.events = append(s.events, event)
	return nil
}

func (s *InMemoryHarnessEventStore) ByRun(runID string) ([]EventEnvelopeV0, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]EventEnvelopeV0, 0)
	for _, event := range s.events {
		if event.RunID == runID {
			out = append(out, event)
		}
	}
	return out, nil
}

type JSONLHarnessEventStore struct {
	InMemoryHarnessEventStore
	path string
	file *os.File
}

func NewJSONLHarnessEventStore(path string) (*JSONLHarnessEventStore, error) {
	if strings.TrimSpace(path) == "" {
		return nil, fmt.Errorf("harness event path is required")
	}
	if err := ensureDir(path); err != nil {
		return nil, err
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR|os.O_APPEND, 0o644)
	if err != nil {
		return nil, fmt.Errorf("open harness event log failed: %w", err)
	}
	store := &JSONLHarnessEventStore{
		InMemoryHarnessEventStore: InMemoryHarnessEventStore{
			events: make([]EventEnvelopeV0, 0),
		},
		path: path,
		file: file,
	}
	if err := store.restoreFromDisk(); err != nil {
		_ = file.Close()
		return nil, err
	}
	return store, nil
}

func (s *JSONLHarnessEventStore) restoreFromDisk() error {
	_, err := s.file.Seek(0, 0)
	if err != nil {
		return fmt.Errorf("seek harness event log failed: %w", err)
	}
	scanner := bufio.NewScanner(s.file)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		var event EventEnvelopeV0
		if err := json.Unmarshal([]byte(line), &event); err != nil {
			return fmt.Errorf("invalid harness event line: %w", err)
		}
		s.events = append(s.events, event)
	}
	if err := scanner.Err(); err != nil {
		return fmt.Errorf("read harness event log failed: %w", err)
	}
	_, err = s.file.Seek(0, 2)
	return err
}

func (s *JSONLHarnessEventStore) Append(event EventEnvelopeV0) error {
	if err := event.Validate(); err != nil {
		return err
	}
	line, err := json.Marshal(event)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, err := s.file.Write(append(line, '\n')); err != nil {
		return fmt.Errorf("append harness event failed: %w", err)
	}
	if err := s.file.Sync(); err != nil {
		return fmt.Errorf("sync harness event log failed: %w", err)
	}
	s.events = append(s.events, event)
	return nil
}

type InMemoryTrajectoryLedgerStore struct {
	mu      sync.RWMutex
	ledgers []AgentTrajectoryLedgerV0
}

func NewInMemoryTrajectoryLedgerStore() *InMemoryTrajectoryLedgerStore {
	return &InMemoryTrajectoryLedgerStore{
		ledgers: make([]AgentTrajectoryLedgerV0, 0),
	}
}

func (s *InMemoryTrajectoryLedgerStore) List() ([]AgentTrajectoryLedgerV0, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]AgentTrajectoryLedgerV0, 0, len(s.ledgers))
	out = append(out, s.ledgers...)
	return out, nil
}

func (s *InMemoryTrajectoryLedgerStore) Append(record AgentTrajectoryLedgerV0) error {
	if err := record.Validate(); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.ledgers = append(s.ledgers, record)
	return nil
}

func (s *InMemoryTrajectoryLedgerStore) ByRun(runID string) ([]AgentTrajectoryLedgerV0, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]AgentTrajectoryLedgerV0, 0)
	for _, item := range s.ledgers {
		if item.RunID == runID {
			out = append(out, item)
		}
	}
	return out, nil
}

type JSONLTrajectoryLedgerStore struct {
	InMemoryTrajectoryLedgerStore
	path string
	file *os.File
}

func NewJSONLTrajectoryLedgerStore(path string) (*JSONLTrajectoryLedgerStore, error) {
	if strings.TrimSpace(path) == "" {
		return nil, fmt.Errorf("trajectory path is required")
	}
	if err := ensureDir(path); err != nil {
		return nil, err
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR|os.O_APPEND, 0o644)
	if err != nil {
		return nil, fmt.Errorf("open trajectory ledger log failed: %w", err)
	}
	store := &JSONLTrajectoryLedgerStore{
		InMemoryTrajectoryLedgerStore: InMemoryTrajectoryLedgerStore{
			ledgers: make([]AgentTrajectoryLedgerV0, 0),
		},
		path: path,
		file: file,
	}
	if err := store.restoreFromDisk(); err != nil {
		_ = file.Close()
		return nil, err
	}
	return store, nil
}

func (s *JSONLTrajectoryLedgerStore) restoreFromDisk() error {
	_, err := s.file.Seek(0, 0)
	if err != nil {
		return fmt.Errorf("seek trajectory ledger log failed: %w", err)
	}
	scanner := bufio.NewScanner(s.file)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		var item AgentTrajectoryLedgerV0
		if err := json.Unmarshal([]byte(line), &item); err != nil {
			return fmt.Errorf("invalid trajectory ledger line: %w", err)
		}
		s.ledgers = append(s.ledgers, item)
	}
	if err := scanner.Err(); err != nil {
		return fmt.Errorf("read trajectory ledger log failed: %w", err)
	}
	_, err = s.file.Seek(0, 2)
	return err
}

func (s *JSONLTrajectoryLedgerStore) Append(record AgentTrajectoryLedgerV0) error {
	if err := record.Validate(); err != nil {
		return err
	}
	line, err := json.Marshal(record)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, err := s.file.Write(append(line, '\n')); err != nil {
		return fmt.Errorf("append trajectory ledger failed: %w", err)
	}
	if err := s.file.Sync(); err != nil {
		return fmt.Errorf("sync trajectory ledger failed: %w", err)
	}
	s.ledgers = append(s.ledgers, record)
	return nil
}

type InMemoryExperienceEventStore struct {
	mu     sync.RWMutex
	events []ExperienceEventV0
}

func NewInMemoryExperienceEventStore() *InMemoryExperienceEventStore {
	return &InMemoryExperienceEventStore{
		events: make([]ExperienceEventV0, 0),
	}
}

func (s *InMemoryExperienceEventStore) List() ([]ExperienceEventV0, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]ExperienceEventV0, 0, len(s.events))
	out = append(out, s.events...)
	return out, nil
}

func (s *InMemoryExperienceEventStore) Append(event ExperienceEventV0) (ExperienceEventV0, error) {
	if err := event.Validate(); err != nil {
		return ExperienceEventV0{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.events = append(s.events, event)
	return event, nil
}

func (s *InMemoryExperienceEventStore) ByRun(runID string) ([]ExperienceEventV0, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]ExperienceEventV0, 0)
	for _, item := range s.events {
		if item.RunID == runID {
			out = append(out, item)
		}
	}
	return out, nil
}

func (s *InMemoryExperienceEventStore) Clear() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.events = make([]ExperienceEventV0, 0)
	return nil
}

type JSONLExperienceEventStore struct {
	InMemoryExperienceEventStore
	path string
	file *os.File
}

func NewJSONLExperienceEventStore(path string) (*JSONLExperienceEventStore, error) {
	if strings.TrimSpace(path) == "" {
		return nil, fmt.Errorf("experience event path is required")
	}
	if err := ensureDir(path); err != nil {
		return nil, err
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR|os.O_APPEND, 0o644)
	if err != nil {
		return nil, fmt.Errorf("open experience event log failed: %w", err)
	}
	store := &JSONLExperienceEventStore{
		InMemoryExperienceEventStore: InMemoryExperienceEventStore{
			events: make([]ExperienceEventV0, 0),
		},
		path: path,
		file: file,
	}
	if err := store.restoreFromDisk(); err != nil {
		_ = file.Close()
		return nil, err
	}
	return store, nil
}

func (s *JSONLExperienceEventStore) restoreFromDisk() error {
	_, err := s.file.Seek(0, 0)
	if err != nil {
		return fmt.Errorf("seek experience event log failed: %w", err)
	}
	scanner := bufio.NewScanner(s.file)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		var event ExperienceEventV0
		if err := json.Unmarshal([]byte(line), &event); err != nil {
			return fmt.Errorf("invalid experience event line: %w", err)
		}
		s.events = append(s.events, event)
	}
	if err := scanner.Err(); err != nil {
		return fmt.Errorf("read experience event log failed: %w", err)
	}
	_, err = s.file.Seek(0, 2)
	return err
}

func (s *JSONLExperienceEventStore) Append(event ExperienceEventV0) (ExperienceEventV0, error) {
	if err := event.Validate(); err != nil {
		return ExperienceEventV0{}, err
	}
	line, err := json.Marshal(event)
	if err != nil {
		return ExperienceEventV0{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, err := s.file.Write(append(line, '\n')); err != nil {
		return ExperienceEventV0{}, fmt.Errorf("append experience event failed: %w", err)
	}
	if err := s.file.Sync(); err != nil {
		return ExperienceEventV0{}, fmt.Errorf("sync experience event failed: %w", err)
	}
	s.events = append(s.events, event)
	return event, nil
}

func (s *JSONLExperienceEventStore) Close() error {
	if s.file == nil {
		return nil
	}
	err := s.file.Close()
	s.file = nil
	return err
}

func ensureDir(path string) error {
	if dir := filepath.Dir(path); dir != "." {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return fmt.Errorf("create directory failed: %w", err)
		}
	}
	return nil
}

func nowTimestampKey() time.Time {
	return time.Now().UTC()
}
