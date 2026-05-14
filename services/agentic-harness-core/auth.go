package main

import (
	"crypto/subtle"
	"fmt"
	"net/http"
	"os"
	"strings"
)

const (
	envHarnessControlPlaneToken = "HARNESS_CONTROL_PLANE_TOKEN"

	headerAuthorization = "Authorization"
	headerHarnessActor  = "X-Harness-Actor"
	headerHarnessRole   = "X-Harness-Role"
	headerHarnessToken  = "X-Harness-Token"
)

type Principal struct {
	Actor string
	Role  string
}

type HarnessAuth struct {
	token string
}

func NewHarnessAuthFromEnv() HarnessAuth {
	return HarnessAuth{token: strings.TrimSpace(os.Getenv(envHarnessControlPlaneToken))}
}

func (a HarnessAuth) Require(r *http.Request) (Principal, error) {
	if a.token == "" {
		return Principal{}, fmt.Errorf("%s is required for mutating harness endpoints", envHarnessControlPlaneToken)
	}
	if subtle.ConstantTimeCompare([]byte(a.presentedToken(r)), []byte(a.token)) != 1 {
		return Principal{}, fmt.Errorf("invalid harness control-plane token")
	}
	role := cleanPrincipalPart(r.Header.Get(headerHarnessRole), "agent")
	actor := cleanPrincipalPart(r.Header.Get(headerHarnessActor), role)
	return Principal{Actor: actor, Role: role}, nil
}

func (a HarnessAuth) presentedToken(r *http.Request) string {
	if raw := strings.TrimSpace(r.Header.Get(headerHarnessToken)); raw != "" {
		return raw
	}
	raw := strings.TrimSpace(r.Header.Get(headerAuthorization))
	if raw == "" {
		return ""
	}
	const prefix = "bearer "
	if !strings.HasPrefix(strings.ToLower(raw), prefix) {
		return ""
	}
	return strings.TrimSpace(raw[len(prefix):])
}

func cleanPrincipalPart(raw string, fallback string) string {
	value := strings.TrimSpace(raw)
	if value == "" {
		return fallback
	}
	if len(value) > 80 {
		value = value[:80]
	}
	value = strings.ToLower(value)
	value = strings.Map(func(r rune) rune {
		switch {
		case r >= 'a' && r <= 'z':
			return r
		case r >= '0' && r <= '9':
			return r
		case r == '.' || r == '_' || r == '-':
			return r
		default:
			return '-'
		}
	}, value)
	value = strings.Trim(value, ".-_")
	if value == "" {
		return fallback
	}
	return value
}
