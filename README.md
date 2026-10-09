# BranchMap

English · [中文](README.zh-CN.md)

See where every project's code actually is: who is working on what, whether it has been merged into `dev`, whether it has reached the test / production environments, which commit is running in production, and what looks unhealthy.

BranchMap is not a Git client: it never commits, switches branches or modifies your repositories. One repository is one project, and each project gets its own page.
Run it on your own machine (just for you), or deploy it to a server for your team (Feishu/Lark sign-in, GitHub App connection).

> The user interface is currently in Chinese. Below, UI labels are given in English with the on-screen Chinese text in parentheses.

## What you see

- **Board** (看板, the home page): one card per project.
  - A route map: in-progress branches flow into `dev`; between `dev` and `main` it shows how many commits are waiting to be released (待上线) and how many are on `main` but not back in `dev` (没回合); environments such as test / production sit on their branches.
  - Issues that need attention (health checks); each one links to the place where you fix it.
  - On the right: activity of people across projects; when running locally, also "This machine" (本机) — branches not yet pushed and working trees with uncommitted changes.
- **Branch graph** (分支图): the commit graph of one project.
  - The full git graph by default; the "trunk" (主线) view shows only the `main` and `dev` lines plus branches not yet merged. `main` is always left of `dev`, each tagged with environment labels such as production / test.
  - Every branch has its own color, consistent between lists and the graph; merged branches keep their color and are labelled by name. The branch bar on top picks which branches are drawn (all by default).
  - The detail panel drills down: branch → commit → file diff; environment → pending deployment, what the next release will carry (copyable release checklist), skipped environments, deployment history.
- **Branches** (分支): every branch in one table — owner, remote / local status, ahead / behind `dev`, which stage it has reached, PR with CI and review status, custom tags.
  Filters: in progress, merged into dev, merged into main, stale, cleanable, local, mine. "Cleanable" only generates the delete commands; you run them yourself.
- **People** (成员): a card per person (14-day activity, which stage their work is at, their branches). The detail page shows commits from the last 7 days, how many of the waiting-to-release / not-merged-back commits are theirs, each piece of work expanded to commits, and whether each branch has reached `dev` / `main`.

Pages refresh automatically when data changes (new commits pushed, an environment switched versions, local files changed).

## Where the data comes from

| Data | Source | Answers |
|---|---|---|
| Remote | BranchMap's own copy of each repository in its cache directory (Git history only, no working files), synced every 2 minutes; synced immediately on push when a GitHub App is connected | The team's real progress: state of `main` / `dev`, everyone's pushed branches |
| Environments | Read-only HTTP GET to the configured URLs, reading the running commit or version, every minute | Which commit is actually running |
| Local | Repositories and all their worktrees under the scan directories (local mode only) | Have I pushed / pulled |
| GitHub | PRs, CI, review status and avatars: a read-only GitHub App, or the local `gh` login | What is in review, did CI pass |

- When a remote copy is first created and the repository already exists locally, history is copied from the local repository first (fast, offline), then completed over the network.
- Syncing uses your existing Git credentials (credential manager, SSH key), so private repositories work; with a GitHub App connected it uses the app's read-only token. Without credentials it fails immediately instead of prompting.
- Local repositories are read-only: "pushed or not" is computed against BranchMap's own copy; it never runs `fetch` in your repositories.
- The server only listens on `127.0.0.1` and checks `Host` / `Origin`.

## Usage

Requires Node 20+ and Git.

```bash
npm install
cp config.example.json config.json   # set scan (where your repositories live) and each project's environments
npm start                             # start and open http://localhost:4317/
```

`npm run serve` starts without opening a browser (VS Code's built-in browser works too).

To see PRs, CI and GitHub avatars, either:

- click "Connect GitHub" (连接 GitHub) in "Add project" (添加项目): GitHub opens a pre-filled "create app" page (all permissions read-only); after creating it, pick the organization and repositories, and they appear in "Add project" ready to select;
- or have a logged-in [GitHub CLI](https://cli.github.com/) on your machine (`gh auth login`).

To deploy it on a server for a team (reverse proxy, Feishu sign-in, GitHub connection, systemd and nginx templates), see [docs/DEPLOY.md](docs/DEPLOY.md) (in Chinese).

## Configuration (config.json)

Works with almost nothing configured: set `scan`, and repositories found there are grouped into projects by remote URL, with `dev` / `main` detected automatically. Add `environments` to a project to track deployments.

```jsonc
{
  "scan": ["C:\\Users\\me\\Projects"],          // directories to scan; every repository and worktree below is found
  "people": { "Zhang San": ["Zhang San", "zhangsan"] },  // several Git names of the same person
  "projects": [
    {
      "remote": "https://github.com/acme/api.git", // matches the project by remote URL; works without a local clone
      "name": "API",
      "group": "Backend",
      "flow": ["dev", "main"],                    // direction of the trunk branches (detected if omitted)
      "environments": [
        {
          "name": "Test",
          "branch": "dev",                        // the branch it deploys from: compared against it
          "url": "https://test.example.com",      // link for people
          "probe": { "url": "https://test.api.example.com/health", "commit": "commit" }
        }
      ]
    }
  ]
}
```

Projects, trunk branches and environments can also be edited in the UI ("Add project", project settings); changes are written back to `config.json`.

**How an environment's running commit is read** (`probe` + `resolve`):

| Config | When |
|---|---|
| `"probe": { "url": "…/health", "commit": "commit" }` | The endpoint returns the commit. The field can be a path, e.g. `"build.sha"` |
| `"probe": { "url": "…/health" }` | No field given: looks for `commit`, `sha`, `gitSha`, `revision` and similar fields in the JSON |
| `"probe": { "url": "…/latest", "version": "version" }` plus `"resolve": [{ "tag": "app-{version}" }]` | The endpoint returns only a version; the commit is found via tags |
| `"resolve": [{ "manifest": "release/production/{version}/*/*.json", "field": "commit" }]` | Found via a build manifest left in a local worktree of the project |

- Environments whose commit cannot be read are still shown, as "version unknown" (版本未知). The pipeline skips them and compares the nearest stages it can judge, e.g. `dev` → `main`.
- The most reliable setup is a health endpoint that returns the commit the service was built from.

**Other options**:

| Field | Default | Meaning |
|---|---|---|
| `port` | 4317 | Port |
| `syncInterval` | 120 | Remote sync interval (seconds) |
| `probeInterval` | 60 | Environment probe interval (seconds) |
| `localInterval` | 90 | Local rescan interval (seconds); also rescans when the page regains focus |
| `windowDays` | 21 | Time window for in-progress work; unreleased work is always included |
| `health.staleDays` | 30 | Days without activity before a branch counts as stale |
| `health.backlogDays` | 7 | Days a waiting-to-release commit may wait before it is flagged |
| `health.envLagHours` | 24 | Hours an environment may lag its branch before it is flagged |
| `tickets` | auto | Ticket IDs: `{ "prefixes": ["ABC"] }` or `{ "pattern": "…" }`, with optional `"url": "https://…/{id}"`. Auto-detected otherwise: a prefix seen with 3+ numbers counts as a ticket |
| `auth` | off | Feishu sign-in for server deployments, see [docs/DEPLOY.md](docs/DEPLOY.md) |

## Health checks

| Rule | Level |
|---|---|
| Remote never synced successfully | critical |
| Environment offline | critical |
| Remote sync failing for more than 15 minutes | warning |
| An environment runs a commit that is on no branch (deployed from unpushed code) | warning |
| An environment runs commits that are not on its branch (deployed from elsewhere) | warning |
| The release branch has commits the previous environment never ran; a later environment has commits an earlier one does not (testing skipped) | warning |
| Not merged back: commits on `main` that are not in `dev` | warning |
| Waiting-to-release commits older than `backlogDays`; an environment lagging its branch longer than `envLagHours` | warning (info before that) |
| Environment version unknown, stale branches, a local environment not running | info |

Local state (unpushed, uncommitted) is not part of a project's health; see "This machine" on the board and the "local" filter on the branches page.

## Code layout

```
server.mjs              HTTP API, live updates (SSE), static files, GitHub connection and webhook
lib/config.mjs          configuration
lib/sources/            the three data sources, independent of each other
  cloud.mjs               remote copy: create, sync, status
  local.mjs               local scan: worktrees, local branches, compared with the remote
  env.mjs                 environment probes: read commit / version, resolve via tags or manifests
lib/engine/             pure computation, no disk or network
  graph.mjs               commit graph (bitmap reachability)
  pipeline.mjs            pipeline: stages, gaps, in-progress work, branches, people
  health.mjs              health rules (one function each; add to RULES)
lib/project.mjs         wires sources into the engine, schedules background jobs, notifies pages on change
lib/repo.mjs            Git queries on the remote copy (graph, commit, diff, compare, PRs)
lib/git.mjs             runs git: read-only, limited concurrency, network commands queued and never prompting
lib/people.mjs          groups "name + email" into people; avatars from GitHub
lib/github.mjs          GitHub connection: app creation and installation, tokens, authorized repositories, webhook verification; falls back to local gh
lib/remote.mjs          normalizes the many spellings of a remote URL into one key
lib/auth.mjs            Feishu sign-in for server deployments (off locally), see docs/DEPLOY.md
web/                    the pages (plain JS modules, no build step)
deploy/                 server templates: systemd service, nginx site
scripts/check-docs.mjs  documentation check (npm run check:docs)
```

Engineering conventions (Git, issues, documentation, UI copy) are in [AGENTS.md](AGENTS.md); the documentation index is [docs/README.md](docs/README.md). Both are in Chinese.

To add a data source (e.g. a ticket system), add a module under `lib/sources/` and wire it up in `project.mjs`. To add a health rule, add a function to `RULES` in `health.mjs`.
