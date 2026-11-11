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

"""Exercise the trust boundary between dependency builds and bot commits."""

import base64
import copy
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

import dependabot_dist as dist


class DistributionTests(unittest.TestCase):
    def setUp(self):
        self.repository = "eclipse-score/cicd-actions"
        self.pr = {
            "number": 81,
            "state": "open",
            "user": {"login": "dependabot[bot]"},
            "head": {
                "sha": "a" * 40,
                "ref": "dependabot/npm_and_yarn/action-updates",
                "repo": {"full_name": self.repository},
            },
        }
        self.run = {
            "event": "pull_request",
            "head_sha": self.pr["head"]["sha"],
            "head_repository": {"full_name": self.repository},
            "pull_requests": [{"number": 81}],
        }
        self.payload = {
            "pr": 81,
            "sha": self.run["head_sha"],
            "files": [{
                "path": "setup-bazel-cache/dst/main/index.js",
                "contents": base64.b64encode(b"generated bundle").decode(),
            }],
        }

    def validate(self):
        return dist.validate(self.payload, self.run, self.pr, self.repository)

    def test_only_current_same_repository_dependabot_builds_are_eligible(self):
        event = {"workflow_run": self.run}
        self.assertTrue(dist.eligible(event, self.repository, lambda _: self.pr))
        for field, value in [("state", "closed"), ("user", {"login": "contributor"})]:
            with self.subTest(field=field):
                pr = copy.deepcopy(self.pr)
                pr[field] = value
                self.assertFalse(dist.eligible(event, self.repository, lambda _: pr))
        self.pr["head"]["sha"] = "b" * 40
        self.assertFalse(dist.eligible(event, self.repository, lambda _: self.pr))

    def test_unassociated_or_fork_builds_skip_before_fetching_artifacts(self):
        for change in [{"pull_requests": []}, {"head_repository": {"full_name": "fork/repo"}}]:
            with self.subTest(change=change):
                run = self.run | change
                self.assertFalse(dist.eligible({"workflow_run": run}, self.repository))

    def test_artifact_cannot_select_workflows_sources_or_traversal_paths(self):
        for name in [".github/workflows/pwn.yml", "setup-bazel-cache/src/main.js",
                     "../dst/main/index.js", "setup-bazel-cache/dst/../../package.json"]:
            with self.subTest(path=name):
                self.payload["files"][0]["path"] = name
                with self.assertRaises(ValueError):
                    self.validate()

    def test_duplicate_paths_and_malformed_content_are_rejected(self):
        self.payload["files"] *= 2
        with self.assertRaises(ValueError):
            self.validate()
        self.payload["files"] = self.payload["files"][:1]
        for contents in ["", "not base64!"]:
            with self.subTest(contents=contents):
                self.payload["files"][0]["contents"] = contents
                with self.assertRaises(ValueError):
                    self.validate()

    def test_artifact_must_match_both_build_sha_and_associated_pr(self):
        for field, value in [("sha", "b" * 40), ("pr", 999)]:
            with self.subTest(field=field):
                payload = self.payload | {field: value}
                with self.assertRaises(ValueError):
                    dist.validate(payload, self.run, self.pr, self.repository)
        self.run["pull_requests"] = [{"number": 999}]
        with self.assertRaises(ValueError):
            self.validate()

    def test_publisher_rechecks_identity_independently_of_eligibility(self):
        for change in [{"user": {"login": "contributor"}},
                       {"head": self.pr["head"] | {"repo": {"full_name": "fork/repo"}}},
                       {"head": self.pr["head"] | {"ref": "main"}}]:
            with self.subTest(change=change):
                with self.assertRaises(ValueError):
                    dist.validate(self.payload, self.run, self.pr | change, self.repository)

    def test_closed_superseded_and_unchanged_builds_never_create_commits(self):
        for case in ["closed", "superseded", "unchanged"]:
            with self.subTest(case=case):
                pr = copy.deepcopy(self.pr)
                payload = copy.deepcopy(self.payload)
                if case == "closed":
                    pr["state"] = "closed"
                elif case == "superseded":
                    pr["head"]["sha"] = "b" * 40
                else:
                    payload["files"] = []
                calls = []

                def call(endpoint, body=None):
                    calls.append((endpoint, body))
                    return pr

                dist.publish(payload, {"workflow_run": self.run}, self.repository, call)
                self.assertEqual(len(calls), 1, "Only the PR lookup is allowed; no commit mutation")

    def test_commit_is_bound_atomically_to_the_built_sha(self):
        calls = []

        def call(endpoint, body=None):
            calls.append((endpoint, body))
            if body is None:
                return self.pr
            return {"data": {"createCommitOnBranch": {"commit": {"url": "commit-url"}}}}

        dist.publish(self.payload, {"workflow_run": self.run}, self.repository, call)
        endpoint, body = calls[1]
        self.assertEqual(endpoint, "graphql")
        commit = body["variables"]["input"]
        self.assertEqual(commit["expectedHeadOid"], self.run["head_sha"])
        self.assertEqual(commit["branch"]["branchName"], self.pr["head"]["ref"])
        self.assertEqual(commit["fileChanges"], {"additions": self.payload["files"]})

    def test_packaging_exports_only_changed_distribution_files(self):
        # A real Git diff must omit unchanged bundles and unrelated source edits.
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            bundle = root / self.payload["files"][0]["path"]
            bundle.parent.mkdir(parents=True)
            bundle.write_text("original")
            (root / "unrelated.js").write_text("original source")
            subprocess.run(["git", "init", "-q", directory], check=True)
            subprocess.run(["git", "-C", directory, "add", "."], check=True)
            subprocess.run(["git", "-C", directory, "-c", "user.name=Test",
                            "-c", "user.email=test@example.org", "commit", "-qm", "initial"], check=True)
            bundle.write_text("rebuilt")
            (root / "unrelated.js").write_text("must not publish")
            event = {"pull_request": self.pr}
            previous = os.getcwd()
            try:
                os.chdir(directory)
                dist.package(event, root / "payload.json")
            finally:
                os.chdir(previous)
            payload = json.loads((root / "payload.json").read_text())
            self.assertEqual([file["path"] for file in payload["files"]], [str(bundle.relative_to(root))])
            self.assertEqual(base64.b64decode(payload["files"][0]["contents"]), b"rebuilt")
            bundle.write_text("original")
            try:
                os.chdir(directory)
                dist.package(event, root / "payload.json")
            finally:
                os.chdir(previous)
            self.assertEqual(json.loads((root / "payload.json").read_text())["files"], [])


if __name__ == "__main__":
    unittest.main()
