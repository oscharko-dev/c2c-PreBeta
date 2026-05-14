package main

import (
	"fmt"
	"net/url"
	"regexp"
)

var idPattern = regexp.MustCompile(`^[a-z0-9]+(?:[._-][a-z0-9]+)*$`)

type PolicyEngine interface {
	Decide(action string, actorRole string, subject map[string]string) (PolicyDecision, error)
}

type DefaultPolicyEngine struct{}

func (d DefaultPolicyEngine) Decide(action string, actorRole string, subject map[string]string) (PolicyDecision, error) {
	if action == "" {
		return PolicyDecision{}, fmt.Errorf("action is required")
	}
	if actorRole == "" {
		actorRole = "agent"
	}

	forbidden := map[string]bool{
		DataClassModel:        true,
		DataClassEvidence:     true,
		DataClassRAG:          true,
		DataClassGraph:        true,
		DataClassParser:       true,
		DataClassGenerator:    true,
		DataClassBuildTest:    true,
		DataClassTest:         true,
		DataClassModelGateway: true,
	}

	if actorRole == "agent" && action == ActionRegisterCapability {
		if forbidden[subject["dataClass"]] {
			return PolicyDecision{
				Allowed: false,
				Reason:  "direct agent integration to core infrastructure services is prohibited",
			}, nil
		}
	}

	return PolicyDecision{
		Allowed: true,
		Reason:  "policy allow",
	}, nil
}

func validateURL(v string) error {
	parsed, err := url.ParseRequestURI(v)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return fmt.Errorf("endpoint must be a valid URL with scheme and host")
	}
	return nil
}

func validateCapabilityFields(cap Capability) error {
	if cap.ID == "" || !idPattern.MatchString(cap.ID) {
		return RegistryValidationError{Reason: "capability.id must be non-empty and use lowercase dot/hyphen/underscore segments"}
	}
	if cap.Name == "" {
		return RegistryValidationError{Reason: "capability.name is required"}
	}
	if cap.Owner == "" {
		return RegistryValidationError{Reason: "capability.owner is required"}
	}
	if cap.Endpoint == "" {
		return RegistryValidationError{Reason: "capability.endpoint is required"}
	}
	if cap.DataClass == "" {
		return RegistryValidationError{Reason: "capability.dataClass is required"}
	}
	if _, ok := allowedDataClasses[cap.DataClass]; !ok {
		return RegistryValidationError{Reason: "capability.dataClass must be one of supported data classes"}
	}
	if cap.PolicyProfile == "" {
		return RegistryValidationError{Reason: "capability.policyProfile is required"}
	}
	if cap.Version == "" {
		return RegistryValidationError{Reason: "capability.version is required"}
	}
	if err := validateURL(cap.Endpoint); err != nil {
		return RegistryValidationError{Reason: err.Error()}
	}
	return nil
}
