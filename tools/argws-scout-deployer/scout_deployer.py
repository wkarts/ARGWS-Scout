#!/usr/bin/env python3
"""Generate and validate ARGWS Scout deployment folders."""

from __future__ import annotations

import argparse
import base64
import re
import secrets
import sys
from pathlib import Path
from urllib.parse import urlparse

TOOL_VERSION = "1.0.0"
TARGETS = ("docker", "dockge", "cloudpanel", "portainer")
CHANNELS = ("develop", "production")
DEFAULT_PORTS = {
    ("docker", "develop"): 8080,
    ("docker", "production"): 8180,
    ("dockge", "develop"): 8081,
    ("dockge", "production"): 8181,
    ("cloudpanel", "develop"): 8082,
    ("cloudpanel", "production"): 8182,
    ("portainer", "develop"): 8083,
    ("portainer", "production"): 8183,
}
SECRET_VALUES = {
    "POSTGRES_PASSWORD": lambda: secrets.token_urlsafe(36),
    "REDIS_PASSWORD": lambda: secrets.token_urlsafe(36),
    "RABBITMQ_PASSWORD": lambda: secrets.token_urlsafe(36),
    "S3_SECRET_ACCESS_KEY": lambda: secrets.token_urlsafe(36),
    "GARAGE_RPC_SECRET": lambda: secrets.token_urlsafe(36),
    "GARAGE_ADMIN_TOKEN": lambda: secrets.token_urlsafe(36),
    "SCOUT_JWT_SECRET": lambda: secrets.token_urlsafe(48),
    "SCOUT_ENCRYPTION_KEY_BASE64": lambda: base64.b64encode(
        secrets.token_bytes(32)
    ).decode("ascii"),
    "SCOUT_BOOTSTRAP_ADMIN_PASSWORD": lambda: secrets.token_urlsafe(24),
}
PLACEHOLDERS = ("replace-me", "REPLACE_WITH", "example.com")


def project_root() -> Path:
    if getattr(sys, "frozen", False):
        return Path(getattr(sys, "_MEIPASS"))
    return Path(__file__).resolve().parents[2]


def product_version() -> str:
    version_file = project_root() / "VERSION"
    return version_file.read_text(encoding="utf-8").strip() if version_file.is_file() else "0.5.0"


def fail(message: str) -> int:
    print(f"Erro: {message}", file=sys.stderr)
    return 1


def parse_env(content: str) -> dict[str, str]:
    values: dict[str, str] = {}
    for line in content.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip().strip('"').strip("'")
    return values


def dotenv_value(value: str) -> str:
    if "\n" in value or "\r" in value or "#" in value or "$" in value or '"' in value:
        raise ValueError("O valor contém caracteres que não são seguros para o arquivo .env.")
    return f'"{value}"' if any(char.isspace() for char in value) else value


def render_env(
    template: str,
    *,
    environment: str,
    public_url: str,
    manager_port: int,
    tenant_name: str,
    tenant_slug: str,
    admin_name: str,
    admin_email: str,
) -> str:
    replacements = {key: factory() for key, factory in SECRET_VALUES.items()}
    replacements.update(
        {
            "SCOUT_VERSION": product_version(),
            "SCOUT_TAG": "develop" if environment == "develop" else "stable",
            "SCOUT_PUBLIC_URL": public_url.rstrip("/"),
            "SCOUT_MANAGER_PORT": str(manager_port),
            "SCOUT_BOOTSTRAP_TENANT_NAME": tenant_name,
            "SCOUT_BOOTSTRAP_TENANT_SLUG": tenant_slug,
            "SCOUT_BOOTSTRAP_ADMIN_NAME": admin_name,
            "SCOUT_BOOTSTRAP_ADMIN_EMAIL": admin_email.lower(),
        }
    )
    output: list[str] = []
    for line in template.splitlines():
        if not line or line.lstrip().startswith("#") or "=" not in line:
            output.append(line)
            continue
        key, value = line.split("=", 1)
        if key in replacements:
            value = dotenv_value(replacements[key])
        output.append(f"{key}={value}")
    return "\n".join(output).rstrip() + "\n"


def validate_public_url(value: str, environment: str) -> str:
    parsed = urlparse(value)
    if parsed.scheme not in ({"https"} if environment == "production" else {"http", "https"}):
        expectation = "HTTPS" if environment == "production" else "HTTP ou HTTPS"
        raise ValueError(f"A URL pública do ambiente {environment} precisa usar {expectation}.")
    if not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError("Informe uma URL pública válida, sem credenciais, consulta ou fragmento.")
    if parsed.path not in ("", "/"):
        raise ValueError("A URL pública deve apontar para a raiz do domínio, sem caminho.")
    return value.rstrip("/")


def safe_profile(value: str, pattern: str, label: str) -> str:
    if not re.fullmatch(pattern, value):
        raise ValueError(f"{label} contém caracteres não aceitos.")
    return value


def generate(args: argparse.Namespace) -> int:
    if args.target not in TARGETS or args.environment not in CHANNELS:
        return fail("plataforma ou ambiente inválido.")
    try:
        public_url = validate_public_url(args.public_url, args.environment)
        tenant_slug = safe_profile(args.tenant_slug, r"[a-z0-9]+(?:-[a-z0-9]+)*", "Slug da organização")
        admin_email = safe_profile(args.admin_email, r"[^\s@]+@[^\s@]+\.[^\s@]+", "E-mail do administrador")
        if not args.tenant_name.strip() or not args.admin_name.strip():
            raise ValueError("Informe o nome da organização e do administrador.")
        manager_port = args.manager_port or DEFAULT_PORTS[(args.target, args.environment)]
        if not 1 <= manager_port <= 65535:
            raise ValueError("A porta do Manager deve ficar entre 1 e 65535.")
        root = project_root()
        template_dir = root / "deploy" / args.target / args.environment
        compose_template = template_dir / "compose.yaml"
        env_template = template_dir / ".env.example"
        if not compose_template.is_file() or not env_template.is_file():
            raise ValueError(f"Modelos ausentes para {args.target}/{args.environment}.")
        output_dir = Path(args.output).expanduser().resolve()
        output_dir.mkdir(parents=True, exist_ok=True)
        compose_path = output_dir / "compose.yaml"
        env_path = output_dir / ".env"
        unexpected = sorted(
            path.name for path in output_dir.iterdir() if path.name not in {"compose.yaml", ".env"}
        )
        if unexpected:
            raise ValueError("A pasta de saída deve estar vazia ou conter somente compose.yaml e .env.")
        if compose_path.exists() and not args.force:
            raise ValueError("compose.yaml já existe; use --force para atualizá-lo.")
        generated_env = None
        if not env_path.exists():
            generated_env = render_env(
                env_template.read_text(encoding="utf-8"),
                environment=args.environment,
                public_url=public_url,
                manager_port=manager_port,
                tenant_name=args.tenant_name.strip(),
                tenant_slug=tenant_slug,
                admin_name=args.admin_name.strip(),
                admin_email=admin_email,
            )
        compose_path.write_text(compose_template.read_text(encoding="utf-8"), encoding="utf-8")
        if generated_env is not None:
            env_path.write_text(generated_env, encoding="utf-8")
            try:
                env_path.chmod(0o600)
            except OSError:
                # Windows ACLs control access; chmod is only a best-effort Unix safeguard.
                pass
        return validate_directory(output_dir, quiet=False)
    except (OSError, UnicodeError, ValueError) as error:
        return fail(str(error))


def validate_directory(directory: Path, *, quiet: bool) -> int:
    try:
        if not directory.is_dir():
            raise ValueError("A pasta selecionada não existe.")
        entries = list(directory.iterdir())
        files = {path.name for path in entries if path.is_file()}
        if len(entries) != 2 or len(files) != 2 or files != {"compose.yaml", ".env"}:
            raise ValueError("A pasta deve conter somente compose.yaml e .env.")
        compose = (directory / "compose.yaml").read_text(encoding="utf-8")
        env = parse_env((directory / ".env").read_text(encoding="utf-8"))
        required = (
            "SCOUT_VERSION",
            "SCOUT_TAG",
            "SCOUT_PUBLIC_URL",
            "SCOUT_MANAGER_PORT",
            "POSTGRES_PASSWORD",
            "REDIS_PASSWORD",
            "RABBITMQ_PASSWORD",
            "GARAGE_RPC_SECRET",
            "GARAGE_ADMIN_TOKEN",
            "SCOUT_JWT_SECRET",
            "SCOUT_ENCRYPTION_KEY_BASE64",
            "SCOUT_BOOTSTRAP_ADMIN_EMAIL",
            "SCOUT_BOOTSTRAP_ADMIN_PASSWORD",
        )
        missing = [key for key in required if not env.get(key)]
        if missing:
            raise ValueError("Variáveis obrigatórias ausentes: " + ", ".join(missing))
        for key in required:
            value = env[key]
            if any(placeholder.lower() in value.lower() for placeholder in PLACEHOLDERS):
                raise ValueError(f"A variável {key} ainda contém um valor de exemplo.")
        if "services:" not in compose or "image:" not in compose:
            raise ValueError("compose.yaml não parece ser uma stack Scout válida.")
        key = base64.b64decode(env["SCOUT_ENCRYPTION_KEY_BASE64"], validate=True)
        if len(key) != 32:
            raise ValueError("SCOUT_ENCRYPTION_KEY_BASE64 precisa decodificar para 32 bytes.")
        if not quiet:
            print("Deploy válido: compose.yaml e .env estão prontos.")
            print(f"Arquivos gravados em: {directory}")
            print("A senha inicial do OWNER está em SCOUT_BOOTSTRAP_ADMIN_PASSWORD no .env.")
        return 0
    except (OSError, UnicodeError, ValueError, base64.binascii.Error) as error:
        return fail(str(error))


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="argws-scout-deployer", description="Deployer portátil do ARGWS Scout")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("version", help="Exibe a versão do deployer")
    sub.add_parser("list", help="Lista as plataformas e ambientes disponíveis")
    make = sub.add_parser("generate", help="Gera compose.yaml e .env para uma instalação")
    make.add_argument("--target", required=True, choices=TARGETS)
    make.add_argument("--environment", required=True, choices=CHANNELS)
    make.add_argument("--output", required=True)
    make.add_argument("--public-url", required=True)
    make.add_argument("--manager-port", type=int, help="Porta local do Manager (padrão da plataforma/canal)")
    make.add_argument("--tenant-name", default="Minha organização")
    make.add_argument("--tenant-slug", default="minha-organizacao")
    make.add_argument("--admin-name", default="Administrador")
    make.add_argument("--admin-email", required=True)
    make.add_argument("--force", action="store_true", help="Atualiza compose.yaml sem sobrescrever .env")
    check = sub.add_parser("validate", help="Valida uma pasta de deploy gerada")
    check.add_argument("--directory", required=True)
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.command == "version":
        print(f"ARGWS Scout Deployer {TOOL_VERSION} (Scout {product_version()})")
        return 0
    if args.command == "list":
        for target in TARGETS:
            print(f"{target}: {', '.join(CHANNELS)}")
        return 0
    if args.command == "generate":
        return generate(args)
    if args.command == "validate":
        return validate_directory(Path(args.directory).expanduser().resolve(), quiet=False)
    parser.error("comando inválido")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
