/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Points the engine at a real title inside a browser that has a GPU.
 *
 * This is the same measurement the command-line probe makes, moved to the one
 * place a device exists. Everything a title needs before it draws -- its files,
 * its threads, its registry -- can be answered without one; the moment it asks
 * for a Direct3D device, only a browser can answer, and so only a browser can
 * say what the title does next. That answer is what this scenario is for.
 *
 * It is not a test and cannot be one: it needs a bundle of a game nobody can
 * put in a repository. Without that bundle it says so and stops.
 *
 *     node tools/cdp_test/game.mjs <bundle-id> [--turns N] [--wait SECONDS]
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchWithGpu, shutdown } from './browser.mjs';
import { CdpEndpoint } from './cdp.mjs';
import { serveStatic } from './server.mjs';
import { openBundle } from '../btl.mjs';

const TOOL_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)));
const REPO_ROOT = resolve(TOOL_ROOT, '..', '..');
const PACKAGE_DIR = join(REPO_ROOT, 'modules', 'core');
const BUNDLES_DIR = join(REPO_ROOT, 'bundles');
const REPORTS_DIR = join(TOOL_ROOT, 'reports');

/** @param {string[]} argv */
function parse(argv){
    const id = argv.find(argument=>!argument.startsWith('--'));
    /** @param {string} flag @param {number} fallback */
    const number = (flag, fallback)=>{
        const at = argv.indexOf(flag);
        return at === -1 ? fallback : Number(argv[at + 1]);
    };
    return {
        id,
        turns: number('--turns', 200000),
        // A run that reads a gigabyte of bundle over HTTP one block at a time
        // is slower than one reading a local file, and the page cannot be asked
        // how it is doing while it runs.
        waitMs: number('--wait', 900) * 1000,
        calls: number('--calls', 40),
        // Guest instructions per scheduler turn when a profile is asked for.
        // Lowering it is what makes a sample a measurement rather than a
        // rumour: a sample lands at a turn boundary, so the turn is the
        // resolution.
        quantum: argv.includes('--profile')
            ? number('--profile', 2000) || 2000
            : 0,
    };
}

/**
 * Waits for an expression to answer something other than null.
 *
 * A command sent while the engine holds the page's thread is never answered and
 * times out; that is the ordinary case here rather than a failure, so it costs
 * one more turn of the loop and nothing else.
 *
 * @param {CdpEndpoint} cdp
 * @param {string} sessionId
 * @param {string} expression
 * @param {number} timeoutMs
 * @returns {Promise<any>}
 */
async function poll(cdp, sessionId, expression, timeoutMs){
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline)
    {
        try
        {
            const answer = await cdp.send(
                'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true },
                sessionId);
            if (answer.exceptionDetails)
            {
                throw new Error(`page threw: ${JSON.stringify(
                    answer.exceptionDetails.exception?.description
                    ?? answer.exceptionDetails)}`);
            }
            if (answer.result.value !== null && answer.result.value !== undefined)
            {
                return JSON.parse(answer.result.value);
            }
        }
        catch (e){
            if (!/timed out/.test(e.message))
            {
                throw e;
            }
        }
        await new Promise(wait=>setTimeout(wait, 500));
    }
    throw new Error(`the page did not answer within ${timeoutMs}ms`);
}

/**
 * One host call as a line: where it was called from, what it was given, what it
 * answered, and what error it left behind.
 *
 * @param {any} call
 * @returns {string}
 */
function formatCall(call){
    const args = (call.args ?? []).map((/** @type {number} */ a,
        /** @type {number} */ index)=>(
        call.strings?.[index]
            ? `${JSON.stringify(call.strings[index])}@0x${(a >>> 0).toString(16)}`
            : `0x${(a >>> 0).toString(16)}`)).join(', ');
    const from = `0x${(call.from >>> 0).toString(16).padStart(8, '0')}`;
    const left = call.error ? `  [err ${call.error}]` : '';
    return `${from}  ${call.name}(${args}) = ${call.result}${left}`;
}

/** Groups "dll!name" into a table by library. @param {string[]} unresolved */
function byLibrary(unresolved){
    /** @type {Map<string, string[]>} */
    const grouped = new Map();
    for (const entry of unresolved)
    {
        const [dll, name] = entry.split('!');
        const held = grouped.get(dll.toLowerCase()) ?? [];
        held.push(name);
        grouped.set(dll.toLowerCase(), held);
    }
    return [...grouped].sort((left, right)=>right[1].length - left[1].length);
}

/**
 * The whole run as text: what was asked, what answered, and where it stopped.
 *
 * @param {any} result
 * @param {any} context
 * @param {number} calls
 * @returns {string}
 */
function describe(result, context, calls){
    const lines = [];
    /** @param {string} text */
    const say = text=>lines.push(text);

    say(`${context.title} ${context.version} -- ${context.entry}`);
    say(`  entry image: ${context.executableBytes} bytes`);
    say(`  adapter: ${JSON.stringify(result.adapter)}`);
    say(`  ran for ${result.elapsedMs}ms, ${result.instructions} guest instructions`);
    say(`stopped: ${result.stopped ?? result.error ?? 'no answer'}`);
    say('');

    const unresolved = byLibrary(result.unresolved ?? []);
    if (unresolved.length === 0)
    {
        say('every import bound.');
    }
    else
    {
        const total = unresolved.reduce((sum, [, names])=>sum + names.length, 0);
        say(`${total} imports nothing claimed:`);
        for (const [dll, names] of unresolved)
        {
            say(`  ${dll}  (${names.length})`);
            say(`    ${[...new Set(names)].sort().join(', ')}`);
        }
    }
    say('');

    if ((result.missing ?? []).length > 0)
    {
        say('asked for by name at run time and not found:');
        for (const name of result.missing)
        {
            say(`  ${name}`);
        }
        say('');
    }

    for (const layer of result.layers ?? [])
    {
        const metrics = Object.entries(layer.metrics ?? {})
            .map(([name, value])=>`${name}=${value}`).join(' ');
        say(`  ${layer.name} [${layer.status}] ${metrics}`);
    }
    say('');

    say(`  threads: ${JSON.stringify(result.threads?.byState ?? {})}`);
    for (const waiting of result.threads?.waiting ?? [])
    {
        say(`    blocked  ${waiting}`);
    }
    say('');

    const sequence = result.bridge?.sequence ?? [];
    if (sequence.length > 0)
    {
        say('  in order:');
        for (let at = 0; at < sequence.length; at += 6)
        {
            say(`    ${sequence.slice(at, at + 6).join('  ')}`);
        }
        say('');
    }

    say('  the last calls, with arguments:');
    for (const call of (result.bridge?.recent ?? []).slice(-calls))
    {
        say(`    ${formatCall(call)}`);
    }
    say('');

    if ((result.bridge?.hot ?? []).length > 0)
    {
        say('  what it was calling, most recent first:');
        for (const [name, count] of result.bridge.hot)
        {
            say(`    ${String(count).padStart(5)}  ${name}`);
        }
        say('');
    }

    say(`  frames presented: ${result.presents ?? 0}`);
    if (result.frame)
    {
        say(`  frame: ${JSON.stringify(result.frame)}`);
        say(`  colours: ${JSON.stringify(result.colours)}`);
    }
    say('');

    for (const failure of (result.failures ?? []).slice(0, 3))
    {
        say(`  reason: ${failure.reason}${failure.message ? ` -- ${failure.message}` : ''}`);
        if (failure.stack)
        {
            say(failure.stack);
        }
        if (failure.trace)
        {
            say(failure.trace);
        }
        say('');
    }
    if (result.trace)
    {
        say('  the trace the run stopped with:');
        say(result.trace);
        say('');
    }

    for (const line of result.output ?? [])
    {
        say(`  [guest] ${line.trimEnd()}`);
    }
    for (const line of result.events ?? [])
    {
        say(`  ${line}`);
    }
    for (const line of result.errors ?? [])
    {
        say(`  [page] ${line}`);
    }

    if (result.profile)
    {
        say('');
        say(`  guest execution, ${result.profile.samples} samples by page:`);
        for (const row of result.profile.pages)
        {
            say(`    ${String(row.count).padStart(7)}  `
                + `${(row.share * 100).toFixed(1).padStart(5)}%  ${row.at}`);
        }
        say('');
        say('  the addresses it sat on:');
        for (const row of result.profile.exact)
        {
            say(`    ${String(row.count).padStart(7)}  `
                + `${(row.share * 100).toFixed(1).padStart(5)}%  ${row.at}`);
        }
    }

    for (const file of result.files ?? [])
    {
        say('');
        say(`  ${file.path} (${file.bytes} bytes)`);
        say(file.tail.split('\n').map((/** @type {string} */ text)=>`    ${text}`).join('\n'));
    }

    return `${lines.join('\n')}\n`;
}

/**
 * Runs the scenario end to end.
 *
 * @param {ReturnType<typeof parse>} options
 * @returns {Promise<any>}
 */
export async function game(options){
    const directory = join(BUNDLES_DIR, options.id ?? '');
    const bundlePath = join(directory, 'bundle.btl');
    if (!existsSync(bundlePath))
    {
        throw new Error(
            `no bundle at ${bundlePath}. A title's bundle is not part of this `
            + 'repository; build one and put it there before running this scenario.');
    }

    const manifest = JSON.parse(
        await readFile(join(directory, 'manifest.json'), 'utf8'));

    // The tools-side reader takes a path and does its own reading, which is how
    // the entry image is lifted out here; the engine's takes a byte range and
    // gets one over HTTP, which is how the page reads everything else.
    const opened = await openBundle(bundlePath);
    const executable = await opened.read(manifest.entry);
    await opened.close();

    const server = await serveStatic({
        sandboxDir: PACKAGE_DIR,
        srcDir: join(PACKAGE_DIR, 'src'),
        extra: [{ prefix: '/bundle/', root: directory }],
    });
    const browser = await launchWithGpu();
    mkdirSync(REPORTS_DIR, { recursive: true });

    const pageUrl = `http://127.0.0.1:${server.port}/sandbox/test/page/game/index.html`;
    /** @type {CdpEndpoint | null} */
    let cdp = null;
    try
    {
        cdp = new CdpEndpoint(browser.browserWs);
        await cdp.open();
        const { targetId } = await cdp.send('Target.createTarget', { url: pageUrl });
        const { sessionId } = await cdp.send(
            'Target.attachToTarget', { targetId, flatten: true });
        await cdp.send('Runtime.enable', {}, sessionId);
        await cdp.send('Page.enable', {}, sessionId);

        /** @type {string[]} */
        const thrown = [];
        cdp.on('Runtime.exceptionThrown', params=>{
            thrown.push(`exception: ${params.exceptionDetails?.exception?.description
                ?? JSON.stringify(params)}`);
        });

        const gpu = await poll(cdp, sessionId,
            'window.__bottlify__ && window.__bottlify__.gpu'
            + ' ? window.__bottlify__.gpu.then(function(g){ return JSON.stringify(g); })'
            + ' : null',
            30000);
        if (!gpu.available)
        {
            return {
                ok: false, measured: false, pageUrl, events: thrown,
                reason: `no WebGPU device in this browser: ${gpu.reason}`,
            };
        }

        const request = JSON.stringify({
            exe: Buffer.from(executable).toString('base64'),
            bundleUrl: `http://127.0.0.1:${server.port}/bundle/bundle.btl`,
            // Where createApp mounts a bundle, so the program is told it was
            // loaded from inside its own installation.
            imagePath: `C:\\App\\${manifest.entry}`,
            maxTurns: options.turns,
            quantum: options.quantum,
        });
        await cdp.send('Runtime.evaluate',
            { expression: `window.__bottlify__.start(${request}); null`,
                returnByValue: true },
            sessionId);

        const result = await poll(cdp, sessionId,
            'window.__bottlify__.result ? JSON.stringify(window.__bottlify__.result) : null',
            options.waitMs);

        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const shotPath = join(REPORTS_DIR, `game-${stamp}.png`);
        const reportPath = join(REPORTS_DIR, `game-${stamp}.txt`);
        const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId);
        writeFileSync(shotPath, Buffer.from(shot.data, 'base64'));

        // Everything the program wrote, kept as files rather than as excerpts.
        // A game's own crash report is its account of what went wrong and beats
        // any trace taken from outside it -- but only if all of it survives.
        for (const file of result.files ?? [])
        {
            const name = `game-${stamp}-${file.path.replace(/[\\/:]+/g, '_')}`;
            const saved = join(REPORTS_DIR, name);
            writeFileSync(saved, file.text, 'latin1');
            file.saved = saved;
        }

        const text = describe(result, {
            title: manifest.title,
            version: manifest.version,
            entry: manifest.entry,
            executableBytes: executable.length,
        }, options.calls);
        writeFileSync(reportPath, text);

        return {
            ok: result.ok === true,
            measured: true,
            adapter: gpu.adapter,
            pageUrl,
            report: text,
            reportPath,
            screenshot: shotPath,
            events: thrown,
        };
    }
    finally
    {
        cdp?.close();
        await shutdown(browser);
        await server.close();
    }
}

const options = parse(process.argv.slice(2));
if (!options.id)
{
    console.error(
        'usage: node tools/cdp_test/game.mjs <bundle-id> [--turns N] [--wait SECONDS]');
    process.exit(2);
}

try
{
    const answer = await game(options);
    if (answer.report)
    {
        console.log(answer.report);
    }
    console.log(`report:     ${answer.reportPath ?? '-'}`);
    console.log(`screenshot: ${answer.screenshot ?? '-'}`);
    for (const line of answer.events ?? [])
    {
        console.log(line);
    }
    if (!answer.measured)
    {
        console.error(answer.reason);
    }
    process.exit(answer.ok ? 0 : 1);
}
catch (e){
    console.error(`game scenario failed: ${e.stack ?? e.message}`);
    process.exit(1);
}
