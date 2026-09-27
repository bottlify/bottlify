/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Runs Wine's conformance tests as guest programs and counts where the engine
 * answers differently from Windows.
 *
 * Wine's tests are Win32 programs: `winetest.exe` carries one `<dll>_test.exe`
 * per library as a TESTRES resource, and each of those runs one named test per
 * invocation, printing `file.c:line: Test failed: ...` for every check that did
 * not hold and a closing `N tests executed (...)` line. A check that holds on
 * Windows and fails here is a divergence in our recreation of that contract,
 * which is exactly what this measures -- node only, no browser, on the default
 * engine unless told otherwise.
 *
 * The binaries are LGPL and stay local: `winetest.exe` lives in
 * `to_install/wine-tests/` (ignored), the tests are lifted out of it into the
 * same folder, and nothing of them goes into the repository, a bundle or dist.
 * The official i386 build is the `build-daily-winetest` job artifact of Wine's
 * own CI (`winetest.exe`), or a mingw i686 cross build of Wine's tree.
 * `--fetch` downloads the latest such artifact into that folder (WINETEST_URL);
 * it is a daily build, so the tests it carries move with Wine's tree, and the
 * build a report names is the one to compare against.
 *
 * The test programs are run directly, as `winetest.exe` itself runs them -- one
 * process per `<dll>_test.exe <test>` -- and each in a child node process of
 * its own: a test that hangs the engine inside a turn is ended from outside, and
 * a host exception is a result rather than the end of the run.
 *
 *     node tools/wine-tests.mjs --fetch
 *     node tools/wine-tests.mjs ddraw:ddraw7 kernel32:file msvcrt
 *     node tools/wine-tests.mjs --preset games --baseline <earlier report.json>
 *
 * A bare library name runs every test its program lists. Options:
 *
 *     --winetest <path>   the winetest.exe to take tests from
 *     --fetch             download winetest.exe first (again, if one is there)
 *     --winetest-url <u>  where --fetch takes it from (WINETEST_URL by default)
 *     --preset games      the libraries games lean on (PRESETS below)
 *     --timeout <s>       wall seconds per test (default 120)
 *     --jobs <n>          tests run at once (default half the processors)
 *     --failures <n>      failed checks listed per test in the markdown (default 20)
 *     --out <dir>         where report.json and report.md go
 *     --baseline <json>   an earlier report to compare against, before -> after
 *     --engine <name>     the execution engine (the translator by default)
 *     --cork-config <json>  the translator's settings, over the ones used here
 *     --reference <engine>  runs each test that did not pass again on this engine
 *                         (`emulator`) and sets apart what fails only on the first
 *
 * The translator is built to run games fast rather than to be every corner of
 * the x86 architecture, so a check that fails only under it is a different kind
 * of finding from one that fails on the reference processor too: the first is
 * the translator's, and may not matter to any game; the second is the Win32
 * layers', whichever engine runs them. `--reference` measures which is which.
 */

import { fork } from 'node:child_process';
import { availableParallelism } from 'node:os';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = new URL('../', import.meta.url);
const PREBUILT = new URL('modules/core/vendor/prebuilt/', ROOT);
const LOCAL = new URL('to_install/wine-tests/', ROOT);

/** The i386 winetest.exe of Wine's daily CI build, the newest one. */
export const WINETEST_URL = 'https://gitlab.winehq.org/wine/wine/-/jobs/artifacts/master/raw/'
    + 'winetest.exe?job=build-daily-winetest';

/**
 * The libraries games call into, and the tests of each that exercise what they
 * call. `null` is every test the library's program lists.
 *
 * @type {Record<string, [string, string[] | null][]>}
 */
export const PRESETS = {
    games: [
        ['ddraw', null],
        ['dsound', null],
        ['d3d8', null],
        ['d3d9', null],
        ['dinput', null],
        ['winmm', null],
        ['kernel32', ['file', 'process', 'sync', 'thread', 'heap', 'virtual', 'locale']],
        ['user32', ['win', 'msg', 'class', 'dialog', 'input']],
        ['gdi32', ['bitmap', 'dc', 'font']],
        ['msvcrt', null],
        ['advapi32', ['registry', 'security']],
        ['ole32', null],
        ['oleaut32', ['typelib', 'vartest']],
    ],
};

/**
 * @typedef {Object} FailedCheck
 * @property {string} file
 * @property {number} line
 * @property {string} kind     `Test failed`, or a todo that unexpectedly held
 * @property {string} message
 */

/**
 * @typedef {Object} ParsedOutput
 * @property {{ executed: number, todo: number, flaky: number, failures: number,
 *     skipped: number } | null} summary  the program's closing count, when it got there
 * @property {FailedCheck[]} failed
 * @property {number} skips
 * @property {string[]} exceptions   the program's own "unhandled exception" lines
 * @property {string | null} lastSeen  the last check before an exception, as file:line
 * @property {boolean} missingTest   the program has no test of that name
 * @property {string[]} names        the test names a `--list` printed
 */

const SUMMARY = /^([0-9a-f]+):(\S+?):[0-9.]* (\d+) tests executed \((\d+) marked as todo, (?:(\d+) as flaky, )?(\d+) failures?\), (\d+) skipped\./;
/** The identifier the engine gives the first process, the one a test runs in. */
const MAIN_PROCESS = 0x1000;
const CHECK = /^(.+?):(\d+):[0-9.]* (Test failed|Test succeeded inside todo block|Test succeeded inside flaky todo block): (.*)$/;
const SKIPPED = /^(.+?):(\d+):[0-9.]* Tests skipped: /;
const EXCEPTION = /^[0-9a-f]+:\S+?:[0-9.]* unhandled exception [0-9a-f]{8} at /;
const LAST_SEEN = /^(.+?):(\d+): this is the last test seen before the exception/;

/**
 * Reads what a test program printed.
 *
 * The text is taken whole rather than as it arrived: the program's standard
 * output is unbuffered, so one line reaches the host as several writes.
 *
 * @param {string} text
 * @param {string} [test]  whose closing count to take, when a child process of
 *     the test printed one of its own
 * @param {number} [mainProcess]  the identifier of the process the test runs
 *     in: a child runs the same test under the same name, and its closing
 *     count is never the test's, even when the test itself never got to its own
 * @returns {ParsedOutput}
 */
export function parseOutput(text, test, mainProcess){
    /** @type {ParsedOutput} */
    const parsed = { summary: null, failed: [], skips: 0, exceptions: [], lastSeen: null,
        missingTest: false, names: [] };
    let listing = false;
    for (const raw of text.split('\n'))
    {
        const line = raw.replace(/\r$/, '');
        if (listing)
        {
            const name = line.trim();
            if (/^\S+$/.test(name))
            {
                parsed.names.push(name);
                continue;
            }
            listing = false;
        }
        if (line.startsWith('Valid test names:'))
        {
            listing = true;
            continue;
        }
        const summary = SUMMARY.exec(line);
        if (summary && mainProcess !== undefined && parseInt(summary[1], 16) !== mainProcess)
        {
            continue;
        }
        if (summary && (test === undefined || summary[2] === test || parsed.summary === null))
        {
            parsed.summary = {
                executed: Number(summary[3]),
                todo: Number(summary[4]),
                flaky: Number(summary[5] ?? 0),
                failures: Number(summary[6]),
                skipped: Number(summary[7]),
            };
            continue;
        }
        const check = CHECK.exec(line);
        if (check)
        {
            parsed.failed.push({ file: check[1], line: Number(check[2]), kind: check[3],
                message: check[4] });
            continue;
        }
        if (SKIPPED.test(line))
        {
            parsed.skips++;
            continue;
        }
        if (EXCEPTION.test(line))
        {
            parsed.exceptions.push(line);
            continue;
        }
        const lastSeen = LAST_SEEN.exec(line);
        if (lastSeen)
        {
            parsed.lastSeen = `${lastSeen[1]}:${lastSeen[2]}`;
            continue;
        }
        if (/^Fatal: test '.*' does not exist\./.test(line))
        {
            parsed.missingTest = true;
        }
    }
    return parsed;
}

/**
 * @typedef {Object} ChildResult
 * @property {string} output
 * @property {number | null} exitCode
 * @property {{ reason: string, message: string, code?: string, stack?: string,
 *     trace?: string } | null} error
 * @property {boolean} killed    ended from outside after the wall budget
 * @property {string | null} died  how the child process ended, when it ended unasked
 * @property {number} wallMs
 * @property {string[]} unimplemented
 * @property {string[]} divergences
 * @property {string[]} missing
 * @property {string[]} unresolved
 */

/**
 * The class of one run's result.
 *
 * `engine-crash` is the engine failing in itself -- a host exception, a child
 * process that died -- as against the guest failing in a way Windows would
 * have shown too. A guest fault the engine stopped on is `guest-fault`: on
 * Windows the program's own filter would have printed it and ended the
 * process. `unimplemented` is a call into an import with no implementation.
 *
 * @param {ChildResult} result
 * @param {ParsedOutput} parsed
 * @returns {string}
 */
export function classify(result, parsed){
    if (result.killed)
    {
        return 'timeout';
    }
    if (result.died !== null)
    {
        return 'engine-crash';
    }
    if (result.error)
    {
        switch (result.error.reason)
        {
            case 'runaway':
                return 'timeout';
            case 'deadlock':
            case 'no-threads':
                return 'deadlock';
            case 'guest-fault':
                // A call into a function nobody wrote stops the machine rather
                // than answering wrongly: a gap, not a wrong answer.
                return /^unimplemented import /.test(result.error.message)
                    ? 'unimplemented' : 'guest-fault';
            default:
                return result.error.code === 'GUEST_FAULT' ? 'guest-fault' : 'engine-crash';
        }
    }
    if (parsed.exceptions.length > 0)
    {
        return 'guest-exception';
    }
    if (parsed.missingTest)
    {
        return 'no-such-test';
    }
    if (!parsed.summary)
    {
        return 'no-summary';
    }
    return parsed.summary.failures > 0 ? 'fail' : 'pass';
}

/**
 * @typedef {Object} TestReport
 * @property {string} module
 * @property {string} test
 * @property {string} status
 * @property {number | null} executed
 * @property {number} failures   the closing count, or the failed checks seen before the end
 * @property {number | null} todo
 * @property {number} skipped
 * @property {number | null} exitCode
 * @property {number} wallMs
 * @property {FailedCheck[]} failed
 * @property {string[]} exceptions
 * @property {string | null} lastSeen
 * @property {ChildResult['error']} error
 * @property {string | null} died
 * @property {string[]} unimplemented
 * @property {string[]} divergences
 * @property {string[]} missing
 * @property {string} tail       the last lines the program printed
 * @property {ReferenceRun | null} [reference]  the same test on the reference engine
 */

/**
 * @typedef {Object} ReferenceRun
 * @property {string} engine
 * @property {string} status
 * @property {number | null} executed
 * @property {number} failures
 * @property {FailedCheck[]} onlyHere  checks that failed on the tested engine and
 *     not on this one, by file:line
 * @property {boolean} statusOnlyHere  the run ended worse on the tested engine: it
 *     hung or crashed the engine where the reference stopped or finished, stopped
 *     where it finished, or failed where it passed
 */

/**
 * @param {string} module @param {string} test @param {ChildResult} result
 * @returns {TestReport}
 */
export function summarise(module, test, result){
    const parsed = parseOutput(result.output, test, MAIN_PROCESS);
    const status = classify(result, parsed);
    return {
        module,
        test,
        status,
        executed: parsed.summary?.executed ?? null,
        failures: parsed.summary?.failures ?? parsed.failed.length,
        todo: parsed.summary?.todo ?? null,
        skipped: parsed.summary?.skipped ?? parsed.skips,
        exitCode: result.exitCode,
        wallMs: Math.round(result.wallMs),
        failed: parsed.failed,
        exceptions: parsed.exceptions,
        lastSeen: parsed.lastSeen,
        error: result.error,
        died: result.died,
        unimplemented: result.unimplemented,
        divergences: result.divergences,
        missing: result.missing,
        tail: result.output.split('\n').slice(-12).join('\n'),
    };
}

/** The runs that got to the program's closing count. */
const FINISHED = new Set(['pass', 'fail']);

/**
 * How badly a run ended, for telling which of two ended worse: a hang or the
 * engine's own failure is worse than the program stopping on something it
 * met, which is worse than finishing.
 *
 * @param {string} status
 */
const endingRank = status=>(status === 'pass' ? 0 : status === 'fail' ? 1
    : ['timeout', 'deadlock', 'engine-crash'].includes(status) ? 3 : 2);

/**
 * What every test asks for and is meant not to find: the name a test looks up
 * to tell Wine from Windows. Its absence is what makes it hold us to Windows.
 */
const EXPECTED_MISSING = new Set(['ntdll.dll!wine_server_call']);

/**
 * Sets a test's result against the same test on the reference engine.
 *
 * A check is the translator's when its line fails here and not there: the
 * Win32 layers are the same code on both engines, and the processor is the
 * one thing that differs. A line checked in a loop counts by its line, since
 * a loop's iterations need not fail alike on both.
 *
 * @param {TestReport} tested @param {TestReport} reference @param {string} engine
 * @returns {ReferenceRun}
 */
export function againstReference(tested, reference, engine){
    const there = new Set(reference.failed.map(check=>`${check.file}:${check.line}`));
    return {
        engine,
        status: reference.status,
        executed: reference.executed,
        failures: reference.failures,
        onlyHere: tested.failed.filter(check=>!there.has(`${check.file}:${check.line}`)),
        // A hang here where the reference processor raised the exception the
        // program's own filter reported is the translator's too.
        statusOnlyHere: endingRank(tested.status) > endingRank(reference.status),
    };
}

/**
 * Finds `<module>_test.exe` among winetest's resources.
 *
 * @param {Uint8Array} winetest @param {string} module
 * @returns {Promise<Uint8Array | null>}
 */
async function extractTest(winetest, module){
    const { parsePe, rvaToFileOffset } = await import(
        '../modules/core/src/layers/loader/internal/pe.js');
    const { listResources } = await import(
        '../modules/core/src/layers/loader/internal/resources.js');
    const image = parsePe(winetest);
    const wanted = `${module}_test.exe`.toUpperCase();
    const found = listResources(winetest, image)
        .find(entry=>entry.typeName === 'TESTRES' && String(entry.name).toUpperCase() === wanted);
    if (!found)
    {
        return null;
    }
    const at = rvaToFileOffset(image, found.rva);
    return winetest.slice(at, at + found.size);
}

/**
 * The build the tests came from, as winetest names it (string resource 1).
 *
 * @param {Uint8Array} winetest
 * @returns {Promise<string | null>}
 */
async function buildId(winetest){
    const { parsePe } = await import('../modules/core/src/layers/loader/internal/pe.js');
    const { loadString } = await import('../modules/core/src/layers/loader/internal/resources.js');
    return loadString(winetest, parsePe(winetest), 1);
}

/**
 * One test program, in this process: what runs in the child.
 *
 * Everything the program prints goes to the parent as it is printed, so a
 * run ended from outside still reports how far it got.
 *
 * @param {string} exePath @param {string} test
 * @param {{ timeout: number, engine?: string, corkConfig: object }} settings
 */
async function runChild(exePath, test, settings){
    const send = (/** @type {any} */ message)=>new Promise(resolve=>{
        process.send?.(message, undefined, {}, ()=>resolve(undefined));
    });
    const { createApp } = await import('../modules/core/src/app.js');
    const { DEFAULT_ENGINE } = await import('../modules/core/src/layers/cpu/module.js');
    const executable = new Uint8Array(await readFile(exePath));
    const wasm = await readFile(new URL('v86.wasm', PREBUILT));
    const name = exePath.split(/[\\/]/).pop() ?? 'test.exe';
    const imagePath = `C:\\winetest\\${name}`;
    const engine = settings.engine;

    /** @type {Set<string>} */
    const unimplemented = new Set();
    /** @type {Set<string>} */
    const divergences = new Set();
    /** @type {Set<string>} */
    const missing = new Set();
    const began = performance.now();
    /** @type {any} */
    let app = null;
    /** @type {number | null} */
    let exitCode = null;
    /** @type {any} */
    let error = null;
    try
    {
        app = await createApp({
            executable,
            v86: {
                moduleUrl: new URL('libv86.mjs', PREBUILT).href,
                wasmBytes: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength),
            },
            imagePath,
            commandLine: test === '' ? `"${imagePath}"` : `"${imagePath}" ${test}`,
            // The program on its own volume, where GetModuleFileName says it is:
            // a test that reads its own resources or copies itself opens it.
            files: [{ path: imagePath, bytes: executable }],
            engine,
            ...((engine ?? DEFAULT_ENGINE) === 'cork'
                ? { cork: { config: { feed: 'slice', timings: true,
                    worker: true, workerUrl: new URL(
                        'modules/cork/src/runtime/translator.worker.js', ROOT).href,
                    ...settings.corkConfig } } } : {}),
            storage: null,
        });
        app.attachLog((/** @type {number} */ stream, /** @type {string} */ text)=>
            send({ type: 'output', stream, text }));
        app.on('unimplemented', (/** @type {any} */ payload)=>unimplemented.add(payload.import));
        app.on('divergence', (/** @type {any} */ payload)=>
            divergences.add(`${payload.api}: ${payload.detail}`));
        app.on('resolved', (/** @type {any} */ asked)=>{
            if (asked.found === 0)
            {
                missing.add(`${asked.module}!${asked.name}`);
            }
        });
        exitCode = await app.run({ maxTurns: Number.MAX_SAFE_INTEGER,
            timeoutMs: settings.timeout * 1000 });
    }
    catch (e){
        const thrown = /** @type {any} */ (e);
        error = {
            reason: thrown.reason ?? 'create',
            message: String(thrown.message ?? thrown),
            code: thrown.code,
            stack: String(thrown.stack ?? '').split('\n').slice(0, 12).join('\n'),
            trace: thrown.traceText,
        };
    }
    // Waited for: the process exits next, and a message still in the channel
    // when it does is lost.
    await send({
        type: 'done',
        exitCode,
        error,
        wallMs: performance.now() - began,
        unimplemented: [...unimplemented],
        divergences: [...divergences],
        missing: [...missing],
        unresolved: app?.image?.unresolved ?? [],
    });
    try
    {
        await app?.dispose();
    }
    catch {
        // Disposing a machine that failed can fail again, and the result is sent.
    }
    process.exit(0);
}

/**
 * Runs one test program in a child process and waits for its result.
 *
 * @param {string} exePath @param {string} test
 * @param {{ timeout: number, engine?: string, corkConfig: object }} settings
 * @returns {Promise<ChildResult>}
 */
function runInChild(exePath, test, settings){
    return new Promise(resolve=>{
        const began = performance.now();
        const child = fork(fileURLToPath(import.meta.url),
            ['--child', exePath, test === '' ? '--' : test, JSON.stringify(settings)],
            { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
        let output = '';
        let stderr = '';
        /** @type {any} */
        let done = null;
        let killed = false;
        // The engine's own budget comes first and reports where the guest stood;
        // this one is for a turn that never returns to look at the clock.
        const timer = setTimeout(()=>{
            killed = true;
            child.kill('SIGKILL');
        }, (settings.timeout + 30) * 1000);
        child.stderr?.on('data', chunk=>{
            stderr = (stderr + chunk).slice(-4000);
        });
        child.on('message', (/** @type {any} */ message)=>{
            if (message.type === 'output')
            {
                output += message.text;
            }
            else if (message.type === 'done')
            {
                done = message;
            }
        });
        child.on('exit', (code, signal)=>{
            clearTimeout(timer);
            resolve({
                output,
                exitCode: done?.exitCode ?? null,
                error: done?.error ?? null,
                killed,
                died: done || killed ? null : `child exited ${signal ?? code}: `
                    + stderr.trim().split('\n').slice(-8).join('\n'),
                wallMs: done?.wallMs ?? performance.now() - began,
                unimplemented: done?.unimplemented ?? [],
                divergences: done?.divergences ?? [],
                missing: done?.missing ?? [],
                unresolved: done?.unresolved ?? [],
            });
        });
    });
}

/** @param {string[]} argv */
function parseArgs(argv){
    /** @param {string} flag @param {string | undefined} [fallback] */
    const value = (flag, fallback)=>{
        const at = argv.indexOf(flag);
        return at === -1 ? fallback : argv[at + 1];
    };
    const flags = new Set(['--winetest', '--preset', '--timeout', '--jobs', '--failures', '--out',
        '--baseline', '--engine', '--cork-config', '--reference', '--winetest-url']);
    /** @type {string[]} */
    const specs = [];
    for (let i = 0; i < argv.length; i++)
    {
        if (flags.has(argv[i]))
        {
            i++;
        }
        else if (!argv[i].startsWith('--'))
        {
            specs.push(argv[i]);
        }
    }
    return {
        winetest: value('--winetest', fileURLToPath(new URL('winetest.exe', LOCAL))),
        fetch: argv.includes('--fetch'),
        winetestUrl: value('--winetest-url', WINETEST_URL),
        preset: value('--preset'),
        timeout: Number(value('--timeout', '120')),
        jobs: Number(value('--jobs', String(Math.max(1, Math.floor(availableParallelism() / 2))))),
        failures: Number(value('--failures', '20')),
        out: value('--out'),
        baseline: value('--baseline'),
        engine: value('--engine'),
        corkConfig: JSON.parse(value('--cork-config', '{}') ?? '{}'),
        reference: value('--reference'),
        specs,
    };
}

/**
 * Downloads winetest.exe, into a file beside the destination first so that an
 * interrupted download never stands in for the program.
 *
 * @param {string} url @param {string} destination
 */
async function download(url, destination){
    console.log(`downloading ${url}`);
    const response = await fetch(url, { redirect: 'follow' });
    if (!response.ok)
    {
        throw new Error(`${url}: HTTP ${response.status} -- the CI artifact may have expired;`
            + ' pass another with --winetest-url');
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    // A page saying the artifact is gone is not a program.
    if (bytes.length < 1 << 20 || bytes[0] !== 0x4d || bytes[1] !== 0x5a)
    {
        throw new Error(`${url}: answered ${bytes.length} bytes that are not a Windows program`);
    }
    await mkdir(new URL('./', pathToFileURL(destination)), { recursive: true });
    const partial = `${destination}.partial`;
    await writeFile(partial, bytes);
    await rename(partial, destination);
    const build = await buildId(bytes);
    console.log(`${destination}: ${bytes.length} bytes, build ${build ?? 'unknown'}`);
}

/**
 * Runs `jobs` tasks at a time, in order of starting.
 *
 * @template T
 * @param {(() => Promise<T>)[]} tasks @param {number} jobs
 * @returns {Promise<T[]>}
 */
async function pool(tasks, jobs){
    /** @type {T[]} */
    const results = new Array(tasks.length);
    let next = 0;
    const worker = async()=>{
        while (next < tasks.length)
        {
            const index = next++;
            results[index] = await tasks[index]();
        }
    };
    await Promise.all(Array.from({ length: Math.min(jobs, tasks.length) }, worker));
    return results;
}

/** @param {string} text */
const cell = text=>text.replace(/\|/g, '\\|').replace(/\n/g, ' ');

/**
 * The comparison of one test against the same test in an earlier report.
 *
 * @param {TestReport} now @param {TestReport | undefined} before
 * @returns {string}
 */
function compared(now, before){
    if (!before)
    {
        return 'new';
    }
    const status = before.status === now.status ? now.status : `${before.status} -> ${now.status}`;
    return `${status}, ${before.failures} -> ${now.failures}`;
}

/**
 * @param {{ build: string | null, engine: string, started: string, tests: TestReport[] }} report
 * @param {{ failures: number, baseline: { tests: TestReport[] } | null }} options
 * @returns {string}
 */
export function markdown(report, { failures, baseline }){
    /** @param {TestReport} t */
    const key = t=>`${t.module}:${t.test}`;
    const earlier = new Map((baseline?.tests ?? []).map(t=>[key(t), t]));
    const lines = [
        `# Wine conformance tests under Bottlify`,
        '',
        `Tests from Wine build ${report.build ?? 'unknown'}, engine ${report.engine}, `
            + `started ${report.started}.`,
        '',
    ];

    /** @type {Map<string, TestReport[]>} */
    const byModule = new Map();
    for (const test of report.tests)
    {
        byModule.set(test.module, [...byModule.get(test.module) ?? [], test]);
    }
    const referenced = report.tests.find(t=>t.reference)?.reference?.engine ?? null;
    /** The failed checks of a test that are the translator's alone. @param {TestReport} t */
    const onlyHere = t=>t.reference?.onlyHere.length ?? 0;
    if (referenced)
    {
        lines.push(`Every test that did not pass ran again on the ${referenced} engine; `
            + `\`${report.engine}-only\` counts the failed checks that held there, `
            + `and \`*\` marks a run that ended worse than it did there.`, '');
    }
    lines.push('## By library', '');
    lines.push(`| library | tests | pass | executed | failures |${
        referenced ? ` ${report.engine}-only |` : ''} todo | skipped | not finished |${
        baseline ? ' failures before |' : ''}`);
    lines.push(`|---|---|---|---|---|${referenced ? '---|' : ''}---|---|---|${
        baseline ? '---|' : ''}`);
    for (const [module, tests] of byModule)
    {
        const sum = (/** @type {(t: TestReport) => number} */ pick)=>tests
            .reduce((total, t)=>total + pick(t), 0);
        const failedBefore = tests.map(t=>earlier.get(key(t)))
            .reduce((total, t)=>total + (t?.failures ?? 0), 0);
        const unfinished = tests.filter(t=>!FINISHED.has(t.status));
        lines.push(`| ${module} | ${tests.length} | ${tests.filter(t=>t.status === 'pass').length}`
            + ` | ${sum(t=>t.executed ?? 0)} | ${sum(t=>t.failures)} |${
                referenced ? ` ${sum(onlyHere)} |` : ''} ${sum(t=>t.todo ?? 0)}`
            + ` | ${sum(t=>t.skipped)} | ${unfinished.map(t=>`${t.test} (${t.status}${
                t.reference?.statusOnlyHere ? '*' : ''})`).join(', ')}`
            + ` |${baseline ? ` ${failedBefore} |` : ''}`);
    }

    lines.push('', '## By test', '');
    lines.push(`| test | status | executed | failures |${
        referenced ? ` ${report.engine}-only | on ${referenced} |` : ''}`
        + ` todo | skipped | seconds |${
            baseline ? ' before -> after |' : ''}`);
    lines.push(`|---|---|---|---|${referenced ? '---|---|' : ''}---|---|---|${
        baseline ? '---|' : ''}`);
    for (const test of report.tests)
    {
        const there = test.reference;
        lines.push(`| ${key(test)} | ${test.status}${there?.statusOnlyHere ? '*' : ''}`
            + ` | ${test.executed ?? '-'} | ${test.failures} |${referenced
                ? ` ${there ? onlyHere(test) : '-'} | ${there
                    ? `${there.status}, ${there.failures}` : '-'} |` : ''}`
            + ` ${test.todo ?? '-'} | ${test.skipped} | ${(test.wallMs / 1000).toFixed(1)} |${
                baseline ? ` ${compared(test, earlier.get(key(test)))} |` : ''}`);
    }

    const crashed = report.tests.filter(t=>t.error || t.died);
    if (crashed.length > 0)
    {
        lines.push('', '## Where the engine stopped', '');
        for (const test of crashed)
        {
            lines.push(`### ${key(test)}: ${test.status}`, '');
            lines.push('```');
            if (test.error)
            {
                lines.push(`${test.error.reason}: ${test.error.message}`);
                if (test.error.trace)
                {
                    // Where it stood and what it called last; the register dump
                    // and the stack words below that are in report.json.
                    const trace = test.error.trace.split('\n');
                    lines.push(...trace.slice(0, 4),
                        ...trace.filter(line=>/^(last calls|frame chain| {2}0x)/.test(line))
                            .slice(0, 8));
                }
                if (test.error.stack && test.status === 'engine-crash')
                {
                    lines.push(...test.error.stack.split('\n').slice(1, 8));
                }
            }
            if (test.died)
            {
                lines.push(test.died);
            }
            if (test.lastSeen)
            {
                lines.push(`last check seen: ${test.lastSeen}`);
            }
            lines.push('```', '');
        }
    }

    /**
     * A test's failed checks, the line that fails most first: one wrong answer
     * checked in a loop is one fix, and it would otherwise fill the listing.
     *
     * @param {FailedCheck[]} checks
     */
    const listChecks = checks=>{
        /** @type {Map<string, { count: number, first: FailedCheck }>} */
        const grouped = new Map();
        for (const check of checks)
        {
            const where = `${check.file}:${check.line}`;
            const held = grouped.get(where);
            if (held)
            {
                held.count++;
            }
            else
            {
                grouped.set(where, { count: 1, first: check });
            }
        }
        const top = [...grouped].sort((a, b)=>b[1].count - a[1].count).slice(0, failures);
        for (const [where, { count, first }] of top)
        {
            const kind = first.kind === 'Test failed' ? '' : `${first.kind}: `;
            lines.push(`- \`${where}\`${count > 1 ? ` (x${count})` : ''}: `
                + `${kind}${cell(first.message).slice(0, 200)}`);
        }
        if (grouped.size > top.length)
        {
            lines.push(`- ... ${grouped.size - top.length} more lines`);
        }
    };

    // What fails on the reference processor too is the Win32 layers'; what
    // fails on the tested engine alone is listed apart, below.
    lines.push('', '## Failed checks', '');
    for (const test of report.tests.filter(t=>t.failed.length > 0 || t.exceptions.length > 0))
    {
        const translator = new Set(test.reference?.onlyHere ?? []);
        const shared = test.failed.filter(check=>!translator.has(check));
        lines.push(`### ${key(test)} (${test.failures} failures${
            translator.size > 0 ? `, ${translator.size} of them ${report.engine}-only` : ''})`, '');
        listChecks(shared);
        for (const exception of test.exceptions)
        {
            lines.push(`- ${cell(exception)}${test.lastSeen ? ` (after ${test.lastSeen})` : ''}`);
        }
        lines.push('');
    }

    const translatorTests = report.tests.filter(t=>onlyHere(t) > 0 || t.reference?.statusOnlyHere);
    if (translatorTests.length > 0)
    {
        lines.push(`## Only on ${report.engine} (held on ${referenced})`, '');
        lines.push('The translator is built to run games fast, not to be the whole '
            + 'architecture: these may matter to no game, and are set apart for that.', '');
        for (const test of translatorTests)
        {
            const there = /** @type {ReferenceRun} */ (test.reference);
            lines.push(`### ${key(test)}: ${test.status} here, ${there.status} on ${referenced}`
                + ` (${there.failures} failures there)`, '');
            listChecks(there.onlyHere);
            lines.push('');
        }
    }

    const missing = report.tests.map(t=>({ test: t, names: (t.missing ?? [])
        .filter(name=>!EXPECTED_MISSING.has(name)) })).filter(({ names })=>names.length > 0);
    if (missing.length > 0)
    {
        // A test that asks GetProcAddress for a function and calls what it got
        // calls null when this build has none: the run stops there, far from
        // the name that explains it.
        lines.push('## Asked for by name and not found', '');
        for (const { test, names } of missing)
        {
            lines.push(`- ${key(test)}: ${names.join(', ')}`);
        }
        lines.push('');
    }

    /** @type {Map<string, number>} */
    const unimplemented = new Map();
    for (const test of report.tests)
    {
        for (const name of test.unimplemented)
        {
            unimplemented.set(name, (unimplemented.get(name) ?? 0) + 1);
        }
    }
    if (unimplemented.size > 0)
    {
        lines.push('## Called and not implemented', '');
        lines.push([...unimplemented].sort((a, b)=>b[1] - a[1] || a[0].localeCompare(b[0]))
            .map(([name, count])=>`${name}${count > 1 ? ` (${count} tests)` : ''}`).join(', '));
        lines.push('');
    }
    /** @type {Set<string>} */
    const divergences = new Set(report.tests.flatMap(t=>t.divergences));
    if (divergences.size > 0)
    {
        lines.push('## Divergences the engine reported', '');
        for (const divergence of divergences)
        {
            lines.push(`- ${cell(divergence).slice(0, 240)}`);
        }
        lines.push('');
    }
    return `${lines.join('\n')}\n`;
}

async function main(){
    const options = parseArgs(process.argv.slice(2));
    /** @type {[string, string[] | null][]} */
    const wanted = [];
    if (options.preset)
    {
        const preset = PRESETS[options.preset];
        if (!preset)
        {
            console.error(`no preset ${options.preset}: ${Object.keys(PRESETS).join(', ')}`);
            process.exit(2);
        }
        wanted.push(...preset);
    }
    for (const spec of options.specs)
    {
        const [module, test] = spec.split(':');
        wanted.push([module, test ? test.split(',') : null]);
    }
    if (options.fetch || !existsSync(options.winetest))
    {
        if (!options.fetch)
        {
            console.error(`${options.winetest} is not there: run with --fetch to download it`
                + ` from ${options.winetestUrl}`);
            process.exit(2);
        }
        await download(options.winetestUrl, options.winetest);
    }
    if (wanted.length === 0)
    {
        if (options.fetch)
        {
            return;
        }
        console.error('usage: node tools/wine-tests.mjs [--fetch] [--preset games]'
            + ' <dll>[:<test>[,<test>]] ...');
        process.exit(2);
    }

    const winetest = new Uint8Array(await readFile(options.winetest));
    const build = await buildId(winetest);
    const extracted = new URL('extracted/', LOCAL);
    await mkdir(extracted, { recursive: true });
    const settings = { timeout: options.timeout, engine: options.engine,
        corkConfig: options.corkConfig };
    const { DEFAULT_ENGINE } = await import('../modules/core/src/layers/cpu/module.js');
    console.log(`winetest build ${build ?? 'unknown'}, engine ${options.engine ?? DEFAULT_ENGINE},`
        + ` ${options.jobs} at a time, ${options.timeout} s each`);

    /** @type {{ module: string, test: string, exePath: string }[]} */
    const plan = [];
    /** @type {TestReport[]} */
    const unavailable = [];
    for (const [module, tests] of wanted)
    {
        const exe = await extractTest(winetest, module);
        if (!exe)
        {
            console.error(`${module}: winetest carries no ${module}_test.exe`);
            continue;
        }
        const exePath = fileURLToPath(new URL(`${module}_test.exe`, extracted));
        await writeFile(exePath, exe);
        let names = tests;
        if (!names)
        {
            // The program is the only record of which tests it holds.
            const listed = await runInChild(exePath, '--list', settings);
            names = parseOutput(listed.output).names;
            if (names.length === 0)
            {
                unavailable.push(summarise(module, '--list', listed));
                console.log(`${module}: --list printed no tests`
                    + ` (${listed.error?.message ?? listed.died ?? 'no output'})`);
                continue;
            }
        }
        for (const test of names)
        {
            plan.push({ module, test, exePath });
        }
    }

    const started = new Date();
    const results = await pool(plan.map(({ module, test, exePath })=>async()=>{
        const result = await runInChild(exePath, test, settings);
        const report = summarise(module, test, result);
        console.log(`  ${`${module}:${test}`.padEnd(28)} ${report.status.padEnd(15)}`
            + ` executed ${String(report.executed ?? '-').padStart(6)}`
            + ` failures ${String(report.failures).padStart(5)}`
            + ` ${(report.wallMs / 1000).toFixed(1).padStart(6)} s`
            + (report.error
                ? `  ${report.error.reason}: ${report.error.message.slice(0, 100)}` : '')
            + (report.died ? `  ${report.died.split('\n')[0]}` : ''));
        return report;
    }), options.jobs);

    if (options.reference)
    {
        const referenceSettings = { ...settings, engine: options.reference };
        const again = results
            .map((report, index)=>({ report, exePath: plan[index].exePath }))
            .filter(({ report })=>report.status !== 'pass' && report.status !== 'no-such-test');
        console.log(`\n${again.length} tests again on ${options.reference}:`);
        await pool(again.map(({ report, exePath })=>async()=>{
            const reference = summarise(report.module, report.test,
                await runInChild(exePath, report.test, referenceSettings));
            report.reference = againstReference(report, reference, options.reference);
            console.log(`  ${`${report.module}:${report.test}`.padEnd(28)}`
                + ` ${reference.status.padEnd(15)}`
                + ` failures ${String(reference.failures).padStart(5)}`
                + ` ${options.engine ?? DEFAULT_ENGINE}-only ${report.reference.onlyHere.length}`
                + (report.reference.statusOnlyHere ? ', ended worse' : ''));
        }), options.jobs);
    }

    const report = {
        build,
        engine: options.engine ?? DEFAULT_ENGINE,
        started: started.toISOString(),
        tests: [...unavailable, ...results],
    };
    const stamp = started.toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
    const out = options.out
        ? pathToFileURL(`${options.out.replace(/\/$/, '')}/`)
        : new URL(`reports/${stamp}/`, LOCAL);
    await mkdir(out, { recursive: true });
    const baseline = options.baseline ? JSON.parse(await readFile(options.baseline, 'utf8')) : null;
    await writeFile(new URL('report.json', out), `${JSON.stringify(report, null, 1)}\n`);
    await writeFile(new URL('report.md', out),
        markdown(report, { failures: options.failures, baseline }));
    console.log(`\nreport: ${fileURLToPath(new URL('report.md', out))}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
{
    if (process.argv[2] === '--child')
    {
        const [, , , exePath, test, settings] = process.argv;
        await runChild(exePath, test === '--' ? '' : test, JSON.parse(settings));
    }
    else
    {
        await main();
    }
}
