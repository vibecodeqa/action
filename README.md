# VibeCode QA GitHub Action

Runs the [VibeCode QA](https://vibecodeqa.online) code-health scanner
([`@vibecodeqa/cli`](https://www.npmjs.com/package/@vibecodeqa/cli)) in your workflow: a
score and grade as step outputs, an optional quality gate, SARIF for GitHub Code Scanning,
and a PR comment.

It is a composite action. It sets up Node 24, runs the CLI with `npx` against the checked-out
repository, and reads the result from `.vibe-check/report.json`.

## Usage

Every example sets an explicit `permissions:` block. Grant only the scopes for the features
you turn on:

| Feature | Input | `GITHUB_TOKEN` scope |
| --- | --- | --- |
| Scan, outputs, quality gate | always on | `contents: read` |
| PR comment | `pr-comment: 'true'` (default) | `pull-requests: write` |
| Code Scanning upload | `sarif: 'true'` (default) | `security-events: write`, plus `actions: read` on private repositories |
| AI autofix (**known broken**, see [Inputs](#inputs)) | `auto-fix: 'true'` | `contents: write`, and an `anthropic-api-key` |

Turning a feature off removes the need for its scope. Without `pull-requests: write`, the
CLI's request to post the comment is refused and the scan carries on: no comment appears,
and nothing in the log says why. Without `security-events: write`, the SARIF upload step
fails visibly but does not fail the job.

### Pull requests: comment, Code Scanning, quality gate

```yaml
name: Code health
on: pull_request

permissions:
  contents: read
  pull-requests: write   # pr-comment
  security-events: write # sarif
  actions: read          # sarif, private repositories only

jobs:
  vibecodeqa:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: vibecodeqa/action@v1
        id: vcqa
        with:
          fail-under: '70'
      - env:
          SCORE: ${{ steps.vcqa.outputs.score }}
          GRADE: ${{ steps.vcqa.outputs.grade }}
        run: echo "Scored $GRADE $SCORE/100"
```

### Pushes to main: score only, read-only token

```yaml
name: Code health
on:
  push:
    branches: [main]

permissions:
  contents: read

jobs:
  vibecodeqa:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: vibecodeqa/action@v1
        with:
          sarif: 'false'
          pr-comment: 'false'
```

### Checkout depth

`fetch-depth` is an input of `actions/checkout`, not of this action. The default checkout is
shallow (one commit), so checks that read history see only that commit — the git-hygiene
check, for example, reads the last 20 commit messages. To give the scan history, set it on
the checkout step:

```yaml
- uses: actions/checkout@v7
  with:
    fetch-depth: 0
```

### Pinning

- `@v1` moves to every `v1.x.y` release. Convenient, and it means a release can change your
  results.
- `@v1.2.3` is not moved by the release process. Use it for reproducible results.
- A full commit SHA is the option for privileged workflows: anything with `contents: write`
  (for example `auto-fix`), `id-token: write`, `pull-requests: write`, or secrets such as
  `anthropic-api-key` in scope. A tag can be moved; a SHA cannot.

Pinning the action does not pin the scanner. The action runs
`npx @vibecodeqa/cli@<cli-version>`, and the default `cli-version` is a range, so a SHA-pinned
action still runs whichever matching CLI version was published last, with that job's token
and secrets. Privileged workflows should pin both:

```yaml
# vibecodeqa/action@v1.2.3
- uses: vibecodeqa/action@<full commit SHA of the v1.2.3 tag>
  with:
    cli-version: '0.56.0' # exact version, not a range
```

The action's own nested actions (`actions/setup-node`, `github/codeql-action/upload-sarif`)
are pinned by commit SHA inside `action.yml`.

## Inputs

| Input | Default | Description |
| --- | --- | --- |
| `fail-under` | `'0'` | Minimum score, a non-negative integer. The step fails when the score is below it. `'0'` passes no threshold, so a `failUnder` in your `.vcqa.json` (or `package.json` `"vcqa"`) still applies. |
| `skip-tests` | `'false'` | Skip test execution for a faster scan. |
| `sarif` | `'true'` | Upload `.vibe-check/report.sarif` to Code Scanning. |
| `pr-comment` | `'true'` | Post or update a PR comment with the score, on `pull_request` events. |
| `auto-fix` | `'false'` | **Known broken; do not enable.** Meant to run `vcqa fix --ai` and push the result to the PR branch on `pull_request` events. As shipped, it stages `.vibe-check/` into the fix commit, and pushes from the detached merge commit that `actions/checkout` produces on `pull_request`, so the push does not reach the PR branch. Both are tracked separately. Skipped with a warning when `anthropic-api-key` is empty, which is what pull requests from forks get. |
| `cli-version` | `'^0.56.0'` | npm version, range or dist-tag of `@vibecodeqa/cli`. The default is the minor line this release was tested against; a caret on `0.x` does not cross minors. |
| `anthropic-api-key` | `''` | Anthropic API key for `auto-fix`. Pass it from a secret. |

Boolean inputs accept exactly `'true'` or `'false'`. An empty string means the default, so a
wrapper workflow can forward an unset input. Any other malformed value fails the step before
anything is downloaded or run.

The `checks` input was removed: it was never read, and the CLI has no flag for it. Workflows
that still pass it get GitHub's "unexpected input" warning, not a failure. To turn checks off,
use `checks` in `.vcqa.json`.

## Outputs

| Output | Description |
| --- | --- |
| `score` | Composite score, 0–100. |
| `grade` | `A`, `B`, `C`, `D` or `F`. |
| `issues` | Total number of issues across all checks. |
| `report-path` | Report directory, `.vibe-check`. It holds `report.json` and `report.sarif`. |

Outputs come from `.vibe-check/report.json`, whose shape is defined by
[`@vibecodeqa/schema`](https://www.npmjs.com/package/@vibecodeqa/schema). They are set
whenever this run wrote a valid report, even if the step then fails: on a quality-gate
failure, and also when the CLI wrote its report and then exited non-zero for another reason.
They are empty, not `0`, when this run wrote no valid report: the CLI could not be installed,
crashed before writing it, or an input was malformed. A report left over from an earlier run
is never read.

## Exit behaviour

| Situation | Log | Step result |
| --- | --- | --- |
| Scan succeeded, gate passed or not set | `::notice` with grade, score and issue count | success |
| CLI exited 1 with the score below `fail-under`, or below `failUnder` from the project config | `::error` "VibeCode QA quality gate — Score N is below the minimum M (set by …)" | failure |
| Any other non-zero exit (install failure, crash, out-of-memory kill, no report), whatever the score | `::error` "VibeCode QA failed — … This is a scan failure, not a quality-gate result" | failure |
| Malformed input | one `::error` per bad input | failure |

The CLI's stderr, including npm warnings, stays in the log. It does not affect the outputs.

## Security

- Inputs reach the shell through `env:` and are passed to the CLI as an argument array. No
  `${{ }}` expression is interpolated into a `run:` script.
- `anthropic-api-key` is only given to the autofix step, and is masked there.
- The scan step gets the workflow's `GITHUB_TOKEN` for the PR comment. Scope it with
  `permissions:` as above.

## Releases

Releases are cut by the [Release](.github/workflows/release.yml) workflow, run from the
Actions tab on `main` with a version number. It runs the [self-test](.github/workflows/self-test.yml)
on that commit, pushes `vX.Y.Z` and the moved `v1` in one atomic push, then publishes a
GitHub release whose notes start with [Upgrading from 1.0](#upgrading-from-10). `v1` only
moves forward along `main`. The workflow never moves or deletes a `vX.Y.Z` tag, and nothing is
tagged from a developer machine. The repository does not yet enforce that with a tag
ruleset, so treat a SHA, not `vX.Y.Z`, as the guarantee.

If the tag push is refused because the commits since the last release change
`.github/workflows/`, add a `RELEASE_TOKEN` repository secret (a fine-grained token for this
repository with Contents and Workflows read and write). The workflow uses it in place of
`GITHUB_TOKEN` when it is set. A failed run can be re-run with the same version.

[CLI pin drift](.github/workflows/cli-pin-drift.yml) checks every Monday whether a newer
CLI minor has been published, and opens an issue when the `cli-version` default is behind.
Moving the default is a release, because it can change every `@v1` user's scores.

## Upgrading from 1.0

`@v1` moves to each release, so these changes reach every workflow that uses `@v1`. 1.0 was
never given a version tag. To keep its behaviour while you adjust, pin the commit `v1` pointed
at before this release: `vibecodeqa/action@3b9c61990f2d61a646b2eba5c67475c74e5d63b2`.

- **A `failUnder` in your project config now fails the job.** 1.0 failed the step only when the
  `fail-under` input was non-zero, so a `failUnder` in `.vcqa.json` or `package.json` `"vcqa"`
  made the CLI exit 1 and the job passed anyway. Now the job fails.
- **Scan failures now fail the job.** With `fail-under` at 0, an npm install failure or a CLI
  crash used to pass with `score=0`, `grade=?`. Now the step fails and the outputs are empty.
- **The scanner moves from 0.45 to 0.56.** `cli-version` now defaults to `^0.56.0`. Scores can
  move between those versions and cross your threshold. Set `cli-version: '^0.45.0'` to keep
  the old engine while you compare.
- **Node 24 stays on `PATH` for the rest of the job.** The action runs `actions/setup-node`
  with Node 24 (1.0 used 22), and that applies to every later step in your job. If a later
  step needs another Node, run `actions/setup-node` again after this action.
- **AI autofix is skipped whenever the step fails**, including on a config `failUnder` that 1.0
  ignored, and a `fix --ai` error now fails the step. Autofix is known broken; see
  [Inputs](#inputs).
- **Outputs are wired.** 1.0 declared `score`, `grade`, `issues` and `report-path` without the
  `value:` mapping that composite actions require, so later steps could not rely on them.
- **npm warnings no longer zero the outputs.** 1.0 parsed stdout and stderr together, so any
  npm warning produced `score=0`, `grade=?`.
- **`checks` was removed.** It was never read. Passing it now produces GitHub's "unexpected
  input" warning; use `checks` in `.vcqa.json` instead.
- **Malformed inputs fail the step.** `fail-under` must be an integer, and the boolean inputs
  must be `'true'` or `'false'`. An empty string still means the default.
- **SARIF is uploaded only from this run's report**, never a leftover file.
- **`anthropic-api-key` is no longer passed to the scan step**, only to autofix.

## Licence

MIT. See [LICENSE](LICENSE).
