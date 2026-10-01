#!/usr/bin/env python3
import argparse,json,os,re,subprocess,time
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
def load():
 d=json.loads((ROOT/".github/ghcr-bases.json").read_text())
 if d.get("schema")!=1 or not d.get("images"): raise ValueError("invalid base-image catalog")
 seen=set()
 for x in d["images"]:
  if not x["package"].startswith("argws-scout-") or not re.fullmatch(r"[A-Za-z0-9._-]+",x["tag"]) or x["tag"]=="latest": raise ValueError("unscoped or floating target")
  if (x["package"],x["tag"]) in seen: raise ValueError("duplicate target")
  seen.add((x["package"],x["tag"]))
 return d["images"]
def main():
 p=argparse.ArgumentParser();p.add_argument("--mode",choices=["validate","ensure"],required=True);p.add_argument("--owner",default=os.getenv("GITHUB_REPOSITORY_OWNER","wkarts"));p.add_argument("--refresh-existing",action="store_true");a=p.parse_args()
 images=load();owner=a.owner.lower()
 for df,pkg in [("Dockerfile","argws-scout-node"),("Dockerfile.manager","argws-scout-node"),("Dockerfile.browser-worker","argws-scout-playwright"),("Dockerfile.docs","argws-scout-nginx"),("Dockerfile.garage-init","argws-scout-garage")]:
  if "ghcr.io/"+owner+"/"+pkg+":" not in (ROOT/df).read_text(): raise ValueError(df+" must default to GHCR")
 if a.mode=="validate": print("Validated",len(images),"GHCR bases.");return
 auth=os.getenv("REGISTRY_AUTH_FILE")
 for x in images:
  target=f"ghcr.io/{owner}/{x['package']}:{x['tag']}"; inspect=["skopeo","inspect"]+([ "--authfile",auth] if auth else [])+["docker://"+target]
  if not a.refresh_existing and subprocess.run(inspect,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode==0:
   print("Preserving",target);continue
  for n in range(1,6):
   cmd=["skopeo","copy","--all","--preserve-digests"]+([ "--dest-authfile",auth] if auth else [])+["docker://"+x["source"],"docker://"+target]
   if subprocess.run(cmd).returncode==0: break
   if n==5: raise SystemExit("Base mirror failed: "+target)
   time.sleep(n*10)
  print("Mirrored",target)
if __name__=="__main__":main()
