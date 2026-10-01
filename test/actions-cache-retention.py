#!/usr/bin/env python3
"""Test policy-driven cache selection without calling GitHub."""
import importlib.util
from datetime import datetime, timedelta, timezone
from pathlib import Path

script = Path(__file__).parents[1] / "scripts" / "actions-cache-retention.py"
spec = importlib.util.spec_from_file_location("cache_retention", script)
cache = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cache)

policy = cache.load_policy()
now = datetime(2026, 10, 1, tzinfo=timezone.utc)
prefix = "buildkit-" + policy["managed_buildkit_scope_prefix"]

assert cache.managed(prefix + "runtime-example")
assert cache.managed("buildkit-runtime-example")
assert cache.managed("buildkit-manager")
assert not cache.managed("pnpm-store")
assert cache.stale(
    {
        "key": prefix + "runtime-example",
        "last_accessed_at": (
            now - timedelta(hours=policy["build_cache_hours"] + 1)
        ).isoformat(),
    },
    now,
)
assert not cache.stale(
    {
        "key": prefix + "runtime-example",
        "last_accessed_at": (
            now - timedelta(hours=max(0, policy["build_cache_hours"] - 1))
        ).isoformat(),
    },
    now,
)
assert not cache.stale({"key": "buildkit-runtime-example"}, now)
assert not cache.stale(
    {
        "key": prefix + "runtime-example",
        "last_accessed_at": "not-a-timestamp",
    },
    now,
)
print("Policy-driven BuildKit cache retention checks passed.")
