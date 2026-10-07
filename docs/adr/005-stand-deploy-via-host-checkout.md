# ADR 005: Stand Deploy via a Host Checkout, Managed by Arcane

## Status

Accepted. Supersedes the Portainer Git-stack flow described in
[ADR 001](001-runtime-and-deployment.md) and, until this document, in `SETUP.md`,
`docs/DEPLOYMENT.md` and `docs/TECHNICAL_README.md`.

## Context

The documented deploy flow was: push `main` → Portainer pulls the repository into a Git stack →
Portainer builds the four images from `infra/docker/*.Dockerfile` → the stack restarts. That flow
no longer exists.

**Portainer has been removed from the OMV server.** The container manager is now
[Arcane](https://github.com/getarcaneapp/arcane) (`v2.8.1`, UI on `:3552`). The leftover
`/data/compose/<id>` directories are empty bind-mount stubs, not usable checkouts.

A project named `parkingassistant` is registered in Arcane with GitOps bound to
`git@github.com:delonet-ai/parkingassistant.git`, and its `lastSyncCommit` does track `main`. But
**Arcane GitOps syncs only the compose file.** Its project directory
(`/app/data/projects/parkingassistant` inside the Arcane container) holds exactly two files —
`compose.yaml` and `.env` — and its git cache is emptied after each sync. There are no sources and
no Dockerfiles there.

Our `docker-compose.yml` builds four of its five services (`migrate`, `api`, `admin-web`, `jobs`)
from `build: context: .`. With only the compose file present, that build has nothing to read, which
is why the stack sat at `status: stopped` with no `parkingassistant-*` image on the host.

Pointing the build context at an absolute host path does not fix it either: the compose client is
the Arcane container, a docker *build* uploads its context from the client, and the Arcane container
mounts only its own `/app/data`. A host path outside that mount is invisible to it. The neighbouring
`backupbot_git` project records the same constraint in a comment — *"No env_file / no build, so
Arcane parses it directly."*

So the stand needs a build client that can read the sources. Two candidates were considered:

- **A — registry images.** CI builds the four images, pushes them to GHCR, and compose references
  `image:` instead of `build:`. Arcane GitOps then works natively, as it does for every other
  project on this server, and a deploy is `arcane pull` + `arcane redeploy`.
- **B — host checkout.** A real git checkout lives on the server; `docker compose` runs on the host,
  where it can read both the sources and the data directories.

## Decision

**Option B.** The test stand deploys from a git checkout on the OMV host.

```text
/opt/git/parkingassistant/          ← git checkout of main (the compose file lives here)
├── docker-compose.yml              ← build context "." resolves to this directory
├── apps/ packages/ infra/ scripts/
└── staging/                        ← NOT in git (.gitignore has /staging/), survives every deploy
    ├── env/app.env                 ← the stand's env file, never committed
    ├── postgres/                   ← the PostgreSQL 16 data directory
    ├── maps/ imports/ logs/ backups/
```

The layout is the one `SETUP.md` already described for the OMV server, so nothing about the compose
file changes: `build: context: .` resolves against the checkout, and the `staging/*` bind mounts were
already absolute for exactly this reason.

Deploying is one idempotent script, run on the host:

```bash
scripts/deploy/stand.sh            # git pull → compose up -d --build → wait for health
```

Arcane keeps its role as the **observer and operator** of the running containers (`arcane ps`,
`arcane logs`, `arcane restart`). It is no longer the thing that *builds* the stack.

## Consequences

**What this buys.** The stand deploys today, with no registry, no CI changes, no credentials on the
server, and no change to `docker-compose.yml`. Builds read sources straight from the checkout, so
what runs on the stand is exactly what `git log` says it is.

**What it costs.** The deploy is no longer triggered by pushing to `main` — someone (or a cron, or
an agent) runs the script. The build happens on the OMV box rather than on CI, so a deploy is
minutes of server CPU. And the checkout is a second place where the repository exists on the server;
if it drifts from `main`, the stand drifts with it. The script therefore always `git pull`s first and
refuses a dirty checkout rather than quietly building local edits.

**The Arcane GitOps project must not be redeployed.** It is still registered, still bound to the
repository, and pressing *redeploy* in the Arcane UI would run a build that cannot work and would
stop the running containers on the way. It should be deleted or unbound in the UI; until then,
treat it as a trap. Deleting it does not touch the containers or the data directories.

**Data is independent of all of this.** `staging/postgres` holds a live PostgreSQL 16 cluster that
predates the migration from Portainer. It is bind-mounted by path, not by docker volume, so no
redeploy, rebuild or project deletion can remove it. `POSTGRES_PASSWORD` in the env file applies only
to a *fresh* cluster — on an existing data directory PostgreSQL keeps the password it was
initialised with, so a mismatch shows up as `api` failing to connect, not as data loss.

**The path to option A stays open.** Nothing here forecloses moving to registry images later: that
change would swap `build:` for `image:` in the compose file and hand the project back to Arcane
GitOps. The host checkout is a deployment detail, not an architectural commitment.
