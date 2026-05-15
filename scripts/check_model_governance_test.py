import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).with_name("check_model_governance.py")


class CheckModelGovernanceTest(unittest.TestCase):
    def test_flags_direct_provider_usage_and_forbidden_env_reads(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            subprocess.run(["git", "init", "-b", "main"], cwd=repo, check=True, stdout=subprocess.DEVNULL)

            product = repo / "services" / "orchestrator-service" / "src" / "orchestrator_service"
            product.mkdir(parents=True, exist_ok=True)
            (product / "config.py").write_text(
                "\n".join(
                    [
                        "from openai import OpenAI",
                        'provider = os.environ.get("C2C_MODEL_DEFAULT_DEPLOYMENT")',
                        'api_key = os.getenv("OPENAI_API_KEY")',
                    ]
                )
                + "\n",
                encoding="utf-8",
            )

            result = subprocess.run(
                [sys.executable, str(SCRIPT), "--worktree"],
                cwd=repo,
                text=True,
                capture_output=True,
                check=False,
            )

            self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn("direct-model-provider-usage", result.stdout)
            self.assertIn("forbidden-model-env-read", result.stdout)
            self.assertIn("forbidden-api-key-env-read", result.stdout)

    def test_ignores_allowed_gateway_and_non_product_paths(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            subprocess.run(["git", "init", "-b", "main"], cwd=repo, check=True, stdout=subprocess.DEVNULL)

            gateway = repo / "services" / "go" / "model-gateway-service"
            gateway.mkdir(parents=True, exist_ok=True)
            (gateway / "server.go").write_text(
                'package main\n\nfunc main() {\n\t_ = os.Getenv("OPENAI_API_KEY")\n}\n',
                encoding="utf-8",
            )

            docs = repo / "services" / "python" / "w0-service" / "docs"
            docs.mkdir(parents=True, exist_ok=True)
            (docs / "note.md").write_text(
                "from openai import OpenAI\nOPENAI_API_KEY\nC2C_MODEL_PROVIDER\n",
                encoding="utf-8",
            )

            tests_dir = repo / "services" / "python" / "w0-service" / "tests"
            tests_dir.mkdir(parents=True, exist_ok=True)
            (tests_dir / "test_service.py").write_text(
                'provider = os.environ.get("C2C_MODEL_PROVIDER")\n',
                encoding="utf-8",
            )

            result = subprocess.run(
                [sys.executable, str(SCRIPT), "--worktree"],
                cwd=repo,
                text=True,
                capture_output=True,
                check=False,
            )

            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn("No model governance violations found.", result.stdout)


if __name__ == "__main__":
    unittest.main()
