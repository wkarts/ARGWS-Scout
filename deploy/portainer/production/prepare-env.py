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
    "SCOUT_ENCRYPTION_KEY_BASE64": base64.b64encode(secrets.token_bytes(32)).decode(),
    "SCOUT_BOOTSTRAP_ADMIN_PASSWORD": secrets.token_urlsafe(36),
}
lines = []
for line in sample.splitlines():
    key = line.partition("=")[0] if "=" in line and not line.lstrip().startswith("#") else ""
    if key in secrets_by_key:
        line = key + "=" + secrets_by_key[key]
    if key == "SCOUT_BOOTSTRAP_ADMIN_EMAIL":
        line = key + "=" + os.getenv("SCOUT_BOOTSTRAP_ADMIN_EMAIL", "admin@example.com")
    lines.append(line)
target.write_text("\n".join(lines) + "\n")
target.chmod(0o600)
print("Created .env with per-install secrets. Save the bootstrap password from that file.")
