/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Whether a title still runs, in one line: a bundle started through
 * `game.mjs` a few times with the same flags, and what each run reached, how
 * many frames it drew and at what pace, what the engine did not do, whether
 * its sound reached the mixer. For a stream of commits that each say nothing
 * about one program, run before and after: a broken contract shows as a run
 * that stops short, an import nothing claims, or frames that got slower beyond
 * the runs' own spread.
 *
 *   node tools/cdp_test/smoke.mjs <bundle-id> [--runs 3] [--run-seconds 240] [--wait S]
 *       [--checkout DIR] [--against FILE] [--json FILE] [-- game.mjs flags...]
 *
 * The title's part is data beside its bundle, never code here: the route's
 * `args` (`bundles/<id>/route.json`, as `game.mjs --route` reads it) take it
 * where it plays, and its `smoke` says what reaching there looks like -- a
 * file the program writes (`log`, a guest path) and the lines in it that mark
 * each step (`milestones`, `{ name, match }`, a regular expression per line),
 * in order. Without them a run is judged by its frames alone.
 *
 * `--checkout DIR` runs another checkout's engine and harness with this
 * tool's bundle (linked into it), which is how `git bisect run` uses it: the
 * bisect moves that checkout and this tool stays where it is, named by its
 * full path (`git -C DIR bisect run node $PWD/tools/cdp_test/smoke.mjs <id>
 * --checkout DIR --against good.json`). Exit 0 is good, 1 is a run that broke
 * or, with `--against` (an earlier run's JSON), one worse than that run beyond
 * its own spread, and 125 is not measured -- no bundle, no harness in that
 * checkout -- which bisect skips. The frame time is the gap between presents
 * once the load is over (the last stall of 1.5 s or more in the first two
 * thirds of the run, as `frame-span.mjs` takes it), so a load does not weigh
 * on it.
 *
 * One summary line, then the JSON report's path; the report lands in
 * `reports/` as `smoke-<stamp>.json` (and at `--json FILE`), with every run's
 * raw values and the conditions it ran under.
 */

import { spawn, execFileSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, symlinkSync, writeFileSync }
    from 'node:fs';
import { createRequire } from 'node:module';
import { cpus, platform, release } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOL_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)));
const REPO_ROOT = resolve(TOOL_ROOT, '..', '..');
const REPORTS_DIR = join(TOOL_ROOT, 'reports');

/** Exit code `git bisect run` reads as "this commit cannot be tested". */
const NOT_MEASURED = 125;

/** A present gap this long is a load, not a frame. */
const STALL_MS = 1500;

/** Frames let pass after the load before the frame time is taken. */
const SETTLE_FRAMES = 30;

/** @param {string[]} argv */
function parse(argv){
    const split = argv.indexOf('--');
    const own = split === -1 ? argv : argv.slice(0, split);
    /** @param {string} flag */
    const value = flag=>(own.includes(flag) ? own[own.indexOf(flag) + 1] : null);
    const runSeconds = Number(value('--run-seconds') ?? 240);
    return {
        id: own.find((argument, at)=>!argument.startsWith('--')
            && !own[at - 1]?.startsWith('--')) ?? null,
        runs: Number(value('--runs') ?? 3),
        runSeconds,
        // The report's read-back of the last frame waits for every frame queued
        // before it, which on a software adapter is minutes past the run.
        wait: Number(value('--wait') ?? runSeconds + 300),
        checkout: resolve(value('--checkout') ?? REPO_ROOT),
        against: value('--against'),
        json: value('--json'),
        extra: split === -1 ? [] : argv.slice(split + 1),
    };
}

/** @param {number[]} values @param {number} share */
const quantile = (values, share)=>{
    const sorted = [...values].sort((left, right)=>left - right);
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * share))];
};

/** @param {number | null} value @param {number} [digits] */
const say = (value, digits = 1)=>(value === null ? 'not measured' : value.toFixed(digits));

/**
 * The lines under a heading of the report, up to the blank line that ends it.
 *
 * @param {string} text @param {RegExp} heading
 */
function section(text, heading){
    const lines = text.split('\n');
    const at = lines.findIndex(line=>heading.test(line));
    if (at === -1)
    {
        return [];
    }
    const end = lines.findIndex((line, index)=>index > at && line.trim() === '');
    return lines.slice(at + 1, end === -1 ? undefined : end).map(line=>line.trim());
}

/**
 * The gaps between presents once the load is over.
 *
 * @param {number[]} times  Each present's wall-clock milliseconds.
 */
function steadyFrames(times){
    let loaded = 0;
    for (let i = 1; i < times.length * 2 / 3; i++)
    {
        if (times[i] - times[i - 1] >= STALL_MS)
        {
            loaded = i;
        }
    }
    const from = Math.min(loaded + SETTLE_FRAMES, times.length);
    const gaps = times.slice(from + 1).map((at, i)=>at - times[from + i]);
    if (gaps.length < 2)
    {
        return { from, frames: gaps.length, medianMs: null, p10Ms: null, p90Ms: null, gaps };
    }
    return { from, frames: gaps.length, medianMs: quantile(gaps, 0.5),
        p10Ms: quantile(gaps, 0.1), p90Ms: quantile(gaps, 0.9), gaps };
}

/**
 * What one run of `game.mjs` said, read off its output and the files it left.
 *
 * @param {string} output  Its stdout and stderr.
 * @param {{ log?: string, milestones?: { name: string, match: string }[] }} smoke
 * @param {number} code  Its exit code.
 */
function readRun(output, smoke, code){
    const number = (/** @type {RegExp} */ pattern)=>{
        const found = output.match(pattern);
        return found ? Number(found[1]) : null;
    };
    const reportPath = output.match(/^report:\s+(\S+)/m)?.[1] ?? null;
    const harnessFailed = output.match(/^game scenario failed: (.*)$/m)?.[1] ?? null;
    const stopped = output.match(/^stopped: (.*)$/m)?.[1] ?? null;
    const audio = output.match(/^ {2}audio \[\w+\] (.*)$/m)?.[1] ?? '';
    const audioNumber = (/** @type {string} */ name)=>{
        const found = audio.match(new RegExp(`(?:^| )${name}=(\\d+)`));
        return found ? Number(found[1]) : null;
    };
    const unbound = number(/^(\d+) imports nothing claimed:/m) ?? 0;
    const errors = [
        ...section(output, /^errors -- what the engine did not do:/),
        ...unbound > 0 ? section(output, /^\d+ imports nothing claimed:/)
            .map(line=>`unbound: ${line}`) : [],
        ...section(output, /^asked for by name at run time and not found:/)
            .map(line=>`missing: ${line}`),
        // What the page threw, printed after the screenshot's line.
        ...output.split('\n').filter(line=>/^(exception|page error|console error):/i.test(line)),
        ...harnessFailed ? [`harness: ${harnessFailed}`] : [],
    ];
    const stamp = reportPath?.match(/game-(.+)\.txt$/)?.[1] ?? null;
    // Beside the report, in whichever checkout's harness wrote it.
    const sibling = (/** @type {string} */ suffix)=>(stamp === null || reportPath === null ? null
        : join(dirname(reportPath), `game-${stamp}-${suffix}`));
    const presentsPath = sibling('presents.json');
    const times = presentsPath && existsSync(presentsPath)
        ? JSON.parse(readFileSync(presentsPath, 'utf8')) : [];
    // The program's own log, saved beside the report as game.mjs names it.
    const logPath = smoke.log ? sibling(smoke.log.replace(/[\\/:]+/g, '_')) : null;
    const log = logPath && existsSync(logPath) ? readFileSync(logPath, 'latin1') : null;
    const milestones = (smoke.milestones ?? []).map(one=>({ name: one.name,
        reached: log !== null && new RegExp(one.match, 'm').test(log) }));
    const instructions = number(/ran for \d+ms, (\d+) guest instructions/);
    const frames = number(/^ {2}frames presented: (\d+)/m);
    const furthest = milestones.findLast(one=>one.reached)?.name
        ?? ((frames ?? 0) > 0 ? 'presented' : (instructions ?? 0) > 0 ? 'started' : 'nothing');
    const steady = steadyFrames(times);
    return {
        code,
        report: reportPath,
        stopped: harnessFailed ?? stopped,
        // A run given --run-seconds ends at the cap; anything else ended it.
        crashed: harnessFailed !== null || stopped === null
            || !/did not finish within \d+ ms/.test(stopped),
        reached: furthest,
        milestones,
        adapter: output.match(/^ {2}adapter: (.*)$/m)?.[1] ?? null,
        ranMs: number(/ran for (\d+)ms/),
        instructions,
        turns: number(/^ {2}kernel \[\w+\] .*?\bturns=(\d+)/m),
        frames,
        presents: presentsPath,
        steady: { from: steady.from, frames: steady.frames, medianMs: steady.medianMs,
            p10Ms: steady.p10Ms, p90Ms: steady.p90Ms },
        errors,
        messages: section(output, /^messages -- what it did otherwise than Windows:/),
        logWarnings: log === null ? null
            : [...new Set(log.split('\n').filter(line=>/^WARNING:/.test(line)))],
        logPath: log === null ? null : logPath,
        sound: { fedBytes: audioNumber('fedBytes'), produced: audioNumber('produced'),
            consumed: audioNumber('consumed'), starvedBlocks: audioNumber('starvedBlocks') },
    };
}

/**
 * What is wrong with a run on its own: anything here fails it.
 *
 * @param {ReturnType<typeof readRun>} run
 */
function problems(run){
    return [
        ...run.crashed ? [`ended: ${run.stopped ?? 'no answer'}`] : [],
        ...run.milestones.filter(one=>!one.reached).map(one=>`not reached: ${one.name}`),
        ...(run.frames ?? 0) === 0 ? ['no frame presented'] : [],
        ...run.errors.map(line=>`error: ${line}`),
        ...(run.sound.fedBytes ?? 0) === 0 ? ['no sound reached the mixer'] : [],
    ];
}

/** @param {number[]} values */
const median = values=>(values.length === 0 ? null : quantile(values, 0.5));

/**
 * The runs folded into what a line can carry.
 *
 * @param {(ReturnType<typeof readRun> & { wallSeconds: number })[]} runs
 */
function summarise(runs){
    const medians = runs.map(run=>run.steady.medianMs).filter(value=>value !== null);
    const pooled = runs.flatMap(run=>[run.steady.p10Ms, run.steady.p90Ms])
        .filter(value=>value !== null);
    return {
        reached: runs.map(run=>run.reached),
        frames: runs.map(run=>run.frames),
        frameMs: {
            median: median(/** @type {number[]} */ (medians)),
            runsLow: medians.length > 0 ? Math.min(.../** @type {number[]} */ (medians)) : null,
            runsHigh: medians.length > 0 ? Math.max(.../** @type {number[]} */ (medians)) : null,
            p10: pooled.length > 0 ? Math.min(.../** @type {number[]} */ (pooled)) : null,
            p90: pooled.length > 0 ? Math.max(.../** @type {number[]} */ (pooled)) : null,
        },
        instructions: median(runs.map(run=>run.instructions ?? 0)),
        turns: median(runs.map(run=>run.turns ?? 0)),
        errors: [...new Set(runs.flatMap(run=>run.errors))],
        fedBytes: median(runs.map(run=>run.sound.fedBytes ?? 0)),
        wallSeconds: median(runs.map(run=>run.wallSeconds)),
    };
}

/**
 * Worse than an earlier report beyond that report's own spread: a run that
 * stopped short of where all of its runs got, an error none of them had, or a
 * frame time past its slowest run by more than its runs differed (at least 5 %).
 *
 * @param {ReturnType<typeof summarise>} now @param {any} before
 */
function regressions(now, before){
    const found = [];
    const order = (/** @type {string[]} */ names, /** @type {string} */ name)=>names.indexOf(name);
    const names = ['nothing', 'started', 'presented',
        ...(before.milestones ?? [])];
    const reachedBefore = Math.min(...before.summary.reached.map((/** @type {string} */ name)=>
        order(names, name)));
    const reachedNow = Math.min(...now.reached.map(name=>order(names, name)));
    if (reachedNow < reachedBefore)
    {
        found.push(`reached ${now.reached.join('/')} where ${before.commit.slice(0, 8)} reached`
            + ` ${before.summary.reached.join('/')}`);
    }
    for (const error of now.errors)
    {
        if (!before.summary.errors.includes(error))
        {
            found.push(`new error: ${error}`);
        }
    }
    const was = before.summary.frameMs;
    if (now.frameMs.median !== null && was.median !== null)
    {
        const allowed = Math.max(was.runsHigh - was.runsLow, was.median * 0.05);
        if (now.frameMs.median > was.runsHigh + allowed)
        {
            found.push(`frame ${now.frameMs.median.toFixed(1)} ms against ${was.median.toFixed(1)}`
                + ` (its runs ${was.runsLow.toFixed(1)}-${was.runsHigh.toFixed(1)})`);
        }
    }
    return found;
}

/**
 * The browser the harness launches: the one it finds itself, or Playwright's
 * Chromium where that is all a machine has.
 *
 * @returns {Record<string, string>}
 */
function browserEnvironment(){
    if (process.env.CDP_TEST_CHROME || process.env.CHROME_BIN)
    {
        return {};
    }
    try
    {
        const playwright = createRequire(import.meta.url)('playwright');
        const path = playwright.chromium.executablePath();
        return existsSync(path) ? { CDP_TEST_CHROME: path } : {};
    }
    catch {
        return {};
    }
}

/** @param {string} directory */
function commitOf(directory){
    try
    {
        const head = execFileSync('git', ['-C', directory, 'rev-parse', 'HEAD'],
            { encoding: 'utf8' }).trim();
        const dirty = execFileSync('git', ['-C', directory, 'status', '--porcelain',
            '--untracked-files=no'], { encoding: 'utf8' }).trim() !== '';
        return { head, dirty };
    }
    catch {
        return { head: 'not recorded', dirty: false };
    }
}

/**
 * One run of the harness, its output into a file: it exits as soon as it has
 * printed, and a pipe would lose the end of a long report, a file does not.
 *
 * @param {string} game @param {string[]} args @param {string} cwd
 * @param {Record<string, string>} env @param {string} logPath
 * @returns {Promise<{ output: string, code: number }>}
 */
function runGame(game, args, cwd, env, logPath){
    const out = openSync(logPath, 'w');
    return new Promise(done=>{
        const child = spawn(process.execPath, [game, ...args], { cwd,
            env: { ...process.env, ...env }, stdio: ['ignore', out, out] });
        child.on('close', code=>{
            closeSync(out);
            done({ output: readFileSync(logPath, 'utf8'), code: code ?? 1 });
        });
    });
}

/** @param {any} report @param {string | null} extraPath */
function save(report, extraPath){
    mkdirSync(REPORTS_DIR, { recursive: true });
    const path = join(REPORTS_DIR, `smoke-${report.stamp}.json`);
    const text = `${JSON.stringify(report, null, 2)}\n`;
    writeFileSync(path, text);
    if (extraPath)
    {
        writeFileSync(extraPath, text);
    }
    return path;
}

const options = parse(process.argv.slice(2));
if (!options.id)
{
    console.error('usage: node tools/cdp_test/smoke.mjs <bundle-id> [--runs 3] [--run-seconds 240]'
        + ' [--checkout DIR] [--against FILE] [--json FILE] [-- game.mjs flags...]');
    process.exit(2);
}
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const bundleDir = join(REPO_ROOT, 'bundles', options.id);
const commit = commitOf(options.checkout);
const game = join(options.checkout, 'tools', 'cdp_test', 'game.mjs');
const absent = !existsSync(join(bundleDir, 'bundle.btl'))
    || !existsSync(join(bundleDir, 'manifest.json'))
    ? `no bundle at ${bundleDir}` : !existsSync(game) ? `no harness at ${game}` : null;
if (absent !== null)
{
    const path = save({ tool: 'smoke', stamp, id: options.id, commit: commit.head,
        measured: false, reason: absent }, options.json);
    console.log(`smoke ${options.id} ${commit.head.slice(0, 8)}: not measured -- ${absent}`);
    console.log(`json: ${path}`);
    process.exit(NOT_MEASURED);
}

const manifest = JSON.parse(readFileSync(join(bundleDir, 'manifest.json'), 'utf8'));
const routePath = join(bundleDir, 'route.json');
const route = existsSync(routePath) ? JSON.parse(readFileSync(routePath, 'utf8')) : {};
const smoke = route.smoke ?? {};
// Another checkout's harness looks for the bundle in its own tree.
const theirs = join(options.checkout, 'bundles', options.id);
if (!existsSync(theirs))
{
    mkdirSync(join(options.checkout, 'bundles'), { recursive: true });
    symlinkSync(bundleDir, theirs, 'dir');
}
const args = [options.id, '--worker', '--run-seconds', String(options.runSeconds),
    '--wait', String(options.wait), ...route.args ?? [], ...options.extra];
const env = browserEnvironment();
mkdirSync(REPORTS_DIR, { recursive: true });

const runs = [];
for (let index = 0; index < options.runs; index++)
{
    const started = Date.now();
    const logPath = join(REPORTS_DIR, `smoke-${stamp}-run${index + 1}.log`);
    const { output, code } = await runGame(game, args, options.checkout, env, logPath);
    const run = { ...readRun(output, smoke, code), wallSeconds: (Date.now() - started) / 1000,
        output: logPath };
    runs.push({ ...run, problems: problems(run) });
    console.log(`  run ${index + 1}: reached ${run.reached},`
        + ` ${run.frames ?? 'not measured'} frames, frame ${say(run.steady.medianMs)} ms,`
        + ` ${run.errors.length} errors, ${Math.round(run.wallSeconds)} s`);
}

const summary = summarise(runs);
const before = options.against ? JSON.parse(readFileSync(options.against, 'utf8')) : null;
const worse = before?.measured ? regressions(summary, before) : [];
const failed = [...new Set(runs.flatMap(run=>run.problems))];
const report = {
    tool: 'smoke',
    stamp,
    id: options.id,
    measured: true,
    commit: commit.head,
    dirty: commit.dirty,
    checkout: options.checkout,
    bundle: { sha256: manifest.bundle?.sha256 ?? 'not recorded',
        bytes: manifest.bundle?.bytes ?? 'not recorded' },
    args,
    milestones: (smoke.milestones ?? []).map((/** @type {any} */ one)=>one.name),
    conditions: {
        node: process.version, os: `${platform()} ${release()}`, cores: cpus().length,
        browser: env.CDP_TEST_CHROME ?? process.env.CDP_TEST_CHROME ?? process.env.CHROME_BIN
            ?? 'the harness default',
        adapter: runs[0]?.adapter ?? 'not recorded',
        gpuDriver: 'not recorded', powerPlan: 'not recorded',
    },
    summary,
    runs,
    against: before?.measured ? { commit: before.commit, stamp: before.stamp } : null,
    problems: failed,
    regressions: worse,
    ok: failed.length === 0 && worse.length === 0,
};
const path = save(report, options.json);
const frame = summary.frameMs;
console.log(`smoke ${options.id} ${commit.head.slice(0, 8)}${commit.dirty ? '+' : ''}`
    + ` (${runs.length} runs, ${options.runSeconds} s): reached ${summary.reached.join('/')},`
    + ` frames ${summary.frames.join('/')}, frame ms median ${say(frame.median)}`
    + ` (runs ${say(frame.runsLow)}-${say(frame.runsHigh)}, p10 ${say(frame.p10)}`
    + ` p90 ${say(frame.p90)}), ${say(summary.instructions === null ? null
        : summary.instructions / 1e9)} G instr, ${summary.turns ?? 'not measured'} turns,`
    + ` ${summary.errors.length} errors, sound ${say(summary.fedBytes === null ? null
        : summary.fedBytes / 2 ** 20)} MiB fed, wall ${say(summary.wallSeconds, 0)} s;`
    + ` bundle ${String(report.bundle.sha256).slice(0, 8)}; ${report.ok ? 'ok'
        : `FAILED: ${[...failed, ...worse].join('; ')}`}`);
console.log(`json: ${path}`);
process.exit(report.ok ? 0 : 1);
