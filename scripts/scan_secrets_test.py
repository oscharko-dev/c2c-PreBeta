import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).with_name("scan-secrets.py")


class ScanSecretsTest(unittest.TestCase):
    def test_staged_scan_catches_secret_removed_from_worktree(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            subprocess.run(["git", "init", "-b", "main"], cwd=repo, check=True, stdout=subprocess.DEVNULL)

            candidate = repo / "config.txt"
            candidate.write_text("token=" + "AKIA" + "A" * 16 + "\n", encoding="utf-8")
            subprocess.run(["git", "add", "config.txt"], cwd=repo, check=True)
            candidate.write_text("token=removed\n", encoding="utf-8")

            staged = subprocess.run(
                [sys.executable, str(SCRIPT), "--staged"],
                cwd=repo,
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertNotEqual(staged.returncode, 0, staged.stdout + staged.stderr)
            self.assertIn("aws-key-id", staged.stdout)

            worktree = subprocess.run(
                [sys.executable, str(SCRIPT), "--worktree"],
                cwd=repo,
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(worktree.returncode, 0, worktree.stdout + worktree.stderr)

    def test_worktree_scan_catches_untracked_secret(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            subprocess.run(["git", "init", "-b", "main"], cwd=repo, check=True, stdout=subprocess.DEVNULL)

            candidate = repo / "scratch.txt"
            candidate.write_text("token=" + "AKIA" + "B" * 16 + "\n", encoding="utf-8")

            worktree = subprocess.run(
                [sys.executable, str(SCRIPT), "--worktree"],
                cwd=repo,
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertNotEqual(worktree.returncode, 0, worktree.stdout + worktree.stderr)
            self.assertIn("aws-key-id", worktree.stdout)


if __name__ == "__main__":
    unittest.main()
