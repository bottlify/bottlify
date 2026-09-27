/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Runs an installer in Node, unattended, and says what every process of it is
 * doing while it runs: each process's threads by state, what they wait on, the
 * host calls parked and for how long, the last call -- every `--every` seconds.
 * An install several processes deep that has stopped shows here which process
 * waits on which; the facade alone speaks for one of them.
 *
 *   node tools/install-watch.mjs <setup.exe> [--every 30] [--minutes 20]
 *       [--journal SECONDS] [--memory MB] [--key Code@S]... [--click X,Y@S]...
 *       [--shots DIR] [--list 'C:\Program Files'] [--collect]
 *
 * `--journal S` prints, S seconds in, the last cross-process COM calls and
 * message waits from the call journal (every call area on).
 *
 * A wizard waits in its own message loop rather than in a modal dialog an
 * unattended run answers, so a route through one is given as input: `--key
 * Enter@40` presses a key (a `KeyboardEvent.code`) forty seconds in, `--click
 * 320,400@55` clicks at a point of the screen. Each goes to the process the
 * facade stands for, which is the newest one standing. Every status line is
 * followed by that process's visible windows, one a line, children indented:
 * what a person would have seen at that moment. `--shots DIR` writes the
 * desktop the facade's process paints into as a PNG at every status, which is
 * what a person would have seen, pixel for pixel. `--list DIR` prints the
 * files under a directory of the volume once the run is over -- what an
 * install left behind, which is what a bottle is made of. `--collect` takes
 * that prefix off the finished run as the installer's own wizard does
 * (`collectFrom`) and says which root, entry and files a bottle would get.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { createApp } from '../modules/core/src/app.js';
import { collectFrom, prefixOptions } from '../modules/installer/src/index.js';

const argv = process.argv.slice(2);
/** @param {string} flag @param {number} fallback */
const number = (flag, fallback)=>{
    const at = argv.indexOf(flag);
    return at >= 0 ? Number(argv[at + 1]) : fallback;
};
const file = argv.find(argument=>!argument.startsWith('--') && !/^\d+$/.test(argument));
if (!file)
{
    console.log('usage: node tools/install-watch.mjs <setup.exe> [--every S] [--minutes M]'
        + ' [--journal S] [--memory MB]');
    process.exit(2);
}
const every = number('--every', 30);
const shotsAt = argv.includes('--shots') ? argv[argv.indexOf('--shots') + 1] : null;

/**
 * Every value a repeatable flag was given.
 *
 * @param {string} flag
 */
const all = flag=>argv.flatMap((argument, index)=>argument === flag && index + 1 < argv.length
    ? [argv[index + 1]] : []);
const journalAt = number('--journal', 0);
const memory = number('--memory', 0);
const listAt = argv.includes('--list') ? argv[argv.indexOf('--list') + 1] : null;

const media = { name: basename(file), bytes: new Uint8Array(readFileSync(file)) };
const prefix = prefixOptions(media);
const started = Date.now();
const seconds = ()=>((Date.now() - started) / 1000).toFixed(1);
const app = await createApp({
    executable: prefix.executable,
    imagePath: prefix.imagePath,
    storage: prefix.storage,
    engine: 'cork',
    graphics: { raster: false },
    unattended: true,
    ...memory > 0 ? { memorySize: memory * 1048576 } : {},
    ...journalAt > 0 ? { log: { capacity: 100000, categories: {
        'call.cpu': 'trace', 'call.com': 'trace', 'call.gpu': 'trace', 'call.input': 'trace',
    } } } : {},
});
for (const name of ['process-create', 'process-started', 'process-resumed', 'process-server',
    'process-server-exit', 'error', 'exit', 'divergence', 'message-box', 'unimplemented'])
{
    app.on(name, (/** @type {any} */ event)=>console.log(seconds(), name,
        JSON.stringify(event, (key, value)=>(key === 'error' && value
            ? String(value.stack ?? value).slice(0, 800) : value))?.slice(0, 900)));
}

// Bound and never called is ordinary -- a program imports far more than it
// calls -- so these are counted and said once, at the end, per library.
/** @type {Map<string, string[]>} */
const unresolved = new Map();
app.on('import-unresolved', (/** @type {any} */ event)=>{
    const [library, name] = String(event.import).split('!');
    unresolved.set(library, [...unresolved.get(library) ?? [], name]);
});

/**
 * The windows a process shows, as lines: its visible top-level windows and,
 * under each, its visible children, with where they are and what they say.
 *
 * @param {any[]} windows
 */
const describeWindows = windows=>{
    const shown = windows.filter(window=>window.visible);
    /** @type {string[]} */
    const lines = [];
    /** @param {any} window @param {number} depth */
    const add = (window, depth)=>{
        lines.push(`${'  '.repeat(depth + 1)}${window.hwnd} ${window.className}`
            + ` "${String(window.title).slice(0, 80)}" ${window.x},${window.y}`
            + ` ${window.width}x${window.height} ${window.style ?? ''}/${window.exStyle ?? ''}`);
        for (const child of shown.filter(other=>other.parent === window.hwnd))
        {
            add(child, depth + 1);
        }
    };
    for (const top of shown.filter(window=>!window.child))
    {
        add(top, 0);
    }
    return lines;
};

/** @param {Uint8Array} bytes @returns {number} */
const crc32 = bytes=>{
    let crc = ~0;
    for (const byte of bytes)
    {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit++)
        {
            crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
        }
    }
    return ~crc >>> 0;
};

/**
 * A 32-bit DIB's pixels -- blue, green, red, unused -- as an opaque PNG.
 *
 * @param {{ width: number, height: number, pitch: number, bytes: Uint8Array }} surface
 */
const png = ({ width, height, pitch, bytes })=>{
    const stride = width * 4 + 1;
    const raw = Buffer.alloc(stride * height);
    for (let y = 0; y < height; y++)
    {
        for (let x = 0; x < width; x++)
        {
            const from = y * pitch + x * 4;
            const to = y * stride + 1 + x * 4;
            raw[to] = bytes[from + 2];
            raw[to + 1] = bytes[from + 1];
            raw[to + 2] = bytes[from];
            raw[to + 3] = 0xff;
        }
    }
    /** @param {string} type @param {Buffer} body */
    const chunk = (type, body)=>{
        const head = Buffer.alloc(8);
        head.writeUInt32BE(body.length, 0);
        head.write(type, 4, 'latin1');
        const crc = Buffer.alloc(4);
        crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
        return Buffer.concat([head, body, crc]);
    };
    const header = Buffer.alloc(13);
    header.writeUInt32BE(width, 0);
    header.writeUInt32BE(height, 4);
    header[8] = 8;
    header[9] = 6;
    return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
};

if (shotsAt)
{
    mkdirSync(shotsAt, { recursive: true });
}

/** @param {string} spec @returns {{ at: number, what: string }} */
const timed = spec=>{
    const [what, at] = spec.split('@');
    return { what, at: Number(at) };
};
for (const { what, at } of all('--key').map(timed))
{
    setTimeout(()=>{
        console.log(seconds(), 'KEY', what);
        app.input.send({ kind: 'key', code: what, down: true });
        setTimeout(()=>app.input.send({ kind: 'key', code: what, down: false }), 150);
    }, at * 1000);
}
for (const { what, at } of all('--click').map(timed))
{
    const [x, y] = what.split(',').map(Number);
    setTimeout(()=>{
        console.log(seconds(), 'CLICK', x, y);
        app.input.send({ kind: 'pointerMove', x, y });
        app.input.send({ kind: 'pointerButton', button: 'left', down: true });
        setTimeout(()=>app.input.send({ kind: 'pointerButton', button: 'left', down: false }),
            150);
    }, at * 1000);
}

/**
 * Each process's reading of where its slices went, by address bucket, at the
 * last status: the difference to the next one is where it ran in between.
 *
 * @type {Map<string, Map<number, number>>}
 */
const lastSamples = new Map();

/**
 * Where a process ran since the last status, the busiest buckets first, each
 * with the image it falls in when the facade's process is the one asked.
 *
 * @param {string} image @param {any} cpu
 */
const ranSince = (image, cpu)=>{
    /** @type {Map<number, number>} */
    const now = new Map((cpu.samples?.top ?? []).map((/** @type {any} */ bucket)=>
        [bucket.address, bucket.instructions]));
    const before = lastSamples.get(image) ?? new Map();
    lastSamples.set(image, now);
    return [...now].map(([address, instructions])=>[address,
        instructions - (before.get(address) ?? 0)])
        .filter(([, grew])=>grew > 0)
        .sort((left, right)=>right[1] - left[1])
        .slice(0, 6)
        .map(([address, grew])=>{
            const at = app.debug.moduleAt(address);
            return `0x${address.toString(16)}${at ? `(${at.name.split('\\').pop()}`
                + `+0x${at.offset.toString(16)})` : ''}:${grew}`;
        });
};

setInterval(async()=>{
    try
    {
        for (const { image, diagnostics } of await app.standing())
        {
            /** @param {string} layer */
            const metrics = layer=>diagnostics.find((/** @type {any} */ entry)=>
                entry.name === layer)?.metrics ?? {};
            const kernel = metrics('kernel');
            const bridge = metrics('bridge');
            const win32 = metrics('win32');
            console.log(seconds(), 'STATUS', image.split('\\').pop(), JSON.stringify({
                threads: kernel.byState, waiting: kernel.waiting, turns: kernel.turns,
                calls: bridge.calls, lastCall: bridge.lastCall,
                suspended: bridge.suspendedCalls, windows: win32.windows,
                procedures: win32.windowProcedures, messages: win32.messages,
            }).slice(0, 1500));
            const cpu = metrics('cpu');
            console.log(seconds(), 'CPU', image.split('\\').pop(), JSON.stringify({
                recent: (cpu.recent ?? []).slice(-4), ran: ranSince(image, cpu),
                traps: `${cpu.traps}/${cpu.trapCapacity}`,
                refused: bridge.comInterfacesRefused, because: bridge.comRefusedBecause,
            }));
            for (const line of describeWindows(win32.windows ?? []))
            {
                console.log(seconds(), 'WINDOW', line);
            }
        }
        const desktop = shotsAt ? app.debug.desktop() : null;
        if (shotsAt && desktop)
        {
            const name = join(shotsAt, `${seconds().padStart(6, '0')}.png`);
            writeFileSync(name, png(desktop));
            console.log(seconds(), 'SHOT', name);
        }
    }
    catch (e){
        console.log('status failed:', e instanceof Error ? e.message : e);
    }
}, every * 1000);

if (journalAt > 0)
{
    setTimeout(()=>{
        const crossing = /OleMainThread|CoWait|MsgWait|PostMessage|PostThread|SendMessage|WaitFor/;
        const trail = app.log.recent(100000).filter((/** @type {any} */ entry)=>
            entry.category === 'call.com' || crossing.test(entry.text));
        for (const entry of trail.slice(-150))
        {
            console.log('JOURNAL', (entry.time / 1000).toFixed(2), entry.text.slice(0, 220));
        }
    }, journalAt * 1000);
}

try
{
    console.log('run ->', await app.run({ maxTurns: Number.MAX_SAFE_INTEGER,
        timeoutMs: number('--minutes', 20) * 60000 }));
}
catch (e){
    console.log('stopped:', e instanceof Error ? e.stack?.slice(0, 1500) : e);
}
if (listAt)
{
    /** @param {string} directory */
    const walk = directory=>{
        for (const entry of app.files.list(directory))
        {
            console.log('FILE', entry.directory ? '<dir>' : String(entry.size).padStart(10),
                entry.path);
            if (entry.directory)
            {
                walk(entry.path);
            }
        }
    };
    try
    {
        walk(listAt);
    }
    catch (e){
        console.log('list failed:', e instanceof Error ? e.message : e);
    }
}
if (argv.includes('--collect'))
{
    try
    {
        const collected = collectFrom(app, media);
        const bytes = collected.files.reduce((total, one)=>total + one.bytes.length, 0);
        console.log('COLLECT root', collected.root, 'entry', collected.entry,
            'files', collected.files.length, 'bytes', bytes, 'outside', collected.outside.length);
        for (const one of collected.files.slice(0, 60))
        {
            console.log('COLLECT file', String(one.bytes.length).padStart(10), one.path);
        }
    }
    catch (e){
        console.log('collect failed:', e instanceof Error ? e.message : e);
    }
}
for (const [library, names] of unresolved)
{
    console.log('unresolved', library, names.length, names.slice(0, 40).join(' '));
}
console.log('seconds', seconds());
process.exit(0);
