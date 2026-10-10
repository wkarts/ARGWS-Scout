#!/usr/bin/env python3
from pathlib import Path
import hashlib
import re
root=Path(__file__).resolve().parents[1]
targets=("docker","dockge","cloudpanel","portainer")
channels=("develop","production")
ports={"docker":{"develop":48080,"production":48180},"dockge":{"develop":48081,"production":48181},"cloudpanel":{"develop":48082,"production":48182},"portainer":{"develop":48083,"production":48183}}
version=(root/"VERSION").read_text().strip()
# Versões em tela e na API precisam identificar o commit efetivamente publicado no GHCR.
runtime_docker=(root/"Dockerfile").read_text(encoding="utf-8")
manager_docker=(root/"Dockerfile.manager").read_text(encoding="utf-8")
publisher=(root/".github/workflows/ghcr-publish-application.yml").read_text(encoding="utf-8")
assert "ENV SCOUT_BUILD_SHA=${SCOUT_GIT_SHA}" in runtime_docker
assert 'VITE_BUILD_SHA="${SCOUT_GIT_SHA}"' in manager_docker
assert "SCOUT_GIT_SHA=${{ github.event.workflow_run.head_sha }}" in publisher
assert "SCOUT_CHANNEL=${{ github.event.workflow_run.head_branch }}" in publisher
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
  assert "  bootstrap:" in y, f"{d}: initial OWNER bootstrap is required"
  bootstrap=y.split("  bootstrap:",1)[1].split("  api:",1)[0]
  assert "    profiles: [maintenance]" not in bootstrap, f"{d}: OWNER bootstrap must run automatically"
  api_block=y.split("  api:",1)[1].split("  manager:",1)[0]
  assert "      bootstrap: { condition: service_completed_successfully }" in api_block, f"{d}: API must wait for initial OWNER bootstrap"
  browser_block=y.split("  browser-worker:",1)[1].split("  scheduler:",1)[0]
  assert "SCOUT_BROWSER_CHROMIUM_SANDBOX: ${SCOUT_BROWSER_CHROMIUM_SANDBOX:-false}" in browser_block, f"{d}: browser must have explicit sandbox policy"
  assert env.get("SCOUT_BROWSER_CHROMIUM_SANDBOX")=="false", f"{d}: unsupported sandbox mode must be explicit in env template"
  assert "garage-config-init:" in y and "cat > /config/garage.toml" in y, f"{d}: Garage config must be generated from this Compose file"
  config_init=y.split("  garage-config-init:",1)[1].split("  garage-init:",1)[0]
  assert "    environment:\n      GARAGE_RPC_SECRET: ${GARAGE_RPC_SECRET:?Generate GARAGE_RPC_SECRET}" in config_init, f"{d}: Garage init must validate the runtime RPC secret"
  assert 'if [ "$$(printf \'%s\' "$$GARAGE_RPC_SECRET" | wc -c)" -ne 64 ]; then' in config_init, f"{d}: missing 32-byte RPC secret validation"
  assert "*[!0-9a-fA-F]*)" in config_init, f"{d}: RPC secret must be hexadecimal"
  assert y.count("    entrypoint: [/bin/sh, -ec]\n    command:\n      - |") == 2, f"{d}: Garage init scripts must each be passed as a single shell argument"
  assert "./volumes/garage/config:/etc/garage-config:ro" in y and "./volumes/garage/config:/config" in y, f"{d}: Garage config must be a local bind mount"
  assert "\nvolumes:" not in y, f"{d}: named Docker volumes must not be used"
  assert "./volumes/garage/meta:/var/lib/garage/meta:ro" in y, f"{d}: Garage CLI requires the same local metadata directory"
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
  assert int(env["SCOUT_MANAGER_PORT"])==ports[target][channel] and 40000<=int(env["SCOUT_MANAGER_PORT"])<=49999, f"{d}: the Manager must expose an isolated 4xxxx port"
  assert env["SCOUT_BROWSER_CONCURRENCY"]=="1", f"{d}: default browser concurrency must be 1"
  assert "SCOUT_BROWSER_CONCURRENCY: ${SCOUT_BROWSER_CONCURRENCY:-1}" in y, f"{d}: browser concurrency must be configurable"
  assert env["SCOUT_ENCRYPTION_KEY_BASE64"]=="REPLACE_WITH_BASE64_32_BYTE_KEY", f"{d}: example must never contain a deployable encryption key"
  if target=="portainer":
   assert "env_file: [stack.env]" in y, f"{d}: Portainer standalone must consume its stack.env"
   assert "env_file: [.env]" not in y
  else:
   assert "env_file: [.env]" in y, f"{d}: Compose, Dockge and CloudPanel use .env"
  for mount in ("postgres:/var/lib/postgresql/data", "redis:/data", "rabbitmq:/var/lib/rabbitmq",
                "garage/meta:/var/lib/garage/meta", "garage/data:/var/lib/garage/data",
                "garage/config:/etc/garage-config:ro"):
   assert f"./volumes/{mount}" in y, f"{d}: required relative bind mount missing: {mount}"
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
    assert "key import --yes -n argws-scout -- " in document, f"{manifest}: Garage key CLI option terminator missing"
    assert "rabbitmq-diagnostics" not in rabbitmq_section, f"{manifest}: expensive CLI check"
    for expected_field in probe_fields:
        assert expected_field in rabbitmq_section, f"{manifest}: missing {expected_field}"
    assert rabbitmq_section.count("      test: ") == 1, f"{manifest}: ambiguous probe"
    browser = re.search(r"(?ms)^  browser-worker:\n(.*?)(?=^  [A-Za-z0-9_-]+:\n|\Z)", document)
    assert browser, f"{manifest}: browser-worker service missing"
    browser_section = browser.group(1)
    safe_tmpfs = '    tmpfs: ["/tmp:rw,noexec,nosuid,size=512m"]'
    assert safe_tmpfs in browser_section, f"{manifest}: invalid browser tmpfs syntax (noexec must be a mount option, not a mount path)"
    assert browser_section.count("    tmpfs:") == 1, f"{manifest}: duplicate browser tmpfs declaration"


print("Eight Compose+env bundles have unique projects, 4xxxx ports and ./volumes bind mounts.")
