import importlib.util
from datetime import datetime,timezone,timedelta
from pathlib import Path
s=importlib.util.spec_from_file_location("c",Path(__file__).parents[1]/"scripts/actions-cache-retention.py");m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
n=datetime(2026,10,1,tzinfo=timezone.utc)
assert m.managed("buildkit-argws-scout-buildkit-runtime-abc") and m.managed("buildkit-runtime") and not m.managed("pnpm-store")
assert m.stale({"key":"buildkit-runtime","last_accessed_at":(n-timedelta(hours=3)).isoformat()},n)
assert not m.stale({"key":"pnpm-store","last_accessed_at":(n-timedelta(days=3)).isoformat()},n)
assert not m.stale({"key":"buildkit-runtime"},n)
print("Cache retention checks passed.")
