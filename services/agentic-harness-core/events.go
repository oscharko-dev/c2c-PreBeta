package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

type EventSink interface {
	Emit(event EventEnvelopeV0) (EventEnvelopeV0, error)
	List() ([]EventEnvelopeV0, error)
}

type InMemoryEventSink struct {
	mu     sync.RWMutex
	events []EventEnvelopeV0
	seq    atomic.Uint64
}

func NewInMemoryEventSink() *InMemoryEventSink {
	return &InMemoryEventSink{
		events: make([]EventEnvelopeV0, 0),
	}
}

func (e *InMemoryEventSink) Emit(event EventEnvelopeV0) (EventEnvelopeV0, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	event = normalizeEvent(event, e.seq.Add(1))
	e.events = append(e.events, event)
	return event, nil
}

func (e *InMemoryEventSink) List() ([]EventEnvelopeV0, error) {
	e.mu.RLock()
	defer e.mu.RUnlock()
	items := make([]EventEnvelopeV0, 0, len(e.events))
	items = append(items, e.events...)
	return items, nil
}

type JSONLFileEventSink struct {
	InMemoryEventSink
	path string
	file *os.File
}

func NewJSONLFileEventSink(path string) (*JSONLFileEventSink, error) {
	if strings.TrimSpace(path) == "" {
		return nil, fmt.Errorf("event log path is required")
	}
	if dir := filepath.Dir(path); dir != "." {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return nil, fmt.Errorf("create event log directory failed: %w", err)
		}
	}

	file, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR|os.O_APPEND, 0o644)
	if err != nil {
		return nil, fmt.Errorf("open event log file failed: %w", err)
	}

	sink := &JSONLFileEventSink{
		InMemoryEventSink: InMemoryEventSink{events: make([]EventEnvelopeV0, 0)},
		path:              path,
		file:              file,
	}
	if err := sink.restoreFromDisk(); err != nil {
		_ = file.Close()
		return nil, err
	}
	return sink, nil
}

func (e *JSONLFileEventSink) restoreFromDisk() error {
	_, err := e.file.Seek(0, 0)
	if err != nil {
		return fmt.Errorf("seek event log file failed: %w", err)
	}
	scanner := bufio.NewScanner(e.file)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		var event EventEnvelopeV0
		if err := json.Unmarshal([]byte(line), &event); err != nil {
			return fmt.Errorf("invalid persisted event: %w", err)
		}
		e.events = append(e.events, event)
	}
	e.seq.Store(uint64(len(e.events)))
	if err := scanner.Err(); err != nil {
		return fmt.Errorf("read event log failed: %w", err)
	}
	_, err = e.file.Seek(0, 2)
	return err
}

func (e *JSONLFileEventSink) Emit(event EventEnvelopeV0) (EventEnvelopeV0, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	event = normalizeEvent(event, e.seq.Add(1))
	line, err := json.Marshal(event)
	if err != nil {
		return EventEnvelopeV0{}, err
	}
	if _, err := e.file.Write(append(line, '\n')); err != nil {
		return EventEnvelopeV0{}, fmt.Errorf("append event log failed: %w", err)
	}
	if err := e.file.Sync(); err != nil {
		return EventEnvelopeV0{}, fmt.Errorf("sync event log failed: %w", err)
	}
	e.events = append(e.events, event)
	return event, nil
}

func (e *JSONLFileEventSink) List() ([]EventEnvelopeV0, error) {
	e.mu.RLock()
	defer e.mu.RUnlock()
	items := make([]EventEnvelopeV0, 0, len(e.events))
	items = append(items, e.events...)
	return items, nil
}

func normalizeEvent(event EventEnvelopeV0, nextID uint64) EventEnvelopeV0 {
	now := time.Now().UTC()
	if event.SchemaVersion == "" {
		event.SchemaVersion = EventSchemaVersionV0
	}
	if event.EventID == "" {
		event.EventID = fmt.Sprintf("hev-%s-%d", now.Format("20060102"), nextID)
	}
	if event.Service == "" {
		event.Service = ActorSystem
	}
	if event.CreatedAt.IsZero() {
		event.CreatedAt = now
	}
	if event.Payload == nil {
		event.Payload = map[string]any{}
	}
	return event
}
