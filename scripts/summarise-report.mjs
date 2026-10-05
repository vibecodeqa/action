// Turns one scan into step outputs and a step result (vibecodeqa/action#3).
//
// Reads `.vibe-check/report.json`, which the CLI writes on every scan, instead of
// parsing stdout: stdout and stderr belong to the log, and anything npm prints
// there (deprecation and config warnings) used to turn the outputs into
// `score=0`, `grade=?`.
//
// Contract: the report shape is defined by @vibecodeqa/schema. This script reads
// only `score`, `grade` and `checks[].issues`.
//
// Environment:
//   VCQA_EXIT        exit code of the CLI run (required)
//   VCQA_SENTINEL    file touched immediately before the CLI ran; a report older
//                    than it is a leftover, not this scan's result (required)
//   VCQA_FAIL_UNDER  the action's `fail-under` input ("0" = defer to project config)
//   VCQA_REPORT      report path, default `.vibe-check/report.json`
//   GITHUB_OUTPUT    step output file, set by the runner
//
// Exit status: 0 when the CLI exited 0 and wrote a valid report; otherwise
// non-zero, with a log line that says whether the quality gate failed or the
// scan itself did.

import { appendFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const reportPath = process.env.VCQA_REPORT || join(".vibe-check", "report.json");
const reportDir = reportPath.replace(/[/\\]report\.json$/, "") || ".vibe-check";
const cliExit = Number.parseInt(process.env.VCQA_EXIT ?? "", 10);
const sentinel = process.env.VCQA_SENTINEL;
const failUnderInput = Number.parseInt(process.env.VCQA_FAIL_UNDER || "0", 10) || 0;

if (!Number.isInteger(cliExit) || !sentinel) {
	console.log("::error title=VibeCode QA action error::summarise-report needs VCQA_EXIT and VCQA_SENTINEL");
	process.exit(1);
}

/** Read this scan's report, or null if the CLI did not produce a usable one. */
function readFreshReport() {
	if (!existsSync(reportPath)) return null;
	if (existsSync(sentinel) && statSync(reportPath).mtimeMs < statSync(sentinel).mtimeMs) return null;
	try {
		const report = JSON.parse(readFileSync(reportPath, "utf8"));
		if (typeof report?.score !== "number" || !Number.isFinite(report.score)) return null;
		return report;
	} catch {
		return null;
	}
}

/**
 * The threshold the CLI applied when no `--fail-under` was passed. Mirrors the
 * CLI's loadConfig (cli `src/config.ts`): `.vcqa.json` wins outright — even if it
 * is unparseable, in which case there is no threshold — else package.json "vcqa".
 */
function configFailUnder(cwd) {
	const configPath = join(cwd, ".vcqa.json");
	if (existsSync(configPath)) {
		try {
			const raw = JSON.parse(readFileSync(configPath, "utf8"));
			return typeof raw?.failUnder === "number" ? { value: raw.failUnder, source: ".vcqa.json failUnder" } : null;
		} catch {
			return null;
		}
	}
	try {
		const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8"));
		const value = pkg?.vcqa?.failUnder;
		return typeof value === "number" ? { value, source: 'package.json "vcqa".failUnder' } : null;
	} catch {
		return null;
	}
}

function setOutput(name, value) {
	if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
	else console.log(`${name}=${value}`);
}

const report = readFreshReport();

if (report) {
	// Validated, not passed through: it goes into a workflow command and $GITHUB_OUTPUT.
	const grade = typeof report.grade === "string" && /^[A-F]$/.test(report.grade) ? report.grade : "";
	const issues = Array.isArray(report.checks)
		? report.checks.reduce((n, c) => n + (Array.isArray(c?.issues) ? c.issues.length : 0), 0)
		: 0;
	setOutput("score", report.score);
	setOutput("grade", grade);
	setOutput("issues", issues);
	setOutput("report-path", reportDir);

	if (cliExit === 0) {
		console.log(`::notice title=VibeCode QA::${grade} ${report.score}/100 (${issues} issues)`);
		process.exit(0);
	}

	const threshold =
		failUnderInput > 0 ? { value: failUnderInput, source: "the fail-under input" } : configFailUnder(process.cwd());
	// The CLI's quality gate exits exactly 1. Any other code (137 from an OOM
	// kill, say) is a scan failure even if the score happens to be low.
	if (cliExit === 1 && threshold && threshold.value > 0 && report.score < threshold.value) {
		console.log(
			`::error title=VibeCode QA quality gate::Score ${report.score} is below the minimum ${threshold.value} (set by ${threshold.source}).`,
		);
		process.exit(1);
	}
}

if (cliExit === 0) {
	// Exit 0 with no report is still a failure: a gate that cannot read its result is not a gate.
	console.log(
		`::error title=VibeCode QA failed::@vibecodeqa/cli exited 0 but wrote no valid report at ${reportPath}. See the scan log above.`,
	);
	process.exit(1);
}

console.log(
	`::error title=VibeCode QA failed::@vibecodeqa/cli exited ${cliExit}${report ? "" : " without writing a report"}. This is a scan failure, not a quality-gate result — see the scan log above.`,
);
process.exit(cliExit > 0 && cliExit < 256 ? cliExit : 1);
