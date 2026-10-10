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

SCOUT_RELEASE_VERSION = (Path(__file__).resolve().parents[2] / "VERSION").read_text(encoding="utf-8").strip()


class ScoutDeployerTests(unittest.TestCase):
    @staticmethod
    def environment_file(target: str) -> str:
        return "stack.env" if target == "portainer" else ".env"

    def command(self, target: str, environment: str, output: Path, *extra: str) -> list[str]:
        return [
            "generate",
            "--target", target,
            "--environment", environment,
            "--output", str(output),
            "--public-url", "https://scout.argws.com.br" if environment == "production" else "http://localhost:8080",
            "--manager-port", str(scout_deployer.DEFAULT_PORTS[(target, environment)]),
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
            self.assertEqual(env["SCOUT_MANAGER_PORT"], "48180")
            self.assertEqual(env["SCOUT_BROWSER_CONCURRENCY"], "1")
            self.assertEqual(env["SCOUT_VERSION"], SCOUT_RELEASE_VERSION)
            self.assertEqual(len(base64.b64decode(env["SCOUT_ENCRYPTION_KEY_BASE64"])), 32)
            self.assertGreaterEqual(len(env["SCOUT_JWT_SECRET"]), 32)
            self.assertRegex(env["GARAGE_RPC_SECRET"], r"^[0-9a-f]{64}$")
            self.assertNotIn("replace-me", (output / ".env").read_text(encoding="utf-8"))

    def test_rejects_invalid_rpc_secret_without_changing_existing_env(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / "deploy"
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(scout_deployer.main(self.command("docker", "production", output)), 0)
            env_path = output / ".env"
            original = env_path.read_text(encoding="utf-8")
            secret = scout_deployer.parse_env(original)["GARAGE_RPC_SECRET"]
            for invalid in ("replace-me", "g" * 64, "A" * 63 + "="):
                with self.subTest(secret=invalid):
                    corrupted = original.replace("GARAGE_RPC_SECRET=" + secret, "GARAGE_RPC_SECRET=" + invalid)
                    env_path.write_text(corrupted, encoding="utf-8")
                    with contextlib.redirect_stderr(io.StringIO()):
                        self.assertEqual(scout_deployer.validate_directory(output, quiet=True), 1)
                    self.assertEqual(env_path.read_text(encoding="utf-8"), corrupted)
            env_path.write_text(original, encoding="utf-8")
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(scout_deployer.validate_directory(output, quiet=True), 0)

    def test_preserves_existing_env_and_force_replaces_only_compose(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / "deploy"
            args = self.command("docker", "develop", output)
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(scout_deployer.main(args), 0)
            env_path = output / ".env"
            env_path.write_text(env_path.read_text(encoding="utf-8") + "CUSTOM_VALUE=keep-me\n", encoding="utf-8")
            database = output / "volumes" / "postgres"
            database.mkdir(parents=True)
            marker = database / "DO-NOT-DELETE"
            marker.write_text("preserved", encoding="utf-8")
            compose_path = output / "compose.yaml"
            compose_path.write_text("old compose\n", encoding="utf-8")
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(scout_deployer.main([*args, "--force"]), 0)
            self.assertIn("CUSTOM_VALUE=keep-me", env_path.read_text(encoding="utf-8"))
            self.assertIn("services:", compose_path.read_text(encoding="utf-8"))
            self.assertEqual(marker.read_text(encoding="utf-8"), "preserved")

    def test_all_eight_bundles_generate(self) -> None:
        for target in scout_deployer.TARGETS:
            for environment in scout_deployer.CHANNELS:
                with self.subTest(target=target, environment=environment), tempfile.TemporaryDirectory() as temporary:
                    output = Path(temporary) / "deploy"
                    with contextlib.redirect_stdout(io.StringIO()):
                        self.assertEqual(scout_deployer.main(self.command(target, environment, output)), 0)
                    env_file = self.environment_file(target)
                    self.assertEqual({path.name for path in output.iterdir()}, {"compose.yaml", env_file})
                    compose = (output / "compose.yaml").read_text(encoding="utf-8")
                    if target == "portainer":
                        self.assertIn("env_file: [stack.env]", compose)
                    expected_tag = "develop" if environment == "develop" else "stable"
                    self.assertIn(f"SCOUT_TAG:-{expected_tag}", compose)
                    self.assertIn(f"SCOUT_VERSION:-{SCOUT_RELEASE_VERSION}", compose)
                    for mount in ("postgres", "redis", "rabbitmq", "garage/config", "garage/meta", "garage/data"):
                        self.assertIn(f"./volumes/{mount}:", compose)

    def test_smtp_and_browser_settings_are_rendered_without_leaking_password(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / "deploy"
            command = self.command(
                "dockge", "production", output,
                "--browser-concurrency", "3",
                "--recovery-smtp-host", "smtp.example.org",
                "--recovery-smtp-port", "587",
                "--recovery-smtp-secure", "false",
                "--recovery-smtp-username", "mailer@example.org",
                "--recovery-smtp-password-stdin",
                "--recovery-smtp-from-email", "suporte@example.org",
                "--recovery-smtp-from-name", "Equipe Scout",
            )
            original_stdin = sys.stdin
            password = "complex#pass$word'123"
            try:
                sys.stdin = io.StringIO(password + "\n")
                output_log = io.StringIO()
                with contextlib.redirect_stdout(output_log):
                    self.assertEqual(scout_deployer.main(command), 0)
            finally:
                sys.stdin = original_stdin
            self.assertNotIn(password, output_log.getvalue())
            raw_env = (output / ".env").read_text(encoding="utf-8")
            env = scout_deployer.parse_env(raw_env)
            self.assertEqual(env["SCOUT_RECOVERY_SMTP_HOST"], "smtp.example.org")
            self.assertEqual(env["SCOUT_RECOVERY_SMTP_PASSWORD"], password)
            self.assertEqual(env["SCOUT_RECOVERY_SMTP_FROM_EMAIL"], "suporte@example.org")
            self.assertEqual(env["SCOUT_RECOVERY_SMTP_FROM_NAME"], "Equipe Scout")
            self.assertEqual(env["SCOUT_BROWSER_CONCURRENCY"], "3")
            self.assertEqual(scout_deployer.validate_directory(output, quiet=True), 0)
            self.assertIn("./volumes/garage/config:", (output / "compose.yaml").read_text())

    def test_invalid_ports_concurrency_and_smtp_configurations(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / "deploy"
            for extra in (
                ("--manager-port", "8181"),
                ("--manager-port", "50000"),
                ("--browser-concurrency", "0"),
                ("--browser-concurrency", "17"),
                ("--recovery-smtp-host", "smtp.example.org"),
                ("--recovery-smtp-username", "mailer"),
            ):
                with self.subTest(extra=extra), contextlib.redirect_stderr(io.StringIO()):
                    self.assertEqual(scout_deployer.main(self.command("docker", "production", output, *extra)), 1)
                self.assertFalse((output / "compose.yaml").exists())

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
            env = scout_deployer.parse_env((output / "stack.env").read_text(encoding="utf-8"))
            self.assertEqual(env["SCOUT_MANAGER_PORT"], "48083")

    def test_accepts_local_volumes_but_rejects_unrelated_directories(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / "deploy"
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(scout_deployer.main(self.command("docker", "production", output)), 0)
            (output / "volumes" / "postgres").mkdir(parents=True)
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(scout_deployer.validate_directory(output, quiet=True), 0)
            (output / "extra").mkdir()
            with contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(scout_deployer.validate_directory(output, quiet=True), 1)

    def test_generation_refuses_to_write_into_unrelated_directory(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / "deploy"
            output.mkdir()
            marker = output / "keep.txt"
            marker.write_text("user data", encoding="utf-8")
            self.assertEqual(scout_deployer.main(self.command("docker", "production", output)), 1)
            self.assertEqual(marker.read_text(encoding="utf-8"), "user data")
            self.assertFalse((output / "compose.yaml").exists())


if __name__ == "__main__":
    unittest.main()
