#!/usr/bin/env python3
"""Fail-closed cleanup of stale BuildKit caches only."""
import datetime as dt,json,os,re,urllib.parse,urllib.request
from pathlib import Path
API="https://api.github.com"; PREFIX="buildkit-argws-scout-buildkit-"; OLD=("buildkit-runtime","buildkit-manager","buildkit-docs","buildkit-browser-worker","buildkit-garage-init"); PARTS=("runtime","manager","docs","browser-worker","garage-init")
def managed(key): return key.startswith(PREFIX) or any(key==p or key.startswith(p+"-") for p in OLD)
def stale(row,now,hours=2):
 value=row.get("last_accessed_at") or row.get("created_at")
 if not managed(row.get("key","")) or not value:return False
 try: seen=dt.datetime.fromisoformat(value.replace("Z","+00:00"))
 except (ValueError,TypeError):return False
 return now-seen.astimezone(dt.timezone.utc)>dt.timedelta(hours=hours)
def request(token,path,method="GET"):
 q=urllib.request.Request(API+path,method=method,headers={"Accept":"application/vnd.github+json","Authorization":"Bearer "+token,"X-GitHub-Api-Version":"2022-11-28","User-Agent":"ARGWS-Scout-cache-retention"})
 with urllib.request.urlopen(q,timeout=20) as r:
  raw=r.read(2*1024*1024);return json.loads(raw) if raw else {}
def pages(token,route,key):
 out=[]
 for n in range(1,101):
  rows=request(token,route+("&" if "?" in route else "?")+f"per_page=100&page={n}").get(key,[]);out+=rows
  if len(rows)<100:return out
 raise RuntimeError("pagination limit; preserve caches")
def verify(token,repo,sha,branch,source_id,publisher_id):
 if branch not in ("main","develop") or not re.fullmatch("[0-9a-f]{40}",sha):raise RuntimeError("invalid source")
 s=request(token,f"/repos/{repo}/actions/runs/{source_id}")
 if s.get("path")!=".github/workflows/ci.yml" or s.get("event")!="push" or s.get("conclusion")!="success" or s.get("head_sha")!=sha or s.get("head_branch")!=branch or s.get("head_repository",{}).get("full_name")!=repo:raise RuntimeError("quality run not proven")
 if request(token,f"/repos/{repo}/branches/{branch}").get("commit",{}).get("sha")!=sha:raise RuntimeError("branch moved")
 jobs=pages(token,f"/repos/{repo}/actions/runs/{publisher_id}/jobs","jobs");pub=[j for j in jobs if j.get("name","").startswith("publish (")]
 got={next((p for p in PARTS if p in j.get("name","")),None) for j in pub if j.get("conclusion")=="success"}
 if len(pub)!=5 or got!=set(PARTS) or any(j.get("conclusion")!="success" for j in pub):raise RuntimeError("image publication not proven")
def active(token,repo,ignore):
 refs=set()
 for status in ("in_progress","queued","waiting","pending","requested"):
  for run in pages(token,f"/repos/{repo}/actions/runs?status={status}","workflow_runs"):
   if str(run.get("id")) in ignore:continue
   b=run.get("head_branch")
   if not b:return None
   refs.add("refs/heads/"+b)
   for pr in run.get("pull_requests",[]):
    if pr.get("number"):refs.update((f"refs/pull/{pr['number']}/head",f"refs/pull/{pr['number']}/merge"))
 return refs
def main():
 repo=os.getenv("GH_REPOSITORY","");token=os.getenv("GH_TOKEN","");sha=os.getenv("SOURCE_SHA","");branch=os.getenv("SOURCE_BRANCH","");sid=os.getenv("SOURCE_RUN_ID","");pid=os.getenv("PUBLISH_RUN_ID","");out=Path("build-cache-retention.json");r={"mode":"blocked","deleted":[],"preserved":[],"hours":2}
 try:
  if not re.fullmatch(r"[\w.-]+/[\w.-]+",repo) or not all((token,sid,pid)):raise RuntimeError("missing scope")
  verify(token,repo,sha,branch,sid,pid);protected=active(token,repo,{sid,pid})
  if protected is None:raise RuntimeError("unknown active branch scope")
  now=dt.datetime.now(dt.timezone.utc);rows=pages(token,f"/repos/{repo}/actions/caches","actions_caches")
  candidates=[c for c in rows if stale(c,now) and c.get("ref") not in protected and c.get("id")][:100]
  r.update(mode="dry-run",candidates=[{"id":c["id"],"key":c.get("key"),"ref":c.get("ref")} for c in candidates])
  if "--apply" in __import__("sys").argv:
   for c in candidates:
    q=urllib.parse.urlencode({"key":c["key"]});fresh=pages(token,f"/repos/{repo}/actions/caches?{q}","actions_caches")
    exact=next((x for x in fresh if x.get("id")==c["id"]),None)
    if not exact or not stale(exact,dt.datetime.now(dt.timezone.utc)) or exact.get("ref") in protected:r["preserved"].append(c["id"]);continue
    request(token,f"/repos/{repo}/actions/caches/{int(c['id'])}","DELETE");r["deleted"].append(c["id"])
   r["mode"]="apply"
 except Exception as e:r["reason"]=str(e)
 out.write_text(json.dumps(r,indent=2)+"\n")
 print(json.dumps({"mode":r["mode"],"candidate_count":len(r.get("candidates",[])),"deleted":len(r["deleted"])}))
 if r["mode"]=="blocked":print("::warning::"+r.get("reason",""))
if __name__=="__main__":main()
