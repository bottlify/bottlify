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
 *     node tools/launch-probe.mjs <bundle-id> [--turns 200000]
 */

import { createWriteStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { openBundle } from './btl.mjs';
import { createApp } from '../modules/core/src/app.js';
import { peekBytes } from '../modules/core/src/trace.js';
import { placementOf } from '../modules/installer/src/prefix.js';

const BUNDLES = new URL('../bundles/', import.meta.url);

/** @param {string[]} argv */
function parse(argv){
    const id = argv.find(argument=>!argument.startsWith('--'));
    const turns = argv.indexOf('--turns');
    return {
        id,
        turns: turns === -1 ? 200000 : Number(argv[turns + 1]),
        map: argv.includes('--map'),
        // Which executable in the bundle to start. `--which launcher` takes the
        // one the manifest names as such, and any other value is a path in the
        // bundle -- a launcher is a different program from the game it starts,
        // and only running it says whether it runs.
        which: argv.includes('--which') ? argv[argv.indexOf('--which') + 1] : null,
        // Wall seconds the run may take, for a program that waits on a person.
        seconds: argv.includes('--seconds') ? Number(argv[argv.indexOf('--seconds') + 1])
            : undefined,
        // How many processes run at once: a launcher and the game it starts,
        // side by side, each child in a worker of its own.
        concurrency: argv.includes('--concurrency')
            ? Number(argv[argv.indexOf('--concurrency') + 1]) : undefined,
        // The translator's settings for the run, merged over the probe's own
        // (`feed: 'slice'`, `timings: true`, a translation worker), so two
        // settings compare on one title.
        corkConfig: argv.includes('--cork-config')
            ? JSON.parse(argv[argv.indexOf('--cork-config') + 1]) : {},
        // Seconds between rows of the run's time series (0: none). A game is no
        // benchmark's loop that settles once: new code keeps arriving and the
        // translator's relinks, merges and reforms may never settle, which only
        // a row per window shows.
        series: argv.includes('--series') ? Number(argv[argv.indexOf('--series') + 1]) : 0,
        // Which calls to print with their arguments. A name, or a fragment of
        // one, narrows a long trace to the handful that answer the question.
        grep: argv.includes('--grep') ? argv[argv.indexOf('--grep') + 1] : null,
        calls: argv.includes('--calls') ? Number(argv[argv.indexOf('--calls') + 1]) : 24,
        // Every call to a file, not the last few thousand. What a program
        // decided is decided early, and by the time it stops the ring that
        // would have shown it has been overwritten many times over.
        log: argv.includes('--log') ? argv[argv.indexOf('--log') + 1] : null,
        // Addresses to read whenever a traced call matches --grep, as
        // `0x37e9610:16`, comma-separated. A program's decisions live in its
        // own globals, and the moment to look at one is the call that acts on
        // it -- by the time a run stops, shutdown has cleared it.
        peek: argv.includes('--peek')
            ? argv[argv.indexOf('--peek') + 1].split(',').map(one=>{
                const [address, length] = one.split(':');
                return { address: Number(address), length: Number(length ?? 32) };
            })
            : [],
        // Which of a game's own libraries to watch calls into, as `Engine.dll`
        // for all of one library's exports or `MSVCR80.dll!toupper` for a
        // single function, comma-separated.
        watch: argv.includes('--watch')
            ? argv[argv.indexOf('--watch') + 1].split(',')
            : [],
        // Sizing the guest's heap from the command line, so that "it ran out
        // of memory" can be tested rather than argued about.
        // Sampled guest execution. A program that decides something inside its
        // own code makes no host call to record, so the instruction pointer is
        // the only account of what it was doing.
        profile: argv.includes('--profile')
            ? Number(argv[argv.indexOf('--profile') + 1] || 2000)
            : 0,
        heap: argv.includes('--heap')
            ? Number(argv[argv.indexOf('--heap') + 1]) * 1024 * 1024
            : undefined,
        // Without a GPU every OpenGL primitive is rasterised on the processor,
        // which past a title's load is most of the thread: off, a run measures
        // the program and the layers instead (the graphics layer's `raster`).
        raster: !argv.includes('--no-raster'),
    };
}

/**
 * One host call as a line: where it was called from, what it was given, what it
 * answered, and what error it left behind.
 *
 * @param {any} call
 * @returns {string}
 */
function formatCall(call){
    // An argument that points at text is shown as the text. A trace of raw
    // dwords says a library was asked for and not which one.
    const args = call.args.map((/** @type {number} */ a, /** @type {number} */ index)=>(
        call.strings?.[index]
            // The address too: where a string lives says who built it, and
            // that is usually the question when the text is wrong.
            ? `${JSON.stringify(call.strings[index])}@0x${(a >>> 0).toString(16)}`
            : `0x${(a >>> 0).toString(16)}`)).join(', ');
    const from = `0x${(call.from >>> 0).toString(16).padStart(8, '0')}`;
    // The error the call left behind, when it left one. That is where a code a
    // program complains about much later actually came from.
    const left = call.error ? `  [err ${call.error}]` : '';
    return `${from}  ${call.name}(${args}) = ${call.result}${left}`;
}

/**
 * Whether an import is one `--watch` named, by library or by exact function.
 *
 * @param {string[]} watch
 * @returns {(dll: string, name: string | null, ordinal: number | null)
 *     => ({ args: number } | null)}
 */
function watching(watch){
    return (dll, name, ordinal)=>{
        const full = `${dll}!${name ?? `#${ordinal}`}`.toLowerCase();
        const asked = watch.some(one=>full === one.toLowerCase()
            || dll.toLowerCase() === one.toLowerCase());
        // Six arguments read from every watched call, which is what a trace
        // shows anyway. The count does not have to be right: a watch forwards
        // into the real function rather than returning, so it never has a
        // stack to clean up.
        return asked ? { args: 6 } : null;
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

/**
 * Where the guest spent its instructions, by module and offset.
 *
 * The histogram says which code a program was running; the tail says what it
 * was doing last, which for a program that gives up on its own computed state
 * is the only account there is. Offsets are rounded, because a sample lands
 * wherever a slice happened to end and the question is which function, not
 * which instruction.
 *
 * @param {any} app @param {number[]} samples
 */
function printProfile(app, samples){
    const layout = app.diagnostics()
        .find((/** @type {any} */ layer)=>layer.name === 'memory')?.metrics?.layout ?? [];
    /** @type {{ name: string, base: number, end: number }[]} */
    const regions = layout.map((/** @type {string} */ entry)=>{
        const [name, extent] = entry.split(' ');
        const [base, size] = extent.split('+').map((/** @type {string} */ n)=>Number(n));
        return { name, base, end: base + size };
    }).sort((/** @type {any} */ a, /** @type {any} */ b)=>a.base - b.base);

    /** @param {number} address */
    const describe = address=>{
        const region = regions.find(entry=>address >= entry.base && address < entry.end);
        return region
            ? `${region.name}+0x${(address - region.base).toString(16)}`
            : `0x${address.toString(16)} <unmapped>`;
    };
    /** @param {number} address */
    const bucket = address=>{
        const region = regions.find(entry=>address >= entry.base && address < entry.end);
        return region
            ? `${region.name}+0x${((address - region.base) & ~0xfff).toString(16)}`
            : '<unmapped>';
    };

    /** @type {Map<string, number>} */
    const counts = new Map();
    for (const eip of samples)
    {
        const key = bucket(eip);
        counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    console.log(`\nguest execution, ${samples.length} samples by page:`);
    for (const [where, count] of [...counts].sort((a, b)=>b[1] - a[1]).slice(0, 20))
    {
        const share = (count * 100 / samples.length).toFixed(1);
        console.log(`    ${String(count).padStart(6)}  ${share.padStart(5)}%  ${where}`);
    }

    // And the same again at instruction granularity. A page says which
    // function; an address says which loop, and a program that has given up is
    // usually sitting in one.
    /** @type {Map<string, number>} */
    const exact = new Map();
    for (const eip of samples)
    {
        const key = describe(eip);
        exact.set(key, (exact.get(key) ?? 0) + 1);
    }
    console.log('\n  the addresses it sat on:');
    for (const [where, count] of [...exact].sort((a, b)=>b[1] - a[1]).slice(0, 12))
    {
        const share = (count * 100 / samples.length).toFixed(1);
        console.log(`    ${String(count).padStart(6)}  ${share.padStart(5)}%  ${where}`);
    }

    console.log('\n  last seen, oldest first:');
    for (const eip of samples.slice(-24))
    {
        console.log(`    ${describe(eip)}`);
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

    // What each thread is doing, and what a blocked one is blocked on. A
    // program spinning on a flag another thread should set looks healthy from
    // every other angle: the counters climb, the calls keep coming, and the
    // one fact that explains it is which threads cannot run.
    const kernel = layers
        .find((/** @type {any} */ layer)=>layer.name === 'kernel')?.metrics ?? {};
    if (kernel.byState || (kernel.waiting ?? []).length > 0)
    {
        console.log(`
  threads: ${JSON.stringify(kernel.byState ?? {})}`);
        for (const waiting of kernel.waiting ?? [])
        {
            console.log(`    blocked  ${waiting}`);
        }
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
        console.log(`    ${formatCall(call)}`);
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

/**
 * @typedef {Object} SeriesPoint
 * @property {number} at  wall milliseconds since the run began
 * @property {number} instructions
 * @property {Record<string, number>} cork  the translator's cumulative counts
 */

/** The translator's counts a row takes the difference of. */
const SERIES_COUNTS = ['regions', 'relinks', 'relinked', 'merges', 'reforms', 'copied',
    'invalidations', 'workerMs', 'translateMs'];

/**
 * Prints one row of the run's time series -- what the guest ran and what the
 * translator did since the row before -- and answers the point it was taken at.
 *
 * @param {any} app
 * @param {SeriesPoint | null} last
 * @param {number} began  `performance.now()` when the run began
 * @returns {SeriesPoint}
 */
function seriesRow(app, last, began){
    const layers = app.diagnostics();
    /** @param {string} name */
    const metricsOf = name=>layers.find((/** @type {any} */ layer)=>layer.name === name)
        ?.metrics ?? {};
    const cpu = metricsOf('cpu');
    const kernel = metricsOf('kernel');
    const corkNow = cpu.cork ?? {};
    /** @type {Record<string, number>} */
    const cork = { untranslated: corkNow.exits?.untranslated ?? 0 };
    for (const name of SERIES_COUNTS)
    {
        cork[name] = Number(corkNow[name] ?? 0);
    }
    const point = { at: performance.now() - began, instructions: Number(cpu.instructions ?? 0),
        cork };
    const seconds = (point.at - (last?.at ?? 0)) / 1000;
    const ran = point.instructions - (last?.instructions ?? 0);
    /** @param {string} name */
    const grew = name=>cork[name] - (last?.cork[name] ?? 0);
    console.log(`  series t=${(point.at / 1000).toFixed(0)}s`
        + ` mips=${(ran / seconds / 1e6).toFixed(1)}`
        + ` untranslatedPerM=${ran > 0 ? (grew('untranslated') / ran * 1e6).toFixed(0) : '-'}`
        + ` share=${((corkNow.translatedShare ?? 0) * 100).toFixed(1)}%`
        + SERIES_COUNTS.map(name=>` ${name}+${Math.round(grew(name))}`).join('')
        + ` worstSliceMs=${kernel.worstSliceMs ?? '-'}`);
    return point;
}

async function main(){
    const { id, turns, map, grep, calls, heap, profile, log, watch, peek, which,
        corkConfig, series, raster, concurrency, seconds } = parse(process.argv.slice(2));
    if (!id)
    {
        console.error('usage: node tools/launch-probe.mjs <bundle-id> [--turns N] '
            + '[--which launcher|<path in bundle>]');
        process.exit(2);
    }

    const directory = new URL(`${id}/`, BUNDLES);
    const manifest = JSON.parse(
        await readFile(new URL('manifest.json', directory), 'utf8'));
    const path = fileURLToPath(new URL('bundle.btl', directory));

    const handle = await (await import('node:fs/promises')).open(path, 'r');
    /** @param {number} offset @param {number} length */
    const fetch = async(offset, length)=>{
        const buffer = Buffer.alloc(length);
        await handle.read(buffer, 0, length, offset);
        return new Uint8Array(buffer);
    };

    // Which executable to start. A bundle names the game, but it may also name
    // a launcher, and the launcher is a different program with a different
    // start-up -- so "the game runs" says nothing about whether the launcher
    // does, and finding that out has to be askable.
    const wanted = which === 'launcher'
        ? manifest.launcher ?? manifest.entry
        : which ?? manifest.entry;

    console.log(`${manifest.title} ${manifest.version} — ${wanted}`);

    // The tools-side reader takes a path and does its own reading; the engine's
    // takes a range fetcher. Both are used here, over the same file: this one to
    // lift the executable out, the engine's to serve the game its own files.
    const bundle = await openBundle(path);
    const executable = await bundle.read(wanted);
    await bundle.close();
    console.log(`  entry image: ${executable.length} bytes\n`);

    /** Every instruction pointer the sampler saw, in order. @type {number[]} */
    const samples = [];

    const sink = log ? createWriteStream(log) : null;

    const placement = placementOf(manifest);
    const app = await createApp({
        executable: new Uint8Array(executable),
        // Where the bundle is mounted and the program started from: where its
        // installation put it, when the manifest says, as the launcher does.
        imagePath: placement.imagePath,
        // No frames here to feed the translator between: it takes its
        // candidates inside the slice.
        cork: { config: { feed: 'slice', timings: true,
            // Emitting on a translation worker, as a page does: inline, the
            // engine thread would carry the whole emission a browser moves off it.
            worker: true, workerUrl: new URL('../modules/cork/src/runtime/translator.worker.js',
                import.meta.url).href,
            ...corkConfig } },
        heapSize: heap,
        ...concurrency ? { concurrency } : {},
        ...(raster ? {} : { graphics: { raster: false } }),
        quantum: profile > 0 ? profile : undefined,
        sample: profile > 0 ? (/** @type {number} */ eip)=>samples.push(eip) : undefined,
        // A probe is read afterwards, which is exactly when a stack string is gone.
        traceStrings: true,
        onCall: sink || peek.length > 0
            ? (/** @type {any} */ call)=>{
                sink?.write(`${formatCall(call)}\n`);
                if (peek.length === 0 || grep === null || !call.name.includes(grep))
                {
                    return;
                }
                console.log(`  ${formatCall(call)}`);
                for (const { address, length } of peek)
                {
                    const rows = peekBytes(
                        { memory: { readBytes: app.debug.read } }, address, length);
                    for (const row of rows ?? ['unreadable'])
                    {
                        console.log(`      0x${address.toString(16)}  ${row}`);
                    }
                }
            }
            : undefined,
        watchImport: watch.length === 0 ? undefined : watching(watch),
        // Nothing durable: a probe should not leave a copy of a game behind, and
        // the file is already on this disk.
        bundle: { fetch, store: null, prefetch: false, prefix: placement.prefix },
        storage: null,
    });

    // Every image, not just the executable. A library the game ships has its own
    // imports into system libraries, and one of those missing is enough to kill
    // its load -- which looks like the library failing rather than like a
    // function nobody wrote.
    const loader = app.diagnostics()
        .find((/** @type {any} */ layer)=>layer.name === 'loader');
    const unresolved = byLibrary(loader?.metrics?.unresolved ?? app.image?.unresolved ?? []);
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
    // What a watched guest function answered. The call itself is recorded when
    // it is made, because that is where it belongs in the order; the answer
    // arrives later and is a line of its own.
    app.on('guest-return', (/** @type {any} */ done)=>{
        const line = `            ${done.name} -> 0x${done.result.toString(16)}`;
        sink?.write(`${line}
`);
        if (grep !== null && done.name.includes(grep))
        {
            console.log(line);
        }
    });
    for (const name of ['libraries', 'libraries-missing', 'libraries-attached',
        'library-loaded', 'library-missing', 'unimplemented', 'warning', 'debug'])
    {
        app.on(name, (/** @type {any} */ payload)=>
            console.log(`  [${name}] ${JSON.stringify(payload).slice(0, 300)}`));
    }

    let stopped;
    const began = performance.now();
    /** @type {SeriesPoint | null} */
    let last = null;
    const timer = series > 0
        ? setInterval(()=>{
            last = seriesRow(app, last, began);
        }, series * 1000)
        : null;
    try
    {
        const code = await app.run({ maxTurns: turns,
            ...seconds ? { timeoutMs: seconds * 1000 } : {} });
        stopped = `exited with ${code}`;
    }
    catch (e){
        stopped = /** @type {any} */ (e).message;
    }
    finally
    {
        if (timer !== null)
        {
            clearInterval(timer);
            seriesRow(app, last, began);
        }
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

    if (profile > 0)
    {
        printProfile(app, samples);
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

    sink?.end();
    await app.dispose();
    await handle.close();
}

main().catch(e=>{
    console.error(e);
    process.exit(1);
});
