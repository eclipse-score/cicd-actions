# *******************************************************************************
# Copyright (c) 2026 Contributors to the Eclipse Foundation
#
# See the NOTICE file(s) distributed with this work for additional
# information regarding copyright ownership.
#
# This program and the accompanying materials are made available under the
# terms of the Apache License Version 2.0 which is available at
# https://www.apache.org/licenses/LICENSE-2.0
#
# SPDX-License-Identifier: Apache-2.0
# *******************************************************************************

"""Transfer Dependabot build outputs as data between unprivileged and trusted jobs."""

import base64
import json
import os
from pathlib import Path
import subprocess
import sys
from urllib.request import Request, urlopen


# An explicit list prevents a build artifact from modifying workflows, scripts,
# manifests, or arbitrary files when it reaches the write-capable publisher.
DISTRIBUTIONS = frozenset({
    "setup-bazel-cache/dst/launcher/index.js",
    "setup-bazel-cache/dst/main/index.js",
    "setup-bazel-cache/dst/post/index.js",
    "setup-qnx-sdp/dst/main/index.js",
    "setup-qnx-sdp/dst/post/index.js",
})
MAX_PAYLOAD_BYTES = 50 * 1024 * 1024


def package(event, destination):
    changed = subprocess.check_output(
        ["git", "diff", "--name-only", "HEAD", "--", *sorted(DISTRIBUTIONS)],
        text=True,
    ).splitlines()
    payload = {
        "sha": event["pull_request"]["head"]["sha"],
        "pr": event["pull_request"]["number"],
        "files": [
            {"path": name, "contents": base64.b64encode(Path(name).read_bytes()).decode("ascii")}
            for name in changed
        ],
    }
    destination.write_text(json.dumps(payload), encoding="utf-8")


def validate(payload, run, pr, repository):
    """Reject untrusted metadata and paths; stale or closed PRs are harmless skips."""
    if run["event"] != "pull_request" or run["head_repository"]["full_name"] != repository:
        raise ValueError("Build did not originate from a pull request in this repository")
    if pr["user"]["login"] != "dependabot[bot]" or pr["head"]["repo"]["full_name"] != repository:
        raise ValueError("Only same-repository Dependabot pull requests may be updated")
    if not pr["head"]["ref"].startswith("dependabot/"):
        raise ValueError("Unexpected Dependabot branch")
    if payload["pr"] != pr["number"] or payload["sha"] != run["head_sha"]:
        raise ValueError("Artifact does not match the triggering build")
    if payload["pr"] not in {item["number"] for item in run["pull_requests"]}:
        raise ValueError("Pull request is not associated with the triggering build")
    if pr["state"] != "open" or pr["head"]["sha"] != run["head_sha"]:
        return False
    files = payload["files"]
    if not isinstance(files, list) or len(files) > len(DISTRIBUTIONS):
        raise ValueError("Invalid distribution file list")
    seen = set()
    for file in files:
        name = file["path"]
        if name not in DISTRIBUTIONS or name in seen or set(file) != {"path", "contents"}:
            raise ValueError("Unexpected or duplicate distribution file")
        seen.add(name)
        if not base64.b64decode(file["contents"], validate=True):
            raise ValueError("Empty distribution file")
    return bool(files)


def api(endpoint, body=None):
    request = Request(
        f"https://api.github.com/{endpoint}",
        data=json.dumps(body).encode() if body is not None else None,
        headers={
            "Authorization": f"Bearer {os.environ['GH_TOKEN']}",
            "Accept": "application/vnd.github+json",
            "Content-Type": "application/json",
            "X-GitHub-Api-Version": "2022-11-28",
        },
    )
    with urlopen(request, timeout=60) as response:
        result = json.load(response)
    if isinstance(result, dict) and result.get("errors"):
        raise RuntimeError("GitHub rejected the commit: " + json.dumps(result["errors"]))
    return result


def eligible(event, repository, call=api):
    run = event["workflow_run"]
    if run["event"] != "pull_request" or run["head_repository"]["full_name"] != repository:
        return False
    if len(run["pull_requests"]) != 1:
        return False
    pr = call(f"repos/{repository}/pulls/{run['pull_requests'][0]['number']}")
    return (
        pr["user"]["login"] == "dependabot[bot]"
        and pr["head"]["repo"]["full_name"] == repository
        and pr["head"]["ref"].startswith("dependabot/")
        and pr["state"] == "open"
        and pr["head"]["sha"] == run["head_sha"]
    )


def publish(payload, event, repository, call=api):
    run = event["workflow_run"]
    # Resolve the PR through GitHub's run metadata, never through an artifact's
    # requested branch or URL. Artifacts are untrusted data even after a build.
    associated = run["pull_requests"]
    if len(associated) != 1:
        raise ValueError("Expected exactly one pull request associated with the build")
    pr = call(f"repos/{repository}/pulls/{associated[0]['number']}")
    if not validate(payload, run, pr, repository):
        print("No distribution commit needed (unchanged, closed, or superseded PR).")
        return
    # expectedHeadOid provides an atomic check: if Dependabot or a maintainer
    # pushes during publishing, GitHub rejects this commit instead of overwriting
    # their work or attaching obsolete build outputs to a newer dependency set.
    result = call("graphql", {
        "query": """mutation($input: CreateCommitOnBranchInput!) {
          createCommitOnBranch(input: $input) { commit { url } }
        }""",
        "variables": {"input": {
            "branch": {"repositoryNameWithOwner": repository, "branchName": pr["head"]["ref"]},
            "expectedHeadOid": run["head_sha"],
            "message": {"headline": "chore(deps): rebuild action distributions"},
            "fileChanges": {"additions": payload["files"]},
        }},
    })
    print("Created distribution commit: " + result["data"]["createCommitOnBranch"]["commit"]["url"])


def main():
    event = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text())
    command = sys.argv[1]
    if command == "eligible":
        with Path(os.environ["GITHUB_OUTPUT"]).open("a") as output:
            output.write(f"publish={str(eligible(event, os.environ['GITHUB_REPOSITORY'])).lower()}\n")
        return
    path = Path(os.environ["DISTRIBUTION_PAYLOAD"])
    if command == "package":
        package(event, path)
    elif command == "publish":
        if not os.environ.get("GH_TOKEN"):
            raise ValueError("SCORE_BOT_CLASSIC_PAT must be available to the publisher")
        if path.stat().st_size > MAX_PAYLOAD_BYTES:
            raise ValueError("Distribution payload is too large")
        publish(json.loads(path.read_text()), event, os.environ["GITHUB_REPOSITORY"])
    else:
        raise ValueError("Expected package, eligible, or publish")


if __name__ == "__main__":
    main()
