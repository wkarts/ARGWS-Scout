#!/usr/bin/env python3
from pathlib import Path
import hashlib
import re
root=Path(__file__).resolve().parents[1]
targets=("docker","dockge","cloudpanel","portainer")
channels=("develop","production")
ports={"docker":{"develop":8080,"production":8180},"dockge":{"develop":8081,"production":8181},"cloudpanel":{"develop":8082,"production":8182},"portainer":{"develop":8083,"production":8183}}
version=(root/"VERSION").read_text().strip()
compose_hashes=set()
projects=set()
for target in targets:
 for channel in channels:
  d=root/"deploy"/target/channel
  assert {p.name for p in d.iterdir() if p.is_file()}=={"compose.yaml",".env.example"},f"unexpected deployment files in {d}"
  y=(d/"compose.yaml").read_text()
  e=(d/".env.example").read_text()
  env=dict(line.split("=",1) for line in e.splitlines() if line and not line.lstrip().startswith("#") and "=" in line)
  project=f"argws-scout-{target}-{channel}"
  assert env.get("COMPOSE_PROJECT_NAME")==project, f"{d}: missing unique Compose project name"
  assert env.get("SCOUT_ENV")==channel and env.get("SCOUT_VERSION")==version, f"{d}: version/channel mismatch"
  if channel=="production":
   assert env.get("SCOUT_COOKIE_SECURE")=="true" and env.get("SCOUT_ALLOW_HTTP")=="false", f"{d}: production cookies and HTTP policy must be secure"
   assert env.get("SCOUT_PUBLIC_URL","").startswith("https://"), f"{d}: production URL must use HTTPS"
  assert f"name: ${{COMPOSE_PROJECT_NAME:-{project}}}" in y, f"{d}: Compose project name is not target-specific"
  assert f"name: ${{COMPOSE_PROJECT_NAME:-{project}}}-network" in y, f"{d}: network must be scoped to its project"
  assert project not in projects, f"duplicate project name: {project}"
  projects.add(project)
  digest=hashlib.sha256(y.encode()).hexdigest()
  assert digest not in compose_hashes, f"deployment manifest is copied unchanged: {d}"
  compose_hashes.add(digest)
  lines=y.splitlines()
  for i,line in enumerate(lines):
   if re.match(r"\s+image:",line): assert lines[i+1].strip()=="pull_policy: always", f"{d}: images must be pulled on deploy"
  assert "configs:" not in y and "content: |" not in y, f"{d}: avoid Compose configs.content for Portainer compatibility"
  assert "garage-config-init:" in y and "cat > /config/garage.toml" in y, f"{d}: Garage config must be generated from this Compose file"
  assert "garage-config-data:/etc/garage-config:ro" in y and "garage-config-data:/config" in y
  assert "./garage.toml" not in y
  refs=[line.split("=",1)[1] for line in e.splitlines() if line.startswith("ARGWS_SCOUT_") and "_IMAGE=" in line]
  assert refs and all(x.startswith("ghcr.io/wkarts/argws-scout-") for x in refs), f"{d}: infrastructure images must come from GHCR"
  assert env.get("SCOUT_IMAGE_OWNER")=="wkarts", f"{d}: application image owner must be configurable"
  image_tag="develop" if channel=="develop" else "stable"
  pattern=r"image: ghcr\.io/\$\{SCOUT_IMAGE_OWNER:-wkarts\}/argws-scout-[^:]+:\$\{SCOUT_TAG:-"+image_tag+r"\}"
  app_images=re.findall(pattern, y)
  assert len(app_images)==12 and len({line.split("/argws-scout-",1)[1].split(":",1)[0] for line in app_images})==10, f"{d}: all ten Scout image names must use the common owner and channel tag"
  expected_tag=image_tag
  assert env.get("SCOUT_TAG")==expected_tag, f"{d}: SCOUT_TAG must be {expected_tag}"
  assert int(env["SCOUT_MANAGER_PORT"])==ports[target][channel], f"{d}: manager port must be isolated by target and channel"
  assert env["SCOUT_ENCRYPTION_KEY_BASE64"]=="REPLACE_WITH_BASE64_32_BYTE_KEY", f"{d}: example must never contain a deployable encryption key"
  if target=="portainer":
   assert "env_file: [stack.env]" in y, f"{d}: Portainer must consume its uploaded stack.env"
   assert "env_file: [.env]" not in y
   assert "./volumes/" not in y, f"{d}: Portainer stack volumes must not depend on relative-path support"
  else:
   assert "env_file: [.env]" in y, f"{d}: Compose and Dockge consume .env from the stack directory"
  if target=="portainer":
   assert "postgres-data:/var/lib/postgresql/data" in y
   assert f"name: ${{COMPOSE_PROJECT_NAME:-{project}}}-postgres" in y
  else:
   assert "./volumes/postgres:/var/lib/postgresql/data" in y
  assert f"SCOUT_MANAGER_PORT={ports[target][channel]}" in e
  current_service=None
  service_blocks={}
  for line in lines:
   service_match=re.match(r"^  ([A-Za-z0-9_-]+):$",line)
   if service_match:
    current_service=service_match.group(1)
    service_blocks[current_service]=[]
   if current_service:
    service_blocks[current_service].append(line)
  recovery_keys=("HOST","PORT","SECURE","USERNAME","PASSWORD","FROM_EMAIL","FROM_NAME")
  for service,block in service_blocks.items():
   block_text="\n".join(block)
   if service!="api" and "env_file:" in block_text:
    for key in recovery_keys:
     assert f'SCOUT_RECOVERY_SMTP_{key}: ""' in block_text, f"{d}/{service}: recovery SMTP must stay inside the API container"
# Enforce the lightweight RabbitMQ readiness check for all supported deployments.
scout_manifests = [root / "compose.yaml", root / "ops/deployment/compose.yaml"]
scout_manifests += [root / "deploy" / target / channel / "compose.yaml"
                    for target in targets for channel in channels]
probe_fields = (
    '      test: ["CMD", "bash", "-ec", "exec 3<>/dev/tcp/127.0.0.1/5672"]',
    "      interval: 60s",
    "      timeout: 5s",
    "      retries: 5",
    "      start_period: 90s",
)
for manifest in scout_manifests:
    document = manifest.read_text(encoding="utf-8")
    block = re.search(r"(?ms)^  rabbitmq:\n(.*?)(?=^  [A-Za-z0-9_-]+:\n|\Z)", document)
    assert block, f"{manifest}: RabbitMQ service is missing"
    rabbitmq_section = block.group(1)
    assert "rabbitmq-diagnostics" not in rabbitmq_section, f"{manifest}: expensive CLI check"
    for expected_field in probe_fields:
        assert expected_field in rabbitmq_section, f"{manifest}: missing {expected_field}"
    assert rabbitmq_section.count("      test: ") == 1, f"{manifest}: ambiguous probe"

print("Eight distinct Compose+env bundles have isolated project names, ports and persistent data.")
