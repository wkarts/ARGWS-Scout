#!/usr/bin/env python3
from pathlib import Path
import re
root=Path(__file__).resolve().parents[1]
for t in ("docker","dockge","cloudpanel","portainer"):
 for c in ("develop","production"):
  d=root/"deploy"/t/c
  assert {p.name for p in d.iterdir() if p.is_file()}=={"compose.yaml",".env.example"},f"unexpected deployment files in {d}"
  y=(d/"compose.yaml").read_text()
  assert y==(root/"ops/deployment/compose.yaml").read_text()
  lines=y.splitlines()
  for i,line in enumerate(lines):
   if re.match(r"\s+image:",line):assert lines[i+1].strip()=="pull_policy: always"
  assert "./garage.toml" not in y and "content: |" in y
  e=(d/".env.example").read_text()
  refs=[line.split("=",1)[1] for line in e.splitlines() if line.startswith("ARGWS_SCOUT_") and "_IMAGE=" in line]
  assert refs and all(x.startswith("ghcr.io/wkarts/argws-scout-") for x in refs)
print("Eight Compose+env bundles use only GHCR images and inline config.")
