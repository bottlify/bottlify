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
 *     node tools/cdp_test/game.mjs <bundle-id> [--turns N] [--wait SECONDS] [--run-seconds N]
 *                                  [--dump-draws] [--skip-texture tN] [--no-video] [--no-hooks]
 *                                  [--keep-images N,M] [--watch-import LIB.dll[#ord+ord]]
 *                                  [--click x,y[,after]] [--key Code[,after]] [--coi]
 *                                  [--mode NAME] [--executors N] [--cork-config JSON]
 *                                  [--graphics-worker] [--journal-calls]
 *                                  [--command-line STRING] [--windows NAME]
 *                                  [--file HOST=GUEST] [--save-files]
 *                                  [--user-data-dir DIR] [--port N] [--store local] [--prefetch]
 *                                  [--cpu-profile SECONDS] [--heap-profile [old]]
 *                                  [--export-translations FILE]
 *                                  [--watch SECONDS] [--press LABEL|LABEL... [--press-settle MS]]
 *                                  [--route] [--shots-every SECONDS]
 *
 * `--watch S` is for a program that does not present, an installer above
 * all: every S seconds the desktop it paints with GDI is written as a PNG,
 * the events since the last look are printed, and every process standing
 * says what its threads wait on, which call is parked, which windows show and
 * where its processor last ran. `--press` walks its wizard: whenever the
 * screen changes and settles, the first of the labels an enabled button
 * carries is pressed.
 */

import { deflateSync } from 'node:zlib';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync }
    from 'node:fs';
import { tmpdir } from 'node:os';
import { readFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchWithGpu, shutdown } from './browser.mjs';
import { CdpEndpoint } from './cdp.mjs';
import { pausedStack, reportTimeout } from './timeout-report.mjs';
import { serveStatic } from './server.mjs';
import { describeProfile, profileWorkers, summarise, summariseAllocations } from './profile.mjs';
import { describeDevice, watchDevice } from './device-lag.mjs';
import { openBundle } from '../btl.mjs';
import { placementOf } from '../../modules/installer/src/prefix.js';
import { windowsVersion } from '../../modules/core/src/layers/win32/kernel32/versions.js';
import { disassemble } from '../../modules/core/src/layers/win32/d3dx9/d3d9-machine.fixture.js';
import { disassembleShader } from '../../modules/core/src/layers/win32/d3dx9/shader-asm.js';
import { modeOf } from '../play/modes.js';

const TOOL_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)));

/**
 * When an action happens: a presented-frame count (`120`), or a time since
 * the first presented frame (`12s`) -- the clock, not the frame count, is
 * what a program's screens arrive on, so a route timed in seconds survives
 * a change in the frame rate. An unresolved time is a frame number of -1
 * until the harness sees the clock pass it.
 *
 * @param {string | undefined} text
 */
const afterOf = text=>{
    if (text !== undefined && /^\d+(\.\d+)?s$/.test(text))
    {
        return { after: -1, afterSeconds: Number(text.slice(0, -1)) };
    }
    return { after: Number(text) || 30 };
};
const REPO_ROOT = resolve(TOOL_ROOT, '..', '..');
const PACKAGE_DIR = join(REPO_ROOT, 'modules', 'core');
const BUNDLES_DIR = join(REPO_ROOT, 'bundles');
const REPORTS_DIR = join(TOOL_ROOT, 'reports');

/** Lines per round trip when draining the call log. */
const LOG_CHUNK = 20000;

/**
 * A compiled shader as text. The reference machine's listing first, which says
 * what each instruction reads; a shader past the limits of its version -- which
 * the compiler warns of and still makes, since WGSL holds it -- is refused
 * there, and is then listed by D3DXDisassembleShader's own code with why.
 *
 * @param {Uint32Array} tokens
 */
function listing(tokens){
    try
    {
        return disassemble(tokens);
    }
    catch (e){
        let text;
        try
        {
            text = disassembleShader(tokens);
        }
        catch (_e){
            text = `not listed: ${/** @type {Error} */ (_e).message}\n`;
        }
        return `; the reference machine refuses it: ${/** @type {Error} */ (e).message}\n${text}`;
    }
}

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
    // The run mode by name, the player's own (`tools/play/modes.js`); an
    // explicit --executors or --cork-config goes over it.
    const mode = modeOf(argv.includes('--mode') ? argv[argv.indexOf('--mode') + 1] : null);
    return {
        mode: mode.name,
        id,
        // A run given a time is bounded by that time: the turn cap alone ended a
        // loading title's run within seconds of the minutes it was given.
        turns: number('--turns', argv.includes('--run-seconds') ? Number.MAX_SAFE_INTEGER : 200000),
        // The arguments the title believes it was started with, so a run can
        // set one cvar (`+set logFile 1`) without editing its files.
        // A disc image mounted as D: for the run, as the disc a program was
        // installed from stays in the drive while it plays.
        disc: argv.includes('--disc') ? resolve(argv[argv.indexOf('--disc') + 1]) : null,
        commandLine: argv.includes('--command-line')
            ? argv[argv.indexOf('--command-line') + 1]
            : null,
        // The Windows the title runs under, over the one its manifest names.
        windows: argv.includes('--windows') ? argv[argv.indexOf('--windows') + 1] : null,
        // Files put on the volume before the program starts, as `HOST=GUEST`:
        // what one run wrote, handed to the next.
        files: argv.flatMap((flag, index)=>{
            if (flag !== '--file')
            {
                return [];
            }
            const at = argv[index + 1].indexOf('=');
            if (at < 0)
            {
                throw new Error(`--file wants HOST=GUEST, got ${argv[index + 1]}`);
            }
            return [{
                path: argv[index + 1].slice(at + 1),
                base64: readFileSync(argv[index + 1].slice(0, at)).toString('base64'),
            }];
        }),
        // Keep what the program wrote as the bytes it wrote, whole, rather
        // than as text: a file meant to be fed back in must survive the trip.
        saveFiles: argv.includes('--save-files'),
        // A browser profile of the caller's own, kept after shutdown rather
        // than a fresh temporary one thrown away with it: the OPFS block
        // store `--store local` asks for lives in the profile, and a warm run
        // needs the same profile the run that warmed it used.
        userDataDir: argv.includes('--user-data-dir')
            ? argv[argv.indexOf('--user-data-dir') + 1] : null,
        // Fixed rather than a random one, because `127.0.0.1:<port>` is the
        // origin OPFS is scoped to: a warm store from an earlier run is only
        // there to find if this run serves the bundle from the same port.
        port: number('--port', 0),
        // Where fetched bundle blocks are kept: `'local'` is OPFS, which only
        // a worker can open synchronously (`--worker` is then required too),
        // in the browser profile named by `--user-data-dir`. Unset keeps the
        // old behaviour -- nothing durable, thrown away with the browser.
        store: argv.includes('--store') ? argv[argv.indexOf('--store') + 1] : null,
        // Fills the rest of the cache from the bundle in the background,
        // beyond whatever the run itself reads -- a fuller warm-up between
        // runs, at the cost of the bandwidth to do it.
        prefetch: argv.includes('--prefetch'),
        // Where the run's translations go once it ends, as the seed a bundle
        // carries (`node tools/make-btl.mjs translations <id> <file>`).
        exportTranslations: argv.includes('--export-translations')
            ? argv[argv.indexOf('--export-translations') + 1] : null,
        // How long the engine itself runs before it stops and reports, for a
        // title that reaches its loop and would otherwise run out the turns
        // hours later. Zero means the turns alone decide.
        runSeconds: number('--run-seconds', 0),
        // The bridge's own record of its last N events -- each host call that
        // parked and finished, each call into the guest, each callback that
        // returned -- written out with the report: how a thread's stack got
        // to where a failure found it.
        record: number('--record', 0),
        // The machine's memory in megabytes, as the launcher's setting gives it;
        // the engine's default without it.
        memory: number('--memory', 0),
        watch: number('--watch', 0),
        // With --watch: the files under this directory of the volume, counted
        // at every look and listed whenever they change.
        list: argv.includes('--list') ? argv[argv.indexOf('--list') + 1] : null,
        // The frame averages taken once this many frames came after the last
        // long stall (a load): with a program that advances one step a frame,
        // the same frames of play in every run (0: not taken).
        steadyFrames: number('--steady-frames', 0),
        // A row of the frame split and the draws and calls a frame every this
        // many presents, printed and written as game-<stamp>-series.json: how
        // a frame's cost moves with what it draws, over the run (0: none).
        series: number('--series', 0),
        // The frame this many frames after the last long stall, written beside
        // the report as game-<stamp>-snap.png: a demo's frame N in every run.
        snapFrame: number('--snap-frame', 0),
        shotsEvery: number('--shots-every', 0),
        snapFromStart: argv.includes('--snap-from-start'),
        // With it, this many frames from it, --snap-every apart, each written
        // as game-<stamp>-snap-<frame>.png.
        snapCount: number('--snap-count', 1),
        snapEvery: number('--snap-every', 1),
        // The browser's own sampling profiler on the engine's workers for
        // this many seconds from the start (or until the run ends): which
        // functions -- translated regions by address, the interpreter, the
        // runtime, the layers -- the engine thread's time went to.
        cpuProfile: number('--cpu-profile', 0),
        cpuProfileFrom: number('--cpu-profile-from', 0),
        // With --cpu-profile: the same workers' allocations sampled over the
        // same window, garbage included (`old`: only what lived to be
        // promoted), and their heaps read every second -- what a long
        // collection pause was paid for.
        heapProfile: argv.includes('--heap-profile')
            ? argv[argv.indexOf('--heap-profile') + 1] === 'old' ? 'old' : 'all'
            : null,
        // V8 flags for the browser ("--no-liftoff", "--liftoff-only"): how a run
        // depends on the wasm tiers.
        jsFlags: argv.includes('--js-flags') ? argv[argv.indexOf('--js-flags') + 1] : undefined,
        // `--chrome-flag --use-webgpu-adapter=swiftshader`, repeatable: the same
        // run on another adapter, to tell a GPU's answer from the engine's.
        chromeFlags: argv.flatMap((arg, at)=>(arg === '--chrome-flag' ? [argv[at + 1]] : [])),
        // The translator's own settings as JSON ('{"countTransfers":true}').
        corkConfig: argv.includes('--cork-config')
            ? { ...mode.cork, ...JSON.parse(argv[argv.indexOf('--cork-config') + 1]) }
            : mode.cork,
        // The display the program is told it has, as `WxH`. The launcher
        // names the person's own screen, which is rarely a size a program of
        // this era lists, so what a title does on one is a different path.
        screen: argv.includes('--screen')
            ? (()=>{
                const [width, height] = argv[argv.indexOf('--screen') + 1].split('x').map(Number);
                return { width, height, bitsPerPixel: 32 };
            })()
            : null,
        // A run that reads a gigabyte of bundle over HTTP one block at a time
        // is slower than one reading a local file, and the page cannot be asked
        // how it is doing while it runs. A run timed by `--run-seconds` answers
        // only once its time is up, so the wait is at least that and the
        // report's read-back after it.
        waitMs: number('--wait', Math.max(900, number('--run-seconds', 0) + 300)) * 1000,
        calls: number('--calls', 40),
        // Every host call written to a file. The ring in a report holds the end
        // of a run, and what a program decided it decided long before that.
        log: argv.includes('--log') ? argv[argv.indexOf('--log') + 1] : null,
        // How many of them to keep. The default holds the head of a run, which
        // is where a program makes its decisions; something that only happens
        // once a title is up needs more than that.
        logLines: number('--log-lines', 0),
        // Only the calls whose line matches this expression are kept, so a
        // question about one family of calls is answered by the whole run.
        logMatch: argv.includes('--log-match') ? argv[argv.indexOf('--log-match') + 1] : null,
        // Each line of the call log led by the page's clock in milliseconds:
        // where a run stood still is the gap between two lines.
        logTimes: argv.includes('--log-times'),
        // Where every draw of the last frame landed, and under what state.
        // Off unless asked for: it transforms every vertex of every draw a
        // second time on the processor.
        // A run measured through a two-minute cinematic measures the
        // cinematic. Not a switch inside the guest: the engine is simply
        // assembled without a decoder, which is an ordinary machine and the
        // one every run had before there was one.
        video: !argv.includes('--no-video'),
        // The bundle's sidecar hooks left unbound, for a pair of runs that
        // differ by them and nothing else.
        hooks: !argv.includes('--no-hooks'),
        dumpDraws: argv.includes('--dump-draws'),
        // The same account for every N-th frame, the last of them kept, each
        // checked against what the GPU held: a picture wrong in one frame of
        // a few is caught with its draws.
        dumpEvery: number('--dump-every', 0),
        // Every host call timed as a phase of its own, so the report's phase
        // table says which API a frame's host time went to, not only that it
        // went to the crossing.
        profileCalls: argv.includes('--profile-calls'),
        // Draws per frame, for bisecting which one painted a region.
        maxDraws: number('--max-draws', -1),
        // A texture id from a draws dump, e.g. "t4". Every draw sampling it is
        // dropped, so two runs differ by that draw and nothing else.
        // Upload indices (as the report's imageDigests count them) whose
        // texels are written beside the report as PNGs.
        keepImages: argv.includes('--keep-images')
            ? argv[argv.indexOf('--keep-images') + 1].split(',').map(Number) : [],
        skipTexture: argv.includes('--skip-texture')
            ? argv[argv.indexOf('--skip-texture') + 1]
            : null,
        // Every draw rendered as if D3DRS_FOGENABLE were clear, so a run
        // differs from an ordinary one by fog and nothing else.
        probeTexture: argv.includes('--probe') ? argv[argv.indexOf('--probe') + 1] : null,
        // Where to hold the pointer, in the program's own pixels, as `x,y`.
        pointer: argv.includes('--pointer')
            ? (()=>{
                const [x, y, down] = argv[argv.indexOf('--pointer') + 1].split(',');
                return { x: Number(x), y: Number(y), down: down === 'down' };
            })()
            : null,
        // Clicks in the program's own pixels after that many presented
        // frames each, as `x,y,after`: pressed on one frame, released on the
        // next. Given more than once for a path through several screens.
        clicks: argv.flatMap((flag, index)=>{
            if (flag !== '--click')
            {
                return [];
            }
            const [x, y, after] = argv[index + 1].split(',');
            return [{ x: Number(x), y: Number(y), ...afterOf(after) }];
        }),
        // Clicks and key taps at a wall-clock moment, milliseconds after the
        // run starts, as `x,y,ms` and `Code,ms`: a screen that waits for a
        // click without presenting -- a dialog, a film's first frame -- never
        // reaches the frame a frame-counted click would be sent on.
        clickTimes: argv.flatMap((flag, index)=>{
            if (flag !== '--click-at')
            {
                return [];
            }
            const [x, y, atMs] = argv[index + 1].split(',').map(Number);
            return [{ x, y, atMs }];
        }),
        // The buttons a wizard shows, pressed by label as each screen
        // settles, as `next >|install|finish`: the first label an enabled
        // button on the screen carries. An installer's pages come when its
        // work is done, which no frame count or moment foretells.
        presses: argv.includes('--press')
            ? argv[argv.indexOf('--press') + 1].split('|') : [],
        pressSettleMs: number('--press-settle', 1500),
        keyTimes: argv.flatMap((flag, index)=>{
            if (flag !== '--key-at')
            {
                return [];
            }
            const [code, atMs] = argv[index + 1].split(',');
            return [{ code, atMs: Number(atMs) }];
        }),
        // Key taps in the program's own keyboard codes, after that many
        // presented frames each, as `Code,after`: pressed on one frame and
        // released on the next. `Code` is a KeyboardEvent.code -- `Enter`,
        // `Escape`, `Space`, `KeyA`.
        keys: argv.flatMap((flag, index)=>{
            if (flag !== '--key')
            {
                return [];
            }
            const [code, after, frames] = argv[index + 1].split(',');
            return [{ code, ...afterOf(after), frames: frames ? Number(frames) : 1 }];
        }),
        // Guest memory to read when the run ends, `address:length` (hex or
        // decimal), into the report.
        peeks: argv.flatMap((flag, index)=>{
            if (flag !== '--peek')
            {
                return [];
            }
            const [address, length] = argv[index + 1].split(':');
            return [{ address: Number(address), length: Number(length) }];
        }),
        // Every import from a library, `lib.dll` or `lib.dll#268+279` for
        // only those ordinals, as the launcher's `?watch=` takes it: each call
        // and its answer join the log.
        watchImports: argv.flatMap((flag, index)=>(flag === '--watch-import'
            ? [argv[index + 1]] : [])),
        // A watch in front of a routine inside one of the program's own
        // modules, `module:offset:label:argBytes:len,len[:strings]` as the
        // launcher's `?hook=` takes it: its calls and answers join the log.
        watches: argv.flatMap((flag, index)=>{
            if (flag !== '--hook')
            {
                return [];
            }
            const [module, offset, label, argBytes, lengths, strings] = argv[index + 1].split(':');
            return [{ module: module.toLowerCase(), offset: Number(offset), label,
                argBytes: Number(argBytes), lengths: lengths.split(',').map(Number),
                strings: (strings ?? '').split('+').filter(Boolean)
                    .map(s=>(/^\d+$/.test(s) ? Number(s) : s)) }];
        }),
        // Mouse motion without a button, `dx,dy,after,frames`: that much each
        // presented frame for that many frames -- how a view is turned.
        looks: argv.flatMap((flag, index)=>{
            if (flag !== '--turn')
            {
                return [];
            }
            const [dx, dy, after, frames] = argv[index + 1].split(',');
            return [{ dx: Number(dx), dy: Number(dy), ...afterOf(after), frames: Number(frames) }];
        }),
        // Text typed into whatever has the focus, one character per presented
        // frame from `after` on, as `text,after`: each character is a key
        // press with its character, the way the page's own keyboard delivers
        // one. The text may not contain a comma.
        typed: argv.flatMap((flag, index)=>{
            if (flag !== '--type')
            {
                return [];
            }
            const at = argv[index + 1].lastIndexOf(',');
            return [{ text: argv[index + 1].slice(0, at),
                ...afterOf(argv[index + 1].slice(at + 1)) }];
        }),
        // Text pasted into whatever has the focus at frame `after`, as
        // `text,after`: onto the clipboard, then the Control-V a program
        // pastes on, the way the page's paste gesture delivers one.
        pasted: argv.flatMap((flag, index)=>{
            if (flag !== '--paste')
            {
                return [];
            }
            const at = argv[index + 1].lastIndexOf(',');
            return [{ text: argv[index + 1].slice(0, at),
                ...afterOf(argv[index + 1].slice(at + 1)) }];
        }),
        // The relay the run's Winsock reaches the world through, as the
        // launcher names it: `--network wss://host/relay` joins room `harness`.
        network: argv.includes('--network') ? argv[argv.indexOf('--network') + 1] : null,
        fog: !argv.includes('--no-fog'),
        mips: !argv.includes('--no-mips'),
        // Fields of the graphics layer's configuration, as `createApp` takes
        // them: `--graphics-config {"compressedTextures":true}`. Generic, so a
        // run can turn on any switch the layer has without a flag of its own.
        graphics: argv.includes('--graphics-config')
            ? JSON.parse(argv[argv.indexOf('--graphics-config') + 1])
            : null,
        // The graphics a bottle chooses in the launcher -- `directx8` leaves the
        // machine DirectDraw and Direct3D 8 and reports DirectX 8.1 -- as
        // `createApp`'s `graphicsApi` takes it.
        graphicsApi: argv.includes('--graphics-api')
            ? argv[argv.indexOf('--graphics-api') + 1]
            : null,
        // Fields of the audio layer's configuration, the same way:
        // `--audio-config {"mp3":false}` runs the program's own MP3 decoder.
        entry: argv.includes('--entry') ? argv[argv.indexOf('--entry') + 1] : null,
        audio: argv.includes('--audio-config')
            ? JSON.parse(argv[argv.indexOf('--audio-config') + 1])
            : null,
        // What the device mixed from FROM to TO seconds of the run, written as
        // a WAV beside the report: `--capture-audio 20:50`.
        captureAudio: argv.includes('--capture-audio')
            ? (([from, to])=>({ fromMs: from * 1000, toMs: to * 1000 }))(
                argv[argv.indexOf('--capture-audio') + 1].split(':').map(Number))
            : null,
        // Peeks every pointer argument of every call for a string. Off unless
        // asked for: a title's draws pay for it, and a measurement run should
        // not without asking.
        trace: argv.includes('--trace'),
        // Guest instructions per scheduler turn when a profile is asked for.
        // Lowering it is what makes a sample a measurement rather than a
        // rumour: a sample lands at a turn boundary, so the turn is the
        // resolution.
        quantum: argv.includes('--profile')
            ? number('--profile', 2000) || 2000
            : 0,
        // Executors of the program's process (`createApp`'s `executors`): past
        // one, threads that are ready together run at once.
        executors: number('--executors', mode.executors ?? 0),
        // Direct3D and OpenGL drawn in a graphics worker, the program's thread
        // keeping only their state, as the player runs them.
        graphicsWorker: argv.includes('--graphics-worker'),
        // The call areas a person's report is taken with, traced from the
        // first instruction: what tracing costs a run is part of what it measures.
        journalCalls: argv.includes('--journal-calls'),
        // The engine in a worker, with the page's canvas transferred to it;
        // otherwise on the page's own thread.
        worker: argv.includes('--worker'),
        headed: argv.includes('--headed'),
        // How the loop waits in the worker: `page` (a look every few
        // milliseconds) or `event` (sleep until something happens).
        pacing: argv.includes('--pacing') ? argv[argv.indexOf('--pacing') + 1] : 'page',
        // Cross-origin isolation headers, so the page comes up
        // `crossOriginIsolated` with `SharedArrayBuffer` -- what the shared-
        // table audio backend and its worklet need to run at all.
        coi: argv.includes('--coi'),
        // How many processes run at once, each child in a worker of its own.
        concurrency: argv.includes('--concurrency')
            ? Number(argv[argv.indexOf('--concurrency') + 1]) : undefined,
    };
}

/** The engine's RGBA read-back as the BGRA the PNG writer takes. @param {Buffer} rgba */
const toBgra = rgba=>{
    const bgra = Buffer.alloc(rgba.length);
    for (let at = 0; at < rgba.length; at += 4)
    {
        bgra[at] = rgba[at + 2];
        bgra[at + 1] = rgba[at + 1];
        bgra[at + 2] = rgba[at];
        bgra[at + 3] = rgba[at + 3];
    }
    return bgra;
};

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
 * The most text one answer carries, before it is escaped twice on its way. An
 * answer of 4 MB closed the connection where one of 2 MB did not, and a run's
 * result is more than that once the files a title wrote and the last frame's
 * pixels are in it.
 */
const RESULT_CHUNK = 1 << 19;

/**
 * The page's result, once it has one: its length first, then its text a piece
 * at a time, a piece never ending between the two halves of a character.
 *
 * @param {CdpEndpoint} cdp
 * @param {string} sessionId
 * @param {number} timeoutMs
 * @returns {Promise<any>}
 */
async function readResult(cdp, sessionId, timeoutMs){
    const length = await poll(cdp, sessionId, 'window.__bottlify__.result ? String(('
        + 'self.__bottlifyResultText = JSON.stringify(window.__bottlify__.result)).length) : null',
    timeoutMs);
    const pieces = [];
    for (let at = 0; at < length;)
    {
        const answer = await cdp.send('Runtime.evaluate', {
            expression: `(()=>{ const text = self.__bottlifyResultText;
                let end = Math.min(text.length, ${at + RESULT_CHUNK});
                const last = text.charCodeAt(end - 1);
                if (end < text.length && last >= 0xd800 && last <= 0xdbff) end--;
                return JSON.stringify({ piece: text.slice(${at}, end), end }); })()`,
            returnByValue: true,
        }, sessionId);
        const { piece, end } = JSON.parse(answer.result.value);
        pieces.push(piece);
        at = end;
    }
    return JSON.parse(pieces.join(''));
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
 * Folds an `Image+0xrva` string (`harness.js`'s own naming, `symboliser()`)
 * through the sidecar's function table, so a sampler bucket reads as the
 * function it fell in rather than a bare offset -- the same "largest start
 * at or below the address" rule a debugger's own symbolication uses.
 *
 * @param {string} at
 * @param {Record<string, { rva: number, name: string | null }[]>} [symbols]
 * @returns {string}
 */
function symbolName(at, symbols){
    const match = symbols ? /^(.+)\+0x([0-9a-f]+)$/.exec(at) : null;
    if (!match)
    {
        return at;
    }
    const [, image, rvaHex] = match;
    const starts = symbols[image];
    if (!starts || starts.length === 0)
    {
        return at;
    }
    const rva = parseInt(rvaHex, 16);
    let found = null;
    for (const entry of starts)
    {
        if (entry.rva > rva)
        {
            break;
        }
        found = entry;
    }
    if (!found)
    {
        return at;
    }
    const offset = rva - found.rva;
    const label = found.name ?? `${image}+0x${found.rva.toString(16)}`;
    return offset === 0 ? label : `${label}+0x${offset.toString(16)}`;
}

/**
 * The translator's own account: the share of retired instructions it ran, why
 * the rest ran interpreted (the refused opcodes and the untranslated exits by
 * target), and how much translating cost. The loading-phase question -- is a
 * loop left interpreted by a policy or by a decoder gap -- is answered by
 * `exitsByTarget`'s reasons and `refusedWhy`, which the `[ready]` table drops
 * because their shapes are not scalars.
 *
 * @param {any} cork
 * @param {(text: string) => void} say
 */
function describeCork(cork, say){
    const share = cork.translatedShare ?? 0;
    say(`  cork: ${cork.regions} regions, ${cork.entries} entries, ${cork.modules} modules`
        + `, share ${(share * 100).toFixed(1)}%`
        + ` (retired ${cork.retired ?? 0})`
        + (cork.relinks || cork.merges ? `, ${cork.relinked} regions relinked in ${cork.relinks}`
            + ` relinks and ${cork.merges ?? 0} merges` : ''));
    say(`    x87 precision: ${cork.wide ? 'wide' : 'rounding'}`
        + `, switched ${cork.precisionSwitches ?? 0} times`);
    say(`    volatile pages: ${cork.volatilePages ?? 0}`
        + `  invalidations: ${cork.invalidations ?? 0}`
        + `  dropped: ${cork.dropped ?? 0}`
        + `  queued: ${cork.queued ?? 0}`
        + `  barren: ${cork.barren ?? 0}`
        + `  queueDrops: ${cork.queueDrops ?? 0}`
        + `  forced steps: ${cork.forcedSteps ?? 0}`
        + `  cache: ${cork.cacheHits ?? 0} hit / ${cork.cacheMisses ?? 0} miss`
        + ` (no record ${cork.missNoRecord ?? 0}, no module ${cork.missNoModule ?? 0})`
        + `  store batches: ${cork.lookedUpNow ?? 0} at once / ${cork.lookedUpLater ?? 0}`
        + ' a turn later');
    if (cork.staleRegions)
    {
        // --cork-config checkStale: translated code a write left standing.
        say(`    stale regions: ${cork.staleRegions.length} `
            + cork.staleRegions.slice(0, 20).join(' '));
    }
    // Under precise, a NaN hunt's first events, in the order they came (`#n`).
    const nan = [
        cork.nanFirst && [cork.nanFirst, `NaN made from ${cork.nanFirst.a} and ${cork.nanFirst.c}`],
        cork.stackFaultFirst && [cork.stackFaultFirst, `x87 stack fault in the region at`
            + ` ${cork.stackFaultFirst.region} (entered at top ${cork.stackFaultFirst.entryTop}),`
            + ` empty mask ${cork.stackFaultFirst.empty}, top ${cork.stackFaultFirst.top}`],
        cork.nanResultFirst && [cork.nanResultFirst, 'NaN result'],
        cork.nanLoadFirst && [cork.nanLoadFirst, `NaN loaded from ${cork.nanLoadFirst.from}`],
        cork.nanStoreFirst && [cork.nanStoreFirst, `NaN stored to ${cork.nanStoreFirst.to}`],
    ].filter(Boolean).sort((x, y)=>x[0].order - y[0].order);
    for (const [event, what] of nan)
    {
        say(`    first ${what}: #${event.order} at ${event.eip}, ${event.count} in all`);
    }
    if (cork.topBlocks?.length)
    {
        // The block profile's most executed blocks (--cork-config blockProfile).
        say(`    hottest blocks: ${cork.topBlocks.slice(0, 20).map((/** @type {any} */ b)=>
            `${b.address.toString(16)}x${b.count}${b.shared ? '*' : ''}`).join(' ')}`);
    }
    if (cork.stalls?.length)
    {
        // The engine thread's long holds (host ms): laid beside the audio
        // layer's staleAt, the stall a repeated sound sat through.
        say(`    stalls: ${cork.stalls.map((/** @type {any} */ s)=>`${s.what}@${s.at}+${s.ms}`).join(' ')}`);
    }
    if (cork.staleAt?.length)
    {
        say(`    repeated sound at: ${cork.staleAt.join(' ')}`);
    }
    if (cork.staleTrail?.length)
    {
        // kind:time:offset:bytes:play:write -- u an unlock, s a repeat.
        say(`    before the last repeat: ${cork.staleTrail.join(' ')}`);
    }
    const exits = cork.exits ?? {};
    say(`    exits: ${Object.entries(exits).map(([kind, count])=>`${kind}=${count}`).join(' ')}`
        + (cork.transfers ? `  transfers through the hash: ${cork.transfers}` : ''));
    if (typeof cork.translateMs === 'number')
    {
        say(`    translate ms: ${cork.translateMs.toFixed(1)}`
            + ` (forming ${cork.formingMs?.toFixed(1)} lookup ${cork.lookupMs?.toFixed(1)}`
            + ` emit ${cork.emitMs?.toFixed(1)} encode ${cork.encodeMs?.toFixed(1)}`
            + ` store ${cork.storeMs?.toFixed(1)} instantiate ${cork.instantiateMs?.toFixed(1)}`
            + ` publish ${cork.publishMs?.toFixed(1)} worker ${cork.workerMs?.toFixed(1)})`);
    }
    const refused = Object.entries(cork.refused ?? {});
    if (refused.length > 0)
    {
        say(`    refused opcodes: ${refused.map(([opcode, count])=>`${opcode} x${count}`)
            .join(', ')}`);
        const why = Object.entries(cork.refusedWhy ?? {});
        if (why.length > 0)
        {
            say(`      ${why.map(([reason, count])=>`${reason} x${count}`).join('; ')}`);
        }
    }
    const byTarget = cork.exitsByTarget ?? [];
    if (byTarget.length > 0)
    {
        say(`    untranslated exits by target:`);
        for (const { address, count, reason } of byTarget)
        {
            say(`      0x${(address >>> 0).toString(16).padStart(8, '0')}`
                + ` x${count}  ${reason}`);
        }
    }
}

/**
 * The whole run as text: what was asked, what answered, and where it stopped.
 *
 * @param {any} result
 * @param {any} context
 * @param {number} calls
 * @param {Record<string, { rva: number, name: string | null }[]>} [symbols]
 * @returns {string}
 */
function describe(result, context, calls, symbols){
    const lines = [];
    /** @param {string} text */
    const say = text=>lines.push(text);

    say(`${context.title} ${context.version} -- ${context.entry}`);
    say(`  entry image: ${context.executableBytes} bytes`);
    say(`  mode: ${context.mode}`);
    const executors = result.executors;
    if (executors?.refused)
    {
        say(`  executors: REFUSED -- ${executors.refused}`);
    }
    else if (executors?.others > 0)
    {
        say(`  executors: ${executors.others + 1}, ${executors.slices ?? 'not measured'} slices`
            + ` on the others, at most ${executors.mostAtOnce ?? 'not measured'} threads at once`);
    }
    say(`  adapter: ${JSON.stringify(result.adapter)}`);
    say(`  ran for ${result.elapsedMs}ms, ${result.instructions} guest instructions`);
    say(`stopped: ${result.stopped ?? result.error ?? 'no answer'}`);
    if (result.answeredAfterMs !== undefined && result.elapsedMs !== undefined)
    {
        say(`  answered ${(result.answeredAfterMs / 1000).toFixed(1)} s after the start, the run`
            + ` ${(result.elapsedMs / 1000).toFixed(1)} s of it: the rest is setting up and the`
            + ' report, whose read-back of the last frame waits for the device to finish every'
            + ' frame queued before it');
    }
    if (result.stack && !result.ok)
    {
        // A failure before the program ran has only this to say where it came from.
        say(result.stack.replace(/^/gm, '    '));
    }
    say('');

    // What the engine did not do and what it did otherwise than Windows, at
    // the top: a program told no -- E_NOTIMPL, a stub, a refused shader --
    // takes another path silently, and the line saying so was a thousand
    // lines down or past the events' cap. Errors first, then the messages.
    /** @type {Map<string, number>} */
    const errors = new Map();
    /** @type {Map<string, number>} */
    const notes = new Map();
    for (const { kind, payload } of result.divergences ?? [])
    {
        const line = kind === 'unimplemented'
            ? `${payload.import}: not implemented, answered with nothing`
            : kind === 'divergence' ? `${payload.api}: ${payload.detail}`
                : `${kind}: ${JSON.stringify(payload).slice(0, 300)}`;
        const failed = kind === 'unimplemented'
            || /E_NOTIMPL|refused|not implemented|not supported|error X\d/i.test(line);
        const into = failed ? errors : notes;
        into.set(line, (into.get(line) ?? 0) + 1);
    }
    for (const [title, entries] of [['errors -- what the engine did not do:', errors],
        ['messages -- what it did otherwise than Windows:', notes]])
    {
        if (/** @type {Map<string, number>} */ (entries).size > 0)
        {
            say(/** @type {string} */ (title));
            for (const [line, count] of /** @type {Map<string, number>} */ (entries))
            {
                say(`  ${count > 1 ? `${count}x ` : ''}${line}`);
            }
            say('');
        }
    }

    for (const peek of result.peeks ?? [])
    {
        say(`peek 0x${(peek.address >>> 0).toString(16)}: ${peek.bytes}`);
    }
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
        // A metric that is a structure prints as its own JSON rather than as
        // "[object Object]", which is what a nested one used to come out as --
        // a line that looks like a measurement and carries none.
        const metrics = Object.entries(layer.metrics ?? {})
            .map(([name, value])=>`${name}=${
                value !== null && typeof value === 'object' ? JSON.stringify(value) : value}`)
            .join(' ');
        say(`  ${layer.name} [${layer.status}] ${metrics}`);
    }
    say('');

    if (result.cork)
    {
        describeCork({ ...result.cork, staleAt: result.staleAt, staleTrail: result.staleTrail },
            say);
        say('');
    }

    const phases = result.phases;
    if (phases && phases.top.length > 0)
    {
        say(`  where the time went (self time, milliseconds):`);
        for (const row of phases.top)
        {
            say(`    ${row}`);
        }
        say('');
    }

    const graphics = result.graphics;
    if (graphics)
    {
        say(`  graphics: created=[${graphics.created.join(' ')}]`);
        if (graphics.openglMs)
        {
            say(`    OpenGL host time, estimated: playing the ring ${graphics.openglMs.ring} ms,`
                + ` the calls ${graphics.openglMs.calls} ms`);
        }
        if (graphics.sentToWorker)
        {
            const { batches, bytes, ms } = graphics.sentToWorker;
            say(`    to the graphics worker: ${batches} batches, ${bytes} bytes, posting them`
                + ` ${ms} ms`);
        }
        if (graphics.compressedTextures)
        {
            // count:bytes:hash of every compressed block the program handed
            // over: two runs of a deterministic load that differ here were
            // given different data by the program itself.
            say(`    compressed textures handed over: ${graphics.compressedTextures}`);
        }
        if (graphics.uploads)
        {
            say(`    texture uploads=${graphics.uploads.textures}`
                + ` staged=${graphics.uploads.staged} bytes=${graphics.uploads.bytes}`);
        }
        // How often a present waited for the device, and how far behind the
        // device ever was: a run on a slow adapter goes at the device's pace.
        const latency = graphics.presenter?.latency;
        if (latency?.frames > 0)
        {
            say(`    frames in flight: bound ${latency.limit || 'none'}; ${latency.held} of`
                + ` ${latency.frames} presents waited for the device,`
                + ` ${(latency.heldMs / 1000).toFixed(1)} s in all;`
                + ` at most ${latency.peak} unfinished`);
        }
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
            const cascade = device.cascade;
            if (cascade && (cascade.noTexture > 0 || cascade.noCoordSet > 0))
            {
                // A draw whose stage cascade stopped early is a draw that ran
                // untextured and said nothing. It is the shape of "a texture
                // disappeared", so a run names it rather than leaving it to a
                // screenshot.
                say(`    cascade cut: no-texture=${cascade.noTexture}`
                    + ` no-coord-set=${cascade.noCoordSet}`);
                for (const line of cascade.truncations)
                {
                    say(`      ${line}`);
                }
            }
            // Frame by frame, the frames that were not like the others: a
            // picture wrong for one frame in fifty is invisible in a total.
            /** @type {any[]} */
            const recent = device.recentFrames ?? [];
            if (recent.length > 0)
            {
                /** @param {(frame: any) => number} of */
                const usual = of=>{
                    /** @type {Map<number, number>} */
                    const seen = new Map();
                    for (const frame of recent)
                    {
                        seen.set(of(frame), (seen.get(of(frame)) ?? 0) + 1);
                    }
                    return [...seen].sort((left, right)=>right[1] - left[1])[0][0];
                };
                const usualTextures = usual(frame=>frame.textures);
                const usualDraws = usual(frame=>frame.draws);
                const odd = recent.filter(frame=>frame.placeholder > 0 || frame.truncated > 0
                    || frame.textures !== usualTextures
                    || Math.abs(frame.draws - usualDraws) > usualDraws / 5);
                say(`    recent frames: ${recent.length}, usually ${usualDraws} draws with`
                    + ` ${usualTextures} textures; ${odd.length} not like that`);
                for (const frame of odd.slice(0, 16))
                {
                    say(`      frame ${frame.index}: ${frame.draws} draws,`
                        + ` ${frame.textures} textures, ${frame.placeholder} placeholder,`
                        + ` ${frame.truncated} cut, ${frame.uploads} uploaded`);
                }
                // The fog each frame's draws ran under, as settings with a
                // draw count each. A frame whose sky ran under its ground's
                // fog is one where a count moved between settings, and that
                // shows here and nowhere else.
                /** @type {Map<string, number>} */
                const fogs = new Map();
                for (const frame of recent)
                {
                    const key = frame.fogs ?? '';
                    fogs.set(key, (fogs.get(key) ?? 0) + 1);
                }
                for (const [key, count] of [...fogs].sort((left, right)=>right[1] - left[1]))
                {
                    say(`      fog on ${count} frames: ${key === '' ? 'none' : key}`);
                }
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

    if ((result.bridge?.byFunction ?? []).length > 0)
    {
        say('  host functions since the start, by host time (name, calls, ms):');
        for (const line of result.bridge.byFunction)
        {
            say(`    ${line}`);
        }
        say('');
    }

    if ((result.bridge?.hooks ?? []).length > 0)
    {
        say('  sidecar hooks:');
        for (const hook of result.bridge.hooks)
        {
            const perCall = hook.calls > 0 ? (hook.ms * 1000) / hook.calls : 0;
            say(`    ${hook.name}  calls=${hook.calls} handled=${hook.handled} `
                + `fellThrough=${hook.fellThrough} mismatches=${hook.mismatches} `
                + `ms=${hook.ms.toFixed(2)} µs/call=${perCall.toFixed(2)}`);
        }
        say(`    kernelGlCalls=${result.bridge.kernelGlCalls ?? 0}`);
        say('');
    }

    const samples = result.samples;
    if (samples?.top?.length > 0)
    {
        const overflow = samples.overflow > 0 ? `, ${samples.overflow} buckets overflowed` : '';
        say(`  guest code, since boot (${samples.slices} slices${overflow}):`);
        const total = samples.top.reduce((sum, row)=>sum + row.instructions, 0);
        for (const row of samples.top.slice(0, 16))
        {
            const share = total > 0 ? (100 * row.instructions / total).toFixed(1) : '0.0';
            say(`    ${share.padStart(5)}%  ${(row.instructions / 1e6).toFixed(2)}M instr`
                + `  ${symbolName(row.at, symbols)}`);
        }
        say('');
    }

    say(`  frames presented: ${result.presents ?? 0}`);
    if ((result.inputs ?? []).length > 0)
    {
        // What the route sent and on which present, so a click that did not
        // land can be told from one that was never sent.
        say(`  input sent: ${result.inputs.map((/** @type {any} */ one)=>`#${one.present} ${
            one.kind === 'pointerMove' ? `move ${one.x},${one.y} by ${one.dx},${one.dy}`
                : one.kind === 'pointerButton' ? `${one.button} ${one.down ? 'down' : 'up'}`
                    : `${one.kind} ${one.code ?? one.text ?? ''}${one.down === false ? ' up' : ''}`
        }`).join('; ')}`);
    }
    // How the page read the sound: the shared table a worklet reads, or the ring.
    say(`  sound drained through: ${result.drain ?? '?'}`);
    if (result.steady)
    {
        const steady = result.steady;
        say(`  steady, ${steady.frames} frames after the load, over the last 240:`
            + ` frame ${steady.averageFrameMs.toFixed(1)} ms,`
            + ` guest ${steady.averageGuestMs.toFixed(1)} ms,`
            + ` host ${steady.averageHostMs.toFixed(1)} ms`);
        if (steady.cork)
        {
            const exits = Object.entries(steady.cork.exits)
                .filter(([, count])=>count > 0)
                .map(([kind, count])=>`${kind} ${Math.round(count)}`).join(', ');
            say(`    a frame: ${(steady.cork.retired / 1e6).toFixed(1)} M instructions,`
                + ` ${Math.round(steady.cork.transfers)} transfers through the hash`
                + ` (countTransfers), exits to the host: ${exits}`);
        }
    }
    const series = /** @type {any[]} */ (result.series ?? []);
    if (series.length > 1)
    {
        say('  frame series (a row per window of presents; per frame, and per draw where it'
            + ' divides):');
        say('      s   frames  frame ms  host ms  guest ms  draws  calls  host us/draw'
            + '  guest us/draw  calls/draw  upload KB  heap MB');
        for (let i = 1; i < series.length; i++)
        {
            const row = series[i];
            const before = series[i - 1];
            const frames = row.frames > 0 ? row.frames : 1;
            const draws = (row.draws - before.draws) / frames;
            const crossings = (row.calls - before.calls) / frames;
            /** @param {number} ms */
            const perDraw = ms=>(draws > 0 ? (ms * 1000 / draws).toFixed(1) : '-');
            say(`  ${(row.at / 1000).toFixed(0).padStart(5)}  ${String(row.frames).padStart(7)}`
                + `  ${row.frameMs.toFixed(1).padStart(8)}  ${row.hostMs.toFixed(1).padStart(7)}`
                + `  ${row.guestMs.toFixed(1).padStart(8)}  ${draws.toFixed(0).padStart(5)}`
                + `  ${crossings.toFixed(0).padStart(5)}  ${perDraw(row.hostMs).padStart(12)}`
                + `  ${perDraw(row.guestMs).padStart(13)}`
                + `  ${(draws > 0 ? crossings / draws : 0).toFixed(1).padStart(10)}`
                + `  ${((row.uploadBytes - before.uploadBytes) / frames / 1024).toFixed(0)
                    .padStart(9)}  ${row.heapMb.toFixed(0).padStart(7)}`);
        }
    }
    // The gaps between presents are the shape a stutter has, and the page's
    // long tasks say whether the thread the person's browser lives on was held.
    const gaps = [...result.presentGaps ?? []].sort((left, right)=>left - right);
    if (gaps.length > 0)
    {
        const at = (/** @type {number} */ share)=>gaps[Math.min(gaps.length - 1,
            Math.floor(gaps.length * share))].toFixed(1);
        say(`  present gap ms: median ${at(0.5)}, p90 ${at(0.9)}, max ${at(1)}`);
        // In order as well: a run that starts smooth and slows down, or one
        // that stutters every few seconds, has a shape the quantiles hide.
        const inOrder = /** @type {number[]} */ (result.presentGaps ?? []);
        const bucket = Math.max(1, Math.ceil(inOrder.length / 24));
        /** @type {string[]} */
        const shape = [];
        for (let from = 0; from < inOrder.length; from += bucket)
        {
            const slice = inOrder.slice(from, from + bucket);
            shape.push((slice.reduce((sum, gap)=>sum + gap, 0) / slice.length).toFixed(0));
        }
        say(`  present gap ms in order (${bucket} presents a bucket): ${shape.join(' ')}`);
    }
    if (result.longTasks)
    {
        say(`  page long tasks: ${result.longTasks.count}, `
            + `${result.longTasks.totalMs.toFixed(0)}ms total, `
            + `${result.longTasks.maxMs.toFixed(0)}ms longest`);
    }
    if (result.frame)
    {
        say(`  frame: ${JSON.stringify(result.frame)}`);
        say(`  colours: ${JSON.stringify(result.colours)}`);
        say(`  opacity: ${JSON.stringify(result.opacity)}`);
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

    for (const one of result.cpuProfiles ?? [])
    {
        say('');
        for (const line of describeProfile(one.url, one.summary, one.windowMs))
        {
            say(line);
        }
        if (one.frames > 0)
        {
            say(`  frames presented in the window: ${one.frames}`
                + `, ${(one.windowMs / one.frames).toFixed(1)} ms a frame`);
        }
        if (one.allocations)
        {
            const { total, sites } = one.allocations;
            const mib = (/** @type {number} */ bytes)=>(bytes / 1024 / 1024).toFixed(1);
            say(`  allocated in the window, sampled: ${mib(total)} MiB`
                + `, ${mib(total / (one.windowMs / 1000))} MiB/s`);
            for (const row of sites)
            {
                say(`    ${(row.share * 100).toFixed(1).padStart(5)}%`
                    + `  ${mib(row.bytes).padStart(7)} MiB  ${row.site}`);
            }
        }
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
        say(`  ${file.path} (${file.bytes} bytes${file.saved ? `, saved as ${file.saved}` : ''})`);
        // The whole file is beside the report; its end is what the program
        // wrote last, which is the part that says why it stopped.
        say(file.text.split('\n').slice(-40).map((/** @type {string} */ text)=>`    ${text}`).join('\n'));
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
    // The Windows the bottle runs under, which createApp would refuse by name
    // if it were not one of its four -- refused here, before a browser starts.
    const windows = options.windows ?? manifest.windows ?? undefined;
    windowsVersion(windows);

    // A bundle's own hooks.json/hooks.mjs, beside its manifest.json and never
    // inside the bundle: read here, the same way this driver already reads
    // the manifest, and handed to createApp as `sidecarHooks`.
    const hooksJsonPath = join(directory, 'hooks.json');
    const sidecarHooks = options.hooks && existsSync(hooksJsonPath)
        ? {
            spec: JSON.parse(await readFile(hooksJsonPath, 'utf8')),
            source: await readFile(join(directory, 'hooks.mjs'), 'utf8'),
        }
        : undefined;

    // The same sidecar convention as `hooks.json`: per-title content beside
    // the manifest, absent for most bundles. Maps an image name to its
    // function starts, sorted ascending, for folding the sampler's address
    // buckets into names below -- this driver's own job, never the engine's.
    const symbolsPath = join(directory, 'symbols.json');
    const symbols = existsSync(symbolsPath)
        ? JSON.parse(await readFile(symbolsPath, 'utf8'))
        : undefined;

    // The tools-side reader takes a path and does its own reading, which is how
    // the entry image is lifted out here; the engine's takes a byte range and
    // gets one over HTTP, which is how the page reads everything else.
    const opened = await openBundle(bundlePath);
    // Another program of the bundle than the one the manifest starts, when
    // asked: `--entry game.exe` starts the game itself where the manifest's
    // entry is its launcher.
    const entry = options.entry ?? manifest.entry;
    const executable = await opened.read(entry);
    await opened.close();
    // The page fetches the image rather than being handed it in the request:
    // an installer's image carries its whole payload, and a protocol message
    // of hundreds of megabytes closes the connection instead of arriving.
    const entryDirectory = mkdtempSync(join(tmpdir(), 'bottlify-entry-'));
    writeFileSync(join(entryDirectory, 'entry.exe'), executable);
    process.on('exit', ()=>rmSync(entryDirectory, { recursive: true, force: true }));

    const server = await serveStatic({
        sandboxDir: PACKAGE_DIR,
        srcDir: join(PACKAGE_DIR, 'src'),
        extra: [
            { prefix: '/bundle/', root: directory },
            { prefix: '/entry/', root: entryDirectory },
            ...(options.disc ? [{ prefix: '/disc/', root: dirname(options.disc) }] : []),
            // The translator package beside core, where app.js resolves it.
            { prefix: '/cork/', root: join(PACKAGE_DIR, '..', 'cork') },
            // The networking client, for a run that names a relay.
            { prefix: '/networking/', root: join(PACKAGE_DIR, '..', 'networking', 'src') },
        ],
        coi: options.coi,
        port: options.port,
    });
    const browser = await launchWithGpu({ profileDir: options.userDataDir ?? undefined,
        headed: options.headed,
        extraFlags: [...options.jsFlags ? [`--js-flags=${options.jsFlags}`] : [],
            ...options.chromeFlags] });
    mkdirSync(REPORTS_DIR, { recursive: true });

    const pageUrl = `http://127.0.0.1:${server.port}/sandbox/test/page/game/index.html`
        + (options.worker ? `?worker=1&pacing=${options.pacing}` : '');
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

        // Where the bundle is mounted and the program started from: where its
        // installation put it, when the manifest says, as the launcher does.
        const { prefix: bundlePrefix, imagePath } = placementOf({ ...manifest, entry });
        const request = JSON.stringify({
            exeUrl: `http://127.0.0.1:${server.port}/entry/entry.exe`,
            bundleUrl: `http://127.0.0.1:${server.port}/bundle/bundle.btl`,
            discUrl: options.disc
                ? `http://127.0.0.1:${server.port}/disc/${encodeURIComponent(basename(options.disc))}`
                : undefined,
            bundlePrefix,
            imagePath,
            // The bundle's own launch arguments, appended after the quoted
            // image path the same way createApp's own default is built,
            // unless `--command-line` overrides them.
            commandLine: options.commandLine
                ?? (manifest.commandLine ? `"${imagePath}" ${manifest.commandLine}` : undefined),
            windows,
            sidecarHooks,
            hooks: options.watches,
            record: options.record,
            memorySize: options.memory > 0 ? options.memory * 1024 * 1024 : undefined,
            watch: options.watchImports.length > 0
                ? { libraries: Object.fromEntries(options.watchImports.map(spec=>{
                    const [dll, ordinals] = spec.toLowerCase().split('#');
                    return [dll, ordinals ? ordinals.split('+').map(Number) : null];
                })), strings: [] }
                : undefined,
            peeks: options.peeks,
            maxTurns: options.turns,
            concurrency: options.concurrency,
            maxMs: options.runSeconds > 0 ? options.runSeconds * 1000 : null,
            // A harness run is a diagnostic one: the translator's timings and its
            // record of long holds are on unless the run turns them off.
            cork: { config: { timings: true, ...options.corkConfig } },
            screen: options.screen,
            quantum: options.quantum,
            executors: options.executors,
            graphicsWorker: options.graphicsWorker,
            ...options.journalCalls ? { logCapacity: 100000, logCategories: {
                'call.cpu': 'trace', 'call.gpu': 'trace', 'call.net': 'trace' } } : {},
            log: Boolean(options.log),
            logLines: options.logLines,
            video: options.video,
            dumpDraws: options.dumpDraws,
            // A window a person watches shows every frame as it comes, not the last at the end.
            live: options.headed,
            dumpEvery: options.dumpEvery || undefined,
            profileCalls: options.profileCalls,
            maxDraws: options.maxDraws,
            skipTexture: options.skipTexture,
            keepImages: options.keepImages,
            probeTexture: options.probeTexture,
            fog: options.fog,
            graphics: options.graphics,
            graphicsApi: options.graphicsApi ?? undefined,
            audio: options.audio ?? undefined,
            captureAudio: options.captureAudio ?? undefined,
            trace: options.trace,
            pointer: options.pointer,
            steadyFrames: options.steadyFrames || undefined,
            series: options.series || undefined,
            snapFrame: options.snapFrame || undefined,
            snapFromStart: options.snapFromStart,
            snapCount: options.snapCount,
            snapEvery: options.snapEvery,
            clicks: options.clicks,
            clickTimes: options.clickTimes,
            presses: options.presses,
            pressSettleMs: options.pressSettleMs,
            keyTimes: options.keyTimes,
            typed: options.typed,
            looks: options.looks,
            pasted: options.pasted,
            logMatch: options.logMatch,
            logTimes: options.logTimes,
            network: options.network
                ? {
                    module: new URL('/networking/client/index.js', pageUrl).href,
                    url: options.network,
                    room: 'harness',
                }
                : undefined,
            keys: options.keys,
            files: options.files,
            wholeFiles: options.saveFiles,
            store: options.store ?? undefined,
            prefetch: options.prefetch,
            exportTranslations: options.exportTranslations !== null,
            bundleId: options.id,
        });
        // Made before the profiler asks for the page's workers, so the engine
        // worker is seen whichever request attaches it.
        const device = watchDevice(cdp, sessionId, { worker: options.worker });
        /** @type {Awaited<ReturnType<typeof profileWorkers>> | null} */
        const profiler = options.cpuProfile > 0 && options.worker
            ? await profileWorkers(cdp, sessionId, { heap: options.heapProfile }) : null;
        const deviceWatched = await device.install({ attach: profiler === null });
        let profilingFrom = Date.now();
        /** @type {{ url: string, profile: any, allocations: any, windowMs: number, from: number }[] | null} */
        let cpuProfiles = null;
        /** @type {{ at: number, workers: any[] }[]} */
        const heapSeries = [];
        const heapTimer = profiler !== null && options.heapProfile
            ? setInterval(()=>{
                profiler.usage().then(workers=>heapSeries.push({ at: Date.now(), workers }))
                    .catch(()=>{});
            }, 1000)
            : null;
        const stopProfiling = async()=>{
            if (profiler === null || cpuProfiles !== null)
            {
                return;
            }
            if (heapTimer !== null)
            {
                clearInterval(heapTimer);
            }
            const windowMs = Date.now() - profilingFrom;
            const from = profilingFrom;
            cpuProfiles = (await profiler.stop()).map(one=>({ ...one, windowMs, from }));
        };
        // A later window: the profilers restart after the load, and the window
        // runs its length from there.
        const profileTimer = profiler === null
            ? null
            : setTimeout(()=>{
                stopProfiling().catch(()=>{});
            }, (options.cpuProfileFrom + options.cpuProfile) * 1000);
        if (profiler !== null && options.cpuProfileFrom > 0)
        {
            setTimeout(()=>{
                profilingFrom = Date.now();
                profiler.restart().catch(()=>{});
            }, options.cpuProfileFrom * 1000);
        }
        /** @param {string} stampFor */
        const saveProfiles = stampFor=>{
            for (const [index, one] of (cpuProfiles ?? []).entries())
            {
                writeFileSync(join(REPORTS_DIR, `game-${stampFor}-cpu-${index}.cpuprofile`),
                    JSON.stringify(one.profile));
                if (one.allocations)
                {
                    writeFileSync(join(REPORTS_DIR, `game-${stampFor}-heap-${index}.heapprofile`),
                        JSON.stringify(one.allocations));
                }
            }
            if (heapSeries.length > 0)
            {
                writeFileSync(join(REPORTS_DIR, `game-${stampFor}-heap-usage.json`),
                    JSON.stringify(heapSeries));
            }
        };
        await cdp.send('Runtime.evaluate',
            { expression: `window.__bottlify__.start(${request}); null`,
                returnByValue: true },
            sessionId);

        const watchFrom = Date.now();
        const watchStamp = new Date().toISOString().replace(/[:.]/g, '-');
        let eventsSeen = 0;
        let filesSeen = '';
        const watchTimer = options.watch > 0
            ? setInterval(()=>{
                const at = ((Date.now() - watchFrom) / 1000).toFixed(0).padStart(5, '0');
                cdp.send('Runtime.evaluate', {
                    expression: `window.__bottlify__.standing(${JSON.stringify(options.list)})`,
                    awaitPromise: true, returnByValue: true }, sessionId).then(answer=>{
                    const { processes = [], events = [], desktop = null, files = [] } =
                        answer.result?.value ?? {};
                    if (options.list)
                    {
                        const bytes = files.reduce((/** @type {number} */ total,
                            /** @type {any} */ file)=>total + file.size, 0);
                        console.log(`${at} s  files ${files.length}, ${bytes} bytes`
                            + ` under ${options.list}`);
                        const now = JSON.stringify(files);
                        if (now !== filesSeen)
                        {
                            filesSeen = now;
                            for (const file of files)
                            {
                                console.log(`${at} s    file ${String(file.size).padStart(10)}`
                                    + ` ${file.path}`);
                            }
                        }
                    }
                    for (const event of events.slice(eventsSeen))
                    {
                        console.log(`${at} s  event ${event}`);
                    }
                    eventsSeen = events.length;
                    for (const one of processes)
                    {
                        const { image, windows: shownWindows, cpu, ...rest } = one;
                        console.log(`${at} s  ${String(image).split('\\').pop()}`
                            + ` ${JSON.stringify(rest).slice(0, 1200)}`);
                        console.log(`${at} s    cpu ${JSON.stringify(cpu)}`);
                        for (const shown of shownWindows)
                        {
                            console.log(`${at} s    window ${shown.hwnd}`
                                + `${shown.parent ? ` in ${shown.parent}` : ''}`
                                + ` ${shown.className} "${shown.title}"`
                                + ` ${shown.x},${shown.y} ${shown.width}x${shown.height}`);
                        }
                    }
                    if (desktop)
                    {
                        // The desktop's rows are its pitch apart, the PNG's
                        // exactly a row of pixels; a DIB's fourth byte is not
                        // an alpha, so every pixel is opaque.
                        const bytes = Buffer.from(desktop.pixels, 'base64');
                        const packed = Buffer.alloc(desktop.width * desktop.height * 4, 0xff);
                        for (let y = 0; y < desktop.height; y++)
                        {
                            for (let x = 0; x < desktop.width; x++)
                            {
                                bytes.copy(packed, (y * desktop.width + x) * 4,
                                    y * desktop.pitch + x * 4, y * desktop.pitch + x * 4 + 3);
                            }
                        }
                        const path = join(REPORTS_DIR, `game-${watchStamp}-desktop-${at}.png`);
                        writeFileSync(path, toPng(desktop.width, desktop.height, packed));
                        console.log(`${at} s  desktop ${path}`);
                    }
                }, (/** @type {any} */ e)=>{
                    console.log(`${at} s  no answer: ${e?.message ?? e}`);
                });
            }, options.watch * 1000)
            : null;

        // The whole call stream, drained in pieces: a quarter of a million
        // lines is more than one evaluation carries. Factored out so a run that
        // never readies a result -- a title that does not exit, slowed by its
        // own freezing past any wait -- still leaves behind the stream up to the
        // point it reached, which is the whole reason the log was asked for.
        const drainLog = async()=>{
            if (!options.log)
            {
                return;
            }
            const lines = [];
            for (let at = 0; ; at += LOG_CHUNK)
            {
                const piece = await cdp.send('Runtime.evaluate', {
                    expression: `window.__bottlify__.drainLog(${at}, ${LOG_CHUNK})`,
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
        };

        // The report reads the last frame back, so it answers only once the
        // device has finished everything queued before that read: said as it
        // happens, so a wait for the device does not read as a page that hangs.
        const startedAt = Date.now();
        /** @type {import('./device-lag.mjs').DeviceState | null} */
        let lastDevice = null;
        const deviceTimer = deviceWatched
            ? setInterval(()=>{
                device.read().then(state=>{
                    lastDevice = state ?? lastDevice;
                    if (state && state.oldestMs >= 5000)
                    {
                        console.log(`  waiting at ${Math.round((Date.now() - startedAt) / 1000)} s:`
                            + ` ${describeDevice(state)}`);
                    }
                }, ()=>{});
            }, 30000)
            : null;
        // `--shots-every S`: the page as it stands every S seconds, written at
        // once, so a run that never comes back still leaves what it showed.
        const shotsStamp = new Date().toISOString().replace(/[:.]/g, '-');
        let shooting = false;
        const shotsTimer = options.shotsEvery > 0
            ? setInterval(()=>{
                if (shooting)
                {
                    return;
                }
                shooting = true;
                const at = Math.round((Date.now() - startedAt) / 1000);
                // The frame presented last, read back from the device: the page's
                // own canvas shows nothing while a run goes on headless.
                cdp.send('Runtime.evaluate', { expression: 'window.__bottlify__.frameShot()',
                    returnByValue: true, awaitPromise: true }, sessionId).then(answer=>{
                    const shot = answer?.result?.value;
                    if (!shot)
                    {
                        console.log(`  shot at ${at} s: no frame presented yet`);
                        return;
                    }
                    const bytes = Buffer.from(shot.pixels, 'base64');
                    const image = toPng(shot.width, shot.height,
                        shot.format === 'bgra8unorm' ? bytes : toBgra(bytes));
                    const path = join(REPORTS_DIR,
                        `game-${shotsStamp}-at-${String(at).padStart(5, '0')}s.png`);
                    writeFileSync(path, image);
                    console.log(`  shot at ${at} s: ${path} (frame ${shot.frameIndex}`
                        + ` of ${shot.presents} presented)`);
                }, ()=>{}).finally(()=>{
                    shooting = false;
                });
            }, options.shotsEvery * 1000)
            : null;
        let result;
        try
        {
            result = await readResult(cdp, sessionId, options.waitMs);
            result.answeredAfterMs = Date.now() - startedAt;
        }
        catch (e){
            const behind = deviceWatched ? await device.read() ?? lastDevice : null;
            if (profileTimer !== null)
            {
                clearTimeout(profileTimer);
            }
            await stopProfiling().catch(()=>{});
            await drainLog();
            const stampOut = new Date().toISOString().replace(/[:.]/g, '-');
            const reason = await reportTimeout({
                reason: `${e instanceof Error ? e.message : String(e)}`
                    + `${deviceWatched ? ` -- ${describeDevice(behind)}` : ''}`
                    + `${options.log ? ` -- call log drained to ${options.log}` : ''}`,
                save(){
                    saveProfiles(stampOut);
                    for (const one of cpuProfiles ?? [])
                    {
                        console.log(describeProfile(one.url,
                            summarise(one.profile, one.windowMs), one.windowMs).join('\n'));
                    }
                },
                capture: async()=>(await cdp.send(
                    'Page.captureScreenshot', { format: 'png' }, sessionId)).data,
                stack: async()=>{
                    const stack = await pausedStack(cdp, sessionId);
                    // The page answers between the engine's turns: every layer's
                    // metrics as the run stands, since no report will come.
                    // A promise from the worker, a string from the page.
                    const live = await cdp.send('Runtime.evaluate', {
                        expression: 'window.__bottlify__.frameReport()', returnByValue: true,
                        awaitPromise: true,
                    }, sessionId).catch(()=>null);
                    if (live?.result?.value)
                    {
                        const path = join(REPORTS_DIR, `game-${stampOut}-live.json`);
                        writeFileSync(path, live.result.value);
                        // And the frame presented last, which a page screenshot
                        // of a WebGPU canvas does not hold.
                        const shot = await cdp.send('Runtime.evaluate', {
                            expression: 'window.__bottlify__.frameShot()'
                                + '.then(function(s){ return JSON.stringify(s); })',
                            returnByValue: true, awaitPromise: true,
                        }, sessionId).catch(()=>null);
                        const frame = shot?.result?.value ? JSON.parse(shot.result.value) : null;
                        if (frame)
                        {
                            writeFileSync(join(REPORTS_DIR, `game-${stampOut}-frame.png`),
                                toPng(frame.width, frame.height, frame.format.startsWith('bgra')
                                    ? Buffer.from(frame.pixels, 'base64')
                                    : toBgra(Buffer.from(frame.pixels, 'base64'))));
                        }
                        return `${stack}
the run as it stands: ${path}`;
                    }
                    return stack;
                },
                write: data=>writeFileSync(join(REPORTS_DIR, `game-${stampOut}.png`),
                    Buffer.from(data, 'base64')),
            });
            return { ok: false, measured: false, pageUrl, events: thrown, reason };
        }
        finally
        {
            if (deviceTimer !== null)
            {
                clearInterval(deviceTimer);
            }
            if (shotsTimer !== null)
            {
                clearInterval(shotsTimer);
            }
            if (watchTimer !== null)
            {
                clearInterval(watchTimer);
            }
        }

        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const shotPath = join(REPORTS_DIR, `game-${stamp}.png`);
        const reportPath = join(REPORTS_DIR, `game-${stamp}.txt`);
        if (profileTimer !== null)
        {
            clearTimeout(profileTimer);
        }
        await stopProfiling().catch(()=>{});
        saveProfiles(stamp);
        // Every present's wall-clock time, for comparing two runs over the same
        // frames rather than the same seconds (tools/frame-span.mjs).
        writeFileSync(join(REPORTS_DIR, `game-${stamp}-presents.json`),
            JSON.stringify(result.presentTimes ?? []));
        if ((result.series ?? []).length > 0)
        {
            writeFileSync(join(REPORTS_DIR, `game-${stamp}-series.json`),
                JSON.stringify(result.series));
        }
        result.cpuProfiles = (cpuProfiles ?? []).map(one=>({
            url: one.url, windowMs: one.windowMs, summary: summarise(one.profile, one.windowMs),
            allocations: one.allocations ? summariseAllocations(one.allocations) : null,
            // The frames the program presented inside the window, so a profile's
            // milliseconds divide into a frame's.
            frames: (result.presentTimes ?? []).filter((/** @type {number} */ at)=>at >= one.from
                && at < one.from + one.windowMs).length,
        }));
        // The whole page: a picture taller than the window is cut off otherwise.
        const shot = await cdp.send('Page.captureScreenshot',
            { format: 'png', captureBeyondViewport: true }, sessionId);
        writeFileSync(shotPath, Buffer.from(shot.data, 'base64'));
        // The last presented frame as the engine read it back, beside the
        // page's screenshot: the screenshot is what the compositor showed at
        // the moment of the stop, the frame is what the program drew.
        for (const [index, one] of (result.snaps ?? []).entries())
        {
            // The first as -snap.png as before, every one also by its frame.
            const image = toPng(one.width, one.height, toBgra(Buffer.from(one.rgba, 'base64')));
            if (index === 0)
            {
                writeFileSync(join(REPORTS_DIR, `game-${stamp}-snap.png`), image);
            }
            writeFileSync(join(REPORTS_DIR, `game-${stamp}-snap-${one.frame}.png`), image);
        }
        delete result.snaps;
        if (result.audioCapture)
        {
            // Sixteen-bit stereo PCM behind a 44-byte RIFF header.
            const pcm = Buffer.from(result.audioCapture.pcm, 'base64');
            const rate = result.audioCapture.sampleRate;
            const head = Buffer.alloc(44);
            head.write('RIFF', 0);
            head.writeUInt32LE(36 + pcm.length, 4);
            head.write('WAVEfmt ', 8);
            head.writeUInt32LE(16, 16);
            head.writeUInt16LE(1, 20);
            head.writeUInt16LE(2, 22);
            head.writeUInt32LE(rate, 24);
            head.writeUInt32LE(rate * 4, 28);
            head.writeUInt16LE(4, 32);
            head.writeUInt16LE(16, 34);
            head.write('data', 36);
            head.writeUInt32LE(pcm.length, 40);
            writeFileSync(join(REPORTS_DIR, `game-${stamp}-audio.wav`), Buffer.concat([head, pcm]));
            delete result.audioCapture;
        }
        if (result.frameRgba && result.frame)
        {
            writeFileSync(join(REPORTS_DIR, `game-${stamp}-frame.png`), toPng(result.frame.width,
                result.frame.height, toBgra(Buffer.from(result.frameRgba, 'base64'))));
            delete result.frameRgba;
        }

        await drainLog();

        // Everything the program wrote, kept as files rather than as excerpts.
        // A game's own crash report is its account of what went wrong and beats
        // any trace taken from outside it -- but only if all of it survives.
        for (const file of result.files ?? [])
        {
            const name = `game-${stamp}-${file.path.replace(/[\\/:]+/g, '_')}`;
            const saved = join(REPORTS_DIR, name);
            writeFileSync(saved, file.base64 ? Buffer.from(file.base64, 'base64') : file.text,
                file.base64 ? undefined : 'latin1');
            file.saved = saved;
        }

        // The seed goes to its own file, not into the report.
        if (options.exportTranslations !== null)
        {
            if (result.translations)
            {
                writeFileSync(options.exportTranslations,
                    Buffer.from(result.translations, 'base64'));
                console.log(`translations: ${options.exportTranslations}`);
            }
            else
            {
                console.log('translations: none (no store)');
            }
            delete result.translations;
        }

        const text = describe(result, {
            title: manifest.title,
            version: manifest.version,
            entry: manifest.entry,
            executableBytes: executable.length,
            mode: `${options.mode}, ${options.executors || 1} executor(s), cork`
                + ` ${JSON.stringify(options.corkConfig ?? {})}`,
        }, options.calls, symbols);
        writeFileSync(reportPath, text);
        // The store's keys put and missed (`traceStore` in --cork-config), for
        // comparing a cold run's keys with a warm run's.
        if (result.cork?.storeTrace)
        {
            writeFileSync(join(REPORTS_DIR, `game-${stamp}-store.json`),
                JSON.stringify(result.cork.storeTrace));
            delete result.cork.storeTrace;
        }
        // Every counted block (`blockProfile` in --cork-config), for tools/cork-mix.mjs.
        if (result.cork?.blockCounts)
        {
            writeFileSync(join(REPORTS_DIR, `game-${stamp}-blocks.json`),
                JSON.stringify({ bundle: options.id, blocks: result.cork.blockCounts }));
            delete result.cork.blockCounts;
        }

        // The graphics layer's whole account as JSON beside the report: the
        // frame records, the presenter's copies by source, every counter --
        // what a black or a frozen picture is read from.
        for (const kept of result.graphics?.keptImages ?? [])
        {
            const rgba = Buffer.from(kept.rgba, 'base64');
            // toPng takes BGRA.
            for (let at = 0; at < rgba.length; at += 4)
            {
                [rgba[at], rgba[at + 2]] = [rgba[at + 2], rgba[at]];
            }
            writeFileSync(join(REPORTS_DIR, `game-${stamp}-image-${kept.index}.png`),
                toPng(kept.width, kept.height, rgba));
        }
        // Every kept frame's lines, one block a frame, beside the graphics
        // dump rather than inside it: tens of megabytes to grep.
        const everyDump = result.graphics?.device?.dumps ?? [];
        if (everyDump.length > 0)
        {
            writeFileSync(join(REPORTS_DIR, `game-${stamp}-dumps.txt`), everyDump
                .map((/** @type {any} */ one)=>`== frame ${one.frame}\n${one.lines.join('\n')}\n`)
                .join(''));
            delete result.graphics.device.dumps;
        }
        if (result.graphics)
        {
            delete result.graphics.keptImages;
            writeFileSync(join(REPORTS_DIR, `game-${stamp}-graphics.json`),
                JSON.stringify(result.graphics, null, 1));
        }
        // A file of its own: one line per draw is thousands of lines, which is
        // a thing to grep rather than a thing to read past.
        const drawn = result.graphics?.device?.lastDump ?? [];
        let drawsPath = null;
        if (drawn.length > 0)
        {
            drawsPath = join(REPORTS_DIR, `game-${stamp}-draws.txt`);
            writeFileSync(drawsPath, `${drawn.join('\n')}\n`);
        }
        if ((result.recorded ?? []).length > 0)
        {
            const path = join(REPORTS_DIR, `game-${stamp}-bridge.jsonl`);
            writeFileSync(path, `${result.recorded.map((/** @type {any} */ event)=>
                JSON.stringify(event)).join('\n')}\n`);
            console.log(`bridge:     ${result.recorded.length} events in ${path}`);
        }
        // Every shader the program compiled: its source and, beside it, what
        // the compiler made of it, disassembled -- a picture wrong in a shader
        // is read by comparing the two.
        if ((result.shaders ?? []).length > 0)
        {
            const shaderDirectory = join(REPORTS_DIR, `game-${stamp}-shaders`);
            mkdirSync(shaderDirectory, { recursive: true });
            result.shaders.forEach((/** @type {any} */ shader, /** @type {number} */ index)=>{
                const name = `${String(index).padStart(3, '0')}-${shader.profile}-${
                    String(shader.entry).replace(/[^\w]/g, '_')}`;
                // The program's macros and flags first, as the defines the
                // source was compiled under: the same text is many shaders.
                writeFileSync(join(shaderDirectory, `${name}.hlsl`), `${(shader.defines ?? [])
                    .map((/** @type {string[]} */ [key, value])=>`#define ${key} ${value}\n`)
                    .join('')}// flags 0x${(shader.flags ?? 0).toString(16)}\n${shader.source}`);
                // What its includes handed over, under their own names, so a
                // reference compiler can read the same tree.
                for (const [file, body] of Object.entries(shader.included ?? {}))
                {
                    writeFileSync(join(shaderDirectory, String(file).replace(/[\\/:*?"<>|]/g, '_')),
                        String(body));
                }
                const bytes = shader.tokens ? Buffer.from(shader.tokens, 'base64') : null;
                writeFileSync(join(shaderDirectory, `${name}.txt`), `${shader.messages}${bytes
                    ? listing(new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4))
                    : 'no bytecode\n'}`);
            });
            console.log(`shaders:    ${result.shaders.length} in ${shaderDirectory}`);
        }
        // The texels behind those draws, as images. A rectangle in a frame is
        // either something a draw put there or something already in what it
        // sampled, and only the texture itself tells those apart.
        for (const texture of result.graphics?.device?.textures ?? [])
        {
            const name = `game-${stamp}-${texture.id}-fmt${texture.format}`;
            writeFileSync(join(REPORTS_DIR, `${name}.png`),
                toPng(texture.width, texture.height, Buffer.from(texture.bgra, 'base64')));
            if (texture.deviceBgra)
            {
                writeFileSync(join(REPORTS_DIR, `${name}-device.png`), toPng(
                    texture.width, texture.height, Buffer.from(texture.deviceBgra, 'base64')));
            }
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

/**
 * The arguments with a title's saved route behind them: `--route` reads
 * route.json beside the bundle, whose `args` are the clicks and keys that take
 * the title from its start to where `reaches` says. Behind, so a flag given by
 * hand wins over the route's.
 *
 * @param {string[]} argv
 */
function withRoute(argv){
    if (!argv.includes('--route'))
    {
        return argv;
    }
    const id = argv.find(argument=>!argument.startsWith('--'));
    const file = join(BUNDLES_DIR, id ?? '', 'route.json');
    if (!existsSync(file))
    {
        throw new Error(`--route: no route saved for ${id} (${file})`);
    }
    const route = JSON.parse(readFileSync(file, 'utf8'));
    console.log(`route: ${route.reaches ?? 'where it goes is not written'}`);
    return [...argv.filter(argument=>argument !== '--route'), ...route.args];
}

const options = parse(withRoute(process.argv.slice(2)));
if (!options.id)
{
    console.error(
        'usage: node tools/cdp_test/game.mjs <bundle-id> [--turns N] [--wait SECONDS] [--worker]');
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
