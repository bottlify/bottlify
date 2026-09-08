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
 *                                  [--dump-draws]
 */

import { deflateSync } from 'node:zlib';
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

/** Lines per round trip when draining the call log. */
const LOG_CHUNK = 20000;

/**
 * A BGRA buffer as a PNG, so a texture the engine uploaded can simply be
 * opened. Written here rather than pulled in: the engine's pixels are already
 * one fixed format, and this is thirty lines of it.
 *
 * @param {number} width @param {number} height @param {Buffer} bgra
 * @returns {Buffer}
 */
function toPng(width, height, bgra){
    const stride = width * 4 + 1;
    const raw = Buffer.alloc(stride * height);
    for (let y = 0; y < height; y++)
    {
        for (let x = 0; x < width; x++)
        {
            const from = (y * width + x) * 4;
            const to = y * stride + 1 + x * 4;
            raw[to] = bgra[from + 2];
            raw[to + 1] = bgra[from + 1];
            raw[to + 2] = bgra[from];
            raw[to + 3] = bgra[from + 3];
        }
    }
    /** @param {string} type @param {Buffer} body */
    const chunk = (type, body)=>{
        const head = Buffer.alloc(8);
        head.writeUInt32BE(body.length, 0);
        head.write(type, 4, 'latin1');
        const crc = Buffer.alloc(4);
        crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])) >>> 0, 0);
        return Buffer.concat([head, body, crc]);
    };
    const header = Buffer.alloc(13);
    header.writeUInt32BE(width, 0);
    header.writeUInt32BE(height, 4);
    header[8] = 8;
    header[9] = 6;
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', header),
        chunk('IDAT', deflateSync(raw)),
        chunk('IEND', Buffer.alloc(0)),
    ]);
}

/** @param {Buffer} bytes @returns {number} */
function crc32(bytes){
    let crc = ~0;
    for (const byte of bytes)
    {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit++)
        {
            crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
        }
    }
    return ~crc;
}

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
        // Every host call written to a file. The ring in a report holds the end
        // of a run, and what a program decided it decided long before that.
        log: argv.includes('--log') ? argv[argv.indexOf('--log') + 1] : null,
        // Where every draw of the last frame landed, and under what state.
        // Off unless asked for: it transforms every vertex of every draw a
        // second time on the processor.
        dumpDraws: argv.includes('--dump-draws'),
        // Draws per frame, for bisecting which one painted a region.
        maxDraws: number('--max-draws', -1),
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
    const from = `0x${(call.from >>> 0).toString(16).padStart(8, '0')}`
        + (call.fromName ? ` ${call.fromName}` : '');
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

    const graphics = result.graphics;
    if (graphics)
    {
        say(`  graphics: created=[${graphics.created.join(' ')}]`);
        const device = graphics.device;
        if (device)
        {
            say(`    frames=${device.frames} draws=${device.draws} clears=${device.clears}`);
            const skipped = Object.entries(device.skipped ?? {})
                .filter(([, count])=>count > 0)
                .map(([name, count])=>`${name}=${count}`).join(' ');
            if (skipped)
            {
                say(`    skipped: ${skipped}`);
            }
            const lighting = device.lighting;
            if (lighting)
            {
                say(`    lighting: lit=${lighting.lit} unlit=${lighting.unlit}`
                    + ` no-normal=${lighting.noNormal} pre-transformed=${lighting.preTransformed}`);
                say(`    lights: most=${lighting.mostLights}`
                    + ` types=[${lighting.types.join(' ')}]`
                    + ` ambient=[${lighting.ambients.join(' ')}]`);
                for (const value of lighting.lightValues ?? [])
                {
                    say(`      light    ${value}`);
                }
                for (const value of lighting.materials ?? [])
                {
                    say(`      material ${value}`);
                }
                for (const value of lighting.worlds ?? [])
                {
                    say(`      world    ${value}`);
                }
                const withFog = lighting.fog;
                if (withFog && (withFog.transformed > 0 || withFog.preTransformed > 0))
                {
                    say(`    fog: modes=[${withFog.modes.join(' ')}]`
                        + ` transformed=${withFog.transformed}`
                        + ` pre-transformed=${withFog.preTransformed}`);
                    for (const value of withFog.settings ?? [])
                    {
                        say(`      fog      ${value}`);
                    }
                    for (const value of withFog.depths ?? [])
                    {
                        say(`      fogged   ${value}`);
                    }
                    for (const value of withFog.screenSpace ?? [])
                    {
                        say(`      screen   ${value}`);
                    }
                }
            }
            for (const failure of (device.failures ?? []).slice(0, 8))
            {
                say(`    failed: ${failure}`);
            }
        }
        say('');
    }

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
            log: Boolean(options.log),
            dumpDraws: options.dumpDraws,
            maxDraws: options.maxDraws,
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

        // The whole call stream, when one was asked for, drained in pieces:
        // a quarter of a million lines is more than one evaluation carries.
        if (options.log)
        {
            const lines = [];
            for (let at = 0; ; at += LOG_CHUNK)
            {
                const piece = await cdp.send('Runtime.evaluate', {
                    expression:
                        `window.__bottlify__.drainLog(${at}, ${LOG_CHUNK})`,
                    returnByValue: true,
                }, sessionId);
                const text = piece.result?.value ?? '';
                if (text === '')
                {
                    break;
                }
                lines.push(text);
            }
            writeFileSync(options.log, lines.join(String.fromCharCode(10)));
            console.log(`call log: ${options.log}`);
        }

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

        // A file of its own: one line per draw is thousands of lines, which is
        // a thing to grep rather than a thing to read past.
        const drawn = result.graphics?.device?.lastDump ?? [];
        let drawsPath = null;
        if (drawn.length > 0)
        {
            drawsPath = join(REPORTS_DIR, `game-${stamp}-draws.txt`);
            writeFileSync(drawsPath, `${drawn.join('\n')}\n`);
        }
        // The texels behind those draws, as images. A rectangle in a frame is
        // either something a draw put there or something already in what it
        // sampled, and only the texture itself tells those apart.
        for (const texture of result.graphics?.device?.textures ?? [])
        {
            writeFileSync(
                join(REPORTS_DIR, `game-${stamp}-${texture.id}-fmt${texture.format}.png`),
                toPng(texture.width, texture.height, Buffer.from(texture.bgra, 'base64')));
        }

        return {
            ok: result.ok === true,
            measured: true,
            adapter: gpu.adapter,
            pageUrl,
            report: text,
            reportPath,
            drawsPath,
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
    if (answer.drawsPath)
    {
        console.log(`draws:      ${answer.drawsPath}`);
    }
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
