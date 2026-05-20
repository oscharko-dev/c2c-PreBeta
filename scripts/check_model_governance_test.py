import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).with_name("check_model_governance.py")


class CheckModelGovernanceTest(unittest.TestCase):
    @staticmethod
    def _run_scan(repo: Path) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, str(SCRIPT), "--worktree"],
            cwd=repo,
            text=True,
            capture_output=True,
            check=False,
        )

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

            result = self._run_scan(repo)

            self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn("direct-model-provider-usage", result.stdout)
            self.assertIn("forbidden-model-env-read", result.stdout)
            self.assertIn("forbidden-api-key-env-read", result.stdout)

    def test_flags_direct_provider_imports_and_usages_in_go_java_and_apps_outside_gateway(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            subprocess.run(["git", "init", "-b", "main"], cwd=repo, check=True, stdout=subprocess.DEVNULL)

            go_service = repo / "services" / "experience-learning-service"
            go_service.mkdir(parents=True, exist_ok=True)
            (go_service / "main.go").write_text(
                "\n".join(
                    [
                        "package main",
                        "",
                        "import (",
                        '\topenai "github.com/openai/openai-go"',
                        "\t\"fmt\"",
                        ")",
                        "",
                        "func main() {",
                        '\tclient := openai.NewClient("token")',
                        "\tfmt.Println(client)",
                        "}",
                    ]
                )
                + "\n",
                encoding="utf-8",
            )

            java_service = (
                repo
                / "services"
                / "build-test-runner-service"
                / "src"
                / "main"
                / "java"
                / "com"
                / "c2c"
                / "build_test_runner"
            )
            java_service.mkdir(parents=True, exist_ok=True)
            (java_service / "App.java").write_text(
                "\n".join(
                    [
                        "package com.c2c.build_test_runner;",
                        "",
                        "import com.openai.client.OpenAIClient;",
                        "",
                        "public final class App {",
                        "    public static void main(String[] args) {",
                        "        OpenAIClient client = com.openai.client.OpenAIClient.builder().build();",
                        "        System.out.println(client);",
                        "    }",
                        "}",
                    ]
                )
                + "\n",
                encoding="utf-8",
            )
            app = repo / "apps" / "c2c-studio" / "src"
            app.mkdir(parents=True, exist_ok=True)
            (app / "llm.ts").write_text(
                "\n".join(
                    [
                        'import OpenAI from "openai";',
                        "",
                        "export const client = new OpenAI({ apiKey: 'token' });",
                    ]
                )
                + "\n",
                encoding="utf-8",
            )
            (app / "legacy-llm.js").write_text(
                '\n'.join(
                    [
                        'const OpenAI = require("openai");',
                        "module.exports = { client: new OpenAI({ apiKey: 'token' }) };",
                    ]
                )
                + "\n",
                encoding="utf-8",
            )
            (repo / "apps" / "c2c-studio" / "package.json").write_text(
                '\n'.join(
                    [
                        "{",
                        '  "name": "c2c-studio",',
                        '  "dependencies": {',
                        '    "@anthropic-ai/sdk": "^0.54.0"',
                        "  }",
                        "}",
                    ]
                )
                + "\n",
                encoding="utf-8",
            )

            result = self._run_scan(repo)

            self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn("direct-model-provider-usage", result.stdout)
            self.assertIn("services/experience-learning-service/main.go", result.stdout)
            self.assertIn(
                "services/build-test-runner-service/src/main/java/com/c2c/build_test_runner/App.java",
                result.stdout,
            )
            self.assertIn("apps/c2c-studio/src/llm.ts", result.stdout)
            self.assertIn("apps/c2c-studio/src/legacy-llm.js", result.stdout)
            self.assertIn("apps/c2c-studio/package.json", result.stdout)

    def test_ignores_allowed_gateway_and_non_product_paths(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            subprocess.run(["git", "init", "-b", "main"], cwd=repo, check=True, stdout=subprocess.DEVNULL)

            gateway = repo / "services" / "model-gateway-service"
            gateway.mkdir(parents=True, exist_ok=True)
            (gateway / "server.go").write_text(
                "\n".join(
                    [
                        "package main",
                        "",
                        "import \"github.com/openai/openai-go\"",
                        "",
                        "func main() {",
                        '\t_ = openai.NewClient("token")',
                        "}",
                    ]
                )
                + "\n",
                encoding="utf-8",
            )

            go_docs = repo / "services" / "experience-learning-service" / "docs"
            go_docs.mkdir(parents=True, exist_ok=True)
            (go_docs / "client.go").write_text(
                "\n".join(
                    [
                        "package docs",
                        "",
                        'import openai "github.com/openai/openai-go"',
                        "",
                        "var _ = openai.NewClient(\"token\")",
                    ]
                )
                + "\n",
                encoding="utf-8",
            )

            java_tests = repo / "services" / "build-test-runner-service" / "tests"
            java_tests.mkdir(parents=True, exist_ok=True)
            (java_tests / "AppTest.java").write_text(
                "\n".join(
                    [
                        "package com.c2c.build_test_runner;",
                        "",
                        "import com.openai.client.OpenAIClient;",
                        "",
                        "public final class AppTest {",
                        "    OpenAIClient client = com.openai.client.OpenAIClient.builder().build();",
                        "}",
                    ]
                )
                + "\n",
                encoding="utf-8",
            )

            result = self._run_scan(repo)

            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn("No model governance violations found.", result.stdout)


if __name__ == "__main__":
    unittest.main()
