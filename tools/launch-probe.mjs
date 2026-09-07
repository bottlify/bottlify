/*
 * Copyright © 2026 Bottlify Project
 * Licensed under BSD-2-Clause License
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
    };
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
function report(app){
    for (const layer of app.diagnostics())
    {
        const metrics = layer.metrics ?? {};
        const interesting = Object.entries(metrics)
            .filter(([, value])=>typeof value === 'number' || typeof value === 'string')
            .map(([name, value])=>`${name}=${value}`)
            .join(' ');
        console.log(`  ${layer.name} [${layer.status}] ${interesting}`);
    }

    const hottest = app.diagnostics()
        .find((/** @type {any} */ layer)=>layer.name === 'bridge')?.metrics?.hot ?? [];
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
    const { id, turns } = parse(process.argv.slice(2));
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
        // Nothing durable: a probe should not leave a copy of a game behind, and
        // the file is already on this disk.
        bundle: { fetch, store: null, prefetch: false },
        storage: null,
    });

    const unresolved = byLibrary(app.image.unresolved ?? []);
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
    for (const name of ['libraries', 'libraries-missing', 'libraries-attached',
        'library-loaded', 'unimplemented', 'warning'])
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
    report(app);
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
