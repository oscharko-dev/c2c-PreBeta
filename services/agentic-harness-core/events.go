package main

import (
	"encoding/hex"
	"fmt"
	"sync"
	"sync/atomic"
	"time"
)

type EventSink interface {
	Emit(event Event) error
	List() ([]Event, error)
}

type InMemoryEventSink struct {
	mu     sync.RWMutex
	events []Event
	seq    atomic.Uint64
}

func NewInMemoryEventSink() *InMemoryEventSink {
	return &InMemoryEventSink{
		events: make([]Event, 0),
	}
}

func (e *InMemoryEventSink) Emit(event Event) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	id := e.seq.Add(1)
	event.ID = fmt.Sprintf("harness-event-%s", hex.EncodeToString([]byte(fmt.Sprintf("%d", id))))
	event.CreatedAt = time.Now().UTC()
	e.events = append(e.events, event)
	return nil
}

func (e *InMemoryEventSink) List() ([]Event, error) {
	e.mu.RLock()
	defer e.mu.RUnlock()
	items := make([]Event, 0, len(e.events))
	items = append(items, e.events...)
	return items, nil
}
