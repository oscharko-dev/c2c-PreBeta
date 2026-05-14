.PHONY: help bootstrap checks dev-check ci-checks versions format

help:
	@echo "Available targets:"
	@echo "  make bootstrap    Run repository bootstrap check"
	@echo "  make checks       Run all service checks (java, go, python, typescript)"
	@echo "  make dev-check    Run full local dev validation (bootstrap + checks)"
	@echo "  make ci-checks    Run CI-equivalent repository checks"
	@echo "  make versions     Print toolchain versions"

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

versions:
	@go version
	@java -version
	@mvn -v
	@cargo --version
	@docker --version
