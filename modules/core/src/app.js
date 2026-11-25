/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { visibleCursor } from './cursor.js';
import { createJsSampler } from './host/js-samples.js';
import { fitFrame, isShown, placementOf, stretchFrame } from './letterbox.js';
import { assembleModules } from './core.js';
import { createEvents } from './events.js';

import { captureTrace, formatTrace } from './trace.js';
import { HEAP_POOLS, NOT_MEASURED } from './memory-zones.js';
import {
    DEFAULT_INITIAL_STACK, DEFAULT_MEMORY_SIZE, DEFAULT_THUNK_BASE, DEFAULT_THUNK_CAPACITY,
    MAX_EXECUTORS, processorsFor,
} from './layers/cpu/module.js';
import { engineContractProblem } from './layers/cpu/engine.js';
import { SETTINGS } from './settings.js';
import { createPresenter } from './layers/graphics/webgpu/internal/presenter.js';
import {
    baseOf, compositionPlan, needsComposing,
} from './layers/graphics/webgpu/internal/compose.js';
import { connectGraphicsWorker } from './layers/graphics/remote/connect.js';
import {
    DIR_EXPORT, imageKind, parseExportDirectory, parsePe, readExports, readImports, rvaToFileOffset,
} from './layers/loader/internal/pe.js';
import { planDependencies } from './layers/loader/internal/dependencies.js';
import { WINDOWS_LIBRARIES } from './layers/loader/internal/windows-libraries.js';
import { LIBRARIES_SINCE } from './layers/loader/internal/libraries-since.js';
import { STATUS } from './layers/win32/ntdll/status.js';
import { readMappedTls } from './layers/loader/internal/tls.js';
import { jumpBytes, relocatablePrefix } from './layers/loader/internal/hooks.js';

import { blockLayouts, createProcessBlocks } from './layers/win32/kernel32/teb.js';
import { DEBUG_EVENT } from './layers/win32/kernel32/debug-events.js';
import { KUSER, KUSER_REGION, SHARED_USER_DATA, createSharedUserData, sharedPageAt }
    from './layers/win32/kernel32/shared-data.js';
import { windowsFor, windowsVersion } from './layers/win32/kernel32/versions.js';
import { KNOWN_ROUTINES } from './layers/win32/msvcrt/known-routines.js';
import { graphicsChoice } from './layers/graphics/choice.js';

import { sectionImageInformation } from './layers/win32/kernel32/mapping.js';
import { announceSteamClient } from './layers/win32/steamclient/functions.js';
import { synthesiseProcessInit, synthesiseStartRefused } from './layers/loader/internal/init.js';
import {
    createSharingMemory, openSharedSharing,
} from './layers/filesystem/internal/shared-sharing.js';
import { openPageFile } from './layers/filesystem/internal/page-file.js';
import { resolveTranslationStore } from './layers/cpu/internal/translation-store.js';
import { createClassTable } from './layers/win32/ole32/remote.js';
import { remoteClassTable } from './com-link.js';
import { createCallRepeats } from './call-repeats.js';
import { withConcurrency } from './concurrency.js';
import { SHARED_MODULE_BYTES, withHeldModules } from './layers/cpu/internal/store-link.js';
import { createMemoryBudget, openMemoryBudget, RUN_HOLDER }
    from './layers/cpu/internal/memory-budget.js';
import { PROGRAMS_LIBRARY, WINDOWS_DIRECTORY } from './layers/win32/programs/table.js';
import { RUN_ONCE_ROUTINE } from './layers/win32/programs/functions.js';
import { frameworkNeeded } from './layers/win32/mscoree/need.js';
import { shareTransport } from './layers/win32/wsock32/transport.js';
import { createSharedViews } from './layers/win32/kernel32/shared-views.js';
import { pipeStandIn } from './layers/win32/kernel32/pipes.js';
import { HANDLE_STDERR, HANDLE_STDIN, HANDLE_STDOUT } from './layers/win32/kernel32/console.js';
import { openProcessWorker } from './host/process-worker.js';
import { createTranslatorPool } from './host/pool/pool.js';
import { createInputRoute } from './layers/input/route.js';
import { mobileOrSafari, tailCallsFault, withoutFaultingTailCalls } from './tail-calls.js';
import { createModuleTable, pathKey } from './process/module-table.js';
import { createSystemModules, shapeOf } from './process/system-modules.js';
import { bindSidecar } from './process/sidecar.js';
import { openRunCache } from './process/run-cache.js';
import { processesBeside } from './process/beside.js';
import { processMemories } from './process/memories.js';
import { compatibilityOf } from './process/image-resources.js';
import { processSound } from './process/sound.js';
import { classServers } from './process/servers.js';
import { IDLE_LOOK_MS } from './process/run-waits.js';
import { ENGINE_CODE_BYTES, FIRST_PROCESS_ID } from './process/process-layout.js';
import {
    buildSystemHost, corkArtifacts, inputRecipient, journalEvents,
} from './process/system-host.js';
import { furnishVolume, openSession } from './process/session.js';
import { mountBundle } from './process/bundle-mount.js';
import { createLibraryLoader } from './process/library-loader.js';
import { layerConfig } from './process/layer-config.js';
import { processController } from './process/controller.js';
import {
    LIBRARY_ALIGN, RT_MANIFEST, exportTables, libraryCandidates, moduleKeyOf, pathDirectories,
    placeLibrary, readWholeFile, resourceOfImage, startDirectoryOf,
} from './process/libraries.js';

/** FNV-1a, 32 bits: a call's number for telling its repeats apart in the journal. */
const FNV_OFFSET = 0x811c9dc5;
/** @param {number} hash @param {number} word */
const hashWord = (hash, word)=>{
    let h = hash;
    for (let shift = 0; shift < 32; shift += 8)
    {
        h = Math.imul(h ^ ((word >>> shift) & 0xff), 0x01000193);
    }
    return h >>> 0;
};
/** @param {number} hash @param {string} text */
const hashText = (hash, text)=>{
    let h = hash;
    for (let at = 0; at < text.length; at++)
    {
        h = Math.imul(h ^ text.charCodeAt(at), 0x01000193);
    }
    // The length too, so "ab" then "c" is not "a" then "bc".
    return hashWord(h >>> 0, text.length);
};

/**
 * createApp — the consumer-facing entry point: run a Win32 application.
 *
 * Everything below it is the module graph; this is the one place that wires the
 * cross-cutting step the graph deliberately does not express. An executable's
 * imports have to become guest addresses that call into win32, but win32 does
 * not know what a guest call looks like and the bridge does not know what win32
 * implements. Neither should. Assembling a process is what knows both.
 */

/** @typedef {import('./app-options.js').SpareMemory} SpareMemory */

/** @typedef {import('./app-options.js').BundleLayer} BundleLayer */

/** @typedef {import('./app-options.js').AppOptions} AppOptions */
/** @typedef {import('./app-options.js').ProcessOptions} ProcessOptions */

/**
 * A first process id of its own for each run, under the 0x2000 the run's other
 * processes are numbered from, on the kernel table's step of eight. Windows
 * never hands out the same id twice in a row, and a program that keeps its
 * id in a file to refuse a second copy of itself -- OpenProcess on the id it
 * wrote, then the modules of what answers -- found itself under the same id
 * the next run and quit as the copy.
 */
export const runProcessId = ()=>0x400 + 8 * Math.floor(Math.random() * ((0x2000 - 0x400) / 8));

/**
 * A yield to the macrotask queue, so everything the host has queued gets a turn.
 *
 * Everything means the host's timers too, which is why Node yields through
 * `setImmediate` and not through a port. Node hands a port's messages over at
 * least a thousand at a time in one pass of its event loop, running the
 * microtasks after each, and a loop that posts its next yield from those
 * microtasks stays inside the pass: a thousand turns go by before a timer
 * fires, a file read or a fetch answers, another port -- a worker's --
 * delivers a message, or a module the translator compiled for hot code is
 * installed, so the engine interprets. Measured: a loop of half-millisecond
 * turns yielding through a port saw a 3 ms interval fire three times in two
 * seconds, and through an immediate six hundred and sixty times. An immediate
 * set from inside an immediate runs on the next pass, and every pass looks at
 * the timers and polls for I/O.
 *
 * Elsewhere through a message channel rather than a timer, and the difference
 * is not small: a browser clamps a zero timeout to four milliseconds and more
 * once they nest, so a loop yielding that way pays the clamp every time --
 * measured at eight milliseconds a yield and fifteen seconds in one run, larger
 * than the emulation it was interrupting. A channel message is delivered on
 * the same macrotask turn without the clamp, and a browser schedules it beside
 * its timers rather than ahead of them: in Chromium, on a page and in a
 * worker, a 3 ms timer came at most 9 ms late with 4 ms of work between two
 * yields, and about 3 ms late with half a millisecond.
 *
 * A timer is still the fallback, because this file has to run in a worker, in a
 * page and under a test runner, and not all of them have a channel.
 *
 * The ports are the machine's for as long as it runs, so the yield carries its
 * own `close`: an open port is a live handle, and a host that counts them --
 * Node does, and will not exit while one is open -- never sees the end of a
 * process that only dropped its reference to it.
 *
 * @returns {(() => Promise<void>) & { close: () => void }}
 */
export function createMacrotask(){
    if (typeof setImmediate === 'function')
    {
        // Nothing to close: an immediate holds the process open only until it
        // runs, and whoever is mid-yield is answered when it does.
        return Object.assign(
            ()=>new Promise(resolve=>{
                setImmediate(resolve);
            }),
            { close: ()=>{} });
    }
    if (typeof MessageChannel !== 'function')
    {
        return Object.assign(
            ()=>new Promise(resolve=>{
                setTimeout(resolve, 0);
            }),
            { close: ()=>{} });
    }
    const channel = new MessageChannel();
    /** @type {(() => void)[]} */
    const waiting = [];
    // One channel for the life of the process rather than one per yield: a
    // channel is a pair of ports the host has to keep, and making one per turn
    // is the cost this was meant to remove.
    channel.port1.onmessage = ()=>waiting.shift()?.();
    channel.port1.start?.();
    return Object.assign(
        ()=>new Promise(resolve=>{
            waiting.push(/** @type {() => void} */ (resolve));
            channel.port2.postMessage(0);
        }),
        {
            close(){
                channel.port1.close();
                channel.port2.close();
                // Whoever was mid-yield is owed an answer: the port that would
                // have delivered it is gone, and a caller left awaiting it
                // would hold the run loop open for ever.
                while (waiting.length > 0)
                {
                    waiting.shift()?.();
                }
            },
        });
}

/**
 * Whether the page this is running in is out of sight.
 *
 * @returns {boolean} false wherever there is no page to ask.
 */
export function pageIsHidden(){
    return typeof document !== 'undefined' && Boolean(document.hidden);
}

/**
 * How the run loop waits when every guest thread is waiting on a deadline.
 *
 * A real timer, ordinarily: the machine has nothing to run, and spinning the
 * event loop to discover that again immediately is heat rather than progress.
 *
 * Except when nobody is looking. A browser clamps a hidden page's timers to
 * about a second, which does not slow the machine down politely -- it stops it.
 * Measured switching tabs during a cinematic: the loop fell from roughly two
 * hundred and fifty turns a second to one, the film from twenty-four frames a
 * second to four, and what came back when the tab did was a program that had
 * lived through one second of every five. A program running in the background
 * is still running, so the wait becomes a macrotask, which nothing clamps.
 *
 * @param {Object} how
 * @param {() => boolean} how.hidden
 * @param {() => Promise<void>} how.macrotask
 * @param {() => Promise<void>} how.timer
 * @returns {Promise<void>}
 */
export function timedWait({ hidden, macrotask, timer }){
    return hidden() ? macrotask() : timer();
}

/** @typedef {import('./app-options.js').RunPacing} RunPacing */

/** @typedef {import('./app-options.js').YieldPending} YieldPending */

/**
 * How long a page's thread may run turns back to back before it is given to
 * the browser regardless.
 *
 * On a page the gap between tasks is where everything else happens: a click
 * is delivered, a frame is composed, the launcher's own interface repaints.
 * The bound is tight because all of that is felt directly -- and a yield every
 * turn, measured on a real title, was the largest host phase of the run at
 * over a hundred microseconds each, because whatever the browser does in the
 * gap is paid on every trip. A few turns between trips keep the page as
 * responsive as a frame needs and cut the trips by that factor.
 */
export const PAGE_YIELD_MS = 2;

/**
 * How often an outstanding host answer -- a call suspended on the host, a
 * range in flight -- is looked for while other guest threads still have work.
 * It bounds how late the parked thread hears its answer; a trip costs tens of
 * microseconds, a turn a few hundred, so one look a millisecond keeps the
 * trips a small share of the run.
 */
export const PENDING_YIELD_MS = 1;

/**
 * A yield by need and by time, not by turn.
 *
 * The loop leaves the microtask queue when the host may have something to
 * deliver -- a call answered, a range arrived, a message posted, a turn that
 * retired nothing and so is waiting on the host -- and otherwise at most once
 * per `intervalMs`, which is what bounds how long an input event or a
 * decoder's output waits behind the guest. A caller parked on an empty
 * message queue is not such a thing: the loop lets it look again every turn
 * without the host, and what the page posts to it waits no longer than the
 * interval -- while a trip a turn, behind a thread that is copying, cost more
 * than the copying. The clock is reset when the trip ends, not when it
 * begins: a trip the browser stretched to compose a frame has already given
 * the thread away for that long.
 *
 * @param {Object} deps
 * @param {() => Promise<void>} deps.macrotask
 * @param {() => number} deps.now             Wall milliseconds.
 * @param {number} deps.intervalMs
 * @param {() => boolean} [deps.signalled]    Whether a message is known to be waiting.
 * @param {Record<string, number>} [deps.counts]  Counted into: each turn, by why it went to
 *     the event loop (`suspended`, `fetching`, `spun`, `signalled`, `interval`) or `kept`.
 * @returns {RunPacing['yield']}
 */
export function pacedYield({ macrotask, now, intervalMs, signalled = ()=>false, counts }){
    let rested = now();
    return pending=>{
        // An answer outstanding is looked for at once only when the turn ran
        // nothing; while other threads run it waits out PENDING_YIELD_MS, since a
        // trip a turn behind a loader running beside a thread parked on
        // Present was the largest host phase of a run (2.46 M trips in 1500 s).
        const since = now() - rested;
        const look = pending.spun > 0 || since >= PENDING_YIELD_MS;
        // Why the turn went to the event loop, the first reason that held -- what a report
        // reads when the trips are many.
        const why = pending.suspended > 0 && look ? 'suspended'
            : pending.fetching > 0 && look ? 'fetching'
                : pending.spun > 0 ? 'spun' : signalled() ? 'signalled'
                    : since >= intervalMs ? 'interval' : null;
        if (counts)
        {
            counts[why ?? 'kept'] = (counts[why ?? 'kept'] ?? 0) + 1;
        }
        if (why === null)
        {
            return null;
        }
        return macrotask().then(()=>{
            rested = now();
        });
    };
}

/**
 * The pacing of a thread that cannot block: a yield when something is pending
 * or the page's interval is up, and an idle wait that looks again on a short
 * timer, or on a macrotask when the page is hidden and its timers clamped.
 *
 * @param {Object} deps
 * @param {() => Promise<void>} deps.macrotask
 * @param {() => boolean} deps.hidden
 * @param {number} [deps.lookMs]
 * @param {number} [deps.yieldMs]
 * @param {() => number} [deps.now]
 * @param {() => boolean} [deps.signalled]
 * @param {Int32Array | null} [deps.napWord]  The shared word a wait to a deadline sleeps
 *     on; null spins macrotasks to it. Left out, one where a browser has it.
 * @returns {RunPacing}
 */
export function pagePacing({ macrotask, hidden, lookMs = IDLE_LOOK_MS, yieldMs = PAGE_YIELD_MS,
    now = ()=>performance.now(), signalled, napWord })
{
    /** Turns kept on the thread and trips to the event loop, by why. @type {Record<string, number>} */
    const counts = {};
    // A word nobody rings, slept on to a deadline: an async wait's timeout is
    // not a timer, so it is neither clamped to milliseconds as nested timers
    // are nor a message. Spinning macrotasks to a deadline instead posted one
    // message per lap -- a program sleeping a millisecond a frame had its
    // engine post 80 000 a second, whose garbage held 356 MB of a worker's
    // heap in Chromium and more where JavaScriptCore lets it grow. Not in
    // node, whose macrotask posts nothing and whose loop an async wait does
    // not hold open.
    const nap = napWord !== undefined ? napWord
        : typeof setImmediate !== 'function'
            && typeof (/** @type {any} */ (Atomics).waitAsync) === 'function'
            ? new Int32Array(new SharedArrayBuffer(4)) : null;
    return {
        counts: ()=>({ ...counts }),
        now,
        yield: pacedYield({ macrotask, now, intervalMs: yieldMs, signalled, counts }),
        wait({ timer, sleep, deadlineMs, wakes }){
            if (!timer)
            {
                // Nothing can run until the guest's own deadline: sleep to it,
                // a look at most, so a message from the page that wakes a
                // thread waits no longer than an idle machine's look. A hidden
                // page keeps its macrotasks, which nothing throttles.
                if (nap && sleep && deadlineMs !== null && deadlineMs > 0 && !hidden())
                {
                    counts.napped = (counts.napped ?? 0) + 1;
                    const slept = /** @type {any} */ (Atomics).waitAsync(nap, 0, 0,
                        Math.min(deadlineMs, lookMs));
                    return slept.async ? slept.value.then(()=>{}) : Promise.resolve();
                }
                return macrotask();
            }
            const look = timedWait({
                hidden,
                macrotask,
                timer: ()=>new Promise(resolve=>{
                    setTimeout(resolve, lookMs);
                }),
            });
            return wakes.length > 0 ? Promise.race([look, ...wakes]) : look;
        },
    };
}

/**
 * How long a machine with a device to feed may wait between looks.
 *
 * A film's next frame and a wave buffer's completion are deadlines the guest
 * owns without writing them down anywhere the loop can read, so while a
 * device is open the loop looks this often at most. Long enough to be tens of
 * looks a second rather than thousands, short against a ring that holds two
 * hundred milliseconds.
 */
const DEVICE_LOOK_MS = 10;

/**
 * Whether a library is answered from this engine's table even when the program
 * brought a file of that name: a KnownDLL, which Windows never looks for beside
 * the program, or a redistributable runtime a layer stands in for -- a sound
 * library's MPEG provider, a JPEG library -- which this engine makes ours
 * whoever's copy it is, since the program's copy found first runs the whole
 * decoder as emulated x86. Every other name the
 * program's own file wins, and the table is the fallback.
 *
 * @param {readonly string[]} knownDlls
 * @param {readonly string[]} runtimes
 * @returns {(name: string) => boolean}
 */
export function answeredByEngine(knownDlls, runtimes){
    const keys = new Set([...knownDlls, ...runtimes].map(moduleKeyOf));
    return name=>keys.has(moduleKeyOf(name));
}

// `relocatablePrefix` and `jumpBytes` live in `layers/loader/internal/hooks.js`
// now -- `bindSiteHook` needs the same two functions, and `check:boundaries`
// allows a root file to import a layer's `internal/` (this file already does
// it for pe, dependencies, resources and tls) but not the reverse. Re-exported
// so this module stays what a caller of `debug.hook` imports them from.
export { jumpBytes, relocatablePrefix };

/** Where the heap's arena begins under an image that ends below it (`spaceAbove`). */
const HEAP_FLOOR = 0x0c000000;

/**
 * Where the engine's range is cut out of the heap when neither the libraries'
 * space nor the heap's start below 0x10000000 holds it: past the bases a
 * library is most often linked for, 0x10000000 and the few megabytes above it,
 * which a library that cannot move takes out of the heap (`claim`). Recorded
 * in roadmap/decisions.md (A233).
 */
export const ENGINE_CUT_AT = 0x14000000;

/**
 * The engine's range of one executor, in MiB: its tables and what lies past
 * them, and the record the executors keep together (`engineAreaFor`).
 */
const ENGINE_FIRST_MIB = 28;

/** The table of far chunks in MiB, rounded up (cork's `FAR.BYTES`, 3.75 MiB). */
const FAR_TABLE_MIB = 4;

/**
 * Where a large-address-aware 32-bit process's space ends on a 64-bit Windows:
 * the last 64 KiB below 4 GiB are never the program's.
 */
const LARGE_ADDRESS_TOP = 0xfffe0000;

/**
 * And on a 32-bit Windows started with /3GB (IncreaseUserVa 3072): the last
 * 64 KiB below 3 GiB are never the program's either.
 */
const INCREASED_USER_VA_TOP = 0xbfff0000;

/**
 * The engine's range in a process's guest space: its tables and other
 * executors' pages (19.25 MiB an executor, 4.2 MiB of a record they share past
 * one). With it the memory holds only the RAM the guest has been given and
 * grows as it is given more (`CorkHostConfig.engineArea`); without one every
 * process commits the whole of `memorySize` at its start.
 *
 * At the top of the libraries' space, under the thread stacks, where 16 MiB is
 * left the libraries below it -- one that does not fit takes heap space, as it
 * does already when the space is full; otherwise at the heap's start, the heap
 * past it (`inHeap`), where it ends short of 0x10000000, the base a library is
 * most often linked for; otherwise cut out of the heap past the bases libraries
 * are linked for (`ENGINE_CUT_AT`, `cut`): four executors or more fit neither
 * place, and without a range every process committed its whole RAM at its start
 * (2.1 GiB a process on an eight-core machine). There the first executor's
 * tables and the record the executors share stay at the top of the libraries'
 * space and only the other executors' pages are cut out (`others`): the memory
 * holds the RAM up to the first range from the start, as with one executor, and
 * reaches the others' when one opens -- a process whose threads open none (most
 * of a run's helpers) never does, where every process started at 512 MiB. A
 * 64-bit process's 4 GiB layout takes one as a 32-bit one does (`longLayout`);
 * a wide window's (`wide`), whose RAM is a memory of its own, none. None for a
 * RAM that is not a power of two, or an image of the program's own lying where
 * the range would.
 *
 * @param {{ wide: boolean, memorySize: number, moduleBase: number, stackPoolStart: number,
 *     heapStart: number, executors: number, far?: boolean,
 *     image: { imageBase: number, sizeOfImage: number } }} what
 * @returns {{ at: number, span: number, inHeap: boolean, cut?: true,
 *     others?: { at: number, span: number } } | undefined}
 */
export function engineAreaFor({ wide, memorySize, moduleBase, stackPoolStart, heapStart,
    executors, image, far = false })
{
    const MIB = 0x100000;
    // And the table of far chunks where a 64-bit process reserves past 4 GiB (`cpu.far`).
    const span = (20 * Math.max(1, executors) + 8 + (far ? FAR_TABLE_MIB : 0)) * MIB;
    if (wide || memorySize < 2 ** 28 || 2 ** Math.round(Math.log2(memorySize)) !== memorySize)
    {
        return undefined;
    }
    const clear = (/** @type {number} */ at)=>at % MIB === 0 && at + span < memorySize
        && !(image.imageBase < at + span && image.imageBase + image.sizeOfImage > at);
    const top = Math.floor((stackPoolStart - span) / MIB) * MIB;
    if (top >= moduleBase + 16 * MIB && clear(top))
    {
        return { at: top, span, inHeap: false };
    }
    if (heapStart + span <= 0x10000000 && clear(heapStart))
    {
        return { at: heapStart, span, inHeap: true };
    }
    if (heapStart >= ENGINE_CUT_AT)
    {
        return clear(heapStart) ? { at: heapStart, span, inHeap: true } : undefined;
    }
    // The first executor's part where one executor's whole range goes, the
    // others' cut out of the heap.
    const first = (ENGINE_FIRST_MIB + (far ? FAR_TABLE_MIB : 0)) * MIB;
    const othersSpan = span - first;
    const firstTop = Math.floor((stackPoolStart - first) / MIB) * MIB;
    /** @param {number} at @param {number} bytes */
    const free = (at, bytes)=>at + bytes < memorySize
        && !(image.imageBase < at + bytes && image.imageBase + image.sizeOfImage > at);
    if (othersSpan > 0 && firstTop >= moduleBase + 16 * MIB && free(firstTop, first)
        && free(ENGINE_CUT_AT, othersSpan))
    {
        return { at: firstTop, span: first, inHeap: false,
            others: { at: ENGINE_CUT_AT, span: othersSpan } };
    }
    return clear(ENGINE_CUT_AT) ? { at: ENGINE_CUT_AT, span, inHeap: false, cut: true }
        : undefined;
}

/**
 * Where the address space above the program begins: the system modules, the
 * pool of thread stacks, and the heap, in that order.
 *
 * Placed relative to where the program's own image ends rather than at fixed
 * addresses, because an image is as large as its headers say and a self-
 * extracting installer carries its whole payload in a section: a few hundred
 * megabytes mapped at 0x400000 reaches well past where a fixed layout put the
 * modules, and a real loader simply maps everything else above it.
 *
 * An image that asks for a base inside the heap's span leaves the layout where
 * it is: the heap gives its span up (`claim`), as Windows maps such an image
 * in free memory and allocates around it. Moving everything above it instead
 * left what lay below unused -- a program based at 0x39000000 had under half
 * of its two gigabytes, and ran out of memory with 720 MiB of them idle.
 *
 * @param {number} imageEnd  One past the last byte of the program's image.
 * @param {number} [imageBase]  Where it starts.
 * @returns {{ moduleBase: number, stackPoolBase: number, heapBase: number }}
 */
export function spaceAbove(imageEnd, imageBase = 0){
    const granule = 0x00100000;
    const lowest = 0x02000000;
    const shift = imageBase >= HEAP_FLOOR ? 0
        : Math.max(0, Math.ceil(imageEnd / granule) * granule - lowest);
    return {
        moduleBase: lowest + shift,
        stackPoolBase: 0x08000000 + shift,
        heapBase: HEAP_FLOOR + shift,
    };
}

/**
 * The least stack a thread is given, whatever its image was linked for. An
 * image linked for 64 KiB was measured here reaching 70 KiB down its first
 * thread, inside a window procedure, for a program released to run on
 * Windows; the linked figure is not what such a program can count on being
 * held to. A megabyte, the linker's own default, is the floor. Recorded in
 * roadmap/decisions.md (A42).
 */
export const MINIMUM_STACK_RESERVE = 0x100000;

/**
 * The stack a thread of an image linked for `reserve` gets.
 *
 * @param {number} reserve  The image's SizeOfStackReserve.
 */
export function stackReserveOf(reserve){
    return Math.max(reserve >>> 0, MINIMUM_STACK_RESERVE);
}

/**
 * Where the first thread's stack goes. Under the default initial stack pointer
 * when what the image was linked to reserve fits between the stub table and
 * it; otherwise at the bottom of the stack pool, the size the image asked for
 * (on a 64 KiB granule, capped at a quarter of the pool), with the pool for
 * the other threads starting above it. Clamping to the low span instead hands
 * a program linked for eight megabytes less than two, and the first deep call
 * walks off the stack's bottom -- through the stub table and below it -- with
 * nothing to say the stack was what ran out.
 *
 * @param {number} reserve      The image's SizeOfStackReserve.
 * @param {number} poolBase     Where the stack pool starts.
 * @param {number} poolSize     How large it is.
 * @returns {{ initialStack: number | undefined, poolBase: number, poolSize: number }}
 *   `initialStack` undefined keeps the processor's default.
 */
export function placeMainStack(reserve, poolBase, poolSize){
    const asked = Math.max(reserve >>> 0, 0x10000);
    if (asked <= DEFAULT_INITIAL_STACK - (DEFAULT_THUNK_BASE + DEFAULT_THUNK_CAPACITY))
    {
        return { initialStack: undefined, poolBase, poolSize };
    }
    const size = Math.min(Math.ceil(asked / 0x10000) * 0x10000, Math.floor(poolSize / 4));
    return { initialStack: poolBase + size, poolBase: poolBase + size, poolSize: poolSize - size };
}

/**
 * How much of the guest's RAM the heap gets: what the caller asked for, or
 * everything from the heap's base up to where RAM keeps the system's shared
 * page (`sharedPageAt`): at 0x7FFE0000 in a RAM that reaches it, as a Windows
 * process's own memory ends there, and 128 KiB short of RAM's end in one that
 * does not. The heap is otherwise the last
 * region, so the end of RAM is the only ceiling -- and a fixed size short of
 * it was what a program loading a level ran into, reporting the machine's
 * memory as exhausted while most of it sat unused above.
 *
 * @param {number} memorySize
 * @param {number} [asked]
 * @param {number} [base]
 */
export function heapSizeFor(memorySize, asked, base = 0x0c000000){
    if (asked !== undefined)
    {
        return asked;
    }
    if (memorySize <= base)
    {
        throw new Error(`heap: ${memorySize} bytes of RAM is less than the heap's base`);
    }
    return sharedPageAt(memorySize) - base;
}

/**
 * A film's sound on its way to its track: what the track took, in the device's
 * frames, and what it had no room for yet, kept whole and offered again.
 *
 * @typedef {{ taken: number, held: Uint8Array[], heldBytes: number,
 *     framesPerByte: number }} FilmSoundLedger
 */

/**
 * Hands a film's sound to its track as far as the track has room
 * (`track.room()`), keeping the rest in `ledger` for the next tick; with no
 * blocks it only offers what is held.
 *
 * Nothing is dropped. A film's file may hold its sound well behind its picture
 * (`graph.js`'s AHEAD_MS), so a decoder that reaches it hands seconds over at
 * once, past what a track holds: refused, that was heard as gaps, and a gap
 * owed until played was owed for ever and held the picture back behind it.
 *
 * @param {{ write: (bytes: Uint8Array) => number, room?: () => number }} track
 * @param {Int16Array[]} blocks
 * @param {number} channels     the film's
 * @param {FilmSoundLedger} ledger
 */
export function feedFilmSound(track, blocks, channels, ledger){
    for (const block of blocks)
    {
        ledger.held.push(new Uint8Array(block.buffer, block.byteOffset, block.byteLength));
        ledger.heldBytes += block.byteLength;
    }
    const stride = channels * 2;
    while (ledger.held.length > 0)
    {
        const first = ledger.held[0];
        const room = track.room?.() ?? Infinity;
        const length = Math.min(first.length, room - room % stride);
        if (length <= 0)
        {
            return;
        }
        ledger.taken += track.write(first.subarray(0, length));
        ledger.heldBytes -= length;
        if (length < first.length)
        {
            ledger.held[0] = first.subarray(length);
            return;
        }
        ledger.held.shift();
    }
}

/**
 * Device frames of a film's sound handed over and not heard yet: what its track
 * holds unplayed, and what is held for want of room in it.
 *
 * The picture is decoded to just ahead of the sound heard, and heard is what
 * was handed over less this.
 *
 * @param {FilmSoundLedger} ledger @param {number} played  the track's `played()`
 */
export function filmSoundOwed(ledger, played){
    return Math.max(0, ledger.taken - played) + Math.round(ledger.heldBytes * ledger.framesPerByte);
}

/**
 * Credits the guest's clock with the wall time that has passed, all of it.
 *
 * Between two slices of the guest the loop yields to the browser, mixes sound,
 * moves cursors and polls its own state, and none of that used to move the
 * guest's clock: it was credited only for the slices themselves. A program
 * then saw its clock run slow by whatever share of the wall the loop took --
 * a tenth at a menu -- and everything paced against a real device fell behind
 * by that share: a sound buffer's cursor lagged the device that plays it, and
 * the device filled the difference with silence, heard as a constant crackle.
 * A real clock runs while the machine is in a syscall too.
 *
 * Capped, because a stall is not time the program spent: a fetch that took a
 * second, a tab in the background, a debugger. Credited in full, a program
 * would wake to find a second gone and run a second's worth of frames at once.
 *
 * @param {() => number} source   The wall clock, in milliseconds.
 * @param {{ advance: (milliseconds: number) => void }} clock  The guest's.
 * @param {number} cap            The most one credit may be.
 * @returns {(limit?: number) => number} credits what passed since the last call
 *     and says how much; a limit of its own for a wait that was asked for in full
 */
export function clockCredit(source, clock, cap){
    let creditedTo = source();
    return (limit = cap)=>{
        const now = source();
        const credit = Math.min(limit, Math.max(0, now - creditedTo));
        creditedTo = now;
        clock.advance(credit);
        return credit;
    };
}

/**
 * The run's pool of translation workers, where every
 * machine's translator would otherwise open a worker of its own: on cork, with
 * shared memory and ports to lend through, and unless the caller set the
 * translators a machine opens itself (`cork.config.translators`). A process in a
 * worker of its own is lent its workers by the run's system, and makes no pool.
 *
 * @param {AppOptions} options
 * @returns {Promise<ReturnType<typeof createTranslatorPool> | null>}
 */
async function openTranslationPool(options){
    const cork = options.cork ?? {};
    const config = /** @type {any} */ (cork.config ?? {});
    if (options.system || typeof MessageChannel !== 'function')
    {
        return null;
    }
    const wanted = config.translators === undefined
        && (config.worker ?? (config.feed !== 'slice' && typeof globalThis.Worker === 'function'));
    if (!wanted)
    {
        return null;
    }
    const engine = await import(corkArtifacts(cork).moduleUrl);
    if (engineContractProblem(engine, corkArtifacts(cork).moduleUrl))
    {
        // The machine's own load of the same module says why; no pool for it.
        return null;
    }
    const url = config.workerUrl ?? engine.translatorWorkerUrl?.() ?? null;
    if (url === null)
    {
        return null;
    }
    const host = globalThis.navigator?.hardwareConcurrency ?? 4;
    return createTranslatorPool({
        open: ()=>openProcessWorker(url),
        perProcess: cork.poolPerProcess ?? translatorsBeside(processorsFor({
            executors: options.cpu?.cores }), host),
        capacity: cork.poolCapacity ?? translatorsInRun(host),
    });
}

/**
 * How many translation workers the whole run keeps at most, however many
 * processes stand: the host's cores less the two the graphics worker and the
 * browser's own threads take, and never fewer than one. Windows shares its
 * processors among every process there is; a worker a process kept while it
 * waited on a pipe was a heap of some 55 MB doing nothing -- sixteen
 * scanners of a benchmark's system information held sixteen.
 *
 * @param {number} host  the host's (`navigator.hardwareConcurrency`)
 */
export const translatorsInRun = host=>Math.max(1, Math.floor(host) - 2);

/**
 * How many translators the pool lends a process at most: the host's cores the
 * program's own leave free -- each of its executors keeps one busy running it,
 * and the graphics worker and the browser's own threads take about two more --
 * and never fewer than one. On four cores a second translator made a game load
 * slower (`negative-results.md`, 2026-10-07): the core it ran on was taken from
 * the engine thread. The two is an estimate, not a measurement.
 *
 * @param {number} cores  the program's (`cpu.cores`)
 * @param {number} host   the host's (`navigator.hardwareConcurrency`)
 */
export const translatorsBeside = (cores, host)=>Math.max(1, Math.floor(host) - cores - 2);

/**
 * The machine's processor as the caller sets it up (`cpu`): `cores`, the
 * processors the program is told it has, is the executors that run its threads
 * at once. Refused before anything is built when it is not a whole number from
 * 1 to 32, and when the caller names `executors`, its older name: taken as
 * nothing, it would have left the run on cores the caller did not ask for.
 * Cores the caller named open before the program starts (`cpu.eager`, unless it
 * says otherwise): opened as a thread first wants one, each came some tens of
 * milliseconds late, a stall in the middle of a game. Automatic cores stay
 * lazy, so a program of one thread pays for none.
 *
 * @template {{ cpu?: { cores?: number, eager?: boolean } }} T
 * @param {T} options
 * @param {CoresHost} [host]  where the run is made (`coresHost`)
 * @returns {T & { cpu?: { cores?: number, eager?: boolean } }}
 */
export function withCpuSetup(options, host = coresHost()){
    if (/** @type {any} */ (options).executors !== undefined)
    {
        throw new Error('cpu: `executors` is `cpu.cores` now -- set that');
    }
    const named = options.cpu?.cores !== undefined;
    const cores = options.cpu?.cores ?? automaticCores(host);
    if (cores === undefined)
    {
        return options;
    }
    if (!Number.isInteger(cores) || cores < 1 || cores > MAX_EXECUTORS)
    {
        throw new Error(`cpu: ${JSON.stringify(cores)} cores -- a whole number from 1 to`
            + ` ${MAX_EXECUTORS}, as many as an affinity mask has bits`);
    }
    return { ...options, cpu: { ...options.cpu, cores, eager: options.cpu?.eager ?? named } };
}

export { mobileOrSafari, tailCallsFault, withoutFaultingTailCalls };

/**
 * The engine's own C runtime routines handed to the translator to form as
 * their operations (cork's `helpersAlso`, `known-routines.js`), unless the
 * caller named its own.
 *
 * @template {AppOptions} T
 * @param {T} options
 * @returns {T & { cork?: any }}
 */
export function withKnownRoutines(options){
    return { ...options, cork: { ...options.cork,
        config: { helpersAlso: KNOWN_ROUTINES, ...options.cork?.config } } };
}

/**
 * Where a run is made, as far as its cores go: whether it is node, the cores
 * `BOTTLIFY_CORES` names there, the host's processors and whether its threads
 * can share memory.
 *
 * `oneCore`: a phone or Safari, where cores are not chosen for the run. Each
 * core is a worker holding the guest's memory, and JavaScriptCore lets a
 * thread's garbage grow with the buffers it holds (in WebKit 26.6 a worker
 * making the same garbage stood at 286 MB holding nothing and sawed between 350
 * and 830 MB holding an untouched 512 MB buffer); a phone has the least memory
 * to give it.
 *
 * @typedef {{ node: boolean, named?: string, processors?: number, oneCore?: boolean }}
 *     CoresHost
 */

/** @returns {CoresHost} */
export function coresHost(){
    const scope = /** @type {any} */ (globalThis);
    return { node: scope.process?.versions?.node !== undefined,
        named: scope.process?.env?.BOTTLIFY_CORES,
        processors: scope.navigator?.hardwareConcurrency,
        oneCore: mobileOrSafari(scope.navigator ?? {}) };
}

/** The most cores a run that names none is given: an estimate, not a measurement. */
export const AUTOMATIC_CORES = 8;

/**
 * The cores a run that names none gets from where it runs. In a browser, one
 * fewer than the host's processors -- the page, the graphics worker and a
 * translator take about one between them -- and at most `AUTOMATIC_CORES`; the
 * program is told of them from its first instruction and sizes its threads to
 * them, and their executors open as its threads want them. One on Safari and a
 * phone. In node, `BOTTLIFY_CORES`, so every suite can be run with its programs
 * on several executors, and otherwise one: a suite runs the same on every
 * machine.
 *
 * @param {CoresHost} host
 * @returns {number | undefined}  none: one
 */
export function automaticCores(host){
    if (host.node)
    {
        return host.named === undefined || host.named === '' ? undefined : Number(host.named);
    }
    if (host.oneCore || !(Number(host.processors) >= 2))
    {
        return undefined;
    }
    return Math.min(AUTOMATIC_CORES, Math.floor(Number(host.processors)) - 1);
}

/**
 * The bytes at a URL, wherever this runs: a browser fetches, and Node reads a
 * file URL from disk because its fetch does not.
 *
 * @param {string} url
 * @returns {Promise<ArrayBuffer>}
 */
export async function bytesAt(url){
    if (url.startsWith('file:'))
    {
        const [{ readFile }, { fileURLToPath }] = await Promise.all([
            import('node:fs/promises'), import('node:url')]);
        const bytes = await readFile(fileURLToPath(url));
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    }
    const response = await fetch(url);
    if (!response.ok)
    {
        throw new Error(`${url}: ${response.status} ${response.statusText}`);
    }
    return response.arrayBuffer();
}

/**
 * Reads a library from wherever the loader would find it, in the order it
 * would find it: beside the running program, then the system directories the
 * engine fills. The first place that has the file is the one whose bytes come
 * back; a name in none of them is null, which is what lets `planDependencies`
 * fall back to the engine's own table.
 *
 * The order matters because the bytes decide whether a real PE is mapped or a
 * synthesised table stands in for one, and the two answer different exports.
 * A title that shipped its own `d3dx9_26.dll` gets that file; a library an
 * installer put in `C:\WINDOWS\system32\` gets that one only when the engine
 * answers no library of the name -- the system's copy of one it does answer
 * is the engine's, as LoadLibrary at run time finds it (`libraryCandidates`'
 * `ours`), so what a bottle carried there is covered rather than mapped.
 *
 * @param {any} filesystem
 * @param {any} blocks       The bundle fetcher, or null when there is no bundle.
 * @param {string} imagePath The running program, whose directory is searched first.
 * @param {(name: string, wanted: any[]) => boolean} [ours]  Whether the engine
 *     answers the name -- told what the importer takes from it, which a table
 *     lacking some of it does not answer.
 * @param {{ currentDirectory?: string, path?: string[] }} [where]  The process's
 *     current directory and PATH, searched after the system directories.
 * @returns {(name: string, wanted?: any[]) => Promise<Uint8Array | null>}
 */
export function shippedLibraryReader(filesystem, blocks, imagePath, ours = ()=>false, where = {}){
    return async(/** @type {string} */ name, /** @type {any[]} */ wanted = [])=>{
        for (const candidate of libraryCandidates(name, imagePath, where.currentDirectory,
            { ours: ours(name, wanted), path: where.path }))
        {
            const file = await readWholeFile(filesystem, blocks, candidate);
            if (file)
            {
                return file;
            }
        }
        return null;
    };
}

/**
 * What a process's engine libraries are, as far as is known before any of
 * them is made (`win32/lazy-libraries.js`): every library's name, the faces'
 * tables whole, the numbers they are imported by, the Windows the machine is
 * and the window they are laid out in. Two processes with the same lay their
 * modules out the same (`process/system-modules.js`), and a module made
 * otherwise than its layout says is refused where it is placed (`shapeOf`):
 * a hash, not the text.
 *
 * @param {string[]} libraries
 * @param {Record<string, Record<string, any>>} faces
 * @param {Record<string, Record<number, string>>} ordinals
 * @param {{ long: boolean, start: number, end: number, windows: string }} window
 */
export function tablesFingerprint(libraries, faces, ordinals, window){
    let hash = 0x811c9dc5;
    /** @param {string} text */
    const mix = text=>{
        for (let index = 0; index < text.length; index++)
        {
            hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193);
        }
    };
    mix(`${window.long}|${window.start}|${window.end}|${window.windows}`);
    for (const name of libraries)
    {
        mix(`|library:${name}:${JSON.stringify(ordinals[name] ?? {})}`);
    }
    for (const [name, table] of Object.entries(faces))
    {
        mix(`|face:${name}:${JSON.stringify(ordinals[name] ?? {})}:${shapeOf(table)}`);
    }
    return (hash >>> 0).toString(16);
}

/** What an LdrRegisterDllNotification callback is told: a library loaded, or unloaded. */
/** What int3 raises (winnt.h's EXCEPTION_BREAKPOINT, STATUS_BREAKPOINT). */
const EXCEPTION_BREAKPOINT = 0x80000003;

/**
 * The system libraries in every process, whatever it imports.
 */
const ALWAYS_LOADED = ['ntdll', 'kernel32'];

/**
 * What loading one system library brings in with it: the libraries it
 * imports itself on Windows, as far as those this engine provides go. A
 * program that imports USER32 finds GDI32 loaded, and may ask for a handle
 * to it without ever having loaded it.
 *
 * @type {Readonly<Record<string, string[]>>}
 */
const SYSTEM_IMPORTS = Object.freeze({
    user32: ['gdi32', 'advapi32'],
    gdi32: ['user32'],
    advapi32: ['rpcrt4'],
    rpcrt4: ['advapi32'],
    ole32: ['advapi32', 'gdi32', 'user32', 'rpcrt4', 'msvcrt'],
    oleaut32: ['ole32', 'rpcrt4', 'user32', 'gdi32', 'advapi32'],
    shell32: ['shlwapi', 'comctl32', 'user32', 'gdi32', 'advapi32', 'msvcrt'],
    shlwapi: ['advapi32', 'gdi32', 'user32', 'msvcrt'],
    comctl32: ['advapi32', 'gdi32', 'user32', 'msvcrt'],
    comdlg32: ['shell32', 'shlwapi', 'comctl32', 'gdi32', 'user32', 'msvcrt'],
    winmm: ['advapi32', 'user32'],
    msacm32: ['winmm', 'user32', 'advapi32'],
    imm32: ['user32', 'gdi32', 'advapi32'],
    wsock32: ['ws2_32', 'mswsock'],
    ws2_32: ['advapi32', 'msvcrt'],
    mswsock: ['ws2_32', 'advapi32', 'msvcrt'],
    mpr: ['advapi32', 'user32'],
    wininet: ['shlwapi', 'user32', 'advapi32', 'msvcrt'],
    winspool: ['gdi32', 'user32', 'advapi32'],
    quartz: ['ole32', 'oleaut32', 'user32', 'gdi32', 'advapi32', 'winmm', 'msvcrt'],
    ddraw: ['user32', 'gdi32', 'advapi32', 'msvcrt'],
    d3d8: ['user32', 'gdi32', 'advapi32', 'msvcrt'],
    d3d9: ['user32', 'gdi32', 'advapi32', 'msvcrt'],
    dsound: ['winmm', 'user32', 'advapi32', 'ole32', 'msvcrt'],
    dinput: ['user32', 'advapi32', 'msvcrt'],
    dinput8: ['user32', 'advapi32', 'msvcrt'],
});

/**
 * Whether Windows itself carries a library: one in system32
 * (`WINDOWS_LIBRARIES`) of the Windows this is, no later one's
 * (`LIBRARIES_SINCE`), or an API set, which the system's schema resolves by
 * name and no program brings.
 *
 * @param {string} name
 * @param {{ major: number, minor: number }} [windows]  the machine's; none, any
 */
export function isWindowsLibrary(name, windows){
    const lower = name.toLowerCase();
    const file = lower.includes('.') ? lower : `${lower}.dll`;
    const since = LIBRARIES_SINCE.get(file);
    if (since && windows && (windows.major < since[0]
        || (windows.major === since[0] && windows.minor < since[1])))
    {
        return false;
    }
    return WINDOWS_LIBRARIES.has(file) || /^(api|ext)-ms-win-/.test(lower);
}

/**
 * Maps every library the program brought with it, in dependency order.
 *
 * Nothing is bound here. A set of libraries that import each other has to be
 * mapped first -- every base settled, every export directory readable -- and
 * bound afterwards, or the first one binds against a library that has no
 * address yet.
 *
 * A library is looked for beside the executable, which is where a program's own
 * libraries live and where its loader would look, then in the system
 * directories, the current directory (`options.currentDirectory`) and the
 * directories PATH names (`options.path`), as Windows looks for a program's
 * imports -- a delay-loaded one among them, which Windows resolves on its
 * first call from the same places and this loader binds at the start.
 *
 * `options.bits` is the process's machine (32 when not given): a library of the
 * other is refused, said with the reason, as Windows refuses to map it.
 *
 * @param {any} options
 * @returns {Promise<any[]>}
 */
export async function mapShippedLibraries(options){
    const { executable, imagePath, filesystem, loader, blocks, events, isSystem,
        isKnownDll, modules } = options;
    const directory = imagePath.slice(0, imagePath.lastIndexOf('\\') + 1);
    const bits = options.bits ?? 32;
    /**
     * Where the process's activation context puts a library, when it does:
     * the program's manifest names the assembly it is in.
     *
     * @type {(name: string) => { path: string, source: string | null } | null}
     */
    const redirect = name=>(isKnownDll(name) ? null : options.redirect?.(name) ?? null);

    /**
     * The first place a bare library name is on the volume: beside the program,
     * then the system directories. Where it was found is what the module is
     * recorded as living at, so a program reading its own loaded path off a
     * library gets the directory it is really in -- a `d3dx9_26` an installer
     * put in `system32` belongs there, not beside the executable.
     *
     * @param {string} name
     * @returns {string}
     */
    const placeOf = name=>redirect(name)?.path ?? libraryCandidates(name, imagePath,
        options.currentDirectory, { ours: isSystem(name), path: options.path }).find(candidate=>{
        try
        {
            const entry = filesystem.stat(candidate);
            return Boolean(entry) && !entry.directory;
        }
        catch {
            return false;
        }
    }) ?? `${directory}${name}`;

    const shipped = shippedLibraryReader(filesystem, blocks, imagePath,
        (name, wanted)=>isSystem(name) && (options.covers?.(name, wanted) ?? true),
        { currentDirectory: options.currentDirectory, path: options.path });
    const { order, missing, absent } = await planDependencies({
        entry: executable,
        entryName: imagePath.slice(
            Math.max(imagePath.lastIndexOf('\\'), imagePath.lastIndexOf('/')) + 1),
        isSystem,
        isKnownDll,
        isWindowsLibrary: (/** @type {string} */ name)=>isWindowsLibrary(name, options.windows),
        // A file the program brought is read from beside it; a file it did not
        // bring is looked for in the system directories the engine fills, which
        // is where the runtime a title links against actually lives. Only when
        // neither has it does the engine's own table answer.
        readLibrary: async(name, wanted)=>{
            // An assembly's DLL is read from where the context puts it -- or
            // is the engine's own, when the engine answers it.
            const found = redirect(name);
            if (found)
            {
                return found.source === null ? null
                    : await readWholeFile(filesystem, blocks, found.source);
            }
            return shipped(name, wanted);
        },
    });

    if (missing.length > 0)
    {
        // Not fatal: a program that never calls into one of these runs, and one
        // that does fails where it called, which says far more than a refusal
        // here would.
        events.emit('libraries-missing', { names: missing });
    }
    if (absent.length > 0)
    {
        // A library the program was meant to bring, found nowhere: Windows does
        // not start it, and the start is refused (`options.onAbsent`).
        events.emit('libraries-not-found', { names: absent, program: imagePath });
        options.onAbsent?.(absent);
    }

    let next = options.base;
    /** @type {any[]} */
    const mapped = [];
    for (const { name, file } of order)
    {
        let image;
        try
        {
            image = parsePe(file, { bits });
        }
        catch (e){
            events.emit('libraries-missing',
                { names: [name], reason: /** @type {Error} */ (e).message });
            continue;
        }
        const place = placeLibrary(image, { next, floor: options.floor, limit: options.limit,
            holder: options.holder, claim: options.claim });
        if ('refused' in place)
        {
            // Refused here rather than as an overlap with the pool of thread
            // stacks above, found only when a thread's stack is laid over it,
            // or as a throw out of the mapping, saying nothing about which
            // library or why.
            events.emit('libraries-missing', { names: [name], reason: place.refused });
            continue;
        }
        const base = place.base;
        // Named by the file, as a library loaded later is: the table of the
        // same name has its own region.
        const region = placeOf(name);
        const record = loader.map(file, { base, name: region, bits });
        const { exports } = readExports(file, image);

        const held = {
            name,
            base,
            size: image.sizeOfImage,
            region,
            ...exportTables(exports, base),
            entryPoint: record.record.entryPoint,
            // Until it is bound (`buildApp`), and let go of then: the mapped
            // image and its file are in guest memory from there on.
            mapped: record,
            // A library a program ships carries the strings, icons, dialogs
            // and version information that program asks for; they are read
            // where it lies mapped (`resourceLookup`), as Windows reads them.
            fromFile: true,
            image,
            // Where it came from. A program asks a library where it lives and
            // then looks for its own data beside it, so this has to be the
            // directory the file was really found in -- a library the program
            // brought lives beside it, and one found in `system32` lives
            // there, where a program that walks its own installation expects
            // to find it.
            path: placeOf(name),
        };
        modules.add(held, name.toLowerCase().replace(/\.dll$/, ''));
        mapped.push(held);

        if (image.relocatable)
        {
            next = base + Math.ceil(image.sizeOfImage / LIBRARY_ALIGN) * LIBRARY_ALIGN;
        }
    }

    events.emit('libraries', { loaded: mapped.map(entry=>entry.name), missing });
    return mapped;
}

/**
 * Which part of the machine a host call belongs to.
 *
 * A program of this age reaches one engine through a dozen libraries, and the
 * question a reader has is never "which DLL" but "what was it doing" --
 * drawing, making a sound, reading a file, asking the processor something. So
 * the libraries are grouped the way the work is, and the group is the
 * journal's category, which is what makes a filter possible at all.
 *
 * @type {Record<string, string>}
 */
export const CALL_AREAS = {
    'D3D8.dll': 'gpu', 'D3D9.dll': 'gpu', 'DDRAW.dll': 'gpu',
    'OPENGL32.dll': 'gpu', 'GDI32.dll': 'gpu',
    'DSOUND.dll': 'audio', 'WINMM.dll': 'audio', 'mss32.dll': 'audio', 'Mp3dec.asi': 'audio',
    'MSACM32.dll': 'audio',
    'quartz.dll': 'video', 'blizzard.ax': 'video', 'ijl15.dll': 'video',
    'DINPUT.dll': 'input', 'DINPUT8.dll': 'input', 'USER32.dll': 'input',
    'WSOCK32.dll': 'net', 'WS2_32.dll': 'net', 'MSWSOCK.dll': 'net',
    'WININET.dll': 'net',
};

/**
 * The journal category one call is written under.
 *
 * A COM method arrives named by its interface rather than by a library, and
 * there is no library to look up -- so it gets its own group instead of being
 * filed under a guess. Everything else that is not drawing, sound, video,
 * input or the network is the processor's own business: memory, files,
 * threads, the registry, the C runtime.
 *
 * Memoised by name in the cache the caller hands in: a call site is made
 * thousands of times in a run and the name it arrives under never changes, so
 * only the first occurrence pays for the split and the lookup.
 *
 * @param {any} call
 * @param {Map<string, string>} cache
 */
export function areaOf(call, cache){
    const name = String(call?.name ?? '');
    const cached = cache.get(name);
    if (cached !== undefined)
    {
        return cached;
    }
    const at = name.indexOf('!');
    const area = at === -1 ? 'call.com' : `call.${CALL_AREAS[name.slice(0, at)] ?? 'cpu'}`;
    cache.set(name, area);
    return area;
}

/**
 * The run's page file (`page-file.js`): the disk its volume's writable layers
 * keep what they let go of from memory, or null to keep it all in memory.
 * A write to it that fails is said once, and the files stay in memory.
 *
 * @param {AppOptions} options @param {any} events
 */
async function openRunPageFile(options, events){
    const spec = options.pageFile ?? 'local';
    if (spec === false)
    {
        return null;
    }
    return openPageFile({
        root: spec === 'local' ? undefined : spec.root,
        residentBytes: HEAP_POOLS.writableFiles,
        onFailure: error=>events.emit('divergence', { api: 'filesystem',
            detail: `the page file refused a write (${error.message}); what the program `
                + 'writes is kept in memory from here' }),
    });
}

/**
 * The severity an event is journalled at: its own. A failure the program
 * cannot see is an error whether or not anybody was listening for it, and a
 * library that could not be found is the warning that explains a program's
 * next decision. Everything else is what happened, at info.
 */
/** A loss repeated is said again once in this many times, with its count. */
const LOSS_EVERY = 256;

/**
 * Says that a call succeeded but did not do all of what it promises
 * (`'divergence'`, a warning) or did not happen at all (`'loss'`, an error).
 *
 * A divergence is not a failure: a program is entitled to make the call, and
 * refusing it changes what the program does -- usually by stopping it. But
 * accepting a state and not honouring it is the defect class that produces a
 * picture rather than an error, and the only thing separating it from correct
 * behaviour is somebody saying so. A layer notices one where it happens, which
 * for a graphics state is every draw, so each is said once: a short list of
 * what this build does differently.
 *
 * A loss is worse: something the program made or asked for did not happen --
 * a draw or a frame dropped, an object WebGPU refused, data not written. It is
 * said the first time and then every LOSS_EVERY times with its count, so one
 * that repeats every frame stays in the journal as it goes on.
 *
 * @param {(name: 'divergence' | 'loss', payload: { api: string, detail: string,
 *     seen?: number }) => void} emit
 * @returns {((api: string, detail: string, severity?: 'loss') => void)
 *     & { divergences: Set<string>, losses: Map<string, number> }}  the reporter, with
 *     what it has heard: every divergence, and every loss with how many times it came
 */
export function divergenceReporter(emit){
    /** @type {Set<string>} */
    const divergences = new Set();
    /** @type {Map<string, number>} */
    const losses = new Map();
    /** @param {string} api @param {string} detail @param {'loss'} [severity] */
    const report = (api, detail, severity)=>{
        const key = `${api}: ${detail}`;
        if (severity === 'loss')
        {
            const seen = (losses.get(key) ?? 0) + 1;
            losses.set(key, seen);
            if (seen === 1 || seen % LOSS_EVERY === 0)
            {
                emit('loss', { api, detail, ...(seen > 1 ? { seen } : {}) });
            }
            return;
        }
        if (divergences.has(key))
        {
            return;
        }
        divergences.add(key);
        emit('divergence', { api, detail });
    };
    return Object.assign(report, { divergences, losses });
}

/** The Subsystem of a console program's image. */
const IMAGE_SUBSYSTEM_WINDOWS_CUI = 3;
/** The console's own standard handles, which a window program has none of. */
const CONSOLE_STANDARD = new Set([HANDLE_STDIN, HANDLE_STDOUT, HANDLE_STDERR]);

/**
 * The handles a child's parent handed down, as this process holds them, and
 * its standard handles. A child that inherited nothing and was named no
 * standard handles is handed its parent's own when it is a console program,
 * duplicates of them (`consoleOnly`), and none when it is a window program,
 * as Windows decides by the image's subsystem; a window program has no
 * console, so a console handle handed it is NULL there.
 *
 * @param {any} options
 * @returns {{ inherited: { handle: number, type: string, object: any }[],
 *     standard: { input?: number, output?: number, error?: number } | undefined }}
 */
function handedDown(options){
    /** @type {any[]} */
    const all = options.inheritedHandles ?? [
        ...(options.pipeEnds ?? []).map((/** @type {any} */ end)=>({
            handle: end.handle, type: 'pipe', object: pipeStandIn(end.id, end) })),
        ...options.inheritedFiles ?? []];
    if (!options.consoleHandles && !options.standardHandles)
    {
        return { inherited: all, standard: undefined };
    }
    const kind = options.executable ? imageKind(options.executable) : null;
    const consoleProgram = kind?.kind === 'pe' && kind.subsystem === IMAGE_SUBSYSTEM_WINDOWS_CUI;
    for (const one of all)
    {
        if (one.consoleOnly && !consoleProgram)
        {
            one.drop?.();
        }
    }
    /** @type {Record<string, number>} */
    const named = options.standardHandles
        ?? (consoleProgram ? options.consoleHandles : { input: 0, output: 0, error: 0 });
    return { inherited: all.filter(one=>consoleProgram || !one.consoleOnly),
        standard: consoleProgram ? named : Object.fromEntries(Object.entries(named)
            .map(([which, handle])=>[which, CONSOLE_STANDARD.has(handle) ? 0 : handle])) };
}

/**
 * One machine, running one image.
 *
 * `createApp` below is what a caller reaches for; this is what it builds, once
 * per process. A child process is a second call to this against the child's
 * image, after the first has been disposed -- so everything here belongs to the
 * program it was built for, and nothing survives except what is passed back in.
 *
 * @param {ProcessOptions} options
 * @returns {Promise<any>} an AppController
 */
async function buildApp(options){
    // What its parent handed it, and which are its standard handles.
    const handed = handedDown(options);
    /**
     * The libraries this build synthesises, once their table is made: a file
     * call the modules make while they are being built (the standard
     * directories made at start) finds none, rather than the table before it
     * exists.
     *
     * @type {Record<string, unknown> | null}
     */
    let builtLibraries = null;
    // Handed in across a replacement, so a caller's subscriptions outlive the
    // process they were made against: the program has changed, the machine it
    // is running in has not.
    const events = options.events ?? createEvents();
    /** The last lines the layers traced, for a report (`TRACED_KEPT`). @type {string[]} */
    const layerTraces = [];
    // The presenter the run made. A machine is a process; the canvas, the
    // texture the primary is copied into and the pacer are not. This machine
    // hands the run's presenter to the graphics layer and draws through it, so
    // the last frame of the process it replaced stays on the canvas until this
    // one has something to show.
    const runPresenter = options.graphics?.presenter ?? null;
    /**
     * This process's debugger while one hears it: from its start, or since
     * one attached (`debug-events.js`); null otherwise.
     */
    const debuggerNow = ()=>(options.debugger && (options.debugger.debugged?.() ?? true)
        ? options.debugger : null);

    // The address space above the program: the system modules first, then the
    // libraries a game brought with it, and the heap above all of them with
    // everything that is left.
    //
    // The heap is last because it is the part that has to be big. A game of
    // this era loads its textures, its models and its sound into ordinary
    // memory and expects hundreds of megabytes of it; a heap wedged between
    // the image and the modules can only ever be a few, and what a program
    // does when it runs out is not fail gracefully -- one real title writes a
    // crash report saying there was not enough memory and stops, tens of
    // millions of instructions after everything else had worked.
    //
    // The gap left for modules is generous for the same reason in reverse: a
    // library a game ships can itself be twelve megabytes, and a library
    // placed inside the heap would be overwritten by the first large
    // allocation.
    const programLoaded = programImage(options.executable, { hostMemory: options.cpu?.hostMemory,
        memorySize: options.memorySize });
    // An image past 4 GiB (`wide`) lies apart from the space below, which is laid
    // out as for an image at the 32-bit programs' base: its libraries, stacks and
    // heap where any other process has them.
    const mainImage = programLoaded.wide === undefined || programLoaded.wide.codeBase === 0
        ? programLoaded : { ...programLoaded, imageBase: LONG_IMAGE_BASE, sizeOfImage: 0x10000 };
    // An x86-64 program (`roadmap/x64.md`): long mode on cork, one executor,
    // its image in the window below 4 GiB.
    const long = mainImage.bits === 64;
    /** The machine every image mapped into the process must be (`parsePe`). */
    const processBits = long ? 64 : 32;
    const { moduleBase: MODULE_BASE, stackPoolBase: STACK_POOL_START, heapBase: HEAP_START }
        = spaceAbove(mainImage.imageBase + mainImage.sizeOfImage, mainImage.imageBase);
    // The engine's range in the guest's space (`engineAreaFor`): where the
    // memory grows as the guest is given more, rather than every process
    // committing the whole of `memorySize`. Not where the run asks for the
    // whole memory from the start (`cpu.grow` false).
    const mayGrow = options.cpu?.grow !== false;
    /** @param {number} size */
    const areaFor = size=>(mayGrow ? engineAreaFor({ wide: programLoaded.wide !== undefined,
        memorySize: size,
        moduleBase: MODULE_BASE, stackPoolStart: STACK_POOL_START, heapStart: HEAP_START,
        executors: options.cpu?.cores ?? 1, image: mainImage,
        far: long && options.cpu?.far === true }) : undefined);
    // `memorySize` is the program's RAM: a limit on what it is given in all, not
    // its address space. The address space is Windows's: 2 GiB, and for a program
    // linked /LARGEADDRESSAWARE 4 GiB under WOW64 or 3 GiB on a 32-bit Windows
    // (`HEAP_SIZE`), whatever RAM the machine has. A memory that grows holds only
    // what the program was given of that space, so its window is the whole of it;
    // one that cannot grow is made whole, and is as large as the RAM.
    // Past 2 GiB the window is all of wasm's 4 GiB -- the tables inside the
    // guest's space, not past it -- and only a memory that grows holds it.
    // A wide window's space below is laid out as a 2 GiB one - its libraries and stacks
    // where any process has them - and its heap reaches on to 4 GiB (`HEAP_SIZE`): its
    // RAM is the window, and the image's low dword span is cut from that heap. Past
    // 4 GiB its RAM is handed out by reservation once the space below has no room
    // (`far-space.js`), as much as the program's memory says.
    const ramLimit = Math.min(options.memorySize ?? DEFAULT_MEMORY_SIZE,
        programLoaded.wide?.ram ?? 2 ** 32);
    const largeSpace = mainImage.largeAddressAware && options.heapSize === undefined;
    const askedMemory = programLoaded.wide !== undefined ? 2 ** 31
        : !mayGrow ? ramLimit
            : largeSpace ? 2 ** 32 : 2 ** 31;
    const memorySize = askedMemory > 2 ** 31 && areaFor(askedMemory) === undefined ? 2 ** 31
        : askedMemory;
    const engineArea = areaFor(memorySize);
    const HEAP_BASE = HEAP_START + (engineArea?.inHeap ? engineArea.span : 0);
    /** Where the libraries' space ends: at the engine's range where that lies at its top. */
    const LIBRARIES_END = engineArea && !engineArea.inHeap && !engineArea.cut ? engineArea.at
        : STACK_POOL_START;
    /** The program's image lies in the heap's span, which gives that part up (`spaceAbove`). */
    const imageInHeap = mainImage.imageBase >= HEAP_BASE;
    // Where a thread that is not the first gets its stack. Above the space
    // libraries are mapped into and below the heap, because a stack of the size
    // a program was linked for is a megabyte or more and the megabyte under the
    // image will not hold several of them.
    const STACK_POOL_WHOLE = 0x04000000;
    const mainStack = placeMainStack(mainImage.stackReserve, STACK_POOL_START, STACK_POOL_WHOLE);
    const STACK_POOL_BASE = mainStack.poolBase;
    const STACK_POOL_SIZE = mainStack.poolSize;
    // What each of them gets: what the image was linked to expect, floored so a
    // program that asks for almost nothing still has room to make a call, and
    // capped so that a program asking for an enormous stack cannot leave the
    // pool with room for only one thread.
    const threadStackSize = Math.min(stackReserveOf(mainImage.stackReserve),
        Math.floor(STACK_POOL_WHOLE / 16));
    // A program linked /LARGEADDRESSAWARE is given addresses past 2 GiB: up to
    // 4 GiB on a 64-bit Windows, up to 3 GiB on a 32-bit one, taken as started
    // with /3GB (`roadmap/decisions.md` A287). Any other stays below, where it may
    // keep a pointer's sign.
    const HEAP_SIZE = (memorySize > 2 ** 31 || programLoaded.wide !== undefined)
        && largeSpace
        ? (long || options.machine === 'amd64' ? LARGE_ADDRESS_TOP : INCREASED_USER_VA_TOP)
            - HEAP_BASE
        : heapSizeFor(memorySize, options.heapSize, HEAP_BASE);

    /**
     * The process's modules, win32's among them, filled in below. win32 is
     * built before they exist -- it is what says which functions they export
     * -- so it is handed lookups rather than the answers, and only ever calls
     * them while the guest is running.
     */
    /**
     * The span the guest code the engine writes itself is placed in - its
     * routines and what they keep, a 64-bit process's call stubs - at the
     * start of the modules' window, before the system modules
     * (`ENGINE_CODE_BYTES`), written as modules are placed. Not the
     * program's heap: a routine is placed when the module that has it is first
     * loaded, and where the program's own allocations land must not hang on
     * which modules it loaded before them. Past its end, the heap.
     */
    const engineCode = {
        next: 0,
        end: 0,
        said: false,
        /** Lays the span out at `base`: one region, its memory reached as it is taken. @param {number} base */
        open(base){
            this.next = base;
            this.end = base + ENGINE_CODE_BYTES;
            memory.register({ name: 'engine code', base, size: ENGINE_CODE_BYTES,
                kind: memory.RegionKind.THUNK_CODE, access: memory.Access.READ_WRITE_EXECUTE });
        },
        /** A module's own part of the span while it is placed (`within`): [next, end). */
        slice: /** @type {{ next: number, end: number } | null} */ (null),
        /** Counts the parts placing began (`within`): the code arena's page per part. */
        part: 0,
        /**
         * A block of the span, reading as zeroes as a heap block does: what the
         * engine keeps there (a routine's tables, the clock's last answer) is
         * read before it is written. A memory just made is zero; one a gone
         * process left holds what that process kept at the same addresses
         * (`reusedMemory`), and the clock's last answer read from it held the
         * counter still for as long as the gone process had lived.
         *
         * @param {number} bytes
         */
        take(bytes){
            const size = Math.ceil(bytes / 16) * 16;
            const at = this.from(size);
            if (at !== null && options.reusedMemory)
            {
                memory.fillBytes(at, 0, size);
            }
            return at;
        },
        /** @param {number} size */
        from(size){
            const slice = this.slice;
            if (slice && slice.next + size <= slice.end)
            {
                const at = slice.next;
                slice.next += size;
                return at;
            }
            if (this.next === 0 || this.next + size > this.end)
            {
                if (this.next !== 0 && !this.said)
                {
                    this.said = true;
                    reportDivergence('engine code', `its ${ENGINE_CODE_BYTES} bytes are`
                        + ' spent: the rest goes to the heap');
                }
                return null;
            }
            const at = this.next;
            this.next += size;
            memory.reach?.(this.next);
            return at;
        },
        /**
         * Runs `place` with what it takes from the span taken from [from, to) -
         * the part a module took where the machine's layout was laid out - in
         * the same order, so a routine lies at the address it has in every
         * process; what does not fit goes on past every module's part.
         *
         * @template T @param {number} from @param {number} to @param {() => T} place @returns {T}
         */
        within(from, to, place){
            const was = this.slice;
            const wasPart = this.part;
            this.slice = to > from ? { next: from, end: to } : null;
            this.part = ++this.parts;
            memory.reach?.(to);
            try
            {
                return place();
            }
            finally
            {
                this.slice = was;
                this.part = wasPart;
            }
        },
        parts: 0,
    };
    const modules = createModuleTable({
        keyOf: moduleKeyOf,
        placesNamed: (path, only)=>placesNamed(path, only),
        importsOf: (/** @type {any} */ module)=>SYSTEM_IMPORTS[moduleKeyOf(module.name)] ?? [],
        onLoaded: (/** @type {any} */ module)=>{
            threadBlocks?.addModule(module);
            // A library of the engine's loaded once the process runs is told to
            // its debugger as it is marked, without waiting for the answer: the
            // mark is made inside a lookup that cannot wait (`debug-events.js`).
            if (debugStarted)
            {
                debuggerNow()?.report({ code: DEBUG_EVENT.LOAD_DLL,
                    threadId: kernel.currentThread()?.id >>> 0, base: module.base });
            }
        },
    });
    /** The heap up to the highest address it ever handed out: what of it the tab pays for. */
    const heapTouched = ()=>{
        const handedTo = core.api('win32')?.heap?.()?.handedTo?.();
        return typeof handedTo === 'number' ? Math.max(0, handedTo - HEAP_BASE) : NOT_MEASURED;
    };
    /**
     * What the program holds of its RAM now, by pool (`memory-zones.js`): the
     * images mapped below the heap (one in the heap is a block of it), the
     * first thread's stack where it is not under the stub table, and the
     * heap up to the highest address it ever handed out; the other threads'
     * stacks are the kernel's to say. A page of guest memory touched once is
     * the tab's for good -- a browser cannot give it back, and an iPhone ended
     * a tab at the same 1.7 GB written whether the pages were zeroed again or
     * not (`roadmap/negative-results.md`) -- so a block freed still counts,
     * and the pages past the highest one are an address space the tab does
     * not pay for.
     */
    const guestHeld = ()=>{
        let images = 0;
        for (const held of modules.all())
        {
            // A system module's bytes are there once placed, loaded or not.
            const there = held.placed ?? held.loaded !== false;
            images += there && held.base < HEAP_BASE ? held.size ?? 0 : 0;
        }
        return {
            images,
            mainStack: mainStack.initialStack === undefined
                ? Math.max(mainImage.stackReserve >>> 0, 0x10000)
                : mainStack.initialStack - STACK_POOL_START,
            heap: heapTouched(),
        };
    };
    /**
     * Libraries LoadLibraryEx loaded as data, by the handle it gave out: no
     * modules, so in neither table above.
     *
     * @type {Map<number, any>}
     */
    const dataFiles = new Map();
    /**
     * Every library whose DllMain has been told DLL_PROCESS_ATTACH, in the
     * order it was, and every one loaded at run time with TLS callbacks but
     * no DllMain, once they were told: ExitProcess tells them of the detach
     * the other way round.
     *
     * @type {any[]}
     */
    const attachOrder = [];
    /**
     * The images the process started with, in the order they were attached:
     * the program first, then its libraries. Set once they are known.
     *
     * @type {any[]}
     */
    let startupImages = [];
    /**
     * Every image with a thread-local directory, by base, those loaded at
     * run time among them: its index in each thread's thread-local array, the
     * block each thread is given a copy of, and its TLS callbacks.
     *
     * @type {Map<number, { index: number, template: Uint8Array, size: number,
     *     callbacks: number[] }>}
     */
    const threadLocalImages = new Map();
    /**
     * The lowest index in the thread-local array no image holds: the loader's
     * own numbering, as Windows gives it -- the program's image 0, the
     * libraries after it in the order they are loaded, an unloaded one's index
     * free again. Not TlsAlloc's: a program compiled to reach its own image's
     * variables at index 0 without reading _tls_index finds them there
     * whatever slots it has allocated.
     */
    const freeLocalIndex = ()=>{
        const taken = new Set([...threadLocalImages.values()].map(local=>local.index));
        let index = 0;
        while (taken.has(index))
        {
            index++;
        }
        return index;
    };
    /**
     * Libraries that asked not to be told of threads (DisableThreadLibraryCalls), by base.
     *
     * @type {Set<number>}
     */
    const withoutThreadCalls = new Set();
    /**
     * An image's routines, as the loader calls them for any reason: its TLS
     * callbacks, then its entry point once DLL_PROCESS_ATTACH has reached it.
     *
     * @param {any} held
     * @returns {number[]}
     */
    const routinesOf = held=>[
        ...threadLocalImages.get(held.base)?.callbacks ?? [],
        ...attachOrder.includes(held) && held.entryPoint && held.entryPoint !== held.base
            ? [held.entryPoint] : [],
    ];
    /**
     * Every image still attached that has routines to tell, in load order --
     * those the process started with, then each library loaded since as it
     * was attached -- with its routines.
     *
     * @returns {{ base: number, routines: number[] }[]}
     */
    const imagesTold = ()=>[
        ...startupImages, ...attachOrder.filter(held=>!startupImages.includes(held)),
    ]
        .filter(held=>held.loaded !== false && held.attached !== false)
        .map(held=>({ base: held.base, routines: routinesOf(held) }))
        .filter(each=>each.routines.length > 0);
    /**
     * The loader lock: the CRITICAL_SECTION the startup's attaches and every
     * thread's are made under. Zero until it is made.
     */
    let loaderLock = 0;
    /** @type {any} */
    let mainModule = null;
    /** Whether a debuggee's start is told: a library loaded after is told as it loads. */
    let debugStarted = false;

    /**
     * Every file a path given to LoadLibrary can name, as `pathKey`s: the one
     * it fixes, or each place a relative one is searched for in.
     *
     * @param {string} path @param {string[]} [only]  A LoadLibraryEx search's places.
     */
    const placesNamed = (path, only = undefined)=>libraryCandidates(path,
        options.imagePath ?? 'C:\\app.exe', core.api('filesystem').currentDirectory(), { only })
        .map(pathKey);

    const { markLoaded, answersPath } = modules;
    const findModule = modules.find;

    /**
     * Whether a file, not a directory, stands at a path on the volume.
     *
     * @param {string} path
     */
    const standsAt = path=>{
        try
        {
            const entry = core.api('filesystem').stat(path);
            return Boolean(entry && !entry.directory);
        }
        catch {
            return false;
        }
    };

    // Where input goes when nobody names a window: the active one, and while
    // there is none -- a program whose window was never shown -- the one it
    // made last, which is the only other thing it could be looking at.
    const lastCreated = { value: 0 };
    const foreground = ()=>win32.activeWindow?.() || lastCreated.value;
    /** Whether a frame is open in the journal: the first present opens one, the rest close and reopen. */
    const framed = { value: false };
    // Where the counters stood when the frame being measured began.
    const retiredAtFrameStart = { value: 0 };
    const interpretedAtFrameStart = { value: 0 };
    const translateAtFrameStart = { value: 0 };
    const exitsAtFrameStart = { value: 0 };
    const writtenAtFrameStart = { value: 0 };
    const heapAtFrameStart = { value: 0 };
    /** The graphics worker's frame times when the frame began (`WorkerFrameTimes`). */
    /** @type {{ value: any }} */
    const workerAtFrameStart = { value: null };
    /** The graphics worker's frame times now, or null with no worker or no graphics layer. */
    const workerFrameTimes = ()=>{
        try
        {
            return core.api('graphics').workerFrameTimes?.() ?? null;
        }
        catch {
            return null;
        }
    };
    /** The JS heap, where the runtime will say; a frame's growth is what the host allocated. */
    const heapReadable = ()=>/** @type {any} */ (globalThis.performance)?.memory !== undefined;
    const heapUsed = ()=>{
        const performance = /** @type {any} */ (globalThis.performance);
        return performance?.memory?.usedJSHeapSize ?? 0;
    };

    // Filled in once the machine is up and a bundle, if any, is mounted. win32
    // is built before that and is handed the lookup rather than the answer.
    /** @type {{ source: any, fetch: (needed: any[]) => Promise<void>, stop: () => void,
     *          ahead: () => number,
     *          refetched: () => { blocks: number, bytes: number },
     *          ranges: () => { requests: number, bytes: number },
     *          decoded?: () => { blocks: number, bytes: number, ms: number },
     *          held?: () => Record<string, number | string>,
     *          registry: Promise<any> } | null} */
    let blocks = null;
    /** Whether this process mounted the bundle, and so reports what its pools hold. */
    let mountedBlocks = false;
    /**
     * Where a thread's environment block comes from, once the process has
     * one to hand out. Every thread needs its own: FS points at it, and a
     * thread without one reads its id, its stack bounds and its thread-local
     * slots from linear address zero and up.
     *
     * @type {{
     *     peb: number,
     *     createThreadBlock: (thread: { id: number, stackBase: number,
     *         stackLimit: number,
     *         locals?: import('./layers/win32/kernel32/teb.js').ThreadLocal[] })
     *         => { teb: number, tls: number } | null,
     *     releaseThreadBlock: (teb: number) => boolean,
     *     addThreadLocal: (local: import('./layers/win32/kernel32/teb.js').ThreadLocal)
     *         => boolean,
     *     removeThreadLocal: (slot: number) => void,
     *     addModule: (module: import('./layers/win32/kernel32/teb.js').LoadedModule) => number,
     *     removeModule: (base: number) => void,
     *     entryOf: (base: number) => number,
     *     hasThreadLocals: (base: number) => void,
     * } | null}
     */
    let threadBlocks = null;
    /** @type {(() => Uint8Array) | null} */
    let imageInformation = null;
    /**
     * The callbacks LdrRegisterDllNotification registered, by their cookie, in
     * the order registered (`tellNotified`).
     *
     * @type {Map<number, { callback: number, context: number }>}
     */
    const notifications = new Map();
    let nextNotificationCookie = 1;
    /** What ntdll's LdrRegisterDllNotification and LdrUnregisterDllNotification act on. */
    const dllNotifications = {
        get size(){
            return notifications.size;
        },
        values: ()=>notifications.values(),
        /** @param {number} callback @param {number} context */
        register: (callback, context)=>{
            const cookie = nextNotificationCookie++;
            notifications.set(cookie, { callback: callback >>> 0, context: context >>> 0 });
            return cookie;
        },
        /** @param {number} cookie */
        unregister: cookie=>notifications.delete(cookie >>> 0),
    };
    /**
     * What a thread made after the process's first is given a copy of: every
     * image's thread-local block, at the image's index, as the loader does
     * for each thread.
     *
     * @returns {import('./layers/win32/kernel32/teb.js').ThreadLocal[]}
     */
    const threadLocals = ()=>[...threadLocalImages.values()]
        .map(({ index, template, size })=>({ slot: index, template, size }));
    /**
     * Every thread holding blocks, and its environment block. Each is given
     * back at the next thread's making once its thread is gone, as a stack is:
     * the call that ends a thread still runs on it on its way out.
     *
     * @type {Map<any, number>}
     */
    const blockHolders = new Map();
    /** @param {any} thread @param {{ teb: number } | null} block */
    const holdBlock = (thread, block)=>{
        if (block === null)
        {
            // Never a thread on no block: FS at zero, it reads its id, its
            // stack and its thread-local slots from linear address zero up.
            throw new Error(`no memory for thread ${thread.id}'s environment block`);
        }
        thread.tebAddress = block.teb;
        blockHolders.set(thread, block.teb);
    };
    const giveBackBlocks = ()=>{
        const gone = core.api('kernel').threadGone;
        for (const [holder, teb] of blockHolders)
        {
            if (gone(holder))
            {
                blockHolders.delete(holder);
                threadBlocks?.releaseThreadBlock(teb);
                // Asked for through a handle still open, it has none, rather
                // than the block of whichever thread is given it next.
                holder.tebAddress = 0;
            }
        }
    };

    /** Range requests outstanding: what a parked guest thread is really on. */
    let fetching = 0;
    /**
     * Resolved when the last of them answers, so the loop can wait for the
     * thing itself rather than poll a timer until it happens.
     *
     * @type {Promise<void> | null}
     */
    let fetched = null;
    /** @type {() => void} */
    let arrived = ()=>{};

    /**
     * What the guest has waited on the network for, and how much of it twice.
     *
     * A block asked for a second time is one the cache had and let go, and
     * there is no other way to tell that apart from a program simply reading
     * more of its own archives -- both look like a run that spends its time
     * fetching. One is a bound to raise; the other is nothing to do with us.
     */
    const bundleReads = { requests: 0, blocks: 0, bytes: 0, again: 0, againBytes: 0 };
    /** By bundle and block: a layer's blocks are numbered from 0 as the bundle's are. @type {Set<string>} */
    const blocksSeen = new Set();

    // A call that is waiting -- a message loop with an empty queue -- is let go
    // once per scheduler turn to look again.
    /** @type {{ value: (() => void)[] }} */
    const idlers = { value: [] };

    /**
     * What the program is told its display is. Mutable: a program that creates
     * its Direct3D device at a resolution other than the one the launch named
     * is telling the engine its screen is that resolution, one window full of
     * it. The reported metrics follow, so a cursor the game normalises by the
     * screen and draws in its own back buffer stays under the pointer.
     *
     * What does not follow is how large the display can be. A program reads
     * the modes on offer to build its resolution menu, and a list bounded by
     * the mode it is already in offers it nothing else: it created its device
     * at the size it last saved, and from then on that was the only size it
     * could see. So the display's own size travels beside the mode in effect,
     * set once from the launch and never moved.
     */
    const launched = options.screen ?? { width: 640, height: 480, bitsPerPixel: 32 };
    // And its rate: what the person says their display shows at most (maxFps),
    // which a program's vertical sync holds it to, as that display would.
    const shownAtMost = options.maxFps ?? SETTINGS.frame.maxFps;
    const display = { ...launched, displayWidth: launched.width, displayHeight: launched.height,
        ...((shownAtMost ?? 0) > 0 ? { refresh: shownAtMost } : {}) };

    const reportDivergence = divergenceReporter((name, payload)=>events.emit(name, payload));

    // A call site is made thousands of times in a run and its name never
    // changes, so the area string is built once per name rather than on
    // every call; the cache is this instance's own, not shared with another.
    /** @type {Map<string, string>} */
    const areaCache = new Map();
    const areaOfCall = (/** @type {any} */ call)=>areaOf(call, areaCache);
    /** @type {Map<string, { revision: number, area: string, on: boolean, seed: number }>} */
    const tracedCalls = new Map();
    /** Each thread's name as the journal writes it, made once. @type {WeakMap<object, string>} */
    const threadTags = new WeakMap();
    // Every process of a run names its first thread "main", so in the run's one
    // journal a later process's threads carry its image name as well.
    const callerImage = String(options.imagePath ?? '').split(/[\\/]/).pop() ?? '';
    const callerTag = options.log?.journal ? `${callerImage}:` : '';
    // The cursor the page shows: the system's or a device's (`visibleCursor`).
    /** @type {{ value: any }} */
    const systemCursor = { value: { shown: true } };
    /** @type {{ value: any }} */
    const deviceCursor = { value: null };
    const mouseHeld = { value: false };
    const showCursor = ()=>{
        const cursor = visibleCursor(systemCursor.value, deviceCursor.value, mouseHeld.value);
        core.api('input')?.cursorShown?.(cursor.shown !== false);
        events.emit('cursor', cursor);
    };
    /** @type {any} */
    let win32Api = null;
    /** The calling thread's last error, from win32: looked up once. */
    const lastErrorOfWin32 = ()=>(win32Api ??= core.api('win32')).lastError();

    /**
     * Writes one host call to the journal.
     *
     * Every one of them, which is why the categories start switched off: a
     * short run makes tens of thousands of calls, and a reader who has not
     * asked for them should pay a map lookup and a comparison rather than a
     * formatted line. Turning one on is what a filter does. Even that was a
     * tenth of a crossing, so the answer is kept per name until a level moves
     * (the journal's `revision`).
     *
     * @param {any} call
     */
    const journalCall = call=>{
        const revision = journal.revision();
        let traced = tracedCalls.get(call.name);
        if (traced === undefined || traced.revision !== revision)
        {
            const area = areaOfCall(call);
            traced = { revision, area, on: journal.enabled(area, journal.Level.TRACE),
                seed: hashText(FNV_OFFSET, call.name) };
            tracedCalls.set(call.name, traced);
        }
        const category = traced.area;
        if (!traced.on)
        {
            return;
        }
        // Named by the thread that made it. A program of this age runs a dozen
        // of them and the interleaving is the whole story: without this, a loop
        // that is one thread waiting and another working reads as a single
        // thread doing something incoherent, and a thread that has stopped
        // calling anything at all cannot be picked out from the noise of the
        // ones that have not.
        // An argument whose text was kept (traceStrings) is shown as that
        // text: a path is what a question about a failed open needs. Every
        // kept argument is written: a blit's source context is its sixth.
        const current = core.api('kernel').currentThread();
        let thread = current ? threadTags.get(current) : undefined;
        if (thread === undefined)
        {
            thread = callerTag + (current?.name ?? '?');
            if (current)
            {
                threadTags.set(current, thread);
            }
        }
        // A thread polling for something is a loop of the same few calls,
        // written twice and then counted (`call-repeats.js`): written each
        // time, it would push out of the ring the moment it began waiting.
        // The calls are told apart by a number made from the name, the
        // arguments and the answer -- a polling loop makes millions, and a
        // line of text made for each was most of what the journal cost.
        let key = traced.seed;
        const values = call.args ?? [];
        for (let at = 0; at < values.length; at++)
        {
            const text = call.strings?.[at];
            key = text ? hashText(key, String(text)) : hashWord(key, values[at] >>> 0);
        }
        key = typeof call.result === 'number' ? hashWord(key, call.result >>> 0)
            : hashText(key, String(call.result));
        const { write, said } = callRepeats.note(thread, key);
        if (said)
        {
            journal.write('trace', category, said.ended
                ? '[{0}] the {1} calls before went round again: {2} calls not written'
                : '[{0}] the last {1} calls still go round: {2} calls not written so far',
            thread, said.period, said.calls);
        }
        if (write)
        {
            // An argument whose text was kept (traceStrings) is shown as that
            // text: a path is what a question about a failed open needs.
            const args = values
                .map((/** @type {number} */ value, /** @type {number} */ at)=>(
                    call.strings?.[at] ? JSON.stringify(String(call.strings[at]).slice(0, 160))
                        : `0x${(value >>> 0).toString(16)}`))
                .join(', ');
            journal.write('trace', category, '[{3}] {0}({1}) = {2}', call.name, args, call.result,
                thread);
        }
    };
    const callRepeats = createCallRepeats();

    // The translator's cache goes with the bundle's blocks: local by default,
    // the bundle's name its namespace, resolved here in the engine's own
    // thread as the block store is. Held here as well, for the bundle's seed.
    const storeSpec = options.cork?.config?.store === undefined ? 'local'
        : options.cork.config.store;
    const translationStore = await resolveTranslationStore(storeSpec,
        options.bundle?.id ?? options.id ?? 'bundle');
    // Closed with this machine only when opened for it: a store handed in is
    // the run's, shared with the machines of the processes still running.
    const ownsTranslationStore = storeSpec === 'local';

    // What the volume's reader calls for blocks a read found absent, kept so a
    // reader outside win32 -- DirectMusic's loader -- can wait for them too.
    const fetchBundleBlocks = (/** @type {any[]} */ needed)=>{
        if (!blocks)
        {
            return Promise.resolve();
        }
        // Counted, because from the run loop every parked thread looks
        // the same and they are not: a thread waiting on a range
        // request is waiting on the network, and a thread waiting on
        // its own message queue is waiting on nothing at all. Told
        // apart, one of them is a number to reduce and the other is a
        // loop to stop taking so seriously.
        bundleReads.requests++;
        for (const block of needed)
        {
            bundleReads.blocks++;
            bundleReads.bytes += block.packed;
            const seen = `${block.layer ?? 0}:${block.index}`;
            if (blocksSeen.has(seen))
            {
                bundleReads.again++;
                bundleReads.againBytes += block.packed;
            }
            else
            {
                blocksSeen.add(seen);
            }
        }
        fetching++;
        if (fetching === 1)
        {
            // The loop is about to have nothing to do until this
            // answers, and it can be told exactly when that is. Without
            // it the only way to find out was to sleep and look again,
            // on a timeout a browser clamps to a millisecond -- which
            // measured out at nineteen wake-ups per range request and a
            // fifth of a whole run spent asking.
            fetched = new Promise(resolve=>{
                arrived = resolve;
            });
            // A page shows that a stall is the bundle arriving, not the game.
            events.emit('bundle-fetching', { fetching: true });
        }
        return blocks.fetch(needed).finally(()=>{
            fetching--;
            if (fetching === 0)
            {
                const open = arrived;
                fetched = null;
                arrived = ()=>{};
                open();
                events.emit('bundle-fetching', { fetching: false });
            }
        });
    };

    const core = await assembleModules(await layerConfig({
        HEAP_BASE, HEAP_SIZE, STACK_POOL_BASE, STACK_POOL_SIZE, STACK_POOL_START, areaOfCall,
        callerImage, dataFiles, deviceCursor, display, dllNotifications, engineArea,
        engineCode, events, exitsAtFrameStart, fetchBundleBlocks, findModule, foreground, framed,
        giveBackBlocks, handed, heapAtFrameStart, heapReadable, heapUsed, holdBlock, imagesTold,
        interpretedAtFrameStart, journalCall, lastCreated, lastErrorOfWin32, layerTraces, long,
        mainImage, mainStack, memorySize, modules, mouseHeld, options, processBits, ramLimit,
        programLoaded, reportDivergence, retiredAtFrameStart, runPresenter, showCursor,
        systemCursor, threadLocalImages, threadLocals, threadStackSize, translateAtFrameStart,
        translationStore, withoutThreadCalls, workerAtFrameStart, workerFrameTimes,
        writtenAtFrameStart,
        blocks: ()=>blocks,
        bridge: ()=>bridge,
        broughtCopies: ()=>broughtCopies,
        builtLibraries: ()=>builtLibraries,
        cpu: ()=>cpu,
        exportOf: ()=>exportOf,
        filesystem: ()=>filesystem,
        idlers: ()=>idlers.value,
        imageInformation: ()=>imageInformation,
        journal: ()=>journal,
        kernel: ()=>kernel,
        loadErrors: ()=>loadErrors,
        loadLibraryAtRuntime: ()=>loadLibraryAtRuntime,
        loaderLock: ()=>loaderLock,
        mainModule: ()=>mainModule,
        memory: ()=>memory,
        moduleUnderContext: ()=>moduleUnderContext,
        resolveImport: ()=>resolveImport,
        systemLibraries: ()=>systemLibraries,
        threadBlocks: ()=>threadBlocks,
        win32: ()=>win32,
        core: ()=>core,
    }));

    // The hosted MPEG provider decodes through the media layer's binary and
    // asks for it synchronously, so the binary has to be up before the first
    // stream opens -- seconds after a program starts, and inside the
    // compilation burst that starts it. Compiled now, off the thread, rather
    // than found missing then; a build with no binary has nothing to prepare.
    if ((options.audio?.mp3 ?? true) && core.api('media').available())
    {
        core.api('media').prepare().catch(()=>{
            // Reported by the layer's own diagnostics; the provider falls back.
        });
    }

    const filesystem = core.api('filesystem');
    const registryInherited = core.api('win32').registryInherited?.() ?? false;
    const { seeded, saver, stopSavingRegistry } = await openSession({ options, events, filesystem,
        registry: core.api('win32').registry(), inherited: registryInherited,
        standing: filesystem.inherited?.() ?? false, system: options.system });
    // A saved session restored the registry whole, with the client a past run
    // had: this run's is announced over it.
    const steamClient = core.api('win32').steamClient?.() ?? 0;
    if (steamClient !== 0 && options.win32?.steam)
    {
        announceSteamClient(core.api('win32').registry(),
            { pid: steamClient, account: options.win32.steam });
    }

    const journal = core.api('log');
    // The run's processes share one event bus and one journal, so only the
    // machine that made the journal writes the bus into it, and straight into
    // the journal rather than through its own view: that view closes with the
    // machine, and a process that replaced it still fires events.
    if (!options.log?.journal)
    {
        journalEvents(events, journal.journal?.() ?? journal, { shaders: options.log?.shaders });
    }

    const cpu = core.api('cpu');
    /** The workers of the run's translation pool lent to this machine, by the pool's token.
     * @type {Map<number, import('./layers/cpu/engine.js').TranslatorPort>} */
    const lentTranslators = new Map();
    const memory = core.api('memory');
    const kernel = core.api('kernel');
    const loader = core.api('loader');
    const win32 = core.api('win32');
    /** The activation contexts the loader looks libraries up through (`actctx.js`). */
    const activation = /** @type {any} */ (win32.activationContexts)?.() ?? null;
    const bridge = core.api('bridge');
    const graphics = core.api('graphics');
    const audio = core.api('audio');
    const input = core.api('input');

    // The machine: cork's own host and memory, and the translator named by
    // `engineUrl`.
    await cpu.boot();

    // A processor exception goes to the handlers the program registered
    // before it stops the machine. The thread waits the way a host call does
    // while they run; if none of them takes it, the machine stops on the
    // fault exactly as it would have without being asked.
    cpu.onFault((/** @type {any} */ fault)=>{
        const thread = kernel.currentThread();
        const answer = thread ? win32.dispatchFault(fault) : null;
        if (!answer)
        {
            return false;
        }
        bridge.holdForFault(thread, {
            name: `<${fault.name}>`,
            restingStack: fault.stack ?? 0,
            hostReturn: fault.eip,
        }, answer.then((/** @type {any} */ where)=>{
            if (where)
            {
                return where;
            }
            cpu.stopWithFault(fault);
            return new Promise(()=>{});
        }));
        return true;
    });

    // Mounted after the machine is up. The bundle is the run's: the first
    // process opens it -- its index, its block cache, the background fill --
    // and every process after it mounts the same one, rather than each reading
    // the index again and filling a second cache from the network beside the
    // first.
    mountedBlocks = !options.system?.bundle;
    blocks = options.system?.bundle
        ?? await mountBundle({ options, events, translationStore,
            runCache: options.cache?.reader ?? null });
    if (options.system && blocks)
    {
        options.system.bundle = blocks;
    }
    // A process that stands on the run's drives finds the bundle under C:
    // already, and its discs, the session and the files the page laid over
    // it; mounting or applying any of them again would put older bytes over
    // what the processes before it wrote.
    if (!(filesystem.inherited?.() ?? false))
    {
        blocks = await furnishVolume({ options, events, filesystem, blocks, seeded,
            registry: registryInherited ? null : core.api('win32').registry() });
        if (options.system && blocks)
        {
            options.system.bundle = blocks;
        }
    }
    // And what the process this one replaces had written. A self-extracting
    // installer unpacks its payload and then starts it; without this the
    // payload goes with the machine that wrote it and the child is started
    // against files that are no longer there.
    if (options.seed && options.seed.length > 0)
    {
        filesystem.apply(options.seed);
    }

    // A program starts in its own directory. One loaded from bytes alone, with
    // nothing at its path on the volume, starts at the root as before.
    try
    {
        filesystem.setCurrentDirectory(options.startDirectory
            ?? startDirectoryOf(options.imagePath ?? 'C:\\app.exe'));
    }
    catch (e){
        void e;
    }

    const { entryVector, initialStack, thunkBase } = cpu.layout;

    // The first thread gets the stack its own image asked the linker for.
    //
    // A fixed default is a guess, and the guess is wrong for anything but a
    // trivial program: a C runtime starting up inside a library the program
    // ships will walk past sixty-four kilobytes on its way to `main`. What
    // that produces is not a stack-overflow exception -- it is a read below
    // the mapped stack, reported at whichever call happened to be crossing
    // the boundary, with nothing pointing at the code that wanted the space.
    //
    // Clamped to what actually fits under the initial stack pointer, because
    // the region below it is finite and a request larger than the room is a
    // layout question rather than something to honour silently.
    const stackRoom = initialStack - (mainStack.initialStack === undefined
        ? thunkBase + cpu.layout.thunkCapacity : STACK_POOL_START);
    const stackSize = Math.min(stackReserveOf(mainImage.stackReserve), stackRoom);

    memory.register({
        name: 'entry-vector', base: entryVector, size: long ? 8 : 4,
        kind: memory.RegionKind.THUNK_DATA, access: memory.Access.READ_WRITE,
    });
    memory.register({
        name: 'stack', base: initialStack - stackSize, size: stackSize,
        kind: memory.RegionKind.STACK, access: memory.Access.READ_WRITE,
    });
    // The engine's range where it is cut out of the heap (`engineAreaFor`'s
    // `cut`): never handed out, and the heap's region two, on either side of it,
    // as a span a library claims leaves it.
    // The other executors' pages, where only they are cut out (`others`).
    const cutRange = engineArea?.cut ? engineArea : engineArea?.others ?? null;
    const cutArea = cutRange && cutRange.at > HEAP_BASE
        && cutRange.at + cutRange.span < HEAP_BASE + HEAP_SIZE ? cutRange : null;
    if (cutRange && !cutArea)
    {
        throw new Error(`app: the engine's range at 0x${cutRange.at.toString(16)} lies`
            + ` outside the heap's span 0x${HEAP_BASE.toString(16)}+0x${HEAP_SIZE.toString(16)}`);
    }
    /** @type {{ name: string, base: number, end: number }[]} */
    const heapParts = cutArea
        ? [{ name: 'heap', base: HEAP_BASE, end: cutArea.at },
            { name: `heap@${(cutArea.at + cutArea.span).toString(16)}`,
                base: cutArea.at + cutArea.span, end: HEAP_BASE + HEAP_SIZE }]
        : [{ name: 'heap', base: HEAP_BASE, end: HEAP_BASE + HEAP_SIZE }];
    for (const { name, base, end } of heapParts)
    {
        memory.register({
            name, base, size: end - base,
            kind: memory.RegionKind.THUNK_DATA, access: memory.Access.READ_WRITE,
        });
    }
    // The space past 4 GiB a 64-bit process reserves in (`cpu.far`): the program's
    // to read and write where kernel32 has given its chunks frames.
    // A wide window's RAM past 4 GiB is registered by reservation, as kernel32 makes
    // them (`far-space.js`): an image may lie there too.
    const farSpace = memory.farSpace?.() ?? null;
    const farFrom = farSpace?.direct === undefined ? farSpace?.base : farSpace.table;
    if (farSpace !== null && farFrom !== undefined)
    {
        memory.register({ name: 'far', base: farFrom, size: farSpace.top - farFrom,
            kind: memory.RegionKind.THUNK_DATA, access: memory.Access.READ_WRITE });
    }
    if (cutArea)
    {
        win32.heap().allocateAt(cutArea.at, cutArea.span,
            { owner: 'engine', reserving: true, held: true });
    }
    // A heap past 2 GiB (`LARGE_ADDRESS_TOP`) runs over the system's shared
    // page, where it lies once the RAM held reaches past it: the heap never
    // hands it out, nor the 64 KiB after it, as Windows maps neither.
    if (HEAP_BASE < SHARED_USER_DATA && HEAP_BASE + HEAP_SIZE > SHARED_USER_DATA + 0x20000)
    {
        win32.heap().allocateAt(SHARED_USER_DATA, 0x20000,
            { owner: 'kuser', reserving: true, held: true });
    }
    // Every system module has its span and its addresses before the program's
    // first instruction: an address taken early has to be the address that
    // works later (§13.3). Its bytes are written when something first loads it.
    const ordinalsOf = {
        ...(win32.ordinals ? win32.ordinals() : {}),
        ...(audio.ordinals?.() ?? {}),
        ...(input.ordinals?.() ?? {}),
        ...(core.api('media').ordinals?.() ?? {}),
    };
    // The drawing APIs are libraries like any other as far as a program is
    // concerned: it imports Direct3DCreate8 exactly as it imports CreateFileA,
    // and nothing about how they are reached should differ.
    // Merged name by name as each layer keeps it: win32's are made when first
    // read, and a spread would make them all.
    /** @type {Record<string, Record<string, any>>} */
    const allLibraries = {};
    for (const tables of [win32.libraries(), graphics.libraries?.() ?? {},
        audio.libraries?.() ?? {}, input.libraries?.() ?? {},
        core.api('media').libraries?.() ?? {}])
    {
        Object.defineProperties(allLibraries, Object.getOwnPropertyDescriptors(tables));
    }
    /**
     * The names answered from this engine's table even beside a file the
     * program brought: the KnownDLLs, and the redistributable runtimes the
     * layers stand in for (`answeredByEngine`).
     *
     * Everything else this engine provides -- `d3dx9_*`, `d3d9`, `ddraw`,
     * `dinput8`, `comctl32`, `version` -- is put aside when the program brought
     * its own file of that name, because that file is what a real loader maps.
     * Both the import walk and the run-time LoadLibrary path ask this question,
     * so they cannot disagree about which of the two wins.
     */
    const isKnownDll = answeredByEngine(
        /** @type {() => string[]} */ (win32.knownDlls)?.() ?? [],
        [
            ...(/** @type {() => string[]} */ (win32.runtimes)?.() ?? []),
            ...(/** @type {() => string[]} */ (audio.runtimes)?.() ?? []),
            ...(/** @type {() => string[]} */ (core.api('media').runtimes)?.() ?? []),
        ]);
    /**
     * The spans `claim` took from the heap's arena, by base, with the region
     * each was cut from: what `giveBack` puts back.
     *
     * @type {Map<number, { size: number, kind: string, access: string }>}
     */
    const claimedSpans = new Map();
    // Where a library may go: above the program's own image, which is not in
    // the map yet, and below the stack pool; and nowhere anything is mapped.
    const librarySpace = {
        floor: imageInHeap ? MODULE_BASE : mainImage.imageBase + mainImage.sizeOfImage,
        limit: LIBRARIES_END,
        /** @param {number} base @param {number} size */
        holder: (base, size)=>memory.list().find((/** @type {any} */ region)=>
            base < region.base + region.size && region.base < base + size) ?? null,
        /**
         * A span of the heap's arena that nothing has been given -- at a base
         * for a library that can only live there, anywhere for one the
         * modules' space has no room for: the heap gives it up and its region
         * is cut around it, the part above it a region of its own.
         *
         * @param {number | null} wanted @param {number} size
         */
        claim: (wanted, size)=>{
            const heap = core.api('win32').heap();
            const base = wanted === null
                ? heap.allocate(size, { alignment: LIBRARY_ALIGN, owner: 'image' })
                : heap.allocateAt(wanted, size, { owner: 'image' }) ? wanted : 0;
            const region = base === 0 ? undefined : memory.find(base);
            if (!region || !region.name.startsWith('heap')
                || base + size > region.base + region.size)
            {
                return 0;
            }
            const end = base + size;
            const regionEnd = region.base + region.size;
            memory.unregister(region.name);
            const { kind, access } = region;
            if (base > region.base)
            {
                memory.register({ name: region.name, base: region.base,
                    size: base - region.base, kind, access });
            }
            if (regionEnd > end)
            {
                memory.register({ name: `heap@${end.toString(16)}`, base: end,
                    size: regionEnd - end, kind, access });
            }
            claimedSpans.set(base, { size, kind, access });
            return base;
        },
        /**
         * Puts back a span `claim` took, once what was mapped on it is gone,
         * and nothing for one it did not take: the heap has it to hand out
         * again -- a library that can only live there is loaded there again --
         * and its region is the heap's once more, joined with the parts on
         * either side, since a block the heap later hands out across where a
         * cut was is one buffer and an access spanning two regions is refused.
         *
         * @param {number} base
         */
        giveBack: base=>{
            const span = claimedSpans.get(base);
            if (!span)
            {
                return;
            }
            claimedSpans.delete(base);
            core.api('win32').heap().free(base);
            const end = base + span.size;
            const heapPart = (/** @type {any} */ region)=>
                (region?.name.startsWith('heap') ? region : null);
            const below = heapPart(memory.find(base - 1));
            const above = heapPart(memory.find(end));
            for (const part of [below, above])
            {
                if (part)
                {
                    memory.unregister(part.name);
                }
            }
            const from = below?.base ?? base;
            memory.register({
                name: below?.name ?? `heap@${base.toString(16)}`, base: from,
                size: (above ? above.base + above.size : end) - from,
                kind: span.kind, access: span.access,
            });
        },
    };
    /**
     * The libraries an assembly of the engine's store carries in a version of
     * its own (`win32.faces`): laid out beside system32's of the same name.
     *
     * @type {Record<string, Record<string, any>>}
     */
    const faceTables = /** @type {any} */ (win32).faces?.() ?? {};
    engineCode.open(MODULE_BASE);
    /** @type {any} */ (win32).runtimeHeap?.();
    const systemModules = createSystemModules({
        loader, bridge, cpu, long, ordinalsOf, librarySpace, placeLibrary,
        atomicCode: (address, length)=>core.api('kernel').atomicCode(address, length),
        start: MODULE_BASE + ENGINE_CODE_BYTES, end: LIBRARIES_END, align: LIBRARY_ALIGN,
        clientFiles: options.win32?.steam?.clientFiles,
        reportDivergence: (api, detail)=>reportDivergence(api, detail),
        release: record=>releaseLibrary(record),
        // A module's bytes go into the process's memory when something first
        // imports or loads it: its span and its addresses are fixed now, in
        // the same order for every process, so an address taken before it is
        // loaded is the one that works after, and a translation of code that
        // calls it is the same in every process.
        later: true,
        // The same tables lay out the same: a layout an earlier process of
        // this runtime made is taken, and a module built only where placed.
        placing: place=>/** @type {any} */ (win32).placing?.(place) ?? place(),
        // Where a module's routines lie: each module's part of the engine's
        // span as laid out.
        engine: {
            at: ()=>engineCode.next,
            skipTo: to=>{
                engineCode.next = Math.max(engineCode.next, to);
                memory.reach?.(engineCode.next);
            },
            within: (from, to, place)=>engineCode.within(from, to, place),
        },
        traps: cpu.trapLayout,
        fingerprint: tablesFingerprint(Object.keys(allLibraries), faceTables, ordinalsOf,
            { long, start: MODULE_BASE, end: LIBRARIES_END,
                windows: JSON.stringify(options.windows ?? null) }),
    });
    const { leftOutAt64 } = systemModules;
    builtLibraries = allLibraries;
    for (const name of Object.keys(allLibraries))
    {
        const record = systemModules.build(name, ()=>allLibraries[name]);
        modules.add(record, moduleKeyOf(name));
    }
    /**
     * The libraries an assembly of the engine's store carries in a version of
     * its own (`win32.faces`), by key: a module beside system32's of the same
     * name, found by no bare name, bound where a context puts the name in
     * that assembly (`faceFor`).
     *
     * @type {Map<string, any>}
     */
    const faces = new Map();
    for (const [name, table] of Object.entries(faceTables))
    {
        // Beside system32's library of the same name, so its region is its own.
        const record = systemModules.build(name, table, `${name} (assembly)`);
        modules.add(record, null);
        faces.set(moduleKeyOf(name), record);
    }
    systemModules.done();
    /**
     * The face a load of `name` binds: where a context redirects the name to
     * an assembly of the engine's (no file of its own, `source` null), that
     * assembly's own version of the library, seen at the assembly's directory.
     *
     * @param {string} name
     * @param {{ path: string, source: string | null } | null} redirected
     */
    const faceFor = (name, redirected)=>{
        const face = redirected?.source === null ? faces.get(moduleKeyOf(name)) : undefined;
        if (!face)
        {
            return null;
        }
        face.path ??= redirected?.path;
        return face;
    };
    /**
     * The library a bare name is under the running thread's context and the
     * process default: a face where one redirects it, else the name's own.
     *
     * @param {string | null} name
     */
    const moduleUnderContext = name=>(name && !/[\\/]/.test(name)
        ? faceFor(name, activation?.redirect(name) ?? null) : null) ?? findModule(name);
    for (const name of ALWAYS_LOADED)
    {
        markLoaded(modules.named(name));
        const always = modules.named(name);
        if (always)
        {
            always.pinned = true;
        }
    }

    // Imports resolved, libraries loaded and let go at run time, files loaded
    // as data (`process/library-loader.js`).
    const libraryLoader = createLibraryLoader({
        allLibraries, win32, events, journal, moduleUnderContext, markLoaded, findModule,
        modules, options, bridge, cpu, memory, kernel, freeLocalIndex, giveBackBlocks,
        threadLocalImages, dllNotifications, processBits, debuggerNow, attachOrder, librarySpace,
        isKnownDll, answersPath, activation, filesystem, faceFor, loader, dataFiles, standsAt,
        threadBlocks: ()=>threadBlocks,
        blocks: ()=>blocks,
    });
    const {
        resolveImport, missingImport, loadLibraryAtRuntime, exportOf, loadErrors, broughtCopies,
        systemLibraries, releaseLibrary, installWatch, windowsLibraries, missingCalls, watches,
    } = libraryLoader;

    // An image in the heap's span takes its place there before anything else
    // can: the heap has handed nothing that high out yet, and a library placed
    // anywhere would otherwise be free to take it.
    if (imageInHeap
        && librarySpace.claim(mainImage.imageBase, mainImage.sizeOfImage) !== mainImage.imageBase)
    {
        throw new Error(`image: 0x${mainImage.imageBase.toString(16)}+0x`
            + `${mainImage.sizeOfImage.toString(16)} lies in the heap and is not free there`);
    }
    // A wide window's image past 4 GiB: its span at the low dword kept from everything
    // else, where the host reads a pointer into the image it was handed the low half of
    // (the cpu's `hostAlias`).
    const aliasAt = programLoaded.wide === undefined || programLoaded.wide.codeBase === 0 ? null
        : programLoaded.imageBase % 2 ** 32;
    if (aliasAt !== null && librarySpace.claim(aliasAt, programLoaded.sizeOfImage) !== aliasAt)
    {
        throw new Error(`image: its low dword's span 0x${aliasAt.toString(16)}+0x`
            + `${programLoaded.sizeOfImage.toString(16)} is not free below 4 GiB`);
    }
    if (aliasAt !== null)
    {
        // A region of its own, so the host's accesses there pass the map; the image's
        // pages keep their own protection at its real address.
        memory.register({ name: 'image (low dword)', base: aliasAt,
            size: programLoaded.sizeOfImage, kind: memory.RegionKind.RESERVED,
            access: memory.Access.READ_WRITE_EXECUTE });
    }

    // A managed program on a machine with no Framework that runs it: the
    // embedder is asked for the layer that carries one. The program goes on,
    // as it would on that machine, until a start with the layer under it.
    const neededLayer = frameworkNeeded(options.executable,
        path=>{
            try
            {
                const entry = filesystem.stat(path);
                return Boolean(entry) && !entry.directory;
            }
            catch {
                return false;
            }
        }, WINDOWS_DIRECTORY);
    if (neededLayer !== null)
    {
        events.emit('layer-needed', { layer: neededLayer, program: options.imagePath ?? null });
    }

    // The program's activation context, before any library is looked for:
    // the assemblies its manifest names decide where some of them are, and a
    // context that cannot be built -- an assembly found nowhere -- ends the
    // start, as Windows ends it.
    const unbuilt = await activation?.processDefaultFrom(
        resourceOfImage(options.executable, RT_MANIFEST, 1), options.imagePath ?? 'C:\\app.exe')
        ?? null;
    if (unbuilt !== null)
    {
        events.emit('activation-context-failed', { reason: unbuilt });
        throw Object.assign(new Error(`the side-by-side configuration is incorrect: ${unbuilt}`),
            { reason: 'side-by-side', code: 'SXS_CANT_GEN_ACTCTX' });
    }

    // The libraries the program brought with it, before the program itself.
    //
    // Every one is mapped before any is bound, because they import each other:
    // binding the first needs the second's exports, which need the second's
    // base. And they are bound after the program is mapped and known by name,
    // because a library may import from the program that loads it.
    /**
     * The static imports found nowhere: the process is created and ends in its
     * first thread with STATUS_DLL_NOT_FOUND, before anything of it runs.
     * @type {string[]}
     */
    let refusedLibraries = [];
    const shipped = await mapShippedLibraries({
        onAbsent: (/** @type {string[]} */ names)=>{
            refusedLibraries = names;
        },
        executable: options.executable,
        bits: processBits,
        windows: windowsVersion(options.windows),
        imagePath: options.imagePath ?? 'C:\\app.exe',
        filesystem, loader, blocks, events,
        isSystem: (/** @type {string} */ name)=>findModule(name) !== null,
        // A table of ours stands in for a copy in the system directories only
        // when it has everything the importer takes from it. One that lacks
        // some -- a C++ runtime's wide strings -- gives way to the copy an
        // installation put in the Windows directory, which is where Windows
        // would have found it.
        covers: (/** @type {string} */ name, /** @type {any[]} */ wanted)=>{
            const table = findModule(name);
            return table !== null && wanted.every(entry=>(entry.name !== null
                ? table.addressOf(entry.name) : table.addressOfOrdinal(entry.ordinal)) !== null);
        },
        isKnownDll,
        redirect: (/** @type {string} */ name)=>activation?.redirect(name) ?? null,
        // Where else Windows looks for a program's imports: its current
        // directory and the PATH it starts with - its parent's, or for a
        // session's first program the one the registry builds.
        currentDirectory: filesystem.currentDirectory(),
        path: pathDirectories(Object.entries(options.environment ?? win32.environment?.() ?? {})
            .find(([variable])=>variable.toUpperCase() === 'PATH')?.[1]),
        modules,
        // Straight after the system modules, which is the first address nothing
        // else has claimed, and up to the pool of thread stacks.
        base: systemModules.end(),
        ...librarySpace,
    });
    // Where a library asked for later goes: after the ones that came with the
    // program, or after the system modules when there were none.
    libraryLoader.nextLibraryBase = shipped.reduce(
        (highest, library)=>Math.max(highest, library.base + library.size), systemModules.end());

    const image = loader.load(options.executable, { resolveImport, missing: missingImport,
        bits: processBits,
        ...long || programLoaded.moved ? { base: programLoaded.imageBase } : {} });
    win32.imageMapped(image.base);

    // An executable exports too: a library a program ships imports from the
    // program that loads it, by name or by ordinal, and is bound to those
    // addresses the way it is bound to any other module's.
    //
    // Read out of the mapping when asked, as Windows reads them, never out of
    // the file at load: an executable may carry its table encoded and write it
    // out in place before it asks for its own exports. Read again whenever the
    // directory's head has changed since; one the image could not hold is no
    // exports at all, said once.
    const ownImage = parsePe(options.executable, { wide: true });
    imageInformation = ()=>sectionImageInformation({ file: options.executable, image: ownImage,
        bytes: memory.readBytes(image.base, ownImage.sizeOfImage) });
    const ownDirectory = ownImage.directories[DIR_EXPORT];
    /** @type {({ head: string } & ReturnType<typeof exportTables>) | null} */
    let ownTable = null;
    let ownRefusal = '';
    const ownExports = ()=>{
        if (!ownDirectory || ownDirectory.size === 0)
        {
            return null;
        }
        const head = [...memory.readBytes(image.base + ownDirectory.address, 40)].join(',');
        if (ownTable?.head !== head)
        {
            const parsed = parseExportDirectory((rva, length)=>(rva >= ownImage.sizeOfImage ? null
                : memory.readBytes(image.base + rva, Math.min(length, ownImage.sizeOfImage - rva))),
            ownDirectory);
            if (parsed.refused !== null && parsed.refused !== ownRefusal)
            {
                ownRefusal = parsed.refused;
                events.emit('exports-refused', { name: mainModule.path, reason: parsed.refused });
            }
            ownTable = { head, ...exportTables(parsed.exports, image.base) };
        }
        return ownTable;
    };
    mainModule = {
        name: 'app.exe',
        base: image.base,
        // What GetModuleHandleEx finds an address of the program's own in
        // (`modules.containing`): without it every such address was nobody's,
        // and a loader stub that asks after its own module gave up there.
        size: ownImage.sizeOfImage,
        /** @param {string} exported */
        addressOf: exported=>ownExports()?.addressOf(exported) ?? null,
        /** @param {number} ordinal */
        addressOfOrdinal: ordinal=>ownExports()?.addressOfOrdinal(ordinal) ?? null,
        /** @param {string | null} exported @param {number | null} ordinal */
        forwardOf: (exported, ordinal)=>ownExports()?.forwardOf(exported, ordinal) ?? null,
        // A program reads its own resources where it lies mapped
        // (`resourceLookup`), as Windows reads them: no copy of its file.
        fromFile: true,
        image: ownImage,
        // The same answer whether a program asks by null handle or by its own
        // image base, which are the two ways of asking the same question. A
        // program that asks the second way and is told a system directory goes
        // looking for its own data there.
        path: options.imagePath ?? 'C:\\app.exe',
    };
    // Known by its file name as well: a program that loads or asks for a
    // handle to its own image by name -- the way it reaches its own resources
    // -- is handed the mapping it is running from, as Windows hands back a
    // module already loaded, rather than a second copy at the one base an
    // image without relocations can take.
    modules.setMain(mainModule, moduleKeyOf(mainModule.path));
    for (const library of shipped)
    {
        loader.bind(library.mapped, resolveImport, missingImport);
        loader.bindDelayed(library.mapped, resolveImport, missingImport);
        win32.imageMapped(library.base);
        // Bound and written: the guest's copy is the image from here on, and
        // holding the file and the mapped image beside it was each library
        // twice over in the engine's heap for the life of the process.
        library.mapped = null;
    }

    // Somewhere to put what a process needs before it starts: thread-local
    // blocks, and the stub that sets them up -- and, ahead of that, a site
    // hook's trampoline, which needs guest heap room before TLS does. Its own
    // span rather than the guest heap, because the heap is the program's and
    // this is written before the program exists to allocate from it.
    const STARTUP_ARENA = 0x100000;
    // After the libraries, like one more of them -- and so only where one
    // would fit: below the thread stacks and on nothing mapped. When the
    // libraries reach the stacks, any gap in the modules' space will do.
    const arenaSpan = { relocatable: true, imageBase: 0, sizeOfImage: STARTUP_ARENA };
    let arenaPlace = placeLibrary(arenaSpan,
        { next: libraryLoader.nextLibraryBase, ...librarySpace });
    if ('refused' in arenaPlace)
    {
        arenaPlace = placeLibrary(arenaSpan, {
            ...librarySpace,
            next: Math.ceil(librarySpace.floor / LIBRARY_ALIGN) * LIBRARY_ALIGN,
        });
    }
    if ('refused' in arenaPlace)
    {
        throw new Error('no room below the thread stacks for what the process needs to start');
    }
    const startupArena = arenaPlace.base;
    memory.register({
        name: 'process-startup', base: startupArena, size: STARTUP_ARENA,
        // Executable because the stub that runs before the program lives here
        // too, and it is guest code.
        kind: memory.RegionKind.THUNK_CODE, access: memory.Access.READ_WRITE_EXECUTE,
    });
    libraryLoader.nextLibraryBase = Math.max(libraryLoader.nextLibraryBase,
        startupArena + STARTUP_ARENA);

    let scratch = startupArena;
    /** @param {number} size */
    const allocateFromHeap = size=>{
        const at = scratch;
        // Aligned, because a thread-local block holds whatever the compiler put
        // in it and some of that wants alignment the program never restates.
        scratch += size + 15 & ~15;
        if (scratch > startupArena + STARTUP_ARENA)
        {
            throw new Error('process startup needs more room than it was given');
        }
        return at;
    };

    // How many calls a site kernel issued through `frame.gl` -- read by the
    // diagnostics below whether or not this run binds any sidecar at all, so
    // it always answers a number rather than being missing from the report.
    const glCounters = { calls: 0 };

    await bindSidecar({
        allocateFromHeap, bridge, core, events, glCounters, image, journal, journalCall,
        libraryLoader, loader, memory, modules, options,
        mainModule: ()=>mainModule,
    });

    const stubs = cpu.thunkImage();
    memory.register({
        // Sized to what the table may grow to rather than to what it holds
        // now. Slots go on being taken for the life of the process -- one per
        // method of every COM interface a program asks for, one per import
        // nothing claims -- and each is written straight into the guest, which
        // needs somewhere inside the map to write to.
        name: 'thunks', base: thunkBase, size: cpu.layout.thunkCapacity,
        kind: memory.RegionKind.THUNK_CODE, access: memory.Access.READ_WRITE_EXECUTE,
    });
    memory.writeBytes(thunkBase, stubs);
    // Read-execute from the guest's side. Later slots are written from ours,
    // which does not go through this permission -- so a guest writing here is
    // still corruption and is still refused.
    memory.protect('thunks', memory.Access.READ_EXECUTE);

    // Thread-local storage, for every image that declares any.
    //
    // Each image is given its index in the thread-local array here, in load
    // order with the program's own first, so the program's is 0 as on Windows
    // -- an image may be compiled to reach its variables at index 0 without
    // reading the _tls_index written for it. The block is filled here too; the
    // stub puts it in the first thread's array.
    let nextLocal = 0;
    const withTls = [mainModule, ...shipped].map(held=>{
        const directory = held.fromFile && held.image
            ? readMappedTls((rva, length)=>memory.readBytes(held.base + rva, length),
                held.image, held.base) : null;
        if (!directory)
        {
            return held;
        }
        const size = directory.templateSize + directory.zeroFillSize;
        const blockAddress = allocateFromHeap(size);
        memory.writeBytes(blockAddress, new Uint8Array(size));
        memory.writeBytes(blockAddress, directory.template);
        const index = nextLocal++;
        memory.writeU32(held.base + directory.indexRva, index);

        return {
            ...held,
            tls: {
                index,
                blockAddress,
                callbacks: directory.callbackRvas.map(rva=>held.base + rva),
                template: directory.template,
                size,
            },
        };
    });
    // Every later thread's blocks are copies of the same templates, at the
    // indices the first thread's were given (`threadLocals`). Without them a
    // thread's thread-local variables were at linear address zero and up, the
    // same bytes for every thread but the first: Call of Duty 4's renderer and
    // its two workers kept their scratch buffers' pointers there, and a worker
    // culled shadow casters into lists another was filling.
    for (const held of withTls)
    {
        if (held.tls)
        {
            const { index, template, size, callbacks } = held.tls;
            threadLocalImages.set(held.base, { index, template, size, callbacks });
        }
    }

    // Every library the program brought with it is attached before the program
    // runs, on the process's first thread, in dependency order -- which is what
    // a real loader does and where a library expects to build the state its
    // exports assume. It is guest code because the calls belong on a guest
    // stack; the stub's last instruction enters the program.
    const kernel32 = findModule('kernel32');
    // RTL_CRITICAL_SECTION, free: LockCount -1 and nothing else. Its first
    // field is a pointer, so the count is past eight bytes in a 64-bit
    // process, and the whole is 40 bytes there.
    const pointerSize = long ? 8 : 4;
    loaderLock = allocateFromHeap(long ? 40 : 24);
    memory.writeBytes(loaderLock, new Uint8Array(long ? 40 : 24));
    memory.writeU32(loaderLock + pointerSize, 0xffffffff);
    const enter = kernel32?.addressOf('EnterCriticalSection') ?? 0;
    const leave = kernel32?.addressOf('LeaveCriticalSection') ?? 0;
    // A session is a logon: its first process runs the RunOnce pass before
    // anything of its own, as Explorer does before the desktop is the user's
    // (an installation leaves a library's registration there for it).
    // A child its parent debugs reports its start before anything of it runs
    // (`debug-events.js`), as Windows' loader does: the process, every library
    // mapped with it, then the loader's breakpoint - an int3 of its own, not
    // DbgBreakPoint - each waited on until the debugger continues it.
    const debugStart = debuggerNow() && !long ? bridge.register('<debug start>', {
        argBytes: 0,
        handler: async()=>{
            const report = /** @type {NonNullable<typeof options.debugger>} */ (
                options.debugger).report;
            const threadId = kernel.currentThread()?.id >>> 0;
            await report({ code: DEBUG_EVENT.CREATE_PROCESS, threadId, base: image.base,
                start: image.entryPoint });
            for (const held of modules.all())
            {
                if (held !== mainModule && held.loaded !== false)
                {
                    await report({ code: DEBUG_EVENT.LOAD_DLL, threadId, base: held.base });
                }
            }
            const breakpoint = allocateFromHeap(1);
            memory.writeBytes(breakpoint, new Uint8Array([0xcc]));
            debugStarted = true;
            await report({ code: DEBUG_EVENT.EXCEPTION, threadId, exception: {
                code: EXCEPTION_BREAKPOINT, flags: 0, address: breakpoint, parameters: [0],
                firstChance: true } });
            return 0;
        },
    }) : 0;
    const prelude = debugStart || (options.parentProcessId
        ? 0 : findModule(PROGRAMS_LIBRARY)?.addressOf(RUN_ONCE_ROUTINE) ?? 0);
    const startup = synthesiseProcessInit({
        libraries: withTls.filter(held=>held !== mainModule || held.tls),
        entryPoint: image.entryPoint,
        ...enter !== 0 && leave !== 0 ? { loaderLock: { address: loaderLock, enter, leave } } : {},
        long,
        prelude,
    });
    startupImages = [mainModule, ...shipped];
    for (const name of startup.attached)
    {
        const held = shipped.find(library=>library.name === name);
        if (held)
        {
            attachOrder.push(held);
        }
    }
    // Inside the same span the blocks came from, rather than beside it: it is
    // written once, before anything runs, and giving it a region of its own
    // only creates a boundary two allocations can land on either side of.
    const exitProcess = kernel32?.addressOf('ExitProcess') ?? 0;
    let start = image.entryPoint;
    if (refusedLibraries.length > 0 && exitProcess !== 0)
    {
        // Nothing of the program runs, no library is attached: the first
        // thread's one act is the loader's refusal, as on Windows (A256).
        const refusal = synthesiseStartRefused({ exitProcess, status: STATUS.DLL_NOT_FOUND,
            long });
        start = allocateFromHeap(refusal.length);
        memory.writeBytes(start, refusal);
        attachOrder.length = 0;
    }
    else if (startup.attached.length > 0 || startup.tlsImages > 0 || prelude !== 0)
    {
        start = allocateFromHeap(startup.bytes.length);
        memory.writeBytes(start, startup.bytes);
        events.emit('libraries-attached', {
            names: startup.attached,
            tlsImages: startup.tlsImages,
        });
    }

    // A quadword in long mode: a wide window's image starts past 4 GiB.
    if (long)
    {
        const vector = new Uint8Array(8);
        new DataView(vector.buffer).setBigUint64(0, BigInt(start), true);
        memory.writeBytes(entryVector, vector);
    }
    else
    {
        memory.writeU32(entryVector, start);
    }

    // What FS points at. A program reaches this in code its compiler emitted
    // rather than code anybody wrote -- a thread-local variable is an index off
    // FS:[0x2c], an exception handler's prologue writes FS:[0] -- so a thread
    // running without one reads linear address 0x2c, finds nothing, and carries
    // on with a null.
    const process = createProcessBlocks({
        allocate: allocateFromHeap,
        // GS's blocks in a 64-bit process, with its pointers a quadword each.
        pointerSize,
        // A thread's blocks from the allocator everything the host hands the
        // guest comes from, which takes them back when the thread is gone;
        // the startup span never does. Aligned for the thread-local blocks
        // among them, as the startup span aligns them.
        threadMemory: {
            allocate: bytes=>win32.heap().allocate(bytes, { alignment: 16 }),
            free: address=>win32.heap().free(address),
        },
        writeMemory: (address, bytes)=>memory.writeBytes(address, bytes),
        processId: options.processId ?? FIRST_PROCESS_ID,
        version: windowsVersion(options.windows),
        // One for each executor, as every other road to the count says.
        processors: kernel.processors?.() ?? 1,
        // PEB->LoaderLock: the section the loader holds around a DLL's
        // initialisation (`init.js`), which a program reads to ask who holds it.
        loaderLock,
        imageBase: image.base,
        processHeap: allLibraries['KERNEL32.dll']?.GetProcessHeap?.handler([]) ?? 0,
        imagePath: options.imagePath ?? 'C:\\app.exe',
        // Quoted, and this is not cosmetic: a program is handed one string and
        // argv[0] ends at the first space, so an unquoted path with a space in
        // it hands the rest of the path to the program as its first argument.
        // A line chosen by whoever started this process wins, because a child
        // is entitled to the arguments its parent gave it.
        commandLine: options.commandLine ?? `"${options.imagePath ?? 'C:\\app.exe'}"`,
        currentDirectory: filesystem.currentDirectory(),
        // The standard handles its parent handed it, which RTL_USER_PROCESS_
        // PARAMETERS carries as GetStdHandle answers them; none otherwise.
        standardHandles: { input: handed.standard?.input ?? 0,
            output: handed.standard?.output ?? 0,
            error: handed.standard?.error ?? 0 },
        // Every module loaded by the time the first instruction runs: the
        // system libraries it imports and theirs, everything the program
        // shipped, and the program's own image -- PEB->Ldr walked before a
        // program calls a single import of its own finds all of them, never
        // an empty list. A system library loaded later joins it then.
        modules: modules.loaded()
            .map(held=>held === mainModule ? {
                ...held, entryPoint: image.entryPoint, size: mainModule.image.sizeOfImage,
            } : held),
    });
    threadBlocks = process;
    for (const held of withTls)
    {
        if (held.tls)
        {
            process.hasThreadLocals(held.base);
        }
    }
    // What IsDebuggerPresent reads: a debuggee's process block says so.
    if (debuggerNow())
    {
        memory.writeBytes(process.peb + blockLayouts(pointerSize).peb.BEING_DEBUGGED,
            new Uint8Array([1]));
    }

    // The page every NT process reads at 0x7FFE0000 without a call: the same
    // version as every other road, and the clocks GetTickCount answers with.
    // In a RAM short of 0x7FFE0000 the page is kept where the engine's
    // untested reads find it: an engine that wraps elsewhere would have the
    // program read the heap there, so it stops the start instead.
    // In a memory that grows (`engineArea`) the page is where the engine
    // wraps 0x7FFE0000 into the RAM it holds now, and moves up with it.
    const growing = cpu.growing?.() === true;
    if (growing)
    {
        // The page is kept 128 KiB short of the RAM held, so the RAM held from
        // the start reaches that far past the thread stacks and a program image
        // in the heap's span: what is handed out from neither goes through the
        // heap, which keeps clear of the page itself (`SHARED_PAGE_GUARD`).
        const placed = Math.max(STACK_POOL_BASE + STACK_POOL_SIZE,
            imageInHeap ? mainImage.imageBase + mainImage.sizeOfImage : 0);
        memory.reach?.(placed + (0x80000000 - SHARED_USER_DATA));
    }
    // A wide window's RAM reaches 0x7FFE0000 itself: the page is where Windows has it.
    let sharedAt = growing ? cpu.wrappedAddress(SHARED_USER_DATA)
        : programLoaded.wide !== undefined ? SHARED_USER_DATA : sharedPageAt(memorySize);
    const wrapped = cpu.wrappedAddress?.(SHARED_USER_DATA) ?? null;
    if (wrapped !== null && wrapped !== sharedAt)
    {
        throw new Error(`kernel32: the engine reads 0x7FFE0000 at 0x${wrapped.toString(16)},`
            + ` the shared page is kept at 0x${sharedAt.toString(16)}`);
    }
    const version = windowsVersion(options.windows);
    // Inside the heap's span (a memory that grows, a wide window's heap to 4 GiB) the
    // page is no region of its own; past the heap's end it is one.
    /** @param {number} at */
    const ownsPlace = at=>memory.find(at) === undefined;
    let sharedOwn = ownsPlace(sharedAt);
    let sharedData = createSharedUserData({ memory, version, at: sharedAt,
        ownRegion: sharedOwn });
    const refresh = ()=>sharedData?.refresh(kernel.clock.virtualTime(),
        kernel.clock.wallClock());
    if (sharedData)
    {
        refresh();
        kernel.clock.whenMoved(refresh);
    }
    if (growing)
    {
        // The engine's range is the engine's: nothing is mapped there.
        const range = cpu.engineRange();
        memory.register({ name: 'engine', base: range.from, size: range.to - range.from,
            kind: memory.RegionKind.THUNK_DATA, access: memory.Access.NONE });
        cpu.onGrow(()=>{
            const at = cpu.wrappedAddress(SHARED_USER_DATA);
            if (at === sharedAt || !sharedData)
            {
                return;
            }
            // Its old place becomes the heap's: left as zeros, as arena never
            // handed out is. A region of its own is given back instead.
            if (sharedOwn)
            {
                memory.unregister(KUSER_REGION);
            }
            else
            {
                memory.writeBytes(sharedAt, new Uint8Array(KUSER.SIZE));
            }
            sharedAt = at;
            sharedOwn = ownsPlace(at);
            sharedData = createSharedUserData({ memory, version, at, ownRegion: sharedOwn });
            refresh();
        });
    }

    /**
     * Takes back what the loader wrote into the process that Windows writes
     * only once the process runs, and answers the work that puts it back.
     * 32-bit only: a 64-bit process keeps it all from its creation.
     *
     * @returns {() => void}
     */
    const holdLoaderState = ()=>{
        if (long)
        {
            return ()=>{};
        }
        const fields = blockLayouts(pointerSize).peb;
        /** @type {[number, Uint8Array, Uint8Array][]} each place, as built, as held */
        const held = [
            [process.peb + fields.LDR, 4],
            [process.peb + fields.PROCESS_HEAP, 4],
            // CSDVersion's UNICODE_STRING: its lengths and its buffer.
            [process.peb + fields.CSD_VERSION, 8],
        ].map(([at, size])=>[at, memory.readBytes(at, size), new Uint8Array(size)]);
        for (const { entries } of readImports(options.executable, ownImage))
        {
            for (const { iatRva } of entries)
            {
                const offset = rvaToFileOffset(ownImage, iatRva);
                held.push([image.base + iatRva, memory.readBytes(image.base + iatRva, 4),
                    options.executable.slice(offset, offset + 4)]);
            }
        }
        for (const [at, , before] of held)
        {
            memory.writeBytes(at, before);
        }
        return ()=>{
            for (const [at, built] of held)
            {
                memory.writeBytes(at, built);
            }
        };
    };

    // The program's first thread. Everything after this runs under the
    // scheduler, including the main thread -- there is no privileged path.
    // Its id the one the parent was told, for a child.
    const mainThread = kernel.createThread({
        entry: start,
        stackTop: initialStack,
        stackLimit: initialStack - stackSize,
        name: 'main',
        id: options.mainThreadId,
        // A program whose entry point returns ends as one that called
        // ExitThread with its answer, as Windows' process start routine sees to.
        returnTo: win32.threadReturn(),
        first: { entry: image.entryPoint, block: process.peb },
    });
    // CREATE_SUSPENDED: the process is there, and nothing of it runs -- not
    // its libraries' initialisers either, which run on this thread -- until
    // its parent's ResumeThread reaches it.
    if (options.suspended)
    {
        kernel.suspendThread(mainThread);
    }
    // What the loader leaves in a process is put there by its first thread to
    // run, as Windows' loader initialises a process inside it (LdrInitializeThunk):
    // a parent that reads a suspended child finds the program's import slots
    // as its file has them and no module list, heap or service pack in its
    // process block yet. The engine binds and builds all of it here, before
    // the process runs; held back until its first slice, it is the same work
    // in the same order, only seen when Windows would show it.
    kernel.beforeFirstSlice(holdLoaderState());
    // Its thread-local blocks are the ones the startup stub hands TlsSetValue.
    holdBlock(mainThread, process.createThreadBlock({
        id: mainThread.id,
        stackBase: initialStack,
        stackLimit: initialStack - stackSize,
    }));

    /** The mixer, when this build has one. Read once; it does not change. */
    const sound = core.api('audio')?.output?.() ?? null;

    /**
     * Whether anything is reading the other end of the ring.
     *
     * A track's play position is what the device consumed, so with nothing
     * consuming there is no position to report -- and a film paced by one that
     * never moves would be a still picture.
     */
    const soundIsHeard = core.api('audio')?.available?.() === true;

    /**
     * Where a film's frames go, and its sound.
     *
     * The graph decodes and hands a frame back; showing one is this layer's
     * business because win32 may not reach graphics. The pixels are copied into
     * guest memory rather than handed over as a view: presenting takes a
     * surface the guest owns, which is also what a real video renderer writes
     * into -- the window's own bits.
     *
     * @type {{ address: number, bytes: number, pixels: Uint8Array } | null}
     */
    let filmSurface = null;

    /**
     * The track a film's sound goes to, opened at the film's own rate, with
     * everything ever written to it -- which, less what has been played, is how
     * much sound the picture is ahead of.
     */
    /** @type {{ track: any, sampleRate: number, channels: number,
     *           ledger: FilmSoundLedger } | null} */
    let filmTrack = null;

    /** Which film that track is playing, so that the next one gets a fresh one. */
    let filmPlaying = 0;
    /** When a film last handed anything over: one that did, recently, is still owed ticks. */
    let filmTickedAt = -Infinity;
    const FILM_ACTIVE_MS = 500;

    /**
     * Milliseconds of the running film's sound handed over and not played yet.
     *
     * The graph holds the picture back while more is owed than a film may lead
     * its sound by, which is what keeps the two together. Null wherever nobody
     * can say: no mixer, nothing draining it, or a film that has yet to hand
     * over a first block of sound -- and then nothing holds the picture back.
     *
     * @returns {number | null}
     */
    const filmSoundOwedMs = ()=>(sound && filmTrack && soundIsHeard
        ? filmSoundOwed(filmTrack.ledger, filmTrack.track.played()) * 1000 / sound.sampleRate
        : null);

    /**
     * Why a decoded frame did not reach the screen.
     *
     * One counter per way out, because "the film decoded and nothing was shown"
     * is five different faults wearing the same face, and a report that only
     * says nothing arrived cannot tell them apart.
     */
    const film = {
        ticks: 0, frames: 0, silent: 0, hidden: 0, offScreen: 0, noScreen: 0, noRoom: 0,
        shown: 0,
        // How far the picture is ahead of the sound, in milliseconds of the
        // film's own timeline. A film has one timeline and two ways to advance
        // along it, and nothing else in a report says whether they agree.
        driftMs: 0, worstDriftMs: 0, soundMs: 0, queuedMs: 0,
        // The film's sound waiting for room in its track, now and at most.
        heldMs: 0, worstHeldMs: 0,
    };

    /** @param {{ hwnd: number, width: number, height: number, bgra: Uint8Array | null,
     *            window?: { left: number, top: number, width: number, height: number,
     *                       visible: boolean, fullScreen: boolean },
     *            audio: Int16Array[], sampleRate: number, channels: number,
     *            positionMs: number, film: number } | null} shown */
    /** @param {any} shown  What a filter graph handed back for this tick. */
    const showVideoFrame = shown=>{
        // Sound held for want of room goes in as the track drains, tick by
        // tick, whether or not this one brought anything.
        if (filmTrack && sound)
        {
            feedFilmSound(filmTrack.track, [], filmTrack.channels, filmTrack.ledger);
        }
        if (!shown)
        {
            return;
        }
        film.ticks++;
        filmTickedAt = clockSource();
        if (shown.film !== filmPlaying)
        {
            // A new film gets a track of its own: what the last one left queued
            // is not played over it, and the position its picture follows
            // starts again at zero rather than at the end of the one before.
            filmPlaying = shown.film;
            filmTrack?.track.close();
            filmTrack = null;
        }
        if (shown.audio.length > 0 && sound)
        {
            // A film carries its own rate and its own channel count, and they
            // are not the device's: a track opened at the wrong one plays the
            // whole cinematic at the wrong pitch.
            if (!filmTrack || filmTrack.sampleRate !== shown.sampleRate
                || filmTrack.channels !== shown.channels)
            {
                filmTrack = {
                    track: sound.open({
                        sampleRate: shown.sampleRate,
                        channels: shown.channels,
                        bitsPerSample: 16,
                    }),
                    sampleRate: shown.sampleRate,
                    channels: shown.channels,
                    ledger: { taken: 0, held: [], heldBytes: 0,
                        framesPerByte: sound.sampleRate / shown.sampleRate / (shown.channels * 2) },
                };
            }
            feedFilmSound(filmTrack.track, shown.audio, shown.channels, filmTrack.ledger);
        }
        if (filmTrack && sound)
        {
            film.heldMs = Math.round(filmTrack.ledger.heldBytes * filmTrack.ledger.framesPerByte
                * 1000 / sound.sampleRate);
            film.worstHeldMs = Math.max(film.worstHeldMs, film.heldMs);
            film.soundMs = Math.round(filmTrack.track.played() * 1000 / sound.sampleRate);
            film.queuedMs = Math.round(filmSoundOwedMs() ?? 0);
            film.driftMs = Math.round(shown.positionMs) - film.soundMs;
            film.worstDriftMs = Math.max(film.worstDriftMs, film.driftMs);
        }
        if (!shown.bgra)
        {
            film.silent++;
            return;
        }
        film.frames++;
        if (!isShown(shown))
        {
            film.hidden++;
            return;
        }
        const screen = core.api('graphics');
        if (!screen?.present)
        {
            film.noScreen++;
            return;
        }
        // On the screen the program asked for, never on one the size of the
        // film. A cinematic is authored at its own dimensions and they are
        // rarely the display's -- letting them through resizes the surface
        // everything else is drawn on, and a display does not change shape
        // because a film started. So a film with the screen to itself is
        // fitted into it and centred, with the margins left black, which is
        // what a video renderer does with a destination rectangle it does not
        // fill; one whose video window the program placed in a window of its
        // own goes where SetWindowPosition put it inside that window's client
        // area, and is shown as that window's picture.
        const shape = screen.screen();
        const width = shape.width;
        const height = shape.height;
        const placement = placementOf(shown,
            (/** @type {number} */ hwnd)=>win32.clientRect(hwnd), shape);
        if (placement && !placement.visible)
        {
            film.offScreen++;
            return;
        }
        const needed = width * height * 4;
        if (!filmSurface || filmSurface.bytes < needed)
        {
            const address = win32.heap().allocate(needed);
            if (address === 0)
            {
                film.noRoom++;
                return;
            }
            filmSurface = { address, bytes: needed, pixels: new Uint8Array(needed) };
        }
        film.shown++;
        const surface = filmSurface;
        if (placement)
        {
            stretchFrame(shown, surface.pixels, width, height, placement);
        }
        else
        {
            fitFrame(shown, surface.pixels, width, height);
        }
        memory.writeBytes(surface.address, surface.pixels);
        screen.present({
            buffer: surface.address,
            width,
            height,
            pitch: width * 4,
            bitCount: 32,
            palette: null,
        }, placement ? shown.hwnd >>> 0 : 0);
    };

    /** The guest's own clock, and the host clock it is credited from. */
    const clock = core.api('kernel').clock;
    const clockSource = ()=>Date.now();
    /**
     * Longer than this between two credits is a stall, not the program's time.
     * Generous next to a turn -- a slice is a few milliseconds and a yield less
     * -- and short next to anything a person would notice as the page hanging.
     */
    const CLOCK_CREDIT_CAP_MS = 250;
    const creditClock = clockCredit(clockSource, clock, CLOCK_CREDIT_CAP_MS);
    kernel.refreshClockWith?.(()=>creditClock());
    // A wait whose object another process of the run may set is sat through
    // in real time, not skipped to its deadline (`othersRunningWith`).
    kernel.othersRunningWith?.(()=>options.othersRunning?.() ?? false);
    // Callers parked on the guest's own queue are suspended calls too, answered
    // at the look each turn gives them.
    kernel.hostAnsweringWith?.(()=>bridge.waitingOnHost() > idlers.value.length);

    const breathe = createMacrotask();
    const jsSampler = options.sampleJs ? createJsSampler() : null;
    const pacing = options.pacing ?? pagePacing({
        macrotask: breathe,
        hidden: options.pageHidden ?? pageIsHidden,
    });

    /**
     * Wall milliseconds until the guest's own next deadline: the soonest of a
     * thread's timed wait, a queue timer, and -- while a film or a track is
     * open -- the next look a device needs. Null when it has none.
     */
    const nextDeadlineMs = ()=>{
        /** @type {number | null} */
        let soonest = null;
        for (const due of [kernel.nextDeadline(), win32.queue?.()?.nextTimerDue?.() ?? null])
        {
            if (due !== null && (soonest === null || due < soonest))
            {
                soonest = due;
            }
        }
        let wall = soonest === null ? null : Math.max(0, soonest - clock.virtualTime());
        const feeding = clockSource() - filmTickedAt < FILM_ACTIVE_MS
            || (sound?.diagnostics().tracks ?? 0) > 0;
        if (feeding && (wall === null || wall > DEVICE_LOOK_MS))
        {
            wall = DEVICE_LOOK_MS;
        }
        return wall;
    };

    /**
     * Pausing is a gate rather than a flag polled in a loop: a paused caller
     * waits on a promise that resuming resolves, so nothing spins.
     *
     * @type {{ gate: Promise<void>, open: () => void } | null}
     */
    let paused = null;
    /**
     * Stops handing out turns without ending anything; `resumeRun` continues
     * from the same place, since no thread's state was touched.
     */
    const pauseRun = ()=>{
        if (paused)
        {
            return;
        }
        /** @type {() => void} */
        let open = ()=>{};
        const gate = new Promise(resolve=>{
            open = ()=>resolve(undefined);
        });
        paused = { gate, open };
    };
    const resumeRun = ()=>{
        if (!paused)
        {
            return;
        }
        paused.open();
        paused = null;
    };

    // attachLog is sugar over the registry: the same subscription, remembered
    // by the sink the caller gave, so detaching still takes what it was given.
    // The map is handed in across a replacement: a subscription made before the
    // handover has to be removable after it, and a fresh map would forget it.
    /** @type {Map<Function, (payload: any) => void>} */
    const logSinks = options.logSinks ?? new Map();

    /**
     * Announces a failure the program itself cannot see, and hands back what to
     * throw. A handler may answer with an error of its own to throw instead.
     *
     * The trace is taken here rather than by whoever catches it: by then the
     * machine has moved on, and the registers that say where it went wrong are
     * gone. It is attached to the error too, so a caller that only catches the
     * throw still has it.
     *
     * @param {string} reason
     * @param {any} error
     * @returns {any}
     */
    const fail = (reason, error)=>{
        if (disposed.value)
        {
            // Whatever a turn under way met once its machine was gone is the
            // disposal, not a failure of the program: no trace, no event.
            return gone();
        }
        // The exception frame, when there is one. Without it the report names
        // the ROM stub the processor is standing in rather than the instruction
        // that faulted, and every register it prints is read from a machine
        // that has already left the scene.
        const trace = captureTrace({ cpu, memory, kernel, bridge,
            traced: ()=>layerTraces.slice(), fault: cpu.fault?.() ?? null });
        const text = formatTrace(trace);
        const thrown = error instanceof Error ? error : new Error(String(error));
        Object.assign(thrown, { reason, trace, traceText: text });
        return events.emit('error', { reason, error: thrown, trace, text }) ?? thrown;
    };

    /** This process's memory, once it has gone (`spareMemory`). @type {{ value: SpareMemory | null }} */
    const spare = { value: null };
    /**
     * Set by `dispose`: the machine under a run still turning is gone. A process
     * standing beside the program runs on a clock of its own, so the program's
     * end is not its loop's, and a loop left turning takes the thread from
     * whatever the page runs next.
     */
    const disposed = { value: false };
    const wasDisposed = ()=>disposed.value;
    /** What a run ends with then. No trace: there is no machine left to read one from. */
    const gone = ()=>Object.assign(new Error('the machine was disposed while its program ran'),
        { reason: 'disposed' });

    return processController({
        HEAP_BASE, STACK_POOL_BASE, allocateFromHeap, blocksSeen, breathe, bridge, bundleReads,
        clock, clockSource, core, cpu, creditClock, disposed, events, fail, filesystem, film,
        filmSoundOwedMs, findModule, foreground, glCounters, gone, guestHeld, idlers, image,
        input, installWatch, journal, jsSampler, kernel, layerTraces, leftOutAt64,
        lentTranslators, logSinks, mainThread, memory, missingCalls, modules, nextDeadlineMs,
        options, ownsTranslationStore, pacing, pauseRun, reportDivergence, resumeRun, saver,
        showVideoFrame, sound, spare, stopSavingRegistry, systemLibraries, translationStore,
        wasDisposed, watches, win32, windowsLibraries,
        // The machine its children run on: a system program's width there.
        machine: options.machine ?? (processBits === 64 ? 'amd64' : 'x86'),
        blocks: ()=>blocks,
        fetched: ()=>fetched,
        fetching: ()=>fetching,
        mainModule: ()=>mainModule,
        mountedBlocks: ()=>mountedBlocks,
        paused: ()=>paused,
    });
}

/**
 * What the tab holds before any program runs, on a machine of the run's
 * (`roadmap/decisions.md` A245): Chrome's renderer with the engine idle is
 * 357 MiB with one executor.
 */
const RUN_ENGINE_BYTES = 384 << 20;

/** Whether the run is in a browser's page or worker, where the machine is a tab. */
const inBrowser = ()=>typeof (/** @type {any} */ (globalThis).WorkerGlobalScope) === 'function'
    || typeof (/** @type {any} */ (globalThis).document) === 'object';

/**
 * How many CreateProcess requests are remembered, each with the guest's stack
 * at the call: a launcher that starts itself again in a loop would otherwise
 * leave nothing to say which call started which.
 */
const REPLACEMENT_HISTORY = 16;

/** The engine's own end-of-game box: MB_OK with MB_ICONINFORMATION. */
const EXIT_NOTICE_TYPE = 0x40;

/**
 * The table of the journal a machine writes on this thread: the system's,
 * where the program's own journal is in a worker and its table is `log`.
 *
 * @param {any[]} tables
 */
const journalOf = tables=>tables.find(table=>table.name === 'system-log')
    ?? tables.find(table=>table.name === 'log');

/**
 * What of a run's volume lives in memory every thread holds, where there is
 * shared memory: a word per drive letter, raised by every change to the
 * drive, under which a process in a worker of its own keeps what it read of
 * the drive; and the sharing every open is settled against, which that
 * process settles its own opens in (`volume-link.js`).
 *
 * @returns {{ revisions: Int32Array, sharing: any, sharingMemory: SharedArrayBuffer }}
 */
function volumeMemory(){
    const sharingMemory = createSharingMemory();
    return { revisions: new Int32Array(new SharedArrayBuffer(26 * 4)),
        sharing: openSharedSharing(sharingMemory), sharingMemory };
}

/**
 * Where an x86-64 program's image goes when the linker placed it above the
 * window: the 32-bit programs' own default base, which the address map below
 * it is laid out around (`roadmap/x64.md`: every guest page below 4 GiB).
 */
const LONG_IMAGE_BASE = 0x00400000;

/**
 * A wide window's RAM: the whole window less its last 64 KiB, which no RAM
 * reaches (`longLayout`). A memory that long is collected without end by
 * Chrome 157 and later (past 4 GiB a thread, 8 GiB in Chrome 153); whether a
 * program runs better there or in the 4 GiB layout is its launcher's to find
 * out, run by run, not a cap of the engine's.
 *
 * @param {number} window
 */
const wideRam = window=>window - 65536;

/**
 * The program's image headers, a 64-bit (PE32+) one included: one whose base
 * lies above 2 GiB is placed at `LONG_IMAGE_BASE`, which its relocations (or
 * its RIP-relative code, which needs none) allow, and every address its
 * process gives out stays below 2 GiB, where a dword sign-extended to a
 * quadword is the same address.
 *
 * One that carries no relocations stays where it was linked, past 4 GiB (a
 * game at 0x140000000): its process runs over a wide window (`wideWindowFor`),
 * its code the translator's in the 4 GiB block the image lies in, and every
 * other address the process gives out below 2 GiB as before (`wide`).
 *
 * @param {Uint8Array} executable
 * @param {{ hostMemory?: number, memorySize?: number }} [machine]  the host's memory in
 *     bytes, which a 16 GiB window needs 32 GB of; the program's RAM, past 4 GiB of which a
 *     64-bit program runs over a wide window wherever its image lies
 * A 32-bit program linked for ASLR with its base in the heap's span (mscorsvw.exe at
 * 0x10000000) is placed where a program usually is, 0x00400000, as Windows places such a one
 * anywhere: at its own base it made the memory of every process of it as large as its base,
 * 512 MiB for a few hundred kilobytes, the memory being as large as the highest address it
 * holds. One not linked for ASLR stays at its base, as Windows keeps it.
 *
 * @returns {import('./layers/loader/internal/pe.js').PeImage
 *     & { wide?: { window: number, codeBase: number, ram: number }, moved?: boolean }}
 */
function programImage(executable, machine = {}){
    const image = parsePe(executable, { wide: true });
    // A 64-bit program given more than 4 GiB of memory: a wide window, its code
    // in the first 4 GiB block, the image where any 64-bit image goes.
    if (image.bits === 64 && (machine.memorySize ?? 0) > 2 ** 32
        && (image.relocatable || image.imageBase + image.sizeOfImage <= 0x80000000))
    {
        return { ...image, ...image.imageBase + image.sizeOfImage > 0x80000000
            ? { imageBase: LONG_IMAGE_BASE } : {},
        wide: { window: 2 ** 33, codeBase: 0, ram: wideRam(2 ** 33) } };
    }
    if (image.bits === 32 && image.relocatable && image.dynamicBase
        && image.imageBase >= HEAP_FLOOR && 0x00400000 + image.sizeOfImage <= HEAP_FLOOR)
    {
        return { ...image, imageBase: 0x00400000, moved: true };
    }
    if (image.bits !== 64 || image.imageBase + image.sizeOfImage <= 0x80000000)
    {
        return image;
    }
    if (!image.relocatable)
    {
        const window = wideWindowFor(image, machine.hostMemory);
        if (window === null)
        {
            throw new Error(`image: an x86-64 program at 0x${image.imageBase.toString(16)} that`
                + ' carries no relocations needs a window this machine cannot give it');
        }
        return { ...image, wide: { window, codeBase: Math.floor(image.imageBase / 2 ** 32)
            * 2 ** 32, ram: wideRam(window) } };
    }
    return { ...image, imageBase: LONG_IMAGE_BASE };
}

/**
 * The window an image past 4 GiB without relocations runs over: 8 GiB where it
 * fits there, 16 GiB only on a host of 32 GB or more (the user's ruling: the
 * larger memory is committed whole), its code in one 4 GiB block of it; null
 * where none holds it.
 *
 * @param {{ imageBase: number, sizeOfImage: number }} image
 * @param {number} [hostMemory]  the host's memory in bytes, when known
 * @returns {number | null}
 */
export function wideWindowFor(image, hostMemory = 0){
    const end = image.imageBase + image.sizeOfImage;
    if (image.imageBase < 2 ** 32
        || Math.floor(image.imageBase / 2 ** 32) !== Math.floor((end - 1) / 2 ** 32))
    {
        return null;
    }
    if (end <= 2 ** 33 - 4096)
    {
        return 2 ** 33;
    }
    return end <= 2 ** 34 - 4096 && hostMemory >= 32 * 2 ** 30 ? 2 ** 34 : null;
}

/**
 * The Windows `windows: 'auto'` runs a program on (`windowsFor`): read from its
 * image, its manifest, its imports and its header; an image that is no PE (an
 * MS-DOS or 16-bit program) names none, and runs on the default.
 *
 * @param {Uint8Array} executable
 * @returns {ReturnType<typeof windowsFor>}
 */
function autoWindows(executable){
    if (imageKind(executable)?.kind !== 'pe')
    {
        return windowsFor({ compatibility: {}, imports: [], bits: null });
    }
    const image = parsePe(executable, { wide: true });
    return windowsFor({ compatibility: compatibilityOf(executable),
        imports: readImports(executable, image).map(table=>table.dll), bits: image.bits });
}

/**
 * createApp — the consumer-facing entry point.
 *
 * One machine running at a time, and a process lifecycle over the top: when
 * the program starts a child and then waits on it, the child runs on a
 * machine of its own built beside the parent's, and the parent goes on with
 * the child's exit code and whatever it wrote; when the program starts a child
 * and exits, the machine is torn down and rebuilt on the child's image. A
 * parent that runs genuinely alongside its child -- both executing at once --
 * is not covered.
 *
 * @param {AppOptions} options
 * @returns {Promise<any>} an AppController
 */
export async function createApp(options){
    // `auto`: the Windows the program was made for, chosen once for the whole
    // run, so a process it starts runs on the same one.
    const chosenWindows = options.windows === 'auto' ? autoWindows(options.executable) : null;
    if (chosenWindows)
    {
        options = { ...options, windows: chosenWindows.windows };
    }
    // Refused before anything is built: a machine made to the wrong Windows
    // fails later somewhere that says nothing about why.
    windowsVersion(options.windows);
    // Settled once, here, so every process the run makes is built in it.
    options = withConcurrency(withCpuSetup(withoutFaultingTailCalls(withKnownRoutines(options))));
    options = { ...options, processId: options.processId ?? runProcessId() };
    // The machine's memory, made once by the run and carried to every process
    // it starts, here or in a worker of its own (`memory-budget.js`).
    // Named, not yet the RAM asked for by default: a run of several processes
    // (an installer, its services, a compiler's workers) finds no room at two
    // gigabytes until the engine's own parts give back under pressure.
    const tabMemory = options.machineMemory;
    if (options.memoryBudget === undefined && tabMemory !== undefined && tabMemory > 0)
    {
        const memoryBudget = createMemoryBudget(tabMemory);
        const run = openMemoryBudget(memoryBudget);
        // The compiled modules every process shares, sized to the machine and
        // taken as they are kept, by what they cost (`sharedCharge`).
        const shared = Math.min(SHARED_MODULE_BYTES, Math.floor(tabMemory / 32));
        run.take(shared, 'translation');
        // In a tab, the tab's own: the page, the engine's thread, the graphics
        // and translators' workers, the browser's code mapped in.
        if (inBrowser())
        {
            run.take(RUN_ENGINE_BYTES, 'engine');
        }
        const config = options.cork?.config;
        options = { ...options, memoryBudget,
            cork: { ...options.cork, config: { ...config,
                sharedModuleBytes: config?.sharedModuleBytes ?? shared } } };
    }
    graphicsChoice(options.graphicsApi);
    // Both outlive every process: subscriptions a caller made before the first
    // child existed still have to fire for the last one, and the record of what
    // asked for a replacement is worthless if it dies with the asker.
    const events = createEvents();
    // A process in a worker of its own tells the run's bus what happens to
    // it: the page subscribes there, on the thread that started it.
    if (options.relay)
    {
        events.onAny(options.relay);
    }
    // The Windows `auto` chose, and why: what the program was made for.
    if (chosenWindows)
    {
        events.emit('windows', chosenWindows);
    }
    /** @type {any[]} */
    const requested = [];

    /** @param {any} request */
    const remember = request=>{
        requested.push(request);
        if (requested.length > REPLACEMENT_HISTORY)
        {
            requested.shift();
        }
    };

    // The log's reader surface outlives the process it was made against, for
    // the same reason `events` does. A page that raised a level, attached a
    // sink or holds a drain cursor did so before the handover and must not have
    // to notice it: the machine is rebuilt, the log is not.
    const logSinks = new Map();
    // A named mutex, event, semaphore, timer or file mapping outlives the
    // process that named it too: the single-instance idiom this exists for is
    // exactly a parent naming an object and a child -- what a replacement
    // makes of this same process -- discovering it by that name.
    /** @type {Map<string, { kind: string, object: any }>} */
    const namedObjects = new Map();
    /**
     * What every process of the run shares (`win32`'s `system`): the named
     * objects, and the registry -- the first process's hive, the one each
     * later process is handed rather than a copy of it.
     *
     * @type {{ namedObjects: Map<string, any>, registry: any, bundle: any, windows: any,
     *     sharedViews?: any, processDirectory?: Map<number, any>,
     *     processTables?: Map<number, any>, ids: { thread: number, process: number },
     *     volume: { drives: Map<string, any>, volumes: Map<string, any>,
     *         writables: Map<string, any>, watchers: Set<Function>, revisions?: Int32Array,
     *         sharing?: any, sharingMemory?: SharedArrayBuffer, pageFile?: any } }}
     */
    // A process in a worker of its own is handed the run's across a link
    // (`system-link.js`), and joins it rather than making one.
    const system = options.system ?? { namedObjects, registry: null, bundle: null, windows: null,
        // Views of one page-file section, kept agreeing at the edges of each
        // process's turns (`shared-views.js`).
        sharedViews: createSharedViews(),
        processDirectory: new Map(),
        // Every process's handle table on this thread, by id (DuplicateHandle).
        processTables: new Map(),
        ids: { thread: 1, process: 0x2000 },
        volume: { drives: new Map(), volumes: new Map(), writables: new Map(),
            watchers: new Set(), ...volumeMemory() } };
    /**
     * A process id and its first thread's, from the run's, for a process no
     * parent was told of: a class's server, which COM starts.
     */
    const newProcessIds = ()=>{
        const processId = system.ids.process;
        // Eight, as the kernel's process table steps: a process and its thread.
        system.ids.process += 8;
        return { processId, mainThreadId: processId + 1 };
    };
    /** @type {Map<string, string | number>} */
    const logLevels = new Map();
    /** @type {string | number | null} */
    let logDefaultLevel = null;
    let logSequence = 0;
    /** The journal every process of the run writes into; the first one's. @type {any} */
    let runJournal = null;
    /** And the profiler every one measures its output with: the first one's. @type {any} */
    let runProfiler = null;
    // The journal's own clock, one for the run. A process's guest clock is
    // not it: each machine has its own, a parent's stands still while the
    // child beside it runs, and a replacement's starts again from zero.
    const journalOrigin = performance.now();
    const journalClock = ()=>performance.now() - journalOrigin;
    // The sound output's storage outlives the process for the same reason, and
    // for one more: the page was handed it before any of this ran and builds
    // its audio graph over that memory once. A rebuilt machine has to mix into
    // the same storage rather than make new storage nobody reads --
    // `{ table }` with a shared track table, `{ control, samples }` with the
    // engine backend's ring. The first machine mixes into the output it was
    // handed, if any: a process in a worker of its own is given the run's
    // table, and built over one of its own it played where no page listened.
    /** @type {any} */
    let audioMemory = options.audio?.memory ?? null;
    // The decoded binary's instance outlives the process too: a machine is a
    // process, the decoder is a service of the run. The child attaches to the
    // parent's compiled module and linear memory, so the first cinematic after
    // a swap does not wait for another instantiation.
    /** @type {{ value: any }} */
    const mediaInstance = { value: null };
    // The presenter is a service of the run too, and for the same reason: a
    // machine is a process, but the canvas it draws into is not. Made once
    // here -- from the GPU the worker opened and the canvas the device carries
    // -- and handed to every machine, so a replacement does not reconfigure
    // the canvas or clear the frame the parent last presented.
    /** @type {any} */
    const presenter = options.graphics?.presenter ?? (options.device
        ? createPresenter({
            device: options.device.device,
            queue: options.device.queue,
            screen: options.device.screen,
            canvas: options.device.canvas,
            now: options.device.now,
            maxFps: options.maxFps ?? SETTINGS.frame.maxFps,
            // One bound for the run: every machine's frames go onto one queue.
            maxFrameLatency: options.graphics?.maxFrameLatency,
            // A build with no canvas but with a sink of its own -- a test
            // harness reading the frame back -- still gets its frames.
            presentTo: options.device.presentTo,
            // The host's own record of the frames: it owns the canvas and the
            // counts a page reads, and a frame reaching the canvas is the one
            // thing it cannot compute for itself.
            onFrame: options.device.onFrame,
            onPresented: options.device.onPresented,
            onPresentFailed: options.device.onPresentFailed,
            frameClock: options.device.frameClock,
            // The run's windows, by which the screen is composed of every
            // process's picture while more than one has a window showing.
            windows: ()=>{
                const manager = system.windows?.manager;
                return manager ? manager.topLevel().map((/** @type {any} */ state)=>({
                    processId: state.processId, rect: state.rect, visible: state.visible,
                    parent: state.parent })) : [];
            },
            foreground: ()=>{
                const manager = system.windows?.manager;
                const hwnd = manager?.foreground() ?? 0;
                return hwnd !== 0 ? manager.get(hwnd)?.processId ?? null : null;
            },
        })
        // A process in a worker of its own has no GPU: its surfaces' pictures
        // go to the thread that has one, as bytes, each burst as it flushes.
        : options.graphics?.display ? createPresenter({ sendFrame: options.graphics.display })
            : null);

    // The translation store is the run's as well: a child's machine is built
    // beside its paused parent's, and a second store opened on the same
    // directory cannot write while the first holds its records file's
    // synchronous handle -- the child stopped at its first append.
    const runStoreSpec = options.cork?.config?.store === undefined ? 'local'
        : options.cork.config.store;
    const openedStore = await resolveTranslationStore(runStoreSpec,
        options.bundle?.id ?? options.id ?? 'bundle');
    // Processes in workers of their own: the batch modules they compile are
    // kept alive here, beside the store they are stored in, for the next ones
    // to find compiled (`withHeldModules`), where the engine hands code by
    // bytes (V8, not JavaScriptCore). Not in a process joined to a run
    // across a link: its store is the run's, kept alive where the run is.
    const heldModuleBytes = options.cork?.config?.sharedModuleBytes ?? SHARED_MODULE_BYTES;
    const translationStore = openedStore && !options.system && (options.concurrency ?? 1) > 1
        && heldModuleBytes > 0 ? withHeldModules(openedStore, heldModuleBytes) : openedStore;

    // The run's cache, its keeper on this thread beside the stores: a process
    // here reads it through the reader made with it, one in a worker of its own
    // through a reader there (`processesBeside`). A process joined to a run
    // across a link is handed the run's reader (`options.cache`).
    const runCache = options.system ? null : await openRunCache(options.cache);

    // The disk under the run's writable layers is the run's, as its volume is:
    // a process in a worker of its own writes through the run's.
    if (!options.system)
    {
        system.volume.pageFile = await openRunPageFile(options, events);
    }

    const translationPool = await openTranslationPool(options);
    /** What a machine's translator is told where the run lends it its translators. */
    const lentConfig = translationPool ? { worker: true, translators: 0 } : {};

    /**
     * The machine every process of the run is on (`AppOptions.machine`): as
     * the caller says, else as wide as the run's first program. A memory past
     * 2 GiB is a 64-bit Windows's: only there does a 32-bit program get addresses
     * past 2 GiB, under WOW64. An image that cannot be read here is left for its
     * own build to refuse.
     *
     * @type {'x86' | 'amd64'}
     */
    const runMachine = options.machine ?? (()=>{
        if ((options.memorySize ?? 0) > 2 ** 31)
        {
            return 'amd64';
        }
        try
        {
            return options.executable && programImage(options.executable).bits === 64
                ? 'amd64' : 'x86';
        }
        catch {
            return 'x86';
        }
    })();

    // The network is the run's, one link for every process; each process's
    // sockets are a view of it, so what arrives reaches the process it is for.
    // An address space of the embedder's own (an adapter, which binds) is
    // the processes' to share as it is.
    const supplied = options.win32?.network;
    const sharedNetwork = supplied && typeof supplied.bind !== 'function'
        ? shareTransport(supplied) : null;

    /**
     * How the run's pool reaches a process's other executors: each one taken
     * as a process of the pool's own, keyed apart from every process id.
     *
     * @param {number} id  the process's
     */
    const executorLending = id=>({
        add: (/** @type {number} */ index, /** @type {any} */ reach)=>{
            translationPool?.addProcess(-(id * 64 + index), reach).catch(()=>{});
        },
        remove: (/** @type {number} */ index)=>translationPool?.removeProcess(-(id * 64 + index)),
    });

    /** @param {any} [extra] */
    const machine = extra=>({
        ...options,
        ...translationPool ? { cpu: { ...options.cpu, executorTranslators:
            executorLending(extra?.processId ?? options.processId ?? FIRST_PROCESS_ID) } } : {},
        ...sharedNetwork ? { win32: { ...options.win32, network: sharedNetwork.view() } } : {},
        // One machine for every process of the run: a 32-bit child of a 64-bit
        // program runs under WOW64 on it.
        machine: runMachine,
        ...runCache === null ? {}
            : { cache: { reader: runCache.reader, figures: runCache.figures,
                join: runCache.join } },
        cork: { ...options.cork, config: { ...options.cork?.config, store: translationStore,
            ...lentConfig } },
        events,
        spawned: remember,
        logSinks,
        system,
        log: {
            ...options.log, sequenceBase: logSequence, ...runJournal ? { journal: runJournal } : {},
            ...runProfiler ? { profiler: runProfiler } : {},
            now: journalClock,
        },
        audio: { ...options.audio, memory: audioMemory },
        media: { ...options.media, instance: mediaInstance.value },
        graphics: { ...options.graphics, presenter },
        ...extra,
    });

    // Processes that run at once: a class served by an executable is made in
    // a process of its own, started beside the one that asked for it and
    // running alongside it for as long as anything holds one of its objects.
    // The table of their class objects is the run's, as the service control
    // manager's is the machine's; their files and registry are the run's
    // (`system`), so what one writes the others read at once.
    /** @type {Map<unknown, any>} */
    const processes = new Map();
    /** @type {Map<any, unknown>} */
    const names = new Map();
    /**
     * Which image each machine was built for, for `standing()`: weak, so a
     * machine whose process is over goes, its gigabyte of memory with it.
     *
     * @type {WeakMap<any, string>}
     */
    const images = new WeakMap();
    /** Each machine's process id, as GetCurrentProcessId answers it. @type {WeakMap<any, number>} */
    const processIds = new WeakMap();
    /** @type {Set<Promise<unknown>>} */
    const servers = new Set();
    /** @type {Set<{ current: any, main: boolean, service: string | null }>} */
    const serving = new Set();
    /** The services started in workers of their own, by process id. @type {Map<number, string>} */
    const servicesAcross = new Map();
    /**
     * A service does not end when its last client lets go: it runs until the
     * machine stops, and the end of the run's program is that. Each one still
     * running is ended then, its control handler not told
     * SERVICE_CONTROL_SHUTDOWN first.
     */
    const endServices = ()=>{
        /** @param {string} service */
        const said = service=>events.emit('divergence', { api: 'Services', detail: `the service`
            + ` ${service} is ended with the run, without a shutdown control` });
        for (const each of serving)
        {
            if (each.service)
            {
                said(each.service);
                each.current.terminate(0);
            }
        }
        for (const [id, service] of servicesAcross)
        {
            said(service);
            reachable.get(id)?.terminate(0);
        }
    };
    /** @type {any} */
    let runOptionsNow;
    /** The machines of the run not yet retired. @type {Set<any>} */
    const standing = new Set();
    /** Whether the run's processes run at once, each beside its parent (`concurrency.js`). */
    const processesAtOnce = (options.concurrency ?? 1) > 1;
    /**
     * Whether every process of the run stands in a worker of its own, its
     * first one too: where processes run at once, this thread is the
     * system alone and runs no program (`buildSystemHost`).
     */
    const rootAcross = processesAtOnce && !options.system;
    /** @type {import('./layers/win32/ole32/remote.js').ClassTableHooks} */
    const serveHere = {
        launch: (request, process)=>{
            const parent = processes.get(process);
            if (!parent)
            {
                return null;
            }
            const exited = startServer(parent, request);
            servers.add(exited);
            exited.finally(()=>servers.delete(exited));
            return { exited };
        },
    };
    // A process in a worker of its own uses the run's table, the system's,
    // across its link (`com-link.js`); a server it starts runs in a worker of
    // its own while the run has room, and beside it here otherwise.
    const classTable = options.system?.com
        ? remoteClassTable(options.system.com, serveHere)
        : createClassTable(serveHere);

    const processMemoriesParts = processMemories({
        options,

    });
    const {
        dropSpare, holderOf, keepMemory, keepSpare, machineMemory, releaseCredit, releaseHolder,
        roomForProcess, spareMemories, spareToProcess, spareToRun,
    } = processMemoriesParts;

    /**
     * A machine for a process, named to the class table.
     *
     * @param {any} [extra]
     */
    const build = async extra=>{
        const process = {};
        /** The machine, once built: what its children are started beside. @type {any} */
        let self = null;
        const reusedMemory = spareMemories.pop() ?? null;
        // Its own holder of the machine's memory; the first process of a
        // worker holds the one its parent claimed for it.
        const given = extra === undefined ? options.memoryHolder : undefined;
        const holder = machineMemory === null ? RUN_HOLDER
            : given ?? machineMemory.claim();
        spareToProcess(reusedMemory, holder);
        const start = { reused: reusedMemory };
        const memoryCredit = await roomForProcess(start, holder).catch(e=>{
            // No room: the memory it was to run in goes back to the run.
            if (given === undefined)
            {
                releaseHolder(holder, [start.reused]);
            }
            else if (start.reused)
            {
                spareToRun(start.reused, holder);
                keepSpare(start.reused);
            }
            throw e;
        });
        const built = await buildApp(machine({ ...extra, reusedMemory: start.reused, memoryCredit,
            ...machineMemory === null ? {} : { memoryHolder: holder },
            com: { table: classTable, process },
            // With concurrency a child runs from CreateProcess on, beside
            // its parent, as on Windows; otherwise it waits for the parent to
            // have nothing left to run, and runs in its place.
            beside: (/** @type {any} */ request)=>startBeside(self, request),
            // Read when called: the parts beside are made further down.
            terminate: (/** @type {any} */ request, /** @type {number} */ code)=>
                terminateBeside(request, code),
            askChild: (/** @type {any} */ request, /** @type {any} */ call)=>askBeside(request, call),
            // Only where processes run at once: one run in its parent's place
            // has the parent paused, which wakes nothing. A process that joined
            // the run's system from a worker of its own is never the run's only
            // one -- its parent at least stands -- so what it waits on is
            // another's to answer, and the run, not it, says when it is over.
            // A child beside counts until its parent is told it ended: its
            // machine stops standing when its run is over and is taken down
            // after, which awaits, while the parent's turns go on -- a parent
            // whose every thread waits on it would find nothing to wake it.
            othersRunning: ()=>Boolean(options.system) || starting.value > 0 || across.value > 0
                || besides.size > 0
                || [...standing].some(other=>other !== self) }))
            .catch(e=>{
                if (given === undefined)
                {
                    machineMemory?.release(holder);
                }
                throw e;
            })
            .finally(()=>releaseCredit(memoryCredit, holder));
        holderOf.set(built, { holder, own: given === undefined });
        self = built;
        standing.add(built);
        processes.set(process, built);
        names.set(built, process);
        images.set(built, extra?.imagePath ?? '');
        // The run's first process has no extra and the run's own id
        // (`runProcessId`), as the machine it is built with numbers it.
        const id = extra?.processId ?? options.processId ?? FIRST_PROCESS_ID;
        processIds.set(built, id);
        translationPool?.addProcess(id, {
            lend: (port, token)=>built.lendTranslator(port, token),
            recall: token=>built.recallTranslator(token),
            demand: ()=>built.translatedHere(),
        }).catch(()=>{});
        // A child beside its parent in a worker, whose run lends translators
        // to its own machines only: told to lend to this one too, or it
        // interprets every instruction, being told it is lent them.
        if (!translationPool && extra)
        {
            options.system?.translators?.add(id);
        }
        return built;
    };

    /**
     * A process is over: everything its proxies held goes back -- which is
     * what lets a server it was using see its last client go.
     *
     * @param {any} ended
     */
    const retire = async ended=>{
        standing.delete(ended);
        translationPool?.removeProcess(processIds.get(ended)
            ?? options.processId ?? FIRST_PROCESS_ID);
        if (!translationPool && ended !== current && processIds.has(ended))
        {
            options.system?.translators?.remove(processIds.get(ended));
        }
        await classTable.ended(names.get(ended));
        processes.delete(names.get(ended));
        names.delete(ended);
    };

    /** @type {any} */
    /** The system libraries the run's own program knew, once it is over. @type {{ value: string[] }} */
    const rootLibraries = { value: [] };
    let current = rootAcross
        ? await buildSystemHost({ options, events, system, translationStore, now: journalClock,
            across: ()=>[...standingAcross], libraries: ()=>rootLibraries.value,
            runCache: runCache?.reader ?? null })
        : await build();
    // What every process's devices present comes back from the run's
    // graphics worker to the machine that opened it; where no process stands
    // on this thread, the system takes those frames to the run's presenter.
    const shownHere = rootAcross && presenter && options.device?.worker && options.device.device
        ? connectGraphicsWorker({ worker: options.device.worker, device: options.device.device,
            presentTo: frame=>presenter.show(frame) })
        : null;
    // The first process's journal is the run's: every process built after it,
    // beside it or in its place, writes there, and a reader of the facade's
    // log sees them all in one order on one clock.
    runJournal = current.log.journal?.() ?? null;
    runProfiler = current.log.profiler?.() ?? null;

    // Read from the machine that made it, while it still stands, and handed to
    // every rebuild from here on.
    try
    {
        audioMemory = current.audio.memory();
    }
    catch {
        // A build with no sound layer has no storage to carry, and that is
        // not a fault: the rebuilt machine runs without one too.
        audioMemory = null;
    }

    /** What a caller holds. Rebound to the live process on every replacement. */
    const facade = /** @type {any} */ ({});

    /** Puts the levels the page set at run time back onto a rebuilt journal. */
    const replayLogLevels = ()=>{
        if (logDefaultLevel !== null)
        {
            current.log.setDefaultLevel(logDefaultLevel);
        }
        for (const [category, level] of logLevels)
        {
            current.log.setLevel(category, level);
        }
    };

    /**
     * Remembers a level set through the facade before passing it to the live
     * journal, so a replacement can be given it again.
     */
    const bindLogLevels = ()=>{
        const live = facade.log;
        facade.log = {
            ...live,
            /** @param {string} category @param {string | number} level */
            setLevel(category, level){
                logLevels.set(category, level);
                return live.setLevel(category, level);
            },
            /** @param {string | number} level */
            setDefaultLevel(level){
                logDefaultLevel = level;
                return live.setDefaultLevel(level);
            },
        };
    };

    /**
     * How deep in `own.run` the run is: a child that runs beside its waiting
     * parent is run through it too, and its exit is not the end of the game.
     */
    /** The page's own line of processes: the program it started, and what replaces it. */
    const mainLine = {
        get current(){
            return current;
        },
        set current(running){
            current = running;
        },
        main: true,
    };
    /** The image of the process running now, the one whose exit ends the game. */
    let imagePath = options.imagePath ?? 'C:\\app.exe';

    /**
     * Tells the player the game is over when it ended by itself with code 0:
     * otherwise the canvas just stops changing, which reads as a hang. The box
     * is the engine's, not the program's -- the process is gone, and nothing
     * waits on its answer -- so it carries id 0, which no program's box does,
     * and `exit` for a page that draws it differently.
     *
     * @param {number} code
     */
    const noticeExit = code=>{
        if (options.exitNotice === false || code !== 0 || (current.exitCode?.() ?? code) !== 0)
        {
            return;
        }
        events.emit('message-box', {
            id: 0,
            text: 'The game has finished and its process has stopped.',
            caption: imagePath.split(/[\\/]/).pop(),
            type: EXIT_NOTICE_TYPE,
            buttons: [{ id: 1, label: 'OK' }],
            defaultButton: 1,
            icon: 'information',
            trace: null,
            exit: { code },
        });
    };

    /**
     * The journal's sequence as the live machine has written it, for the
     * machine built next to continue from.
     */
    const noteLogSequence = ()=>{
        const written = journalOf(current.diagnostics())?.metrics?.journal?.written;
        if (typeof written === 'number')
        {
            logSequence = written;
        }
    };

    const { lendSound, ownSound } = processSound({
        events, options,
        audioMemory: ()=>audioMemory,
    });

    const classServersParts = classServers({
        bindLogLevels, build, events, keepMemory, newProcessIds, ownSound, retire, serving,
        current: ()=>current,
        noteMachines: ()=>noteMachines,
        runOptionsNow: ()=>runOptionsNow,
        runProcesses: ()=>runProcesses,
        stand: ()=>stand,
        standingBeside: ()=>standingBeside,
    });
    const {
        serverImage, startServer,
    } = classServersParts;

    /**
     * The children running beside their parents, with concurrency: each
     * one's run, until it exits.
     *
     * @type {Set<Promise<number>>}
     */
    const besides = new Set();
    /** Children asked for whose machines are not built yet. */
    const starting = { value: 0 };
    /** Children running in workers of their own. */
    const across = { value: 0 };
    /**
     * Whether the next child runs in a worker of its own: while fewer than
     * the run's concurrency run at once, the first on this thread. One past
     * it takes turns beside its parent here, slower and as correct. A process
     * that joined another run's system from a worker starts its children
     * beside it, in its worker: the run's processes are counted by the run.
     */
    const inWorker = ()=>!options.system
        && across.value < (options.concurrency ?? 1) - (rootAcross ? 0 : 1);
    /**
     * The children standing in workers of their own, each with the way its
     * diagnostics are asked for across its link, and those of every process
     * running beside it there.
     *
     * @type {Set<{ image: string, id: number, link: ReturnType<typeof import('./system/link.js').openLink>,
     *     diagnostics: () => Promise<any>,
     *     frames: (count: number) => Promise<any[] | null>,
     *     read: (address: number, length: number) => Promise<Uint8Array | null>,
     *     standing: (journal: number) => Promise<{ image: string, diagnostics: any }[]
     *         | null> }>}
     */
    const standingAcross = new Set();
    /**
     * The children running beside their parent, in this worker: listed with
     * the others, since a child that never exits holds its executors and
     * their memory, and a list without it says the run has one process.
     *
     * @type {Set<{ image: string, id: number, beside: true,
     *     diagnostics: () => Promise<any>,
     *     read: (address: number, length: number) => Uint8Array,
     *     hook: (address: number, how: any) => any }>}
     */
    const standingBeside = new Set();

    /**
     * The page's input, where the run's window manager says it goes
     * (`inputRecipient`). Only a run with no window showing has the page for
     * its console: the newest process in a worker of its own has it, else the
     * process the facade speaks for.
     *
     * @param {any} machineInput  the input of the process the facade speaks for
     */
    const routedInput = machineInput=>{
        /**
         * The input the pointer's last motion went to: a press that names no
         * place is placed where that input's cursor is. The facade's own
         * cursor stood where it was while another program's window took the
         * motion, and the press went to nobody. Null for a process across a
         * link, whose cursor is there: the manager places the press itself.
         *
         * @type {any}
         */
        let pointed = machineInput;
        /** @param {any} event @param {any} input */
        const moved = (event, input)=>{
            if (event.kind === 'pointerMove')
            {
                pointed = input;
            }
        };
        return {
            ...machineInput,
            /** @param {any} event */
            send: event=>{
                const { target, dropped } = inputRecipient(system.windows?.manager, event,
                    pointed?.cursor?.() ?? null);
                if (dropped)
                {
                    return false;
                }
                for (const built of target === null ? [] : processes.values())
                {
                    if (processIds.get(built) === target)
                    {
                        moved(event, built.input);
                        return built.input.send(event);
                    }
                }
                const inWorkers = [...standingAcross];
                const process = inWorkers.find(each=>each.id === target) ?? inWorkers.at(-1);
                if (process)
                {
                    moved(event, null);
                    process.link.call('input', 'send', [event, null]).catch(()=>{});
                    return true;
                }
                moved(event, machineInput);
                return machineInput.send(event);
            },
            // A route a tool queues clicks and keys on goes the same way: built
            // on the machine's own send, it took every press to the process the
            // facade speaks for, whichever program's window was under it.
            route(){
                return createInputRoute(event=>this.send(event));
            },
        };
    };

    /**
     * The run's windows as a tool reads them (`debug.windows`): every
     * process's, as the run's window manager has them, the topmost top-level
     * window first and each followed by its children -- where the facade's
     * one process would show only its own. Null where the run keeps none.
     */
    const runWindows = ()=>{
        const manager = system.windows?.manager;
        if (!manager)
        {
            return null;
        }
        /** @param {number} value */
        const hex = value=>`0x${(value >>> 0).toString(16)}`;
        /** @type {any[]} */
        const listed = [];
        /** @param {any} state */
        const add = state=>{
            listed.push({
                hwnd: hex(state.hwnd), processId: state.processId,
                x: state.rect.left, y: state.rect.top, width: state.rect.right - state.rect.left,
                height: state.rect.bottom - state.rect.top,
                rect: state.rect, client: state.client, region: state.region,
                visible: state.visible, enabled: state.enabled, className: state.className,
                title: state.title,
                parent: state.parent || state.owner ? hex(state.parent || state.owner) : null,
                child: state.parent !== 0, style: hex(state.style), exStyle: hex(state.exStyle),
            });
            manager.children(state.hwnd).forEach(add);
        };
        manager.topLevel().forEach(add);
        return listed;
    };

    /**
     * The screen as a tool reads it (`debug.desktop`), as the presenter shows
     * it: while windows of more than one process show, every process on this
     * thread's desktop composed by the run's windows (`compose.js`); while one
     * process's do, that process's desktop. Its own for the facade's process
     * when the run keeps no windows, or the picture is not on this thread --
     * a process in a worker of its own sends its picture to the presenter.
     *
     * @param {() => any} own  the desktop of the process the facade speaks for
     */
    const runDesktop = own=>{
        const manager = system.windows?.manager;
        const placed = manager ? manager.topLevel() : [];
        if (!manager)
        {
            return own();
        }
        /** @type {Map<number, { width: number, height: number, pitch: number, bytes: Uint8Array }>} */
        const layers = new Map();
        for (const built of standing)
        {
            const id = processIds.get(built);
            const picture = id === undefined ? null : built.debug?.desktop?.() ?? null;
            if (id !== undefined && picture && typeof picture.then !== 'function')
            {
                layers.set(id, picture);
            }
        }
        if (!needsComposing(placed))
        {
            const showing = placed.find((/** @type {any} */ state)=>state.visible
                && layers.has(state.processId))?.processId;
            return (showing === undefined ? null : layers.get(showing)) ?? own();
        }
        const foreground = manager.get(manager.foreground() ?? 0)?.processId ?? null;
        const base = baseOf(placed, layers, foreground);
        const first = base === null ? null : layers.get(base);
        if (base === null || !first)
        {
            return own();
        }
        const screen = { width: first.width, height: first.height, pitch: first.width * 4,
            bytes: new Uint8Array(first.width * first.height * 4) };
        for (const copy of compositionPlan({ windows: placed, layers, base, screen }))
        {
            const layer = /** @type {{ pitch: number, bytes: Uint8Array }} */ (
                layers.get(copy.source));
            for (let row = 0; row < copy.height; row++)
            {
                const from = (copy.y + row) * layer.pitch + copy.x * 4;
                screen.bytes.set(layer.bytes.subarray(from, from + copy.width * 4),
                    (copy.toY + row) * screen.pitch + copy.toX * 4);
            }
        }
        return screen;
    };

    const processesBesideParts = processesBeside({
        across, besides, bindLogLevels, build, classTable, endServices, events,
        facade, inWorker, keepMemory, keepSpare, lendSound, lentConfig, machineMemory, mainLine,
        mediaInstance, names, newProcessIds, noteLogSequence, noticeExit, options, ownSound,
        presenter, releaseHolder, replayLogLevels, retire, rootAcross, rootLibraries,
        routedInput, runDesktop, runMachine, runWindows, serverImage, servers, servicesAcross,
        serving, spareMemories, standing, standingAcross, standingBeside, starting, system,
        translationPool, translationStore, runCache,
        audioMemory: ()=>audioMemory,
        current: ()=>current,
        imagePath: ()=>imagePath,
        logSequence: ()=>logSequence,
        own: ()=>own,
        runOptionsNow: ()=>runOptionsNow,
    });
    const {
        askBeside, noteMachines, reachable, runProcesses, runRoot, stand, startBeside,
        terminateBeside,
    } = processesBesideParts;

    /**
     * A machine of this app by its process id; its first, the app's own, for
     * none.
     *
     * @param {number | null | undefined} processId
     */
    const machineOf = processId=>{
        if (processId === null || processId === undefined)
        {
            return current;
        }
        for (const built of [current, ...processes.values()])
        {
            if (processIds.get(built) === processId)
            {
                return built;
            }
        }
        return null;
    };

    const own = {
        /**
         * The run's translation pool as it stands: its workers, the idle ones,
         * how many work for each process, and its journal of joins and leaves;
         * null where the run has none.
         */
        translationPool: ()=>translationPool?.diagnostics() ?? null,
        /**
         * A worker of the run's pool lent to a process of this app: its own
         * (no id) or a child beside it, by id - not the facade's, which speaks
         * for the child started last. One gone already gives the port back.
         *
         * @param {number | null | undefined} processId
         * @param {MessagePort} port @param {number} token
         */
        lendTranslatorTo(processId, port, token){
            const to = machineOf(processId);
            if (to)
            {
                to.lendTranslator(port, token);
            }
            else
            {
                port.close();
            }
        },
        /** @param {number | null | undefined} processId @param {number} token */
        recallTranslatorFrom(processId, token){
            machineOf(processId)?.recallTranslator(token);
        },
        /**
         * A call this process's parent makes in it (`cross-process.js`): the
         * process the run was started for, not a child it stands for now.
         *
         * @param {any} call
         */
        answerCall: (/** @type {any} */ call)=>mainLine.current.answerCall(call),
        /**
         * Every process standing, each with its image and its own diagnostics:
         * the facade speaks for one of them, and an install several processes
         * deep that waits on itself shows nothing through one.
         *
         * With `journal`, each also with the last that many entries of its
         * own call journal: a process in a worker keeps its ring there, and
         * one that never ends never hands it back.
         *
         * @param {{ journal?: number }} [asked]
         * @returns {Promise<{ image: string, diagnostics: any, worker?: boolean,
         *     journal?: { time: number, text: string }[] }[]>}
         */
        async standing({ journal = 0 } = {}){
            const machines = new Set([...rootAcross ? [] : [current], ...processes.values()]);
            return Promise.all([
                ...[...machines].map(async made=>({
                    image: images.get(made) || imagePath,
                    diagnostics: await made.diagnostics(),
                    ...journal > 0 ? { journal: (made.log?.recent?.(journal) ?? [])
                        .map((/** @type {any} */ entry)=>({ time: entry.time,
                            text: String(entry.text) })) } : {},
                })),
                // A child in a worker of its own answers at its next look at
                // its link, with every process running beside it there; one
                // that ends meanwhile answers nothing.
                ...[...standingAcross].map(async child=>{
                    const there = await child.standing(journal).catch(()=>null);
                    return (there ?? [{ image: child.image, diagnostics: null }])
                        .map(each=>({ ...each, worker: true }));
                }),
            ]).then(found=>found.flat());
        },

        /**
         * Runs the program, and whatever replaces it, to completion.
         *
         * @param {Object} [runOptions]
         * @param {number} [runOptions.maxTurns]
         * @returns {Promise<number>} the last program's exit code
         */
        async run(runOptions){
            runOptionsNow = runOptions;
            return rootAcross ? runRoot() : runProcesses(runOptions);
        },

        /**
         * Ends this program, and with it the run's presenter: the canvas and
         * the texture a replacement draws into are released here and nowhere
         * earlier, because the process that takes this one's place still needs
         * them.
         */
        dispose: ()=>Promise.all(
            // Every machine of the run on this thread, not only the servers: a child
            // beside its parent turns on a loop of its own, which ends when its
            // machine is disposed and not when the program's does.
            [...new Set([...[...serving].map(line=>line.current), ...standing])]
                .filter(one=>one !== current).map(one=>one.dispose()))
            .then(()=>current.dispose())
            .then(()=>{
                // A process in a worker of its own keeps its memories for the
                // worker to hand back to the run's thread.
                if (options.spareMemories)
                {
                    [...serving].forEach(line=>keepMemory(line.current));
                    keepMemory(current);
                }
                else
                {
                    // The run is over: what its last processes held goes with them.
                    for (const gone of [...serving.values()].map(line=>line.current)
                        .concat(current))
                    {
                        const held = holderOf.get(gone);
                        holderOf.delete(gone);
                        if (held?.own)
                        {
                            machineMemory?.release(held.holder);
                        }
                    }
                }
                system.bundle?.stop();
                // Closed once the last save under way has read its files.
                if (!options.system)
                {
                    system.volume.pageFile?.close();
                }
                // The run's store outlives each machine it was handed to, and
                // goes with the last of them; the run is gone once its last
                // records are written and the file let go of.
                runCache?.close();
                if (runStoreSpec === 'local')
                {
                    return translationStore?.close?.();
                }
                return undefined;
            })
            .finally(()=>{
                if (!options.spareMemories)
                {
                    spareMemories.splice(0).forEach(dropSpare);
                }
                shownHere?.dispose();
                presenter?.dispose?.();
                translationPool?.dispose();
            }),

        /**
         * The presenter this run draws through: the canvas, the format it was
         * configured in, the pacer and the texture the primary is copied into.
         * Shared by every machine the run is rebuilt on, which is what keeps
         * the last frame of one process on the canvas until the next presents.
         */
        presenter: ()=>presenter,

        /**
         * The last few CreateProcess requests, each with the guest's stack at
         * the call that made it.
         */
        replacements: ()=>[...requested],
    };

    stand(current);
    bindLogLevels();
    return facade;
}
