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
 * which is exactly what this measures -- node only, no browser.
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
 *     --preset installers the libraries installers lean on
 *     --timeout <s>       wall seconds per test (default 120)
 *     --jobs <n>          tests run at once (default half the processors)
 *     --failures <n>      failed checks listed per test in the markdown (default 20)
 *     --out <dir>         where report.json and report.md go
 *     --baseline <json>   an earlier report to compare against, before -> after
 *     --gate              with --baseline: exit 1 when a test got worse than the
 *                         baseline says (`regressions`): its status, or a check
 *                         failing that held there
 *     --volume <dir>      a directory of this machine laid on C: before each test:
 *                         a runtime the tests need that is not part of the engine
 *                         (the .NET Framework, for the tests of its libraries)
 *     --cork-config <json>  the translator's settings, over the ones used here
 *     --browser           run each test in a headless browser on WebGPU, through
 *                         tools/cdp_test/game.mjs: what a test draws is drawn and
 *                         read back, where in node every read-back is zero, so the
 *                         visual tests (d3d9:visual, ddraw:ddraw7, d3d11) answer
 *                         only here. The program is packed alone as the local
 *                         bundle wine-<dll>. One test at a time unless --jobs says
 *                         otherwise: each run is a browser of its own
 *     --graphics-config <json>  with --browser: the graphics layer's settings, as
 *                         game.mjs takes them (`{"driverRules":"current"}` judges
 *                         Direct3D 8 and 9 by today's drivers, as Wine's tests do)
 *     --gpu-adapter <a>   with --browser: swiftshader (default), the adapter the
 *                         pictures are judged on, or hardware
 */

import { execFileSync, fork, spawn } from 'node:child_process';
import { availableParallelism, tmpdir } from 'node:os';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isMain } from './common.mjs';

const ROOT = new URL('../', import.meta.url);
const LOCAL = new URL('to_install/wine-tests/', ROOT);

/** The i386 winetest.exe of Wine's daily CI build, the newest one. */
export const WINETEST_URL = 'https://gitlab.winehq.org/wine/wine/-/jobs/artifacts/master/raw/'
    + 'winetest.exe?job=build-daily-winetest';

/**
 * The libraries games call into, and the tests of each that exercise what they
 * call; and those an installer leans on, from its packages and cabinets to the
 * shell's file operations, the registry and its security. `null` is every
 * test the library's program lists.
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
    installers: [
        ['kernel32', null],
        ['advapi32', null],
        ['user32', null],
        ['ole32', null],
        ['oleaut32', null],
        ['msi', null],
        ['setupapi', null],
        ['cabinet', null],
        ['version', null],
        ['shlwapi', null],
        ['shell32', ['shlfileop', 'shellpath', 'shlexec', 'shelllink', 'shlfolder', 'shellole']],
        ['comctl32', ['propsheet', 'progress', 'listview', 'treeview', 'imagelist', 'status',
            'toolbar', 'animate', 'updown', 'tab']],
        ['comdlg32', ['filedlg']],
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
 */

/**
 * @param {string} module @param {string} test @param {ChildResult} result
 * @param {number | null} [mainProcess]  the test's process, null where not known: a run in
 *     a browser numbers its processes as the page does, and is read without one
 * @returns {TestReport}
 */
export function summarise(module, test, result, mainProcess = MAIN_PROCESS){
    const parsed = parseOutput(result.output, test, mainProcess ?? undefined);
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
 * What every test asks for and is meant not to find: the name a test looks up
 * to tell Wine from Windows. Its absence is what makes it hold us to Windows.
 */
const EXPECTED_MISSING = new Set(['ntdll.dll!wine_server_call']);

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
 * Every file under a directory of this machine, at its place under a guest
 * directory: what `--volume` lays on C: before a test runs.
 *
 * @param {string} host @param {string} guest
 * @returns {Promise<{ path: string, bytes: Uint8Array }[]>}
 */
async function filesUnder(host, guest){
    const { readdir, stat } = await import('node:fs/promises');
    /** @type {{ path: string, bytes: Uint8Array }[]} */
    const out = [];
    for (const name of await readdir(host))
    {
        const path = join(host, name);
        if ((await stat(path)).isDirectory())
        {
            out.push(...await filesUnder(path, `${guest}\\${name}`));
        }
        else
        {
            out.push({ path: `${guest}\\${name}`, bytes: new Uint8Array(await readFile(path)) });
        }
    }
    return out;
}

/**
 * One test program, in this process: what runs in the child.
 *
 * Everything the program prints goes to the parent as it is printed, so a
 * run ended from outside still reports how far it got.
 *
 * @param {string} exePath @param {string} test
 * @param {{ timeout: number, corkConfig: object, volume?: string }} settings
 */
async function runChild(exePath, test, settings){
    const send = (/** @type {any} */ message)=>new Promise(resolve=>{
        process.send?.(message, undefined, {}, ()=>resolve(undefined));
    });
    const { createApp } = await import('../modules/core/src/app.js');
    const executable = new Uint8Array(await readFile(exePath));
    const name = exePath.split(/[\\/]/).pop() ?? 'test.exe';
    const imagePath = `C:\\winetest\\${name}`;

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
            imagePath,
            commandLine: test === '' ? `"${imagePath}"` : `"${imagePath}" ${test}`,
            // The program on its own volume, where GetModuleFileName says it is:
            // a test that reads its own resources or copies itself opens it.
            files: [{ path: imagePath, bytes: executable },
                ...settings.volume ? await filesUnder(settings.volume, 'C:') : []],
            // The run's first process is numbered at random otherwise, and
            // the test's own closing count is told from a child's by it.
            processId: MAIN_PROCESS,
            cork: { config: { feed: 'slice', timings: true,
                worker: true, workerUrl: new URL(
                    'modules/cork/src/runtime/translator.worker.js', ROOT).href,
                ...settings.corkConfig } },
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
 * @param {{ timeout: number, corkConfig: object }} settings
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

/**
 * Packs a test program alone as the bundle `wine-<module>`, which game.mjs
 * starts. Bundles are local, as winetest is.
 *
 * @param {string} module @param {string} exePath
 * @returns {string} the bundle's id
 */
function packTest(module, exePath){
    const id = `wine-${module}`;
    const directory = mkdtempSync(join(tmpdir(), `${id}-`));
    try
    {
        copyFileSync(exePath, join(directory, `${module}_test.exe`));
        execFileSync(process.execPath, [fileURLToPath(new URL('tools/make-btl.mjs', ROOT)), 'pack',
            directory, id, `--entry=${module}_test.exe`], { cwd: fileURLToPath(ROOT),
            stdio: 'ignore' });
    }
    finally
    {
        rmSync(directory, { recursive: true, force: true });
    }
    return id;
}

/**
 * One test in a headless browser, through game.mjs: the program's output as it
 * printed it, and the run's end read off the report's `stopped:` line.
 *
 * @param {string} bundle @param {string} module @param {string} test
 * @param {{ timeout: number, adapter: string, graphicsConfig?: object }} settings
 * @returns {Promise<ChildResult>}
 */
function runInBrowser(bundle, module, test, settings){
    return new Promise(resolve=>{
        const began = performance.now();
        const output = join(tmpdir(), `${bundle}-${test || 'all'}-${process.pid}-`
            + `${Math.round(began)}.txt`);
        const child = spawn(process.execPath, [
            fileURLToPath(new URL('tools/cdp_test/game.mjs', ROOT)), bundle,
            '--entry', `${module}_test.exe`,
            '--command-line', `"C:\\App\\${module}_test.exe" ${test}`.trimEnd(),
            '--wait', String(settings.timeout), '--output', output,
            ...settings.adapter === 'hardware' ? []
                : ['--chrome-flag', '--use-webgpu-adapter=swiftshader'],
            ...settings.graphicsConfig
                ? ['--graphics-config', JSON.stringify(settings.graphicsConfig)] : [],
        ], { cwd: fileURLToPath(ROOT), stdio: ['ignore', 'pipe', 'pipe'] });
        let printed = '';
        // The report's path is caught as it goes by: the program's own output
        // printed after it is often more than the tail kept.
        let reportLine = '';
        let partial = '';
        child.stdout.on('data', chunk=>{
            printed = (printed + chunk).slice(-20000);
            const lines = (partial + chunk).split('\n');
            partial = lines.pop() ?? '';
            reportLine = lines.find(line=>/^report:\s+\S/.test(line)) ?? reportLine;
        });
        child.stderr.on('data', chunk=>{
            printed = (printed + chunk).slice(-20000);
        });
        let killed = false;
        const timer = setTimeout(()=>{
            killed = true;
            child.kill('SIGKILL');
        }, (settings.timeout + 120) * 1000);
        child.on('exit', (code, signal)=>{
            clearTimeout(timer);
            const reportPath = /^report:\s+(.+\.txt)\s*$/.exec(reportLine || partial)?.[1]
                ?? /^report:\s+(.+\.txt)\s*$/m.exec(printed)?.[1];
            const report = reportPath && existsSync(reportPath)
                ? readFileSync(reportPath, 'latin1') : '';
            const stopped = /^stopped: (.*)$/m.exec(report)?.[1] ?? null;
            const exited = stopped ? /^exited with (\d+)$/.exec(stopped) : null;
            const text = existsSync(output) ? readFileSync(output, 'latin1') : '';
            rmSync(output, { force: true });
            resolve({
                output: text,
                exitCode: exited ? Number(exited[1]) | 0 : null,
                error: stopped && !exited
                    ? { reason: 'host', message: `${stopped} (${reportPath})` } : null,
                killed,
                died: report ? null : `game.mjs exited ${signal ?? code} with no report: `
                    + printed.trim().split('\n').slice(-8).join('\n'),
                wallMs: performance.now() - began,
                unimplemented: [],
                divergences: [],
                missing: [],
                unresolved: [],
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
        '--baseline', '--cork-config', '--winetest-url', '--gpu-adapter', '--graphics-config',
        '--volume']);
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
        browser: argv.includes('--browser'),
        adapter: value('--gpu-adapter', 'swiftshader') ?? 'swiftshader',
        jobs: Number(value('--jobs', argv.includes('--browser') ? '1'
            : String(Math.max(1, Math.floor(availableParallelism() / 2))))),
        failures: Number(value('--failures', '20')),
        out: value('--out'),
        baseline: value('--baseline'),
        gate: argv.includes('--gate'),
        corkConfig: JSON.parse(value('--cork-config', '{}') ?? '{}'),
        volume: value('--volume'),
        graphicsConfig: value('--graphics-config')
            ? JSON.parse(/** @type {string} */ (value('--graphics-config'))) : undefined,
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

/** How a test ended, best first: a pass, failed checks, then a run that did not finish. */
const STATUS_RANK = { pass: 0, fail: 1 };

/**
 * A failed check as it is told from another across runs and Wine builds: its
 * file and message, the numbers in the message (addresses, counts, values that
 * move run to run) taken out; the line moves with Wine's tree.
 *
 * @param {FailedCheck} check
 */
const checkKey = check=>`${check.file}: ${check.message.replace(/0x[0-9a-f]+|\d+/gi, '#')}`;

/**
 * What got worse since `baseline`, one line each: a test whose run ended
 * worse (a pass that fails, a test that ran to its end and now does not), and
 * a test with a failed check the baseline's run did not have. A test the
 * baseline did not run is new, not worse; fewer failures are not reported.
 *
 * @param {{ tests: TestReport[] }} report @param {{ tests: TestReport[] }} baseline
 * @returns {string[]}
 */
export function regressions(report, baseline){
    /** @param {TestReport} t */
    const key = t=>`${t.module}:${t.test}`;
    /** @param {string} status */
    const rank = status=>STATUS_RANK[/** @type {keyof STATUS_RANK} */ (status)] ?? 2;
    const before = new Map(baseline.tests.map(t=>[key(t), t]));
    /** @type {string[]} */
    const worse = [];
    for (const test of report.tests)
    {
        const was = before.get(key(test));
        if (!was)
        {
            continue;
        }
        if (rank(test.status) > rank(was.status))
        {
            worse.push(`${key(test)}: ${was.status} -> ${test.status}`);
        }
        const held = new Set(was.failed.map(checkKey));
        const fresh = test.failed.filter(check=>!held.has(checkKey(check)));
        if (fresh.length > 0)
        {
            const [first] = fresh;
            worse.push(`${key(test)}: ${fresh.length} failed check(s) the baseline did not have,`
                + ` first ${first.file}:${first.line}: ${first.message}`);
        }
    }
    return worse;
}

/**
 * @param {{ build: string | null, started: string, tests: TestReport[] }} report
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
        `Tests from Wine build ${report.build ?? 'unknown'}, started ${report.started}.`,
        '',
    ];

    /** @type {Map<string, TestReport[]>} */
    const byModule = new Map();
    for (const test of report.tests)
    {
        byModule.set(test.module, [...byModule.get(test.module) ?? [], test]);
    }
    lines.push('## By library', '');
    lines.push(`| library | tests | pass | executed | failures | todo | skipped | not finished |${
        baseline ? ' failures before |' : ''}`);
    lines.push(`|---|---|---|---|---|---|---|---|${baseline ? '---|' : ''}`);
    for (const [module, tests] of byModule)
    {
        const sum = (/** @type {(t: TestReport) => number} */ pick)=>tests
            .reduce((total, t)=>total + pick(t), 0);
        const failedBefore = tests.map(t=>earlier.get(key(t)))
            .reduce((total, t)=>total + (t?.failures ?? 0), 0);
        const unfinished = tests.filter(t=>!FINISHED.has(t.status));
        lines.push(`| ${module} | ${tests.length} | ${tests.filter(t=>t.status === 'pass').length}`
            + ` | ${sum(t=>t.executed ?? 0)} | ${sum(t=>t.failures)} | ${sum(t=>t.todo ?? 0)}`
            + ` | ${sum(t=>t.skipped)} | ${unfinished.map(t=>`${t.test} (${t.status})`).join(', ')}`
            + ` |${baseline ? ` ${failedBefore} |` : ''}`);
    }

    lines.push('', '## By test', '');
    lines.push(`| test | status | executed | failures | todo | skipped | seconds |${
        baseline ? ' before -> after |' : ''}`);
    lines.push(`|---|---|---|---|---|---|---|${baseline ? '---|' : ''}`);
    for (const test of report.tests)
    {
        lines.push(`| ${key(test)} | ${test.status} | ${test.executed ?? '-'} | ${test.failures}`
            + ` | ${test.todo ?? '-'} | ${test.skipped} | ${(test.wallMs / 1000).toFixed(1)} |${
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

    lines.push('', '## Failed checks', '');
    for (const test of report.tests.filter(t=>t.failed.length > 0 || t.exceptions.length > 0))
    {
        lines.push(`### ${key(test)} (${test.failures} failures)`, '');
        listChecks(test.failed);
        for (const exception of test.exceptions)
        {
            lines.push(`- ${cell(exception)}${test.lastSeen ? ` (after ${test.lastSeen})` : ''}`);
        }
        lines.push('');
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
    const settings = { timeout: options.timeout, corkConfig: options.corkConfig,
        volume: options.volume,
        adapter: options.adapter, graphicsConfig: options.graphicsConfig };
    /** @type {Map<string, string>} module -> its bundle, for --browser */
    const bundles = new Map();
    console.log(`winetest build ${build ?? 'unknown'}, ${options.jobs} at a time,`
        + ` ${options.timeout} s each`
        + (options.browser ? `, in a browser on ${options.adapter}` : ''));

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
        if (options.browser)
        {
            bundles.set(module, packTest(module, exePath));
        }
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
        const result = options.browser
            ? await runInBrowser(/** @type {string} */ (bundles.get(module)), module, test,
                settings)
            : await runInChild(exePath, test, settings);
        const report = summarise(module, test, result,
            options.browser ? null : MAIN_PROCESS);
        console.log(`  ${`${module}:${test}`.padEnd(28)} ${report.status.padEnd(15)}`
            + ` executed ${String(report.executed ?? '-').padStart(6)}`
            + ` failures ${String(report.failures).padStart(5)}`
            + ` ${(report.wallMs / 1000).toFixed(1).padStart(6)} s`
            + (report.error
                ? `  ${report.error.reason}: ${report.error.message.slice(0, 100)}` : '')
            + (report.died ? `  ${report.died.split('\n')[0]}` : ''));
        return report;
    }), options.jobs);

    const report = {
        build,
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
    if (options.gate)
    {
        if (!baseline)
        {
            throw new Error('wine-tests: --gate compares with a --baseline report');
        }
        const worse = regressions(report, baseline);
        console.log(worse.length === 0 ? 'gate: nothing got worse than the baseline'
            : `gate: ${worse.length} worse than the baseline\n${worse.join('\n')}`);
        process.exitCode = worse.length === 0 ? 0 : 1;
    }
}

if (isMain(import.meta.url))
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
