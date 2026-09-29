#!/usr/bin/env python3
from pathlib import Path
import base64
import os
import secrets

folder = Path(__file__).resolve().parent
target = folder / ".env"
if target.exists():
    raise SystemExit(".env already exists; secrets were left untouched.")

sample = (folder / ".env.example").read_text()
secrets_by_key = {
    "POSTGRES_PASSWORD": secrets.token_hex(32),
    "REDIS_PASSWORD": secrets.token_hex(32),
    "RABBITMQ_PASSWORD": secrets.token_hex(32),
    "S3_SECRET_ACCESS_KEY": secrets.token_hex(32),
    "GARAGE_RPC_SECRET": secrets.token_hex(32),
    "GARAGE_ADMIN_TOKEN": secrets.token_urlsafe(48),
    "SCOUT_JWT_SECRET": secrets.token_hex(32),
    "SCOUT_ENCRYPTION_KEY_BASE64": base64.b64encode(
        secrets.token_bytes(32)
    ).decode(),
    "SCOUT_BOOTSTRAP_ADMIN_PASSWORD": secrets.token_urlsafe(36),
}
postgres_password = secrets_by_key["POSTGRES_PASSWORD"]
redis_password = secrets_by_key["REDIS_PASSWORD"]
rabbitmq_password = secrets_by_key["RABBITMQ_PASSWORD"]
lines = []
for line in sample.splitlines():
    key = (
        line.partition("=")[0]
        if "=" in line and not line.lstrip().startswith("#")
        else ""
    )
    if key in secrets_by_key:
        line = key + "=" + secrets_by_key[key]
    if key == "DATABASE_URL":
        line = key + f"=postgresql://scout:{postgres_password}@127.0.0.1:5432/scout?schema=public"
    if key == "REDIS_URL":
        line = key + f"=redis://:{redis_password}@127.0.0.1:6379/0"
    if key == "RABBITMQ_URL":
        line = key + f"=amqp://scout:{rabbitmq_password}@127.0.0.1:5672"
    if key == "SCOUT_BOOTSTRAP_ADMIN_EMAIL":
        line = key + "=" + os.getenv("SCOUT_BOOTSTRAP_ADMIN_EMAIL", "admin@example.com")
    lines.append(line)

target.write_text("\n".join(lines) + "\n")
target.chmod(0o600)
print("Created .env with per-install secrets. Save the bootstrap password from that file.")
