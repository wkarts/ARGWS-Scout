#!/usr/bin/env python3
"""Fail-closed cleanup of stale ARGWS Scout BuildKit caches only."""

import datetime as dt
import json
import os
import re
import sys
import urllib.parse
import urllib.request
from pathlib import Path

API = "https://api.github.com"
ROOT = Path(__file__).resolve().parents[1]
POLICY_PATH = ROOT / ".github" / "retention-policy.json"
LEGACY_SCOPES = (
    "buildkit-runtime",
    "buildkit-manager",
    "buildkit-docs",
    "buildkit-browser-worker",
    "buildkit-garage-init",
)
PARTS = ("runtime", "manager", "docs", "browser-worker", "garage-init")


def load_policy():
    policy = json.loads(POLICY_PATH.read_text(encoding="utf-8"))
    if policy.get("schema") != 1:
        raise ValueError("unsupported retention policy schema")
    hours = policy.get("build_cache_hours")
    maximum = policy.get("maximum_deletions_per_run")
    prefix = policy.get("managed_buildkit_scope_prefix")
    if type(hours) is not int or not 1 <= hours <= 168:
        raise ValueError("build_cache_hours must be between 1 and 168")
    if type(maximum) is not int or not 1 <= maximum <= 100:
        raise ValueError("maximum_deletions_per_run must be between 1 and 100")
    if not isinstance(prefix, str) or not re.fullmatch(
        r"argws-scout-buildkit-[a-z0-9-]*", prefix
    ):
        raise ValueError("invalid managed BuildKit scope prefix")
    for field in (
        "delete_git_tags",
        "delete_github_releases",
        "delete_release_images",
    ):
        if policy.get(field) is not False:
            raise ValueError(f"{field} must remain false")
    return policy


def managed(key, policy=None):
    policy = policy or load_policy()
    managed_prefix = "buildkit-" + policy["managed_buildkit_scope_prefix"]
    if not isinstance(key, str):
        return False
    return key.startswith(managed_prefix) or any(
        key == scope or key.startswith(scope + "-") for scope in LEGACY_SCOPES
    )


def stale(row, now, hours=None, policy=None):
    policy = policy or load_policy()
    threshold = policy["build_cache_hours"] if hours is None else hours
    key = row.get("key", "")
    value = row.get("last_accessed_at") or row.get("created_at")
    if not managed(key, policy) or not value:
        return False
    try:
        seen = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except (ValueError, TypeError, AttributeError):
        return False
    if seen.tzinfo is None:
        return False
    return now.astimezone(dt.timezone.utc) - seen.astimezone(
        dt.timezone.utc
    ) > dt.timedelta(hours=threshold)


def request(token, path, method="GET"):
    req = urllib.request.Request(
        API + path,
        method=method,
        headers={
            "Accept": "application/vnd.github+json",
            "Authorization": "Bearer " + token,
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "ARGWS-Scout-cache-retention",
        },
    )
    with urllib.request.urlopen(req, timeout=20) as response:
        raw = response.read(2 * 1024 * 1024)
        return json.loads(raw) if raw else {}


def pages(token, route, key):
    rows = []
    for page in range(1, 101):
        separator = "&" if "?" in route else "?"
        result = request(
            token, route + separator + f"per_page=100&page={page}"
        ).get(key, [])
        if not isinstance(result, list):
            raise RuntimeError("unexpected paginated API response")
        rows.extend(result)
        if len(result) < 100:
            return rows
    raise RuntimeError("pagination limit reached; preserve caches")


def verify(token, repository, sha, branch, source_run_id, publisher_run_id):
    if branch not in ("main", "develop") or not re.fullmatch(r"[0-9a-f]{40}", sha):
        raise RuntimeError("invalid source branch or SHA")

    source = request(
        token, f"/repos/{repository}/actions/runs/{source_run_id}"
    )
    if (
        source.get("path") != ".github/workflows/ci.yml"
        or source.get("event") != "push"
        or source.get("conclusion") != "success"
        or source.get("head_sha") != sha
        or source.get("head_branch") != branch
        or source.get("head_repository", {}).get("full_name") != repository
    ):
        raise RuntimeError("successful source quality run not proven")
    current_sha = request(token, f"/repos/{repository}/branches/{branch}").get(
        "commit", {}
    ).get("sha")
    if current_sha != sha:
        raise RuntimeError("source branch moved after its quality run")

    publisher = request(
        token, f"/repos/{repository}/actions/runs/{publisher_run_id}"
    )
    if (
        publisher.get("path")
        != ".github/workflows/ghcr-publish-application.yml"
        or publisher.get("event") != "workflow_run"
        or publisher.get("head_repository", {}).get("full_name") != repository
    ):
        raise RuntimeError("application publisher run not proven")

    jobs = pages(
        token,
        f"/repos/{repository}/actions/runs/{publisher_run_id}/jobs",
        "jobs",
    )
    publish_jobs = [
        job
        for job in jobs
        if job.get("name", "").startswith("publish (")
    ]
    expected_jobs = {f"publish ({part})" for part in PARTS}
    if (
        {job.get("name") for job in publish_jobs} != expected_jobs
        or any(job.get("conclusion") != "success" for job in publish_jobs)
    ):
        raise RuntimeError("complete successful image publication not proven")
    base_job = next(
        (
            job
            for job in jobs
            if job.get("name") == "ensure-bases"
            or job.get("name", "").startswith("ensure-bases /")
        ),
        None,
    )
    if not base_job or base_job.get("conclusion") != "success":
        raise RuntimeError("successful base-image mirror not proven")


def active_refs(token, repository, ignored_run_ids):
    refs = set()
    for status in ("in_progress", "queued", "waiting", "pending", "requested"):
        runs = pages(
            token,
            f"/repos/{repository}/actions/runs?status={status}",
            "workflow_runs",
        )
        for run in runs:
            if str(run.get("id")) in ignored_run_ids:
                continue
            branch = run.get("head_branch")
            if not branch:
                return None
            refs.add("refs/heads/" + branch)
            for pull_request in run.get("pull_requests", []):
                number = pull_request.get("number")
                if number:
                    refs.update(
                        (
                            f"refs/pull/{number}/head",
                            f"refs/pull/{number}/merge",
                        )
                    )
    return refs


def main():
    repository = os.getenv("GH_REPOSITORY", "")
    token = os.getenv("GH_TOKEN", "")
    sha = os.getenv("SOURCE_SHA", "")
    branch = os.getenv("SOURCE_BRANCH", "")
    source_run_id = os.getenv("SOURCE_RUN_ID", "")
    publisher_run_id = os.getenv("PUBLISH_RUN_ID", "")
    report_path = Path("build-cache-retention.json")
    report = {
        "mode": "blocked",
        "deleted": [],
        "preserved": [],
    }

    try:
        policy = load_policy()
        report["policy"] = {
            "build_cache_hours": policy["build_cache_hours"],
            "managed_buildkit_scope_prefix": policy[
                "managed_buildkit_scope_prefix"
            ],
            "maximum_deletions_per_run": policy[
                "maximum_deletions_per_run"
            ],
        }
        if (
            not re.fullmatch(r"[\w.-]+/[\w.-]+", repository)
            or not token
            or not source_run_id.isdigit()
            or not publisher_run_id.isdigit()
        ):
            raise RuntimeError("missing or invalid repository/run scope")

        verify(
            token,
            repository,
            sha,
            branch,
            source_run_id,
            publisher_run_id,
        )
        ignored = {source_run_id, publisher_run_id}
        protected = active_refs(token, repository, ignored)
        if protected is None:
            raise RuntimeError("an active run has an unknown ref; preserve caches")

        now = dt.datetime.now(dt.timezone.utc)
        caches = pages(
            token, f"/repos/{repository}/actions/caches", "actions_caches"
        )
        candidates = [
            cache
            for cache in caches
            if stale(cache, now, policy=policy)
            and cache.get("ref") not in protected
            and cache.get("id") is not None
        ][: policy["maximum_deletions_per_run"]]
        report.update(
            mode="dry-run",
            candidates=[
                {
                    "id": cache["id"],
                    "key": cache.get("key"),
                    "ref": cache.get("ref"),
                }
                for cache in candidates
            ],
        )

        if "--apply" in sys.argv:
            # Recheck live workflow refs after planning and before deleting.
            protected = active_refs(token, repository, ignored)
            if protected is None:
                raise RuntimeError(
                    "an active run has an unknown ref; preserve caches"
                )
            for candidate in candidates:
                query = urllib.parse.urlencode({"key": candidate["key"]})
                fresh = pages(
                    token,
                    f"/repos/{repository}/actions/caches?{query}",
                    "actions_caches",
                )
                exact = next(
                    (
                        cache
                        for cache in fresh
                        if cache.get("id") == candidate["id"]
                    ),
                    None,
                )
                if (
                    not exact
                    or not stale(exact, dt.datetime.now(dt.timezone.utc), policy=policy)
                    or exact.get("ref") in protected
                ):
                    report["preserved"].append(candidate["id"])
                    continue
                request(
                    token,
                    f"/repos/{repository}/actions/caches/{int(candidate['id'])}",
                    "DELETE",
                )
                report["deleted"].append(candidate["id"])
            report["mode"] = "apply"
    except Exception as error:
        report["mode"] = "blocked"
        report["reason"] = str(error)

    report_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(
        json.dumps(
            {
                "mode": report["mode"],
                "candidate_count": len(report.get("candidates", [])),
                "deleted": len(report["deleted"]),
            }
        )
    )
    if report["mode"] == "blocked":
        print(
            "::warning::" + report.get("reason", "retention was blocked")
        )


if __name__ == "__main__":
    main()
