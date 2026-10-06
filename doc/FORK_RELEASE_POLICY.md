# Downstream Fork Release Policy

This repository is maintained as a downstream fork of Paperclip.

The changes developed here are **not intended to be merged back into the upstream Paperclip repository** unless we explicitly decide otherwise. The primary goal is to maintain and release our own stable Docker distribution.

## Branch model

- `develop` is the integration and active development branch.
- Feature and fix branches should normally target `develop`.
- `master` is our stable release branch.
- Pull requests from `develop` to `master` are internal release gates for this fork. They are not preparation for an upstream contribution.

Upstream compatibility is useful when it reduces maintenance cost, but it is not a release requirement. Changes should be evaluated primarily for correctness, maintainability, security, and stability of our downstream distribution.

## Merge gate for `master`

Do not merge `develop` into `master` merely because the feature appears to work.

A release PR should be merged only after:

1. code review has been completed;
2. blocking review findings have been fixed;
3. relevant automated tests pass;
4. the application builds successfully;
5. the Docker image builds successfully;
6. important runtime or migration risks introduced by the PR have been checked.

If a problem is found during review, fix it on `develop` and update the same release PR until the release gate is clean.

## Release flow

The intended flow is:

```text
feature / fix branches
          |
          v
       develop
          |
          | PR + review + tests + build verification
          v
        master
          |
          | version tag, for example v0.1.0
          v
    Docker release
```

`master` should always represent a revision that we are comfortable using as the basis for a release.

## Docker distribution

Our fork will publish its own Docker image instead of relying on the upstream image for downstream-specific changes.

The planned image namespace is:

```text
ghcr.io/pawelwielga/paperclip
```

For a tagged release, publish at least:

```text
ghcr.io/pawelwielga/paperclip:<version>
ghcr.io/pawelwielga/paperclip:latest
```

For example:

```text
ghcr.io/pawelwielga/paperclip:0.1.0
ghcr.io/pawelwielga/paperclip:latest
```

Prefer immutable version tags for deployments. `latest` is a convenience alias and should point to the most recent stable release from our `master`.

## Versioning and automation

Stable releases should be created from tags on `master`, using semantic versioning where practical.

The target release automation is:

1. merge a reviewed `develop` -> `master` PR;
2. create and push a version tag on the resulting `master` commit;
3. GitHub Actions builds the Docker image from that exact revision;
4. publish the versioned tag to GHCR;
5. update `latest` only after the versioned image has built successfully.

Release automation should never publish an image from an unreviewed feature branch as a stable release.

## Relationship with upstream

Upstream Paperclip remains the source project and may continue to evolve independently.

When bringing upstream changes into this fork:

- integrate them through `develop`;
- resolve conflicts in favor of the requirements of this downstream distribution where necessary;
- run the same release checks before promoting the result to `master`;
- do not assume upstream release or publishing conventions are automatically appropriate for this fork.

This document defines the release policy for this fork. Upstream documentation such as `PUBLISHING.md`, `RELEASING.md`, and `DOCKER.md` may describe the upstream project's own publishing process and should not override this downstream policy.
