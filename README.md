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
| AI autofix | `auto-fix: 'true'` | `contents: write`, and an `anthropic-api-key` |

Turning a feature off removes the need for its scope. Without the scope, the PR comment is
skipped and a failed SARIF upload is reported on its step without failing the job.

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
- `@v1.2.3` never moves. Use it for reproducible results.
- A full commit SHA is the option for privileged workflows: anything with `contents: write`
  (for example `auto-fix`), `id-token: write`, or secrets in scope. A tag can be moved; a
  SHA cannot.

```yaml
# vibecodeqa/action@v1.2.3
- uses: vibecodeqa/action@<full commit SHA of the v1.2.3 tag>
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
| `auto-fix` | `'false'` | Run `vcqa fix --ai` and push the result to the PR branch, on `pull_request` events. Skipped with a warning when `anthropic-api-key` is empty, which is what pull requests from forks get. |
| `cli-version` | `'^0.56.0'` | npm version, range or dist-tag of `@vibecodeqa/cli`. The default is the minor line this release was tested against; a caret on `0.x` does not cross minors. |
| `anthropic-api-key` | `''` | Anthropic API key for `auto-fix`. Pass it from a secret. |

Boolean inputs accept exactly `'true'` or `'false'`. Malformed inputs fail the step before
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
whenever the scan wrote a report, including when the quality gate fails. When the scan itself
fails, they are empty rather than `0`.

## Exit behaviour

| Situation | Log | Step result |
| --- | --- | --- |
| Scan succeeded, gate passed or not set | `::notice` with grade, score and issue count | success |
| Score below `fail-under`, or below `failUnder` from the project config | `::error` "VibeCode QA quality gate — Score N is below the minimum M (set by …)" | failure |
| The CLI failed for any other reason (install failure, crash, no report) | `::error` "VibeCode QA failed — … This is a scan failure, not a quality-gate result" | failure |
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
on that commit, tags an immutable `vX.Y.Z`, publishes a GitHub release, and moves `v1`
forward to the same commit. Version tags are never moved or deleted, and nothing is tagged
from a developer machine.

[CLI pin drift](.github/workflows/cli-pin-drift.yml) checks every Monday whether a newer
CLI minor has been published, and opens an issue when the `cli-version` default is behind.
Moving the default is a release, because it can change every `@v1` user's scores.

## Licence

MIT. See [LICENSE](LICENSE).
