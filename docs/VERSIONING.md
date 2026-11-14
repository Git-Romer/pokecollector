# Version automation

The application keeps one version in `VERSION`, `frontend/package.json`, both
root version entries in `frontend/package-lock.json`, the frontend/backend image
defaults in `docker-compose.yml`, and the README badge/current-version text.
Use `node scripts/bump-version.mjs patch` or an explicit `major.minor.patch`
version to update them together. `--dry-run` prints the affected files without
writing. Versions must satisfy SemVer and Docker image tag rules, so `+build`
suffixes are not supported. Prereleases such as `2.0.0-rc.1` are supported.

## Checks for every contribution

`Version Consistency / version-check` runs on every branch push and PR update,
including translation-only changes. It checks consistency, a version newer than
the latest target branch, and reuse of an existing `v<version>` release tag.
Direct default-branch pushes compare against the previous commit; an existing
tag is accepted there only when it resolves to the exact checked commit.
The workflow has read-only repository permissions and does not write versions.

For a local equivalent, fetch the target branch and tags, then run:

```bash
node scripts/check-version.mjs --base origin/main --check-tags
node --test scripts/version.test.mjs scripts/weblate-version.test.mjs scripts/version-workflows.test.mjs
```

## Automatic Weblate patch versions

`Weblate Version Bump` runs on GitHub Actions, independently of a running local
agent or application installation. It handles only an open, non-draft PR from
`Git-Romer/pokecollector:weblate-translations` to this repository's `main`.
It also checks the open Weblate PR when `main` advances, and supports manual
workflow dispatch.

The writer checks out trusted `main`, never the PR. GitHub APIs provide PR files
as data. Only modified, existing non-English catalogue files and the five version
files are accepted. Symlinks, new or removed catalogues, workflow changes,
dependency changes, unrelated README/Compose edits and incomplete inventories
are rejected. Rejection leaves the PR branch unchanged for manual review.

The shared updater selects a patch newer than `main`, skips released versions,
and keeps a suitable version already proposed by the PR. All metadata changes
are committed together on top of the current PR head. Translator commits and
translation text are not rewritten by the writer. The final branch update is
non-forced, with head/base rechecks to avoid overwriting concurrent work. A race
fails the job rather than forcing a stale update; rerun after checking the PR.

Weblate itself owns and can replace its translation branch on a later push.
That can remove the previous version-only commit. The next workflow restores the
same proposed version while `main` is unchanged, rather than creating another
patch increment. If `main` catches up, it selects a new patch. This is not a
promise that Weblate preserves an externally added Git commit SHA.

## Maintainer setup and activation

1. Review and merge the implementation normally. No workflow merges PRs,
   pushes application changes directly to `main`, or deploys the application.
2. Configure the Actions repository secret `WEBLATE_VERSION_TOKEN` with a
   dedicated token restricted to this repository, with Contents write and Pull
   requests read. Do not use a broad operational token. A GitHub App integration
   could supply an equivalent installation token, but minting one is not part of
   this workflow. Manage expiry/rotation separately.
3. A dedicated token is necessary because commits made with the built-in
   `GITHUB_TOKEN` do not trigger the usual subsequent Actions runs. The built-in
   token remains Contents read; the dedicated token is exposed only to the
   trusted writer step. Its version commit starts fresh push/PR validation.
4. Verify a real Weblate PR, a subsequent translation push, the resulting version
   files and fresh checks on the latest head. The local Git round-trip test uses
   synthetic data; it does not replace this post-merge live acceptance check.
5. Only after that verification, explicitly make `version-check` a required
   status check and require branches to be up to date. Required-check activation
   is separate from this code change. Existing PRs may need a version refresh
   before merging. Do not treat an old green check as current validation.

To rerun without the GitHub UI:

```bash
gh workflow run weblate-version.yml --repo Git-Romer/pokecollector --ref main
```

Other clients can use GitHub's existing API:
`POST /repos/Git-Romer/pokecollector/actions/workflows/weblate-version.yml/dispatches`
with `{"ref":"main"}` and an appropriately authorized Actions token.
No application API endpoint or runtime dependency is added.

The existing release workflow is unchanged: merging a `VERSION` change starts
release/image publication. Publication does not deploy an application instance.
