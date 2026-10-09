#!/usr/bin/env python3
"""Validate the rendered Compose model for one standalone deployment package."""
import json
import os
import pathlib
import sys

folder = pathlib.Path(sys.argv[1]).resolve()
target = folder.parent.name
channel = folder.name
project = f"argws-scout-{target}-{channel}"
model = json.loads(pathlib.Path(sys.argv[2]).read_text(encoding="utf-8"))
# RabbitMQ readiness must not start the Erlang diagnostic CLI for every probe.
expected_rabbitmq_check = ["CMD", "bash", "-ec", "exec 3<>/dev/tcp/127.0.0.1/5672"]
rabbitmq_check = model["services"]["rabbitmq"].get("healthcheck", {}).get("test")
assert rabbitmq_check == expected_rabbitmq_check, (
    f"{folder}: RabbitMQ must use the lightweight Bash TCP readiness probe, got {rabbitmq_check!r}"
)
# Container mounts must resolve to absolute targets; a bare "noexec" is not a path.
for container_name, container_config in model["services"].items():
    for volume in container_config.get("volumes", []):
        target_path = volume.get("target", "")
        assert pathlib.PurePosixPath(target_path).is_absolute(), (
            f"{folder}/{container_name}: invalid volume mount target {target_path!r}"
        )
browser_tmpfs = model["services"]["browser-worker"].get("tmpfs", [])
assert isinstance(browser_tmpfs, list) and len(browser_tmpfs) == 1, (
    f"{folder}: browser-worker tmpfs must contain exactly one mount, got {browser_tmpfs!r}"
)
tmpfs_mount = browser_tmpfs[0]
assert isinstance(tmpfs_mount, str) and tmpfs_mount.startswith("/tmp:"), (
    f"{folder}: invalid tmpfs target {tmpfs_mount!r}"
)
tmpfs_options = tmpfs_mount.split(":", 1)[1].split(",")
assert {"rw", "noexec", "nosuid", "size=512m"}.issubset(set(tmpfs_options)), (
    f"{folder}: browser-worker tmpfs security or size options missing: {tmpfs_mount!r}"
)

env = dict(
    line.split("=", 1)
    for line in (folder / ".env.example").read_text(encoding="utf-8").splitlines()
    if line and not line.lstrip().startswith("#") and "=" in line
)
owner = env["SCOUT_IMAGE_OWNER"]
app_tag = env["SCOUT_TAG"]
assert model.get("name") == project, (folder, model.get("name"), project)
published = [(name, port) for name, service in model["services"].items() for port in service.get("ports", [])]
assert len(published) == 1, f"{folder}: expected exactly one published port, got {published}"
service, port = published[0]
assert service == "manager" and port.get("host_ip") == "127.0.0.1", (folder, service, port)
assert port.get("published") == {"docker": {"develop":"8080", "production":"8180"}, "dockge": {"develop":"8081", "production":"8181"}, "cloudpanel": {"develop":"8082", "production":"8182"}, "portainer": {"develop":"8083", "production":"8183"}}[target][channel], (folder, port)
for name, mount_target in (
    ("postgres", "/var/lib/postgresql/data"),
    ("redis", "/data"),
    ("rabbitmq", "/var/lib/rabbitmq"),
    ("garage", "/var/lib/garage/meta"),
    ("garage", "/var/lib/garage/data"),
):
    mounts = model["services"][name].get("volumes", [])
    data_mount = next((mount for mount in mounts if mount.get("target") == mount_target), None)
    assert data_mount, f"{folder}: {name} missing persistent storage for {mount_target}"
    if target == "portainer":
        volume_name = data_mount.get("source", "")
        volume = model.get("volumes", {}).get(volume_name, {})
        assert data_mount.get("type") == "volume" and volume.get("name", "").startswith(project + "-"), (folder, name, data_mount, volume)
    else:
        assert data_mount.get("type") == "bind" and pathlib.Path(data_mount.get("source", "")).is_relative_to(folder), (folder, name, data_mount)
# Garage CLI runs in its own container: sharing Garage's network namespace
# does not share its filesystem. It needs the node key stored in metadata_dir.
garage_meta = next(
    mount for mount in model["services"]["garage"]["volumes"]
    if mount.get("target") == "/var/lib/garage/meta"
)
init_meta = next(
    (mount for mount in model["services"]["garage-init"].get("volumes", [])
     if mount.get("target") == "/var/lib/garage/meta"),
    None,
)
assert init_meta is not None, f"{folder}/garage-init: missing Garage node metadata mount"
assert init_meta.get("source") == garage_meta.get("source"), (
    f"{folder}/garage-init: node metadata must use the exact Garage source volume"
)
assert init_meta.get("read_only") is True, (
    f"{folder}/garage-init: node metadata must be mounted read-only"
)

app_images = {
    "garage-config-init": "garage-init",
    "garage-init": "garage-init",
    "migrate": "migrate",
    "bootstrap": "migrate",
    "api": "api",
    "manager": "manager",
    "docs": "docs",
    "dispatcher": "dispatcher",
    "worker": "worker",
    "browser-worker": "browser-worker",
    "scheduler": "scheduler",
    "webhook-worker": "webhook-worker",
}
for name, service in model["services"].items():
    assert service.get("pull_policy") == "always", name
    image = service.get("image", "")
    assert image.startswith(f"ghcr.io/{owner}/argws-scout-"), (name, image)
    if name in app_images:
        expected_image = f"ghcr.io/{owner}/argws-scout-{app_images[name]}:{app_tag}"
        assert image == expected_image, (folder, name, image, expected_image)
# A Compose scalar command is tokenized, so /bin/sh -ec may run only "cat"
# and exit 0 without writing garage.toml. Require a single argv script for
# both Garage one-shot services; verify syntax and run the config generator.
import subprocess
import tempfile
import tomllib

for name in ("garage-config-init", "garage-init"):
    service = model["services"][name]
    assert service.get("entrypoint") == ["/bin/sh", "-ec"], (
        f"{folder}/{name}: missing shell entrypoint"
    )
    command = service.get("command")
    assert isinstance(command, list) and len(command) == 1 and isinstance(command[0], str), (
        f"{folder}/{name}: pass the full shell script as a single command list item"
    )
    subprocess.run(["/bin/sh", "-n", "-c", command[0]], check=True)

config_init = model["services"]["garage-config-init"]
assert config_init.get("environment", {}).get("GARAGE_RPC_SECRET") == env["GARAGE_RPC_SECRET"], (
    f"{folder}: Garage config init must receive the same RPC secret as the server"
)
# Docker Compose may keep escaped $$ in its rendered model; the Engine passes a
# single $ to the shell after interpolation, so emulate that when testing locally.
config_script = config_init["command"][0].replace("$$", "$")
valid_rpc_env = {**os.environ, "GARAGE_RPC_SECRET": "a" * 64}
for invalid_rpc_secret in ("replace-me", "g" * 64, "A" * 63 + "="):
    with tempfile.TemporaryDirectory(prefix="scout-garage-invalid-") as temp:
        invalid_output = pathlib.Path(temp) / "garage.toml"
        invalid_script = config_script.replace("/config/garage.toml", str(invalid_output))
        execution = subprocess.run(
            ["/bin/sh", "-ec", invalid_script],
            env={**os.environ, "GARAGE_RPC_SECRET": invalid_rpc_secret},
            capture_output=True, text=True, check=False,
        )
        assert execution.returncode != 0 and not invalid_output.exists(), (
            f"{folder}: invalid Garage RPC secret must fail before writing config"
        )
        assert "GARAGE_RPC_SECRET" in execution.stderr, (
            f"{folder}: startup failure must explain the invalid key"
        )
assert "cat > /config/garage.toml <<'EOF'" in config_script, f"{folder}: missing Garage configuration heredoc"
assert "test -s /config/garage.toml" in config_script, f"{folder}: missing Garage config verification"
with tempfile.TemporaryDirectory(prefix="scout-garage-test-") as temp:
    output = pathlib.Path(temp) / "garage.toml"
    test_script = config_script.replace("/config/garage.toml", str(output))
    subprocess.run(["/bin/sh", "-ec", test_script], check=True, env=valid_rpc_env)
    config = tomllib.loads(output.read_text(encoding="utf-8"))
    assert config["replication_factor"] == 1 and config["db_engine"] == "lmdb", (folder, config)
    assert config["s3_api"]["api_bind_addr"] == "[::]:3900", (folder, config)
    assert config["s3_api"]["s3_region"] == "us-east-1", (folder, config)
    before = output.read_text(encoding="utf-8") + "# retained-user-configuration\n"
    output.write_text(before, encoding="utf-8")
    subprocess.run(["/bin/sh", "-ec", test_script], check=True, env=valid_rpc_env)
    assert output.read_text(encoding="utf-8") == before, (
        f"{folder}: existing Garage config must survive redeploy"
    )
assert "key import --yes" in model["services"]["garage-init"]["command"][0]
assert "bucket allow --read --write" in model["services"]["garage-init"]["command"][0]

assert "garage-config-init" in model["services"] and "configs" not in model, "Garage config must be generated by the stack without Compose config features"
assert model["networks"]["scout"].get("name") == project + "-network"
assert model["services"]["garage"].get("depends_on", {}).get("garage-config-init", {}).get("condition") == "service_completed_successfully"
if target == "portainer":
    assert all(entry["path"].endswith("/stack.env") for service in model["services"].values() for entry in service.get("env_file", [])), "Portainer standalone stacks must use their uploaded stack.env"
else:
    assert all(entry["path"].endswith("/.env") for service in model["services"].values() for entry in service.get("env_file", [])), "Compose/Dockge stacks must read .env"
print(f"{folder}: target project, isolated port, persistent data and GHCR images validated")
