package main

import (
	"fmt"
	"sort"
	"sync"
)

type CapabilityRegistry struct {
	mu           sync.RWMutex
	capabilities map[string]Capability
}

func NewCapabilityRegistry() *CapabilityRegistry {
	return &CapabilityRegistry{
		capabilities: make(map[string]Capability),
	}
}

func (r *CapabilityRegistry) Register(cap Capability) error {
	if err := validateCapabilityFields(cap); err != nil {
		return err
	}

	r.mu.Lock()
	defer r.mu.Unlock()
	if _, exists := r.capabilities[cap.ID]; exists {
		return RegistryValidationError{Reason: fmt.Sprintf("capability %s already registered", cap.ID)}
	}
	r.capabilities[cap.ID] = cap
	return nil
}

func (r *CapabilityRegistry) Get(id string) (Capability, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	capability, ok := r.capabilities[id]
	return capability, ok
}

func (r *CapabilityRegistry) List() []Capability {
	r.mu.RLock()
	defer r.mu.RUnlock()
	caps := make([]Capability, 0, len(r.capabilities))
	ids := make([]string, 0, len(r.capabilities))
	for _, capability := range r.capabilities {
		caps = append(caps, capability)
		ids = append(ids, capability.ID)
	}
	sort.Slice(ids, func(i, j int) bool {
		return ids[i] < ids[j]
	})
	sorted := make([]Capability, 0, len(caps))
	capabilityByID := make(map[string]Capability, len(caps))
	for _, capability := range caps {
		capabilityByID[capability.ID] = capability
	}
	for _, id := range ids {
		sorted = append(sorted, capabilityByID[id])
	}
	return sorted
}

func (r *CapabilityRegistry) Validate(id string) (Capability, error) {
	capability, ok := r.Get(id)
	if !ok {
		return Capability{}, fmt.Errorf("capability %s not found", id)
	}
	if err := validateCapabilityFields(capability); err != nil {
		return Capability{}, err
	}
	return capability, nil
}

type McpServerRegistry struct {
	mu      sync.RWMutex
	servers map[string]McpServer
}

func NewMcpServerRegistry() *McpServerRegistry {
	return &McpServerRegistry{
		servers: make(map[string]McpServer),
	}
}

func (r *McpServerRegistry) Register(server McpServer) error {
	if server.ID == "" {
		return RegistryValidationError{Reason: "mcp server id is required"}
	}
	if server.Name == "" {
		return RegistryValidationError{Reason: "mcp server name is required"}
	}
	if server.Endpoint == "" {
		return RegistryValidationError{Reason: "mcp server endpoint is required"}
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, exists := r.servers[server.ID]; exists {
		return RegistryValidationError{Reason: fmt.Sprintf("mcp server %s already registered", server.ID)}
	}
	r.servers[server.ID] = server
	return nil
}

func (r *McpServerRegistry) List() []McpServer {
	r.mu.RLock()
	defer r.mu.RUnlock()
	servers := make([]McpServer, 0, len(r.servers))
	ids := make([]string, 0, len(r.servers))
	for _, server := range r.servers {
		servers = append(servers, server)
		ids = append(ids, server.ID)
	}
	sort.Slice(ids, func(i, j int) bool {
		return ids[i] < ids[j]
	})
	sorted := make([]McpServer, 0, len(servers))
	serverByID := make(map[string]McpServer, len(servers))
	for _, server := range servers {
		serverByID[server.ID] = server
	}
	for _, id := range ids {
		sorted = append(sorted, serverByID[id])
	}
	return sorted
}

func (r *McpServerRegistry) Get(id string) (McpServer, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	server, ok := r.servers[id]
	return server, ok
}
