#!/usr/bin/env python3
"""Validate and mirror pinned ARGWS Scout base images into GHCR."""

import argparse
import json
import os
import re
import subprocess
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE_IMAGE = re.compile(
    r"(?:docker\.io|mcr\.microsoft\.com)/[a-z0-9._/-]+:[A-Za-z0-9_.-]+"
)
PACKAGE_NAME = re.compile(r"[a-z0-9][a-z0-9-]*")
IMAGE_TAG = re.compile(r"[A-Za-z0-9_.-]+")

DOCKERFILE_BASES = {
    "Dockerfile": "argws-scout-node",
    "Dockerfile.manager": "argws-scout-node",
    "Dockerfile.browser-worker": "argws-scout-playwright",
    "Dockerfile.docs": "argws-scout-nginx",
    "Dockerfile.garage-init": "argws-scout-garage",
}


def load_catalog(owner):
    catalog = json.loads(
        (ROOT / ".github" / "ghcr-bases.json").read_text(encoding="utf-8")
    )
    if catalog.get("schema") != 1 or not catalog.get("images"):
        raise ValueError("invalid GHCR base-image catalog")

    targets = set()
    images = catalog["images"]
    for image in images:
        package = image.get("package", "")
        tag = image.get("tag", "")
        source = image.get("source", "")
        if not PACKAGE_NAME.fullmatch(package) or not package.startswith(
            "argws-scout-"
        ):
            raise ValueError(f"unscoped GHCR package: {package!r}")
        if not IMAGE_TAG.fullmatch(tag) or tag.lower() == "latest":
            raise ValueError(f"floating or invalid GHCR tag: {tag!r}")
        if not SOURCE_IMAGE.fullmatch(source):
            raise ValueError(f"invalid pinned source image: {source!r}")
        target = (package, tag)
        if target in targets:
            raise ValueError(f"duplicate GHCR target: {package}:{tag}")
        targets.add(target)

    available_packages = {image["package"] for image in images}
    required_packages = {
        "argws-scout-postgres",
        "argws-scout-redis",
        "argws-scout-rabbitmq",
        "argws-scout-garage",
        "argws-scout-node",
        "argws-scout-nginx",
        "argws-scout-alpine",
        "argws-scout-playwright",
        "argws-scout-buildkit",
    }
    missing = required_packages - available_packages
    if missing:
        raise ValueError(f"required GHCR bases missing from catalog: {sorted(missing)}")

    for dockerfile, package in DOCKERFILE_BASES.items():
        if package not in available_packages:
            raise ValueError(f"{dockerfile} base missing from catalog: {package}")
        path = ROOT / dockerfile
        expected = f"ghcr.io/{owner}/{package}:"
        if expected not in path.read_text(encoding="utf-8"):
            raise ValueError(f"{dockerfile} must default to {expected}<tag>")

    publisher = ROOT / ".github" / "workflows" / "ghcr-publish-application.yml"
    if "argws-scout-buildkit:" not in publisher.read_text(encoding="utf-8"):
        raise ValueError("GHCR BuildKit image is not configured for application builds")

    return images


def run(command, quiet=False):
    options = {}
    if quiet:
        options["stdout"] = subprocess.DEVNULL
        options["stderr"] = subprocess.DEVNULL
    return subprocess.run(command, check=False, **options).returncode


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=("validate", "ensure"), required=True)
    parser.add_argument(
        "--owner",
        default=os.getenv("GITHUB_REPOSITORY_OWNER", "wkarts"),
    )
    parser.add_argument("--refresh-existing", action="store_true")
    args = parser.parse_args()

    owner = args.owner.lower()
    if not re.fullmatch(r"[a-z0-9-]+", owner):
        raise ValueError(f"invalid GHCR owner: {owner!r}")
    images = load_catalog(owner)
    if args.mode == "validate":
        print(f"Validated {len(images)} pinned GHCR base images.")
        return

    auth_file = os.getenv("REGISTRY_AUTH_FILE")
    for image in images:
        target = f"ghcr.io/{owner}/{image['package']}:{image['tag']}"
        inspect = ["skopeo", "inspect"]
        if auth_file:
            inspect.extend(("--authfile", auth_file))
        inspect.append(f"docker://{target}")

        if not args.refresh_existing and run(inspect, quiet=True) == 0:
            print(f"Preserving existing pinned mirror {target}")
            continue

        copy = ["skopeo", "copy", "--all", "--preserve-digests"]
        if auth_file:
            copy.extend(("--dest-authfile", auth_file))
        copy.extend((f"docker://{image['source']}", f"docker://{target}"))

        for attempt in range(1, 6):
            if run(copy) == 0:
                break
            if attempt == 5:
                raise SystemExit(f"Failed to mirror base image {target}")
            delay = attempt * 10
            print(f"Mirror attempt {attempt} failed; retrying in {delay}s")
            time.sleep(delay)
        print(f"Mirrored {target}")


if __name__ == "__main__":
    main()
