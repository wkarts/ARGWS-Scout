#!/usr/bin/env python3
"""Validate the rendered Compose model for one standalone deployment package."""
import json
import pathlib
import sys

folder = pathlib.Path(sys.argv[1]).resolve()
model = json.loads(pathlib.Path(sys.argv[2]).read_text(encoding="utf-8"))
published = [(name, port) for name, service in model["services"].items() for port in service.get("ports", [])]
assert len(published) == 1, f"{folder}: expected exactly one published port, got {published}"
service, port = published[0]
assert service == "manager" and port.get("host_ip") == "127.0.0.1", (folder, service, port)
for name, target in (
    ("postgres", "/var/lib/postgresql/data"),
    ("redis", "/data"),
    ("rabbitmq", "/var/lib/rabbitmq"),
    ("garage", "/var/lib/garage/meta"),
    ("garage", "/var/lib/garage/data"),
):
    mounts = model["services"][name].get("volumes", [])
    assert any(
        mount.get("type") == "bind"
        and pathlib.Path(mount.get("source", "")).is_relative_to(folder)
        and mount.get("target") == target
        for mount in mounts
    ), f"{folder}: {name} must use a relative persistent bind mount for {target}"
for name, service in model["services"].items():
    assert service.get("pull_policy") == "always", name
    assert service.get("image", "").startswith("ghcr.io/wkarts/argws-scout-"), name
assert "content" in model.get("configs", {}).get("garage-config", {}), "Garage config must be inline"
print(f"{folder}: isolated port, persistent binds and GHCR images validated")
