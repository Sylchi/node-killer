# Pre-commit `act` hook

`pre-commit-act.js` runs a GitHub Actions job locally with [`act`][act] before
every commit. It fails the commit when the run exceeds 30 seconds, even if
`act` itself would have succeeded.

[act]: https://github.com/nektos/act

## Install

```sh
node scripts/install-pre-commit.js
```

This symlinks `<git hooks dir>/pre-commit` to `scripts/pre-commit-act.js`, makes
the script executable, seeds `~/.config/act/actrc` with runner image mappings
(so `act` never prompts), and backs up any hook it replaces.

Remove it with:

```sh
node scripts/install-pre-commit.js --uninstall
```

## Runtime

The hook prefers rootless Podman at `$XDG_RUNTIME_DIR/podman/podman.sock` and
starts `podman system service` on demand. Rootless Podman maps container root to
your UID, so container writes never leave root-owned files in the work tree.
Docker is used as a fallback when its daemon is reachable.

## Runner image

The hook uses a small image built from `scripts/act-runner.Dockerfile`, which
extends `catthehacker/ubuntu:act-latest`. The hook builds it automatically when
the image is missing. The build context is only `scripts/`, so the checkout is
never uploaded to the builder.

Preparing the image (build or pull) happens before the 30 second clock starts,
so only the `act` run itself counts against the limit.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `ACT_PRECOMMIT_SKIP` | unset | `1` skips the hook for one run |
| `ACT_PRECOMMIT_TIMEOUT_MS` | `30000` | hard deadline for the `act` process |
| `ACT_PRECOMMIT_JOB` | `qnode` | job id to run |
| `ACT_PRECOMMIT_WORKFLOW` | `.github/workflows/ci.yml` | workflow file |
| `ACT_PRECOMMIT_EVENT` | `push` | GitHub event name |
| `ACT_PRECOMMIT_RUNTIME` | `auto` | `auto`, `podman`, or `docker` |
| `ACT_PRECOMMIT_IMAGE` | `qnode-act-runner:latest` | runner image |
| `ACT_PRECOMMIT_IMAGE_BUILD` | on for the default image | `1` builds the image, `0` disables |
| `ACT_PRECOMMIT_BASE_IMAGE` | `catthehacker/ubuntu:act-latest` | base for the image build |
| `ACT_PRECOMMIT_BUILD_TIMEOUT_MS` | `600000` | limit for the one-time image build |
| `ACT_PRECOMMIT_PULL` | `0` | `1` pulls the image before running |
| `ACT_PRECOMMIT_ARGS` | unset | full `act` argument override |
| `ACT_PRECOMMIT_SOCKET` | auto | Podman API socket override |
| `ACT_PRECOMMIT_PULL_TIMEOUT_MS` | `600000` | limit for the one-time image pull |
| `ACT_PRECOMMIT_DOCKER_USER` | `uid:gid` | `--user` for the Docker fallback |

Examples:

```sh
# bypass one commit
ACT_PRECOMMIT_SKIP=1 git commit -m "wip"

# different job and a 60s budget
ACT_PRECOMMIT_JOB=jscheck ACT_PRECOMMIT_TIMEOUT_MS=60000 git commit

# inspect the exact act invocation without running a job
ACT_PRECOMMIT_ARGS='-l' git commit

# use the large runner image (needed for some toolchains)
ACT_PRECOMMIT_IMAGE=catthehacker/ubuntu:full-latest ACT_PRECOMMIT_PULL=1 git commit
```

On failure the hook kills the whole `act` process group, removes containers and
networks created by that run, and prints how to bypass the check once.
