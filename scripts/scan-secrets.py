#!/usr/bin/env python3
"""Scan staged or changed files for likely credentials before commit/merge."""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
from pathlib import Path


FORBIDDEN_PATH_PATTERNS = (
    ".env",
    ".env.",
    ".env.local",
    "id_rsa",
    "id_dsa",
    "id_ecdsa",
    ".pem",
    ".key",
    ".p12",
    ".pfx",
    ".jks",
    "credentials",
    ".npmrc",
    ".netrc",
    "service-account.json",
    "google-credentials.json",
    "azure-credentials.json",
)

ALLOWED_PATHS = (
    ".env.example",
)

SECRET_PATTERNS = [
    (re.compile(r"-----BEGIN (?:RSA|DSA|EC|OPENSSH|PGP|PRIVATE) KEY-----"), "private-key-block"),
    (re.compile(r"\b(AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|AIDA[0-9A-Z]{16}|ACCA[0-9A-Z]{16})\b"), "aws-key-id"),
    (re.compile(r"\bAIza[0-9A-Za-z\-_]{35}\b"), "google-api-key"),
    (re.compile(r"\b(AKIA|xox[baprs]|gh[pousr]|xox[-_]?b)\b[0-9A-Za-z-_]{12,}\b"), "token"),
    (re.compile(r"\b(sk_live_[A-Za-z0-9]{24,})\b"), "stripe-live-key"),
    (re.compile(r"\b(sk_test_[A-Za-z0-9]{24,})\b"), "stripe-test-key"),
    (re.compile(r"\bya29\.[0-9A-Za-z\-_]+"), "google-oauth-token"),
]


def _run_git(*args: str) -> str:
    return subprocess.check_output(["git", *args], text=True).strip()


def _git_show(path: str, ref: str = "") -> str:
    if ref == "cached":
        data = subprocess.check_output(["git", "show", f":{path}"], text=True, errors="replace")
        return data
    data = subprocess.check_output(["git", "show", f"{ref}:{path}"], text=True, errors="replace")
    return data


def _file_has_forbidden_path(file_path: str) -> bool:
    if file_path in ALLOWED_PATHS:
        return False
    for pattern in FORBIDDEN_PATH_PATTERNS:
        if pattern in file_path:
            return True
    return False


def _is_binary(content: str) -> bool:
    return "\x00" in content


def _mask_line(line: str) -> str:
    stripped = line.strip()
    if len(stripped) <= 12:
        return "[redacted]"
    return "{}...[redacted]...{}".format(stripped[:6], stripped[-4:])

def _collect_files_staged() -> list[str]:
    output = _run_git("diff", "--cached", "--name-only", "--diff-filter=ACMR")
    if not output:
        return []
    return [line for line in output.splitlines() if line.strip()]


def _collect_files_changed(base: str, head: str) -> list[str]:
    output = _run_git("diff", "--name-only", f"{base}..{head}")
    if not output:
        return []
    return [line for line in output.splitlines() if line.strip()]


def _collect_files_worktree() -> list[str]:
    output = _run_git("ls-files", "--cached", "--others", "--exclude-standard")
    if not output:
        return []
    return [line for line in output.splitlines() if line.strip()]


def scan_staged() -> list[tuple[str, int, str, str]]:
    findings = []
    for file_path in _collect_files_staged():
        if _file_has_forbidden_path(file_path):
            findings.append((file_path, 0, "forbidden-path", "forbidden credential file path"))
            continue

        try:
            content = _git_show(file_path, "cached")
        except subprocess.CalledProcessError:
            continue
        if _is_binary(content):
            continue

        for i, line in enumerate(content.splitlines(), start=1):
            for pattern, kind in SECRET_PATTERNS:
                for _ in pattern.finditer(line):
                    findings.append((file_path, i, kind, _mask_line(line)))
    return findings


def scan_changed(base: str, head: str) -> list[tuple[str, int, str, str]]:
    findings = []
    for file_path in _collect_files_changed(base, head):
        if _file_has_forbidden_path(file_path):
            findings.append((file_path, 0, "forbidden-path", "forbidden credential file path"))
            continue

        try:
            content = _git_show(file_path, head)
        except subprocess.CalledProcessError:
            continue
        if _is_binary(content):
            continue

        for i, line in enumerate(content.splitlines(), start=1):
            for pattern, kind in SECRET_PATTERNS:
                if pattern.search(line):
                    findings.append((file_path, i, kind, _mask_line(line)))
    return findings


def scan_worktree() -> list[tuple[str, int, str, str]]:
    findings = []
    root = Path.cwd()
    for file_path in _collect_files_worktree():
        if _file_has_forbidden_path(file_path):
            findings.append((file_path, 0, "forbidden-path", "forbidden credential file path"))
            continue

        path = root / file_path
        try:
            content = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        if _is_binary(content):
            continue

        for i, line in enumerate(content.splitlines(), start=1):
            for pattern, kind in SECRET_PATTERNS:
                if pattern.search(line):
                    findings.append((file_path, i, kind, _mask_line(line)))
    return findings


def _format_findings(findings: list[tuple[str, int, str, str]]) -> str:
    lines = ["Potential credential material detected:"]
    for path, line_no, kind, snippet in findings:
        if line_no:
            lines.append(f"- {path}:{line_no} [{kind}] {snippet}")
        else:
            lines.append(f"- {path} [{kind}]")
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description="Scan for credential-like content in staged or changed files.")
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--staged", action="store_true", help="Scan only staged files")
    mode.add_argument("--base", dest="base", help="Base ref to compare against, e.g. origin/dev")
    mode.add_argument("--worktree", action="store_true", help="Scan tracked files in the current worktree")
    parser.add_argument("--head", default="HEAD", help="Head ref to compare against (default: HEAD)")
    args = parser.parse_args()

    if args.staged:
        findings = scan_staged()
    elif args.worktree:
        findings = scan_worktree()
    else:
        if not args.base:
            parser.error(" --base is required when not using --staged")
        findings = scan_changed(args.base, args.head)

    if findings:
        print(_format_findings(findings))
        return 1
    print("No credential-like patterns found.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
