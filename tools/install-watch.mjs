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
 *   node tools/install-watch.mjs <setup.exe | disc.iso | archive.zip [--entry PATH]>
 *       | --bundle ID [--which PATH]
 *       [--every 30] [--minutes 20]
 *       [--journal SECONDS] [--memory MB] [--key Code@S]... [--click X,Y@S]...
 *       [--shots DIR] [--list 'C:\Program Files'] [--collect]
 *       [--screen 1024x768] [--cat 'C:\WINDOWS\DirectX.log']... [--siblings]
 *       [--copy 'C:\WINDOWS\TEMP' temp]...
 *
 * `--trace-box` prints the trace when the first box reporting an error is
 * shown instead, and `--trace-fault` when a process ends with an exception's
 * code. `--journal S` prints, S seconds in, the last cross-process COM calls and
 * message waits from the call journal (every call area on); `--trace S` prints
 * the last three thousand calls of every kind instead (`--trace-lines N`), with their first
 * arguments -- what a process that loops without waiting keeps calling;
 * `--trace-match REGEX` keeps only the lines that match. A run
 * that ends sooner prints either when it ends. `--strings` peeks every pointer
 * argument for a string, so those lines name the paths and texts themselves.
 *
 * A wizard waits in its own message loop rather than in a modal dialog an
 * unattended run answers, so a route through one is given as input: `--key
 * Enter@40` presses a key (a `KeyboardEvent.code`) forty seconds in, `--click
 * 320,400@55` clicks at a point of the screen, and `--press 'Next >|Finish'`
 * presses buttons by their titles in turn, each once it has stood a whole
 * look. Each goes to the process the facade stands for, which is the newest
 * one standing. Every status line is followed by that process's visible
 * windows, one a line, children indented: what a person would have seen at
 * that moment. `--shots DIR` writes the
 * desktop the facade's process paints into as a PNG at every status, which is
 * what a person would have seen, pixel for pixel. `--list DIR` prints the
 * files under a directory of the volume once the run is over -- what an
 * install left behind, which is what a bottle is made of. `--cat FILE` prints
 * a text file of the volume once the run is over -- the log a setup keeps of
 * what it decided. `--copy DIR TO` writes a directory of the volume out to TO
 * on this machine -- what a setup unpacked, for the PE tools to read. `--peek
 * ADDRESS LENGTH` prints guest memory there once the run is over, and `--args
 * '...'` is what follows the program's own path on its command line. `--registry
 * FILE` writes the registry as it stands once the run is over.
 * `--collect` takes that prefix off the finished run as the installer's own
 * wizard does (`collectFrom`) and says which root, entry and
 * files a bottle would get;
 * `--collect-to DIR` also writes it there, a directory make-btl packs.
 *
 * `--bundle ID` runs an installed program instead (its blocks kept in
 * `bundles/ID/blocks`, or the folder `--blocks DIR` names, between runs), `--file HOST=GUEST` putting
 * a file of this disk on its volume first (`--steam ACCOUNT` signs the run in to
 * Steam as tools/steam-account.mjs's account, for the engine's Steam client;
 * and `--reg 'HKCU\path\name=value'` a
 * registry value, a string or `dword:N`): the bundle in
 * `bundles/ID`, mounted where its installation put it, started at its entry
 * or at `--which`, a path in the bundle -- a launcher's dialog driven by the
 * same keys, clicks and pictures as a wizard's. `--attended` leaves a message
 * box on the desktop for those to answer rather than answering it unseen.
 *
 * `--network ws://host:port/` puts the run on a relay's network
 * (`modules/networking`): Winsock's connections and names go through it, in
 * room `harness`, as game.mjs's do. Without it the machine has the loopback
 * adapter alone. `--roots FILE` adds a PEM bundle's certificates to the
 * machine's trusted roots (tools/relay-option.mjs).
 *
 * `--debug-strings` prints what the programs say through OutputDebugString.
 *
 * `--windows win2000|winxp|win7|win10` is the Windows the machine is, over
 * the one a bundle's manifest names (XP when neither does).
 *
 * `--worker` plays the devices' calls in a graphics worker over the fake GPU,
 * as a page does; `--unshared` keeps guest memory out of a SharedArrayBuffer,
 * as on a page that is not cross-origin isolated; `--cork JSON` sets cork's
 * own settings (`EngineConfig`), and `--graphics JSON` the graphics layer's
 * (`{"guestCode":false}` traps every Direct3D call).
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { deflateSync } from 'node:zlib';
import { openBundle } from './btl.mjs';
import { relayFromArgv, rootsFromArgv } from './relay-option.mjs';
import { diskDirectory } from './disk-directory.mjs';
import { createOpfsStore } from '../modules/core/src/layers/filesystem/internal/opfs-store.js';
import { isButtonClass, label } from './wizard-buttons.mjs';
import { createApp } from '../modules/core/src/app.js';
import { createFakeDevice } from '../modules/core/src/layers/graphics/webgpu/internal/fake-device.js';
import { archiveDisc, collectFrom, discOptions, placementOf, prefixOptions, readZip }
    from '../modules/installer/src/index.js';

const argv = process.argv.slice(2);
/** @param {string} flag @param {number} fallback */
const number = (flag, fallback)=>{
    const at = argv.indexOf(flag);
    return at >= 0 ? Number(argv[at + 1]) : fallback;
};
const bundleId = argv.includes('--bundle') ? argv[argv.indexOf('--bundle') + 1] : null;
const file = bundleId
    ?? argv.find(argument=>!argument.startsWith('--') && !/^\d+$/.test(argument));
if (!file)
{
    console.log('usage: node tools/install-watch.mjs <setup.exe> | --bundle ID [--which PATH]'
        + ' [--every S] [--minutes M] [--journal S] [--memory MB]');
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
const traceAt = number('--trace', 0);
// `--dump-at S`: S seconds in, the next frame with draws written down by the
// devices the graphics worker plays (`--worker`), every draw with its state,
// shaders and textures, into `--dump-to` (dump.txt by default) once the
// worker has sent it.
const dumpAt = number('--dump-at', 0);
const dumpTo = argv.includes('--dump-to') ? argv[argv.indexOf('--dump-to') + 1] : 'dump.txt';
let dumpAsked = false;
let dumpWritten = false;
// `--trace-box`: the trace printed when the first message box is shown --
// the calls that led a setup to the error it reports, which a fixed time
// misses when the box's moment moves from run to run.
const traceOnBox = argv.includes('--trace-box');
// `--trace-fault`: the trace printed when a process ends with an exception's
// code -- the calls that led to a crash nothing reported in a box.
const traceOnFault = argv.includes('--trace-fault');
const journalAt = number('--journal', 0) || traceAt
    || (traceOnBox || traceOnFault ? 1e6 : 0);
const memory = number('--memory', 0);
const listAt = argv.includes('--list') ? argv[argv.indexOf('--list') + 1] : null;
// The launcher hands a program the size of the screen it is on; the engine's
// own default is 640x480, which a wizard laid out for 800x600 overhangs.
const [screenWidth, screenHeight] = argv.includes('--screen')
    ? argv[argv.indexOf('--screen') + 1].split('x').map(Number) : [0, 0];

/**
 * An installed program to start: the bundle's entry, or the path `--which`
 * names in it, at the place its installation put it, the bundle's files read
 * from the file on this disk.
 *
 * @param {string} id
 */
const mountBundle = async id=>{
    const directory = join('bundles', id);
    const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8'));
    const path = join(directory, 'bundle.btl');
    const wanted = argv.includes('--which') ? argv[argv.indexOf('--which') + 1] : manifest.entry;
    const reader = await openBundle(path);
    const executable = new Uint8Array(await reader.read(wanted));
    await reader.close();
    const handle = await open(path, 'r');
    const placement = placementOf({ ...manifest, entry: wanted });
    // `--file HOST=GUEST`: a file of this disk put on the session's volume
    // before the program starts -- a saved game to load, a settings file.
    const seeded = all('--file').map(pair=>{
        const at = pair.indexOf('=');
        return { path: pair.slice(at + 1), bytes: new Uint8Array(readFileSync(pair.slice(0, at))) };
    });
    return {
        executable,
        windows: manifest.windows,
        imagePath: placement.imagePath,
        // Laid over the volume as a person's own edits are (`files`),
        // over whatever session there is rather than as one.
        storage: null,
        files: seeded,
        bundle: {
            /** @param {number} offset @param {number} length */
            fetch: async(offset, length)=>{
                const buffer = Buffer.alloc(length);
                await handle.read(buffer, 0, length, offset);
                return new Uint8Array(buffer);
            },
            // The blocks read kept in a folder (`--blocks DIR`, the bundle's
            // own by default) as a page keeps them in its origin's storage:
            // in memory the pool holds 64 MiB, and a program whose libraries
            // are larger than that fetches and inflates every block again on
            // each pass the loader makes over them.
            store: await createOpfsStore({ root: diskDirectory(argv.includes('--blocks')
                ? argv[argv.indexOf('--blocks') + 1] : join(directory, 'blocks')) }),
            prefetch: false,
            prefix: placement.prefix,
        },
    };
};
// `--siblings`: the files beside the setup go on the medium with it, as an
// unpacked distribution's do -- a setup reads its cabinets from its own place.
const besideSetup = ()=>readdirSync(dirname(file), { withFileTypes: true })
    .filter(one=>one.isFile() && one.name !== basename(file))
    .map(one=>({ name: one.name,
        bytes: new Uint8Array(readFileSync(join(dirname(file), one.name))) }));
/**
 * A disc image, or a zip built into one as the page builds it, mounted as D:
 * with the program it names started from there -- the autorun's, or the one
 * `--entry PATH` names on it.
 */
/** What an install came from, for `--collect`: the setup, or the disc built for it. */
/** @type {any} */
let collectable = null;
const discMedia = async()=>{
    const name = basename(file);
    const bytes = new Uint8Array(readFileSync(file));
    const read = /\.zip$/i.test(name) ? readZip : null;
    const disc = read ? archiveDisc(name, await read(new Blob([bytes]))) : { name, disc: bytes };
    collectable = disc;
    return discOptions(disc, argv.includes('--entry')
        ? { entry: argv[argv.indexOf('--entry') + 1] } : {});
};
const isDisc = !bundleId && /\.(iso|zip)$/i.test(file);
const media = bundleId || isDisc ? null : {
    name: basename(file),
    bytes: new Uint8Array(readFileSync(file)),
    ...argv.includes('--siblings') ? { files: besideSetup() } : {},
};
/** @type {any} */
const prefix = media ? prefixOptions(media) : isDisc ? await discMedia() : await mountBundle(file);
/**
 * `--worker`: the devices draw as a page's do, in a graphics worker -- a
 * worker thread playing their calls over the fake GPU, which this thread
 * stands in front of too.
 */
const graphicsDevice = ()=>{
    const gpu = createFakeDevice();
    const gpuDevice = /** @type {any} */ (gpu.device);
    gpuDevice.features = new Set();
    gpuDevice.createSampler = (/** @type {any} */ descriptor)=>({ kind: 'sampler', descriptor });
    const thread = new Worker(new URL('./fake-graphics-worker.mjs', import.meta.url));
    thread.unref();
    thread.postMessage({ type: 'open', frames: 'none' });
    /** @type {Map<Function, (data: any) => void>} */
    const listeners = new Map();
    return {
        device: gpu.device, queue: gpu.queue, screen: gpu.screen, canvas: gpu.canvas,
        adapter: { vendor: 'fake', architecture: '', description: 'a stand-in' },
        worker: {
            postMessage: (/** @type {any} */ message, /** @type {any} */ transfer)=>
                thread.postMessage(message, transfer),
            addEventListener: (/** @type {string} */ type, /** @type {Function} */ listener)=>{
                const relay = (/** @type {any} */ data)=>listener({ data });
                listeners.set(listener, relay);
                thread.on('message', relay);
            },
            removeEventListener: (/** @type {string} */ type, /** @type {Function} */ listener)=>{
                thread.off('message', /** @type {any} */ (listeners.get(listener)));
            },
        },
    };
};
const network = await relayFromArgv(argv);
const roots = rootsFromArgv(argv);
const started = Date.now();
const seconds = ()=>((Date.now() - started) / 1000).toFixed(1);
// `--steam ACCOUNT`: the signed-in Steam account and the games it owns
// (tools/steam-account.mjs), which the engine's Steam client answers with.
// `--steam-app N` is the app being run, as Steam tells a game it starts.
const steam = argv.includes('--steam')
    ? { ...JSON.parse(readFileSync(argv[argv.indexOf('--steam') + 1], 'utf8')),
        ...argv.includes('--steam-app')
            ? { appId: Number(argv[argv.indexOf('--steam-app') + 1]) } : {} }
    : null;
const app = await createApp({
    win32: { ...network ? { network } : {},
        ...roots ? { trustedRoots: roots } : {}, ...steam ? { steam } : {} },
    executable: prefix.executable,
    imagePath: prefix.imagePath,
    // `--args '...'`: what follows the program's own path on its command line.
    ...'commandLine' in prefix ? { commandLine: prefix.commandLine } : {},
    ...'discs' in prefix ? { discs: prefix.discs } : {},
    ...'startDirectory' in prefix ? { startDirectory: prefix.startDirectory } : {},
    ...argv.includes('--args')
        ? { commandLine: `"${prefix.imagePath}" ${argv[argv.indexOf('--args') + 1]}` } : {},
    storage: prefix.storage,
    ...prefix.files?.length > 0 ? { files: prefix.files } : {},
    ...'bundle' in prefix ? { bundle: prefix.bundle } : {},
    // `--windows NAME`: the Windows the machine is, over the one a bundle's
    // manifest names -- a program that refuses an old one says so first.
    ...argv.includes('--windows') || prefix.windows
        ? { windows: argv.includes('--windows')
            ? argv[argv.indexOf('--windows') + 1] : prefix.windows }
        : {},
    // `--concurrency N`: processes at once, each child in a worker of its
    // own, as a page with concurrency runs them.
    ...argv.includes('--concurrency')
        ? { concurrency: Number(argv[argv.indexOf('--concurrency') + 1]) } : {},
    // `--executors N`: the program's threads on N executors at once, as the
    // player's multi modes run them.
    ...argv.includes('--executors')
        ? { cpu: { cores: Number(argv[argv.indexOf('--executors') + 1]) } } : {},
    // `--unshared`: guest memory not a SharedArrayBuffer, as on a page that is
    // not cross-origin isolated.
    // `--cork JSON`: cork's settings (`EngineConfig`), beside `--unshared`.
    cork: { config: {
        ...argv.includes('--cork') ? JSON.parse(argv[argv.indexOf('--cork') + 1]) : {},
        ...argv.includes('--unshared') ? { sharedMemory: false } : {},
    } },
    // `--graphics JSON`: the graphics layer's settings beside these, `guestCode` among them.
    graphics: { raster: false,
        ...argv.includes('--graphics') ? JSON.parse(argv[argv.indexOf('--graphics') + 1]) : {} },
    ...argv.includes('--worker') ? { device: graphicsDevice() } : {},
    // Nobody at the screen unless `--attended`: then a message box is drawn
    // on the desktop and waits for a key or a click like any dialog.
    unattended: !argv.includes('--attended'),
    ...memory > 0 ? { memorySize: memory * 1048576 } : {},
    ...screenWidth > 0
        ? { screen: { width: screenWidth, height: screenHeight, bitsPerPixel: 32 } } : {},
    // Every pointer argument peeked for a string, so a journal line names
    // the path or the text a call was given: costly, and off unless asked.
    ...argv.includes('--strings') ? { traceStrings: true } : {},
    // The ring holds as many lines as `--trace-lines` asks for: by bytes, a
    // default ring holds a few thousand of them, a fraction of a second of a
    // setup's calls, and the call an error comes of is often seconds before it.
    ...journalAt > 0 ? { log: {
        capacity: Math.max(100000, number('--trace-lines', 0)),
        bytes: Math.max(1 << 20, number('--trace-lines', 0) * 512),
        // Every call area, as the header promises: a program that stops over
        // its sockets or its sound leaves nothing to read otherwise.
        categories: {
            'call.cpu': 'trace', 'call.com': 'trace', 'call.gpu': 'trace', 'call.input': 'trace',
            'call.net': 'trace', 'call.audio': 'trace', 'call.video': 'trace',
            'call.hook': 'trace',
        },
    } } : {},
});
for (const name of ['process-create', 'process-started', 'process-resumed', 'process-server',
    'process-server-exit', 'error', 'exit', 'divergence', 'message-box', 'unimplemented',
    // `--debug-strings`: what the programs say through OutputDebugString --
    // a client's own log and its assertions, which name where it gave up.
    ...argv.includes('--debug-strings') ? ['debug'] : []])
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
// Clicks go through the input layer's route (`app.input.route`), a step every
// 150 ms: a pointer a program keeps by relative motion is pushed into the
// corner first and moved from there, and a dialog's button sees a press and a
// release apart. Nothing here presents frames to count, so a timer stands in.
const route = app.input.route();
setInterval(()=>route.tick(), 150).unref?.();

// `--press 'Next >|I &accept|Finish'`: the buttons pressed in turn, each by
// its title once it has stood visible and enabled for a whole look, and is not
// the button pressed last unless three looks have passed -- a wizard's pages
// driven without guessing when each will come, which drifts from run to run.
//
// `--press-any 'Next >|OK|Finish'`: any of them, in whatever order they come,
// for as long as the run lasts -- every installer on the disk driven by one
// list of the buttons that go forward.
const anyOrder = argv.includes('--press-any');
const pressing = argv.includes('--press') || anyOrder
    ? argv[argv.indexOf(anyOrder ? '--press-any' : '--press') + 1].split('|').map(label) : [];
if (pressing.length > 0)
{
    let step = 0;
    let lastButton = '';
    let looksSince = 0;
    let seen = '';
    let looking = false;
    const WS_DISABLED = 0x08000000;
    const look = setInterval(async()=>{
        if (looking || step >= pressing.length)
        {
            return;
        }
        looking = true;
        looksSince++;
        try
        {
            for (const { diagnostics } of await app.standing())
            {
                const win32 = diagnostics.find((/** @type {any} */ entry)=>entry.name === 'win32')
                    ?.metrics ?? {};
                // Of several standing at once, the one named first: a licence
                // page's "I accept" before the "Next >" beside it, which on its
                // own goes nowhere.
                const button = (win32.windows ?? []).filter((/** @type {any} */ w)=>w.visible
                    && isButtonClass(w.className)
                    && (anyOrder ? pressing.includes(label(w.title))
                        : label(w.title) === pressing[step])
                    && (w.hwnd !== lastButton || looksSince > 3)
                    && (parseInt(w.style, 16) & WS_DISABLED) === 0)
                    .sort((/** @type {any} */ a, /** @type {any} */ b)=>
                        pressing.indexOf(label(a.title)) - pressing.indexOf(label(b.title)))[0];
                if (!button)
                {
                    continue;
                }
                if (seen !== button.hwnd)
                {
                    seen = button.hwnd;
                    break;
                }
                const x = Math.round((button.rect.left + button.rect.right) / 2);
                const y = Math.round((button.rect.top + button.rect.bottom) / 2);
                console.log(seconds(), 'PRESS', button.title, x, y);
                lastButton = button.hwnd;
                looksSince = 0;
                step += anyOrder ? 0 : 1;
                route.click(x, y);
                break;
            }
        }
        finally
        {
            looking = false;
        }
    }, 2000);
    look.unref?.();
}
for (const { what, at } of all('--click').map(timed))
{
    const [x, y] = what.split(',').map(Number);
    setTimeout(()=>{
        console.log(seconds(), 'CLICK', x, y);
        route.click(x, y);
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
        // This process as a whole, every worker in it: what grows between two
        // lines is what a page's tab would grow by.
        const usage = process.memoryUsage();
        const mb = (/** @type {number} */ bytes)=>Math.round(bytes / 1048576);
        console.log(seconds(), 'MEM', JSON.stringify({ rss: mb(usage.rss),
            heapUsed: mb(usage.heapUsed), external: mb(usage.external),
            arrayBuffers: mb(usage.arrayBuffers) }));
        for (const standing of await app.standing())
        {
            // A process standing in a worker of its own may not have said
            // its image or its figures yet.
            const image = String(standing.image ?? 'process');
            const diagnostics = standing.diagnostics ?? [];
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
            // What the devices drew against what reached the screen: a
            // picture that stops changing while the program still presents
            // is a device that stopped replaying, and only these say so.
            const graphics = metrics('graphics');
            const device = graphics.seam?.device;
            if (dumpAt > 0 && !dumpAsked && Number(seconds()) >= dumpAt)
            {
                dumpAsked = true;
                app.debug.dumpFrames(1);
                console.log(seconds(), 'DUMP asked');
            }
            else if (dumpAsked && !dumpWritten && app.debug.dumped())
            {
                dumpWritten = true;
                const { lines, frame } = app.debug.dumped();
                writeFileSync(dumpTo, `${lines.join('\n')}\n`);
                console.log(seconds(), 'DUMP', dumpTo, `frame ${frame}`, lines.length, 'lines');
            }
            if (device || graphics.worker)
            {
                const last = device?.recentFrames?.at(-1);
                console.log(seconds(), 'GFX', image.split('\\').pop(), JSON.stringify({
                    shown: graphics.worker?.frames, dropped: graphics.worker?.dropped,
                    drawn: device?.frames, replays: device?.timing?.replays,
                    failures: device?.failures, last: last && `#${last.index} ${last.draws}`
                        + ` draws ${last.clears} clears ${last.target}`
                        + (last.fogs ? ` fog ${last.fogs}` : ''),
                }));
            }
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

// Printed once: at S seconds, or when the run ends first -- an installer that
// quits on an error it just showed has its last calls in the journal still.
let journalPrinted = false;
const printJournal = ()=>{
    if (journalAt <= 0 || journalPrinted)
    {
        return;
    }
    journalPrinted = true;
    const crossing = /OleMainThread|CoWait|MsgWait|PostMessage|PostThread|SendMessage|WaitFor/;
    const whole = traceAt > 0 || traceOnBox || traceOnFault;
    // `--trace-match REGEX`: only the calls whose line matches -- one family
    // (`WS2_32|WSA|GetQueuedCompletion`) across a run far longer than the lines kept.
    const match = argv.includes('--trace-match')
        ? new RegExp(argv[argv.indexOf('--trace-match') + 1]) : null;
    const trail = app.log.recent(100000).filter((/** @type {any} */ entry)=>(whole
        || entry.category === 'call.com' || crossing.test(entry.text))
        && (!match || match.test(entry.text)));
    for (const entry of trail.slice(whole ? -number('--trace-lines', 3000) : -150))
    {
        console.log('JOURNAL', (entry.time / 1000).toFixed(2), entry.text.slice(0, 400));
    }
};
if (traceOnFault)
{
    const EXCEPTION_CODES = 0xc0000000;
    app.on('process-resumed', (/** @type {any} */ event)=>{
        if ((event?.code >>> 0) >= EXCEPTION_CODES)
        {
            console.log(seconds(), 'FAULT', event.image, (event.code >>> 0).toString(16));
            printJournal();
        }
    });
}
if (journalAt > 0 && !traceOnBox && !traceOnFault)
{
    setTimeout(printJournal, journalAt * 1000);
}
if (traceOnBox)
{
    app.on('divergence', (/** @type {any} */ event)=>{
        if (/MessageBox|DialogBox/.test(event?.api ?? '') && /error|cannot|fail|not /i
            .test(event?.detail ?? ''))
        {
            printJournal();
        }
    });
    app.on('message-box', printJournal);
}

// `--reg 'HKCU\Software\Vendor\Name=value'`: a registry value set before the
// program starts, a string or `dword:N` -- a setting a person's machine has and
// a bottle must not carry, laid in for this run alone.
const ROOTS = { HKCU: 0x80000001, HKLM: 0x80000002 };
for (const entry of all('--reg'))
{
    const [, root, path, name, value] = /^(HKCU|HKLM)\\(.*)\\([^\\=]*)=(.*)$/s.exec(entry) ?? [];
    if (!root)
    {
        throw new Error(`--reg ${entry}: not ROOT\\path\\name=value`);
    }
    const hive = app.registry();
    const { key } = hive.create(hive.root(ROOTS[/** @type {'HKCU' | 'HKLM'} */ (root)]), path);
    const dword = /^dword:(\d+)$/.exec(value);
    hive.setValue(key, name, dword ? 4 : 1, dword
        ? new Uint8Array(Uint32Array.of(Number(dword[1])).buffer)
        // Narrow, as the hive keeps a string.
        : Uint8Array.from([...value, '\0'], character=>character.charCodeAt(0) & 0xff));
}

try
{
    console.log('run ->', await app.run({ maxTurns: Number.MAX_SAFE_INTEGER,
        timeoutMs: number('--minutes', 20) * 60000 }));
}
catch (e){
    console.log('stopped:', e instanceof Error ? e.stack?.slice(0, 1500) : e);
}
printJournal();
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
if (argv.includes('--registry'))
{
    const to = argv[argv.indexOf('--registry') + 1];
    mkdirSync(dirname(to), { recursive: true });
    writeFileSync(to, JSON.stringify(app.registry().toJSON()));
}
for (const path of all('--cat'))
{
    try
    {
        console.log(`CAT ${path}\n${new TextDecoder('latin1').decode(app.files.read(path))}`);
    }
    catch (e){
        console.log('cat failed:', path, e instanceof Error ? e.message : e);
    }
}
for (let at = argv.indexOf('--peek'); at >= 0; at = argv.indexOf('--peek', at + 1))
{
    const address = Number(argv[at + 1]);
    const bytes = app.debug.read(address, Number(argv[at + 2]));
    for (let row = 0; row < bytes.length; row += 16)
    {
        const line = [...bytes.subarray(row, row + 16)];
        console.log('PEEK', (address + row).toString(16).padStart(8, '0'),
            line.map(byte=>byte.toString(16).padStart(2, '0')).join(' '),
            line.map(byte=>(byte >= 32 && byte < 127 ? String.fromCharCode(byte) : '.')).join(''));
    }
}
/** @param {string} from @param {string} to */
const copyOut = (from, to)=>{
    mkdirSync(to, { recursive: true });
    for (const entry of app.files.list(from))
    {
        const name = join(to, entry.path.slice(entry.path.lastIndexOf('\\') + 1));
        if (entry.directory)
        {
            copyOut(entry.path, name);
        }
        else
        {
            writeFileSync(name, app.files.read(entry.path));
        }
    }
};
for (let at = argv.indexOf('--copy'); at >= 0; at = argv.indexOf('--copy', at + 1))
{
    try
    {
        copyOut(argv[at + 1], argv[at + 2]);
    }
    catch (e){
        console.log('copy failed:', argv[at + 1], e instanceof Error ? e.message : e);
    }
}
const collectTo = argv.includes('--collect-to') ? argv[argv.indexOf('--collect-to') + 1] : null;
collectable ??= media;
if (collectable && (argv.includes('--collect') || collectTo))
{
    try
    {
        const collected = collectFrom(app, collectable);
        const bytes = collected.files.reduce((total, one)=>total + one.bytes.length, 0);
        console.log('COLLECT root', collected.root, 'entry', collected.entry,
            'files', collected.files.length, 'bytes', bytes, 'outside', collected.outside.length);
        for (const one of collected.files.slice(0, 60))
        {
            console.log('COLLECT file', String(one.bytes.length).padStart(10), one.path);
        }
        // The prefix unpacked, as a directory make-btl packs into the bottle
        // the wizard would have published.
        for (const one of collectTo ? collected.files : [])
        {
            const to = join(collectTo, ...one.path.split('\\'));
            mkdirSync(dirname(to), { recursive: true });
            writeFileSync(to, one.bytes);
        }
        // The directories left empty too: a program that checks its tree (an
        // updater verifying its install) finds one missing as damage.
        for (const path of collectTo ? collected.directories ?? [] : [])
        {
            mkdirSync(join(collectTo, ...path.split('\\')), { recursive: true });
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
