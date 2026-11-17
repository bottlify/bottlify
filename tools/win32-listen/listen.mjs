/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Listens to a program at the system's door: runs it in Node, headless and
 * unattended, and writes down every request it makes of the engine's Windows
 * -- each host call with its caller, arguments (text where an argument was
 * text), answer, last error and thread -- plus the run's events (processes,
 * message boxes, unimplemented entries, unresolved imports, the exit).
 *
 * It only listens. The answers are the engine's own, whatever this build gives;
 * nothing here changes one. What a program does without calling anything --
 * its own code, and the calls the engine answers in guest code (heap, SList,
 * slim locks, and the handle words below unless turned off) -- is not heard.
 *
 *   node tools/win32-listen/listen.mjs <program.exe>
 *       [--dir DIR]         every file of DIR put beside the program first
 *       [--out DIR]         where calls.jsonl, events.jsonl and summary.txt go (dbg/listen)
 *       [--seconds 120]     wall-clock bound of the run
 *       [--turns N]         scheduler turns bound of the run
 *       [--args '...']      what follows the program's path on its command line
 *       [--guest-words]     keep the handle words answered in the guest (faster, quieter)
 *       [--print REGEX]     also print matching calls as they happen
 *       [--tail 40]         how many of the last calls to print when the run ends
 *
 * `calls.jsonl` is one call a line in the order they happened across every
 * process and thread, `timeline.txt` the same as text; `summary.txt` is each
 * request once, by family (`classify.mjs`); `events.jsonl` is the engine's
 * events. The last calls are printed when the run ends, since what a program
 * did just before it stopped is the first thing asked of a run.
 */

import { createWriteStream, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync }
    from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createApp } from '../../modules/core/src/app.js';
import { prefixOptions } from '../../modules/installer/src/index.js';
import { formatCall, renderSummary, summarize } from './classify.mjs';

const argv = process.argv.slice(2);
/** @param {string} flag */
const option = flag=>(argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined);
const FLAGS_WITH_VALUE = new Set(['--dir', '--out', '--seconds', '--turns', '--args', '--print',
    '--tail']);
const program = argv.find((argument, index)=>!argument.startsWith('--')
    && !FLAGS_WITH_VALUE.has(argv[index - 1]));
if (!program)
{
    console.error('usage: node tools/win32-listen/listen.mjs <program.exe> [--dir DIR] [--out DIR]'
        + ' [--seconds N] [--turns N] [--args STRING] [--guest-words] [--print REGEX]');
    process.exit(2);
}
const out = resolve(option('--out') ?? 'dbg/listen');
mkdirSync(out, { recursive: true });
const seconds = Number(option('--seconds') ?? 120);
const turns = Number(option('--turns') ?? Number.MAX_SAFE_INTEGER);
const printing = option('--print') ? new RegExp(String(option('--print'))) : null;

/**
 * The files a program expects beside it, by name: a directory's own files,
 * not its subdirectories, which is what "beside" means to a loader.
 *
 * @param {string | undefined} directory
 */
const siblings = directory=>(directory === undefined ? [] : readdirSync(directory)
    .filter(name=>statSync(join(directory, name)).isFile())
    .map(name=>({ name, bytes: new Uint8Array(readFileSync(join(directory, name))) })));

const media = {
    name: basename(program),
    bytes: new Uint8Array(readFileSync(program)),
    files: siblings(option('--dir')),
};
const prefix = /** @type {any} */ (prefixOptions(media));

const calls = createWriteStream(join(out, 'calls.jsonl'));
const events = createWriteStream(join(out, 'events.jsonl'));
/** @type {import('./classify.mjs').CallEntry[]} */
const entries = [];
let seq = 0;
const started = performance.now();
const now = ()=>Math.round((performance.now() - started) * 1000) / 1000;

/**
 * A call as the bridge hands it: the record is the bridge's own and written
 * over by the next call, so what is kept is copied out here.
 *
 * @param {any} record
 */
const onCall = record=>{
    /** @type {import('./classify.mjs').CallEntry} */
    const entry = {
        seq: seq++,
        t: now(),
        name: record.name,
        from: record.from >>> 0,
        args: [...record.args],
        strings: record.strings ? [...record.strings].map(text=>text ?? null) : null,
        kind: record.kind,
        thread: record.thread ?? null,
        image: record.image ?? null,
    };
    if (record.answer !== undefined)
    {
        entry.answer = record.answer >>> 0;
    }
    else if (typeof record.result === 'string' && /^0x[0-9a-f]+/.test(record.result))
    {
        entry.answer = Number.parseInt(record.result, 16) >>> 0;
    }
    if (record.error)
    {
        entry.error = record.error;
    }
    entries.push(entry);
    calls.write(`${JSON.stringify(entry)}\n`);
    if (printing && printing.test(entry.name))
    {
        console.log(formatCall(entry));
    }
};

const app = await createApp({
    executable: prefix.executable,
    imagePath: prefix.imagePath,
    ...argv.includes('--args')
        ? { commandLine: `"${prefix.imagePath}" ${option('--args')}` } : {},
    storage: prefix.storage,
    engine: 'cork',
    unattended: true,
    traceStrings: true,
    // Waits and event signals answered in the guest never reach the sink;
    // a listener wants them heard unless asked to run as a player does.
    ...argv.includes('--guest-words') ? {} : { win32: { handleWords: false } },
    onCall,
});

for (const name of ['process-create', 'process-started', 'process-exit', 'exit', 'error',
    'divergence', 'message-box', 'unimplemented', 'import-unresolved'])
{
    app.on(name, (/** @type {any} */ event)=>{
        const line = JSON.stringify({ seq: seq++, t: now(), event: name, detail: event },
            (key, value)=>(value instanceof Error ? String(value.stack ?? value).slice(0, 2000)
                : typeof value === 'bigint' ? String(value) : value));
        events.write(`${line}\n`);
        console.log(line.slice(0, 600));
    });
}

console.log(`listening: ${prefix.imagePath}, ${media.files.length} files beside it, out ${out}`);
/** @type {any} */
let result;
try
{
    result = await app.run({ maxTurns: turns, timeoutMs: seconds * 1000 });
}
catch (e){
    result = { threw: e instanceof Error ? String(e.stack).slice(0, 3000) : String(e) };
}
const elapsed = now();
await new Promise(done=>calls.end(done));
await new Promise(done=>events.end(done));
const header = [
    `program ${prefix.imagePath}`,
    `run ${JSON.stringify(result, (key, value)=>(typeof value === 'bigint' ? String(value) : value))
        ?.slice(0, 4000)}`,
    `calls ${entries.length} in ${(elapsed / 1000).toFixed(1)} s`,
    '',
].join('\n');
writeFileSync(join(out, 'summary.txt'), header + renderSummary(summarize(entries)));
writeFileSync(join(out, 'timeline.txt'), `${entries.map(formatCall).join('\n')}\n`);
const tail = Number(option('--tail') ?? 40);
console.log(`last ${Math.min(tail, entries.length)} calls:`);
for (const entry of entries.slice(-tail))
{
    console.log(formatCall(entry));
}
console.log(header);
console.log(`written: ${['calls.jsonl', 'timeline.txt', 'events.jsonl', 'summary.txt']
    .map(name=>join(out, name)).join(', ')}`);
process.exit(0);
