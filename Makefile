.PHONY: help bootstrap checks dev-check ci-checks versions format w0-2-gate w0-2-gate-foundry

help:
	@echo "Available targets:"
	@echo "  make bootstrap        Run repository bootstrap check"
	@echo "  make checks           Run all service checks (java, go, python, typescript)"
	@echo "  make dev-check        Run full local dev validation (bootstrap + checks)"
	@echo "  make ci-checks        Run CI-equivalent repository checks"
	@echo "  make w0-2-gate        Run the W0.2 release gate (deterministic, no Foundry)"
	@echo "  make w0-2-gate-foundry Run the W0.2 release gate against Foundry (requires secrets)"
	@echo "  make versions         Print toolchain versions"

bootstrap:
	./scripts/bootstrap.sh

checks:
	./scripts/go-check.sh
	./scripts/java-check.sh
	./scripts/python-check.sh
	./scripts/typescript-check.sh

dev-check: bootstrap checks
	@echo "Running dependency/license checks..."
	./scripts/license-sbom.sh

ci-checks:
	./scripts/ci-checks.sh

w0-2-gate:
	./scripts/w0-2-release-gate.sh

w0-2-gate-foundry:
	./scripts/w0-2-release-gate.sh --foundry

versions:
	@go version
	@java -version
	@mvn -v
	@cargo --version
	@docker --version
