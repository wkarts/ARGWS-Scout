from __future__ import annotations

import base64
import contextlib
import io
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import scout_deployer


class ScoutDeployerTests(unittest.TestCase):
    def command(self, target: str, environment: str, output: Path, *extra: str) -> list[str]:
        return [
            "generate",
            "--target", target,
            "--environment", environment,
            "--output", str(output),
            "--public-url", "https://scout.argws.com.br" if environment == "production" else "http://localhost:8080",
            "--manager-port", "8081" if target == "dockge" else "8180",
            "--tenant-name", "Minha organização",
            "--tenant-slug", "minha-organizacao",
            "--admin-name", "Administrador",
            "--admin-email", "admin@argws.com.br",
            *extra,
        ]

    def test_generates_two_files_and_unique_secrets(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / "deploy"
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(scout_deployer.main(self.command("docker", "production", output)), 0)
            self.assertEqual({path.name for path in output.iterdir()}, {"compose.yaml", ".env"})
            env = scout_deployer.parse_env((output / ".env").read_text(encoding="utf-8"))
            self.assertEqual(env["SCOUT_TAG"], "stable")
            self.assertEqual(env["SCOUT_VERSION"], "0.5.0")
            self.assertEqual(len(base64.b64decode(env["SCOUT_ENCRYPTION_KEY_BASE64"])), 32)
            self.assertGreaterEqual(len(env["SCOUT_JWT_SECRET"]), 32)
            self.assertNotIn("replace-me", (output / ".env").read_text(encoding="utf-8"))

    def test_preserves_existing_env_and_force_replaces_only_compose(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / "deploy"
            args = self.command("docker", "develop", output)
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(scout_deployer.main(args), 0)
            env_path = output / ".env"
            env_path.write_text(env_path.read_text(encoding="utf-8") + "CUSTOM_VALUE=keep-me\n", encoding="utf-8")
            compose_path = output / "compose.yaml"
            compose_path.write_text("old compose\n", encoding="utf-8")
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(scout_deployer.main([*args, "--force"]), 0)
            self.assertIn("CUSTOM_VALUE=keep-me", env_path.read_text(encoding="utf-8"))
            self.assertIn("services:", compose_path.read_text(encoding="utf-8"))

    def test_all_eight_bundles_generate(self) -> None:
        for target in scout_deployer.TARGETS:
            for environment in scout_deployer.CHANNELS:
                with self.subTest(target=target, environment=environment), tempfile.TemporaryDirectory() as temporary:
                    output = Path(temporary) / "deploy"
                    with contextlib.redirect_stdout(io.StringIO()):
                        self.assertEqual(scout_deployer.main(self.command(target, environment, output)), 0)
                    self.assertEqual({path.name for path in output.iterdir()}, {"compose.yaml", ".env"})

    def test_rejects_http_in_production_and_bad_slug(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / "deploy"
            self.assertEqual(
                scout_deployer.main(self.command("docker", "production", output, "--public-url", "http://scout.example.org")),
                1,
            )
            self.assertEqual(
                scout_deployer.main(self.command("docker", "production", output, "--tenant-slug", "Minha Organização")),
                1,
            )

    def test_refuses_to_overwrite_without_force(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / "deploy"
            args = self.command("docker", "production", output)
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(scout_deployer.main(args), 0)
            self.assertEqual(scout_deployer.main(args), 1)

    def test_cli_selects_the_manager_port_for_the_platform_and_channel(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / "deploy"
            args = self.command("portainer", "develop", output)
            del args[args.index("--manager-port") : args.index("--manager-port") + 2]
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(scout_deployer.main(args), 0)
            env = scout_deployer.parse_env((output / ".env").read_text(encoding="utf-8"))
            self.assertEqual(env["SCOUT_MANAGER_PORT"], "8083")

    def test_validation_rejects_extra_directories(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / "deploy"
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(scout_deployer.main(self.command("docker", "production", output)), 0)
            (output / "extra").mkdir()
            self.assertEqual(scout_deployer.validate_directory(output, quiet=True), 1)


if __name__ == "__main__":
    unittest.main()
