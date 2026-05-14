#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path

root = Path(__file__).resolve().parents[1]
out_dir = root / "artifacts"
out_dir.mkdir(exist_ok=True)

services = {
    "go": root / "services" / "go" / "w0-service",
    "python": root / "services" / "python" / "w0-service",
    "typescript": root / "services" / "typescript" / "w0-service",
    "java": root / "services" / "java" / "w0-service",
    "java-cobol-parser": root / "services" / "cobol-parser-service",
    "java-semantic-ir": root / "services" / "semantic-ir-service",
}

manifest = {
    "generated_at": datetime.now(timezone.utc).isoformat(),
    "schema_version": "w0-sbom-1",
    "artifacts": [],
}

for language, service_dir in services.items():
    files = []
    for pattern in ["Dockerfile", "README.md", "pom.xml", "go.mod", "requirements.txt", "package.json", "tsconfig.json"]:
        path = service_dir / pattern
        if path.exists():
            with open(path, "rb") as fh:
                digest = hashlib.sha256(fh.read()).hexdigest()
            files.append({
                "path": str(path.relative_to(root)),
                "sha256": digest,
            })

    manifest["artifacts"].append({
        "service": service_dir.name,
        "language": language,
        "files": files,
    })

out_file = out_dir / "platform-sbom.json"
with open(out_file, "w", encoding="utf-8") as fh:
    json.dump(manifest, fh, indent=2, sort_keys=True)

print(f"Wrote {out_file}")
