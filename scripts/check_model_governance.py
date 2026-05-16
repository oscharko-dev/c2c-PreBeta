#!/usr/bin/env python3
"""Scan product code for direct model-provider use outside the model gateway."""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path


SCAN_ROOTS = ("services", "apps")
ALLOWED_PREFIX = Path("services/go/model-gateway-service")
IGNORED_DIRS = {"docs", "fixtures", "tests", "__tests__"}
TEST_FILE_SUFFIXES = (
    "_test.go",
    "_test.py",
    ".test.ts",
    ".test.js",
    ".test.py",
    ".spec.ts",
    ".spec.js",
    "Test.java",
    "Tests.java",
)

MODEL_PROVIDER_ENV_NAMES = {
    "C2C_MODEL_PROVIDER",
    "MODEL_GATEWAY_PROVIDER",
    "C2C_MODEL_DEFAULT_DEPLOYMENT",
    "C2C_MODEL_FALLBACK_DEPLOYMENTS",
    "C2C_MODEL_ALLOWED_DEPLOYMENTS",
    "C2C_MODEL_DATA_POLICY",
}

API_KEY_ENV_NAMES = {
    "AZURE_FOUNDRY_API_KEY",
    "AZURE_FOUNDRY_API_KEY_REF",
    "MODEL_GATEWAY_FOUNDRY_API_KEY_REF",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "COHERE_API_KEY",
    "MISTRAL_API_KEY",
    "AZURE_OPENAI_API_KEY",
    "GOOGLE_API_KEY",
    "GEMINI_API_KEY",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "HF_TOKEN",
    "HUGGINGFACEHUB_API_TOKEN",
    "HUGGING_FACE_HUB_TOKEN",
}

DIRECT_PROVIDER_PATTERNS = (
    (
        re.compile(r"(?i)\b(?:from|import)\b[^\n]*\b(openai|anthropic|cohere|mistralai|litellm|ollama)\b"),
        "direct-model-provider-usage",
    ),
    (
        re.compile(r"(?i)\b(openai|anthropic|cohere|mistralai|litellm|ollama)\.[A-Za-z_]\w*"),
        "direct-model-provider-usage",
    ),
    (
        re.compile(r'(?i)\brequire\s*\(\s*["\'](?:openai|@anthropic-ai/sdk|cohere-ai|mistralai|ollama)["\']\s*\)'),
        "direct-model-provider-usage",
    ),
    (
        re.compile(r"(?i)\b(azure\.ai\.inference|google\.generativeai|google\.genai|vertexai|huggingface_hub)\b"),
        "direct-model-provider-usage",
    ),
    (
        re.compile(r"(?i)\bbedrock-runtime\b"),
        "direct-model-provider-usage",
    ),
    (
        re.compile(
            r'(?i)["\'](?:github\.com/[^"\']*(?:openai|anthropic|cohere|mistral|ollama)|'
            r'github\.com/aws/aws-sdk-go-v2/service/bedrockruntime|'
            r'github\.com/google/generative-ai-go|'
            r'cloud\.google\.com/go/vertexai|'
            r'github\.com/Azure/azure-sdk-for-go/sdk/ai/azopenai)[^"\']*["\']'
        ),
        "direct-model-provider-usage",
    ),
    (
        re.compile(
            r"(?i)\bimport\s+(?:com\.openai|com\.azure\.ai\.(?:openai|inference)|"
            r"software\.amazon\.awssdk\.services\.bedrockruntime|"
            r"com\.google\.cloud\.vertexai|com\.google\.generativeai)\b"
        ),
        "direct-model-provider-usage",
    ),
    (
        re.compile(r'(?i)["\'](?:openai|@anthropic-ai/sdk|cohere-ai|mistralai|ollama)["\']\s*:'),
        "direct-model-provider-usage",
    ),
)

GO_DIRECT_PROVIDER_USAGE_PATTERNS = (
    (
        re.compile(
            r"(?i)\b(?:azopenai|openai|anthropic|cohere|mistral|mistralai|litellm|ollama|genai|vertexai|bedrockruntime)\.[A-Za-z_]\w*"
        ),
        "direct-model-provider-usage",
    ),
)

JAVA_DIRECT_PROVIDER_USAGE_PATTERNS = (
    (
        re.compile(
            r"(?i)\b(?:new\s+)?(?:OpenAI|Anthropic|Cohere|Mistral|Mistralai|LiteLLM|Ollama|GenAI|GenerativeAI|VertexAI|Bedrock|AzureOpenAI|HuggingFace)\w*"
            r"(?:\s*\(|\s+\w+\s*=|\s*\.\s*class\b|\s*\.)"
        ),
        "direct-model-provider-usage",
    ),
)


# noinspection PyClassHasNoInitInspection
@dataclass(frozen=True)
class Finding:
    path: str
    line_no: int
    kind: str
    snippet: str


def _run_git(*args: str) -> str:
    return subprocess.check_output(["git", *args], text=True).strip()


def _is_ignored_path(file_path: str) -> bool:
    path = Path(file_path)
    if ALLOWED_PREFIX == path or ALLOWED_PREFIX in path.parents:
        return True
    if any(part in IGNORED_DIRS for part in path.parts):
        return True

    lower_name = path.name.lower()
    if any(lower_name.endswith(suffix.lower()) for suffix in TEST_FILE_SUFFIXES):
        return True
    if lower_name.startswith("test_") or lower_name.startswith("spec_"):
        return True
    return False


def _collect_files() -> list[str]:
    output = _run_git("ls-files", "--cached", "--others", "--exclude-standard", "--", *SCAN_ROOTS)
    if not output:
        return []
    return [line for line in output.splitlines() if line.strip()]


def _is_binary(content: str) -> bool:
    return "\x00" in content


def _mask_line(line: str) -> str:
    stripped = line.strip()
    if len(stripped) <= 12:
        return "[redacted]"
    return f"{stripped[:6]}...[redacted]...{stripped[-4:]}"


def _scan_line_for_env_reads(line: str, file_path: str, line_no: int) -> list[Finding]:
    findings: list[Finding] = []
    for env_name in MODEL_PROVIDER_ENV_NAMES:
        if env_name in line:
            findings.append(
                Finding(
                    path=file_path,
                    line_no=line_no,
                    kind="forbidden-model-env-read",
                    snippet=_mask_line(line),
                )
            )
    for env_name in API_KEY_ENV_NAMES:
        if env_name in line:
            findings.append(
                Finding(
                    path=file_path,
                    line_no=line_no,
                    kind="forbidden-api-key-env-read",
                    snippet=_mask_line(line),
                )
            )
    return findings


def scan_worktree() -> list[Finding]:
    findings: list[Finding] = []
    root = Path.cwd()

    for file_path in _collect_files():
        if _is_ignored_path(file_path):
            continue

        path = root / file_path
        try:
            content = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        if _is_binary(content):
            continue

        patterns = DIRECT_PROVIDER_PATTERNS
        if file_path.endswith(".go"):
            patterns = patterns + GO_DIRECT_PROVIDER_USAGE_PATTERNS
        elif file_path.endswith(".java"):
            patterns = patterns + JAVA_DIRECT_PROVIDER_USAGE_PATTERNS

        for line_no, line in enumerate(content.splitlines(), start=1):
            findings.extend(_scan_line_for_env_reads(line, file_path, line_no))
            for pattern, kind in patterns:
                if pattern.search(line):
                    findings.append(
                        Finding(
                            path=file_path,
                            line_no=line_no,
                            kind=kind,
                            snippet=_mask_line(line),
                        )
                    )
    return findings


def _format_findings(findings: list[Finding]) -> str:
    lines = ["Model governance violations detected:"]
    for finding in sorted(findings, key=lambda item: (item.path, item.line_no, item.kind)):
        lines.append(f"- {finding.path}:{finding.line_no} [{finding.kind}] {finding.snippet}")
    return "\n".join(lines)


# noinspection PyTypeHintsInspection
def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Scan product code for direct model-provider usage outside services/go/model-gateway-service."
    )
    parser.add_argument(
        "--worktree",
        action="store_true",
        help="Scan tracked and untracked product files in the current worktree (default).",
    )
    _args = parser.parse_args(argv)

    findings = scan_worktree()

    if findings:
        print(_format_findings(findings))
        return 1

    print("No model governance violations found.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
