import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


FAKE_CURL = r"""#!/usr/bin/env python3
import json
import os
import sys


def read_state(path):
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except FileNotFoundError:
        return {"requests": []}


def write_state(path, state):
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(state, fh)


args = sys.argv[1:]
method = "GET"
data = None
output_path = None
url = None
write_status = False
i = 0
while i < len(args):
    arg = args[i]
    if arg == "-X":
        method = args[i + 1]
        i += 2
        continue
    if arg in ("--data", "--data-binary"):
        data = args[i + 1]
        if method == "GET":
            method = "POST"
        i += 2
        continue
    if arg == "-o":
        output_path = args[i + 1]
        i += 2
        continue
    if arg == "-w":
        write_status = True
        i += 2
        continue
    if arg in ("-H", "--header"):
        i += 2
        continue
    if arg.startswith("-"):
        i += 1
        continue
    url = arg
    i += 1

state_path = os.environ["FAKE_CURL_STATE"]
state = read_state(state_path)
state["requests"].append({"method": method, "url": url, "data": data})
write_state(state_path, state)

status = 404
body = {"error": "unexpected fake curl request", "method": method, "url": url}
if url and url.endswith("/v0/capabilities"):
    status = 200
    body = {
        "roles": [
            {
                "role": "transformation",
                "status": "ok",
                "availableModels": ["gpt-oss-120b"],
            }
        ]
    }
elif url and url.endswith("/v0/runs") and method == "POST":
    status = 201
    body = {"runId": "run-smoke-1"}
elif url and url.endswith("/v0/invoke"):
    status = int(os.environ.get("FAKE_CURL_INVOKE_HTTP", "500"))
    if status == 200:
        body = {
            "status": os.environ.get("FAKE_CURL_INVOKE_STATUS", "completed"),
            "provider": "foundry-development",
            "policyId": "foundry-development-v0",
            "ledgerRef": {"uri": "urn:model-gateway/test", "sha256": "a" * 64},
        }
    else:
        body = {"error": "provider unavailable"}
elif url and "/v0/runs/run-smoke-1" in url and method == "PATCH":
    status = 200
    patch = json.loads(data or "{}")
    body = {"runId": "run-smoke-1", "status": patch.get("status")}

if output_path:
    with open(output_path, "w", encoding="utf-8") as fh:
        json.dump(body, fh)
else:
    print(json.dumps(body))
if write_status:
    print(status, end="")
sys.exit(0)
"""


class FoundrySmokeLifecycleTests(unittest.TestCase):
    def run_smoke(self, *, invoke_http: int, invoke_status: str = "completed") -> tuple[subprocess.CompletedProcess[str], list[dict[str, str | None]]]:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            fake_bin = tmp_path / "bin"
            fake_bin.mkdir()
            fake_curl = fake_bin / "curl"
            fake_curl.write_text(FAKE_CURL, encoding="utf-8")
            fake_curl.chmod(0o755)
            state_path = tmp_path / "curl-state.json"
            env = os.environ.copy()
            env.update(
                {
                    "PATH": f"{fake_bin}{os.pathsep}{env['PATH']}",
                    "FAKE_CURL_STATE": str(state_path),
                    "FAKE_CURL_INVOKE_HTTP": str(invoke_http),
                    "FAKE_CURL_INVOKE_STATUS": invoke_status,
                    "AZURE_FOUNDRY_API_KEY_REF": "unit-test-ref",
                    "AZURE_FOUNDRY_ENDPOINT": "https://foundry.example.test",
                    "MODEL_GATEWAY_BASE_URL": "http://gateway.example.test",
                    "MODEL_GATEWAY_CONTROL_TOKEN": "gateway-token",
                    "HARNESS_BASE_URL": "http://harness.example.test",
                    "HARNESS_CONTROL_TOKEN": "harness-token",
                }
            )

            result = subprocess.run(
                [str(ROOT / "scripts" / "foundry-smoke.sh"), "transformation", "gpt-oss-120b"],
                cwd=ROOT,
                env=env,
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                check=False,
            )
            state = json.loads(state_path.read_text(encoding="utf-8"))
            return result, state["requests"]

    def test_created_harness_run_is_failed_when_gateway_invoke_fails(self) -> None:
        result, requests = self.run_smoke(invoke_http=500)

        self.assertEqual(result.returncode, 2, result.stderr)
        patches = [
            request for request in requests
            if request["method"] == "PATCH" and request["url"].endswith("/v0/runs/run-smoke-1")
        ]
        self.assertEqual(len(patches), 1)
        self.assertEqual(json.loads(patches[0]["data"])["status"], "failed")

    def test_created_harness_run_is_completed_on_success(self) -> None:
        result, requests = self.run_smoke(invoke_http=200)

        self.assertEqual(result.returncode, 0, result.stderr)
        patches = [
            request for request in requests
            if request["method"] == "PATCH" and request["url"].endswith("/v0/runs/run-smoke-1")
        ]
        self.assertEqual(len(patches), 1)
        self.assertEqual(json.loads(patches[0]["data"])["status"], "completed")


if __name__ == "__main__":
    unittest.main()
