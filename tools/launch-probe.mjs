/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Points the engine at a real game and reports where it stops.
 *
 * This is not a test and cannot be one: it needs a bundle of a game nobody can
 * put in a repository. It is a measurement, and it exists because the question
 * it answers -- what is actually missing before a title runs -- is not one that
 * can be answered by reading the code. Every guess about it so far has been a
 * guess.
 *
 * It reports two things, and the first is worth having on its own: the imports
 * the loader could not bind, grouped by the library that exports them. That is
 * a complete, ordered list of what to implement next, produced without running a
 * single guest instruction. The second is where execution stopped, when it got
 * far enough to run at all.
 *
 *     node tools/launch-probe.mjs warcraft-iii-frozen-throne [--turns 200000]
 */

import { readFile } from 'node:fs/promises';
import { openBundle } from './btl.mjs';
import { createApp } from '../modules/core/src/app.js';

const PREBUILT = new URL('../modules/core/vendor/prebuilt/', import.meta.url);
const BUNDLES = new URL('../bundles/', import.meta.url);

/** @param {string[]} argv */
function parse(argv){
    const id = argv.find(argument=>!argument.startsWith('--'));
    const turns = argv.indexOf('--turns');
    return {
        id,
        turns: turns === -1 ? 200000 : Number(argv[turns + 1]),
        map: argv.includes('--map'),
        // Which calls to print with their arguments. A name, or a fragment of
        // one, narrows a long trace to the handful that answer the question.
        grep: argv.includes('--grep') ? argv[argv.indexOf('--grep') + 1] : null,
        calls: argv.includes('--calls') ? Number(argv[argv.indexOf('--calls') + 1]) : 24,
        // Sizing the guest's heap from the command line, so that "it ran out
        // of memory" can be tested rather than argued about.
        heap: argv.includes('--heap')
            ? Number(argv[argv.indexOf('--heap') + 1]) * 1024 * 1024
            : undefined,
    };
}

/**
 * The address space as the region map holds it, with the gaps between regions
 * spelled out. A fault outside every region is usually a region that is too
 * small rather than an address that is wrong, and the gap is where it could
 * have grown to.
 *
 * @param {any} app
 */
function printMap(app){
    const layout = app.diagnostics()
        .find((/** @type {any} */ layer)=>layer.name === 'memory')?.metrics?.layout ?? [];
    console.log('\naddress space:');
    let previousEnd = 0;
    for (const entry of layout)
    {
        const [name, extent, access] = entry.split(' ');
        const [base, size] = extent.split('+').map((/** @type {string} */ n)=>Number(n));
        if (base > previousEnd)
        {
            console.log(`    ${'—'.padEnd(28)} gap 0x${(base - previousEnd).toString(16)}`);
        }
        console.log(`  0x${base.toString(16).padStart(8, '0')}`
            + `..0x${(base + size).toString(16).padStart(8, '0')}`
            + `  ${name.padEnd(24)} ${access}`);
        previousEnd = Math.max(previousEnd, base + size);
    }
    console.log('');
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
 * What a run spent itself on.
 *
 * The single most useful thing after a run that did not finish: which imports
 * the guest was calling, by count. A program stuck in a loop says so here in
 * one line, where a stack trace only shows where the loop happened to be when
 * it was interrupted.
 *
 * @param {any} app
 */
function report(app, { grep = null, calls = 24 } = {}){
    // Taken once: a snapshot walks every ring it publishes, and asking three
    // times over asks three times as much of the guest's address space.
    const layers = app.diagnostics();
    for (const layer of layers)
    {
        const metrics = layer.metrics ?? {};
        const interesting = Object.entries(metrics)
            .filter(([, value])=>typeof value === 'number' || typeof value === 'string')
            .map(([name, value])=>`${name}=${value}`)
            .join(' ');
        console.log(`  ${layer.name} [${layer.status}] ${interesting}`);
    }

    const bridge = layers
        .find((/** @type {any} */ layer)=>layer.name === 'bridge')?.metrics ?? {};
    // Read backwards from the failure: what was asked, and what it was told.
    // Names alone say what a program was doing; these say whether an answer was
    // wrong rather than missing.
    //
    // First the order they arrived in. The histogram further down says what the
    // program did; this says what it was doing, which is the question a failure
    // asks.
    const sequence = bridge.sequence ?? [];
    if (sequence.length > 0)
    {
        console.log('\n  in order:');
        for (let at = 0; at < sequence.length; at += 6)
        {
            console.log(`    ${sequence.slice(at, at + 6).join('  ')}`);
        }
        console.log('');
    }

    const detailed = (bridge.recentDetailed ?? [])
        .filter((/** @type {any} */ call)=>grep === null || call.name.includes(grep));
    for (const call of detailed.slice(-calls))
    {
        // An argument that points at text is shown as the text. A trace of
        // raw dwords says a library was asked for and not which one.
        const args = call.args.map((/** @type {number} */ a, /** @type {number} */ index)=>(
            call.strings?.[index]
                ? JSON.stringify(call.strings[index])
                : `0x${(a >>> 0).toString(16)}`)).join(', ');
        const from = `0x${(call.from >>> 0).toString(16).padStart(8, '0')}`;
        // The error the call left behind, when it left one. That is where a
        // code a program complains about much later actually came from.
        const left = call.error ? `  [err ${call.error}]` : '';
        console.log(`    ${from}  ${call.name}(${args}) = ${call.result}${left}`);
    }

    const hottest = bridge.hot ?? [];
    if (hottest.length > 0)
    {
        console.log('\n  what it was calling, most recent first:');
        for (const [name, count] of hottest)
        {
            console.log(`    ${String(count).padStart(5)}  ${name}`);
        }
    }
}

async function main(){
    const { id, turns, map, grep, calls, heap } = parse(process.argv.slice(2));
    if (!id)
    {
        console.error('usage: node tools/launch-probe.mjs <bundle-id> [--turns N]');
        process.exit(2);
    }

    const directory = new URL(`${id}/`, BUNDLES);
    const manifest = JSON.parse(
        await readFile(new URL('manifest.json', directory), 'utf8'));
    const path = new URL('bundle.btl', directory).pathname.replace(/^\//, '');

    const handle = await (await import('node:fs/promises')).open(path, 'r');
    /** @param {number} offset @param {number} length */
    const fetch = async(offset, length)=>{
        const buffer = Buffer.alloc(length);
        await handle.read(buffer, 0, length, offset);
        return new Uint8Array(buffer);
    };

    console.log(`${manifest.title} ${manifest.version} — ${manifest.entry}`);

    // The tools-side reader takes a path and does its own reading; the engine's
    // takes a range fetcher. Both are used here, over the same file: this one to
    // lift the executable out, the engine's to serve the game its own files.
    const bundle = await openBundle(path);
    const executable = await bundle.read(manifest.entry);
    await bundle.close();
    console.log(`  entry image: ${executable.length} bytes\n`);

    const [wasm] = await Promise.all([readFile(new URL('v86.wasm', PREBUILT))]);
    const app = await createApp({
        executable: new Uint8Array(executable),
        v86: {
            moduleUrl: new URL('libv86.mjs', PREBUILT).href,
            wasmBytes: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength),
        },
        imagePath: `C:\\${manifest.entry}`,
        heapSize: heap,
        // Nothing durable: a probe should not leave a copy of a game behind, and
        // the file is already on this disk.
        bundle: { fetch, store: null, prefetch: false },
        storage: null,
    });

    // Every image, not just the executable. A library the game ships has its own
    // imports into system libraries, and one of those missing is enough to kill
    // its load -- which looks like the library failing rather than like a
    // function nobody wrote.
    const loader = app.diagnostics()
        .find((/** @type {any} */ layer)=>layer.name === 'loader');
    const unresolved = byLibrary(loader?.metrics?.unresolved ?? app.image.unresolved ?? []);
    if (unresolved.length === 0)
    {
        console.log('every import bound.\n');
    }
    else
    {
        const total = unresolved.reduce((sum, [, names])=>sum + names.length, 0);
        console.log(`${total} imports nothing claimed:\n`);
        for (const [dll, names] of unresolved)
        {
            console.log(`  ${dll}  (${names.length})`);
            console.log(`    ${[...new Set(names)].sort().join(', ')}\n`);
        }
    }

    if (map)
    {
        printMap(app);
    }

    /** @type {any[]} */
    const failures = [];
    app.on('error', (/** @type {any} */ payload)=>failures.push(payload));

    // What the program says about itself: OutputDebugString, and anything it
    // writes to a standard handle. Games say a great deal here and it is the
    // cheapest window into a run there is.
    app.attachLog((/** @type {number} */ stream, /** @type {string} */ text)=>{
        process.stdout.write(`  [guest ${stream}] ${text}`);
    });
    // Everything a failing run says about itself. A guest fault reports where
    // the guest stood; a host one reports what threw, and the two are told
    // apart only by looking.
    // What a program asked for by name at run time and did not get. A zero here
    // is a decision the program makes next, and that decision is usually
    // invisible from anywhere else -- most often it calls the pointer anyway.
    app.on('resolved', (/** @type {any} */ asked)=>{
        if (asked.found === 0)
        {
            console.log(`  [missing] ${asked.module}!${asked.name}`);
        }
    });
    // `debug` carries what the program traced about itself, including the text
    // of a message box it is about to put in front of a person -- which is the
    // program's own account of the failure and beats any trace taken outside it.
    for (const name of ['libraries', 'libraries-missing', 'libraries-attached',
        'library-loaded', 'library-missing', 'unimplemented', 'warning', 'debug'])
    {
        app.on(name, (/** @type {any} */ payload)=>
            console.log(`  [${name}] ${JSON.stringify(payload).slice(0, 300)}`));
    }

    let stopped;
    try
    {
        const code = await app.run({ maxTurns: turns });
        stopped = `exited with ${code}`;
    }
    catch (e){
        stopped = /** @type {any} */ (e).message;
    }

    console.log(`stopped: ${stopped}`);

    // What the program wrote. A game of this age keeps its own log, and it
    // says in plain words what it thought went wrong -- which is a better
    // account of a failure than any trace taken from outside it.
    for (const file of app.session.export())
    {
        const text = new TextDecoder('latin1').decode(file.bytes);
        console.log(`\n  ${file.path} (${file.bytes.length} bytes)`);
        console.log(text.split('\n').slice(-40).map(line=>`    ${line}`).join('\n'));
    }

    report(app, { grep, calls });
    for (const failure of failures.slice(0, 3))
    {
        // The trace, not the payload. A dump of the whole event is unreadable
        // and the one thing wanted from it is where the guest was standing.
        const reason = failure.reason ?? failure.error?.reason;
        const said = failure.error?.message ?? failure.message;
        console.log(`  reason: ${reason}${said ? ` — ${said}` : ''}`);
        // Where it threw on our side. A guest trace says where the guest stood,
        // which for a host fault inside a stub is the stub -- true and useless.
        const where = failure.error?.stack ?? failure.stack;
        if (where)
        {
            console.log(String(where).split('\n').slice(0, 8).join('\n'));
        }
        const text = failure.traceText ?? failure.text ?? failure.error?.traceText;
        console.log(text ? `
${text}` : `  ${JSON.stringify(failure).slice(0, 200)}`);
    }

    await app.dispose();
    await handle.close();
}

main().catch(e=>{
    console.error(e);
    process.exit(1);
});
