/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What a run shares across its processes, made once: the bundle mounted, the
 * session opened, the journal and the sound output, the engine's modules
 * assembled - the host every process of the run is built on (`app.js`).
 */

import { assembleModules } from '../core.js';
import { defaultModules } from '../layers/index.js';
import { createRunRegistry } from '../layers/win32/module.js';
import { GRAPHICS_CHOICES } from '../layers/graphics/choice.js';
import { CORK_TSC_MHZ } from '../layers/cpu/internal/cork-host.js';
import { SETTINGS, processorName } from '../settings.js';
import { processorsFor } from '../layers/cpu/module.js';
import { createWindowDirectory } from '../layers/win32/user32/directory.js';
import { furnishVolume, openSession } from './session.js';
import { mountBundle } from './bundle-mount.js';
import { createMixer } from '../layers/audio/output/mixer.js';
import { TABLE_BYTES } from '../layers/audio/output/mix.js';
import { cacheSpace } from '../layers/cache/module.js';
import { liveDumpOf } from './live-dump.js';
import { eventFrom } from '../system/events-across.js';
import { createInputRoute } from '../layers/input/route.js';
import { describeEvent, readWholeFile } from './libraries.js';
import { withZones } from '../memory-zones.js';
import { programInPlaceOf, systemProgramImage } from '../layers/win32/programs/table.js';

/**
 * Which process a page event goes to, by the run's window manager: the
 * process of the window under the pointer or holding the mouse, the keyboard
 * to the process of the window with the focus -- and `dropped` where no window
 * has it while some window shows, as on Windows: the desktop under the
 * pointer, no window in the foreground.
 *
 * Motion is never dropped: the cursor is the system's and goes wherever the
 * mouse takes it, and a cursor that reached the desktop under a locked
 * pointer, its motion dropped there, never left it. And a locked pointer
 * sends motion alone, so where it points is where the cursor is -- `cursor`,
 * which a process keeps -- or the manager went on choosing by the last place
 * the page named, the desktop after a click there, and every press went to
 * nobody.
 *
 * @param {{ inputTarget: (event: any) => number | null,
 *     topLevel: () => { visible: boolean }[] } | undefined} manager
 * @param {import('../layers/input/router.js').HostInputEvent} event
 * @param {{ x: number, y: number } | null} [cursor]  where the cursor is, for an
 *     event of a locked pointer
 * @returns {{ target: number | null, dropped: boolean }}
 */
export function inputRecipient(manager, event, cursor = null){
    const pointed = event.kind === 'pointerMove' || event.kind === 'pointerButton'
        || event.kind === 'wheel';
    const located = pointed && typeof event.x !== 'number' && cursor
        ? { ...event, x: cursor.x, y: cursor.y } : event;
    const target = manager?.inputTarget(located) ?? null;
    return {
        target,
        dropped: target === null && event.kind !== 'pointerMove'
            && (manager?.topLevel().some(state=>state.visible) ?? false),
    };
}

/**
 * Where the translator is, relative to this module: built beside a package,
 * the workspace's own source otherwise.
 */
const CORK = /** @type {{ env?: { BOTTLIFY_CORK?: string } }} */ (import.meta).env?.BOTTLIFY_CORK
    ?? '../../../cork/src/index.js';

/**
 * The translator to load for `cork`: what the caller named, else
 * the one built beside this module (see `CORK`).
 *
 * @param {{ moduleUrl?: string } | undefined} asked
 * @param {string} [here]
 */
export function corkArtifacts(asked, here = import.meta.url){
    return { moduleUrl: asked?.moduleUrl ?? new URL(CORK, here).href };
}

/**
 * The translator's version, which the processor is named after: what its
 * entry module says. The module is the one the machine loads to run, so the
 * name follows whichever translator the run has, with nothing to keep in step.
 *
 * @param {{ moduleUrl?: string } | undefined} cork
 * @returns {Promise<string | undefined>}
 */
export async function engineVersion(cork){
    const engine = await import(corkArtifacts(cork).moduleUrl);
    return typeof engine.version === 'string' ? engine.version : undefined;
}

/**
 * A child's image: its file on the volume, or -- for a program of the system
 * folder the volume has no file for, or one a title brought that the engine
 * runs in its place -- the image the engine makes for it
 * (`win32/programs/table.js`). Every way a child is started reads it here, so
 * such a program is a process in each of them.
 *
 * @param {any} filesystem
 * @param {any} blocks
 * @param {string} path
 * @param {'x86' | 'amd64'} [machine]  the run's: a system program's width on it
 * @returns {Promise<Uint8Array | null>}
 */
export async function readProgramImage(filesystem, blocks, path, machine){
    const file = await readWholeFile(filesystem, blocks, path);
    return file ? programInPlaceOf(file) ?? file : systemProgramImage(path, machine);
}

const SEVERITY = /** @type {Record<string, string>} */ ({
    error: 'error',
    'bundle-unavailable': 'error',
    'library-missing': 'warn',
    'libraries-missing': 'warn',
    // A static import found nowhere: the process is not started.
    'libraries-not-found': 'error',
    divergence: 'warn',
    // Something the program made did not happen: a draw, a frame, data.
    loss: 'error',
    // The program's own words about why it is stopping. It is not our
    // failure, but it is never good news.
    'message-box': 'warn',
    // The program's own account of why it is going down.
    'program-error': 'error',
    'bundle-retry': 'warn',
    'bundle-prefetch-failed': 'warn',
    'bundle-unbacked': 'warn',
    'storage-full': 'warn',
});

/**
 * Events the bus does not write down. An event whose own source writes the
 * journal keeps a record per call while the event itself fires once, so the
 * bus must not write the first of those calls a second time: `unimplemented`,
 * whose program may call a missing import in a loop and would fill the page's
 * queue with a clone and a wake-up per call. And a position rather than a
 * happening: `cursor-moved` fires at every move of the mouse, and written down
 * it laps everything else out of the ring. Nor `bundle-fetching`, at each start and end
 * of the range requests, which the bundle's own read counts account for.
 */
const UNJOURNALLED = new Set(['unimplemented', 'cursor-moved', 'bundle-fetching']);

/**
 * Every event the run reports also goes to its journal, so that one ordered
 * stream carries the whole story. A consumer that subscribes to a name still
 * gets it exactly as before -- a watcher never answers, so it cannot take an
 * event away from a handler that would have.
 *
 * @param {{ onAny: (watcher: (name: string, payload: any) => void) => unknown }} events
 * @param {{ write: (level: string, category: string, template: string,
 *     ...args: any[]) => any }} into
 */
export function journalEvents(events, into, { shaders = false } = {}){
    // A program's console output is journalled a line at a time: a C runtime
    // writes unbuffered output a character per call, a line of the journal each.
    /** @type {Map<number, string>} */
    const unfinished = new Map();
    /** @param {number} handle @param {string} text */
    const outputLine = (handle, text)=>into.write('info', 'output', '{0}',
        describeEvent({ handle, text }));
    events.onAny((/** @type {string} */ name, /** @type {any} */ payload)=>{
        if (UNJOURNALLED.has(name))
        {
            return;
        }
        if (name === 'output')
        {
            const lines = ((unfinished.get(payload.handle) ?? '') + payload.text).split(/\r?\n/);
            unfinished.set(payload.handle, /** @type {string} */ (lines.pop()));
            for (const line of lines)
            {
                outputLine(payload.handle, line);
            }
            return;
        }
        if (name === 'exit')
        {
            for (const [handle, text] of unfinished)
            {
                if (text)
                {
                    outputLine(handle, text);
                }
            }
            unfinished.clear();
        }
        if (name === 'shader-compiled')
        {
            // The source is for a shader the compiler refused, where it is the
            // thing to read; a compile that worked is a line, and only when asked.
            if (!payload?.tokens)
            {
                into.write('warn', name, '{0}', describeEvent(payload));
            }
            else if (shaders)
            {
                const defines = (payload.defines ?? []).map((/** @type {any} */ one)=>
                    (Array.isArray(one) ? one.join('=') : String(one))).join(' ');
                into.write('info', name, '{0}', `${payload.api} ${payload.profile} `
                    + `${payload.entry}${defines ? ` defines=[${defines}]` : ''}`);
            }
            return;
        }
        into.write(SEVERITY[name] ?? 'info', name, '{0}', describeEvent(payload));
    });
}

/**
 * The call areas a run's journal starts with switched off; see `buildApp`.
 */
const CALLS_OFF = Object.freeze({
    'call.cpu': 'off', 'call.gpu': 'off', 'call.audio': 'off', 'call.video': 'off',
    'call.input': 'off', 'call.net': 'off', 'call.com': 'off', 'call.hook': 'off',
});

/**
 * The run's system where every process of it stands in a worker of its own
 * (`concurrency` above 1): this thread runs no program. What a process's
 * machine is to the page -- its log, its sound, its input, its files and
 * registry, the calls that look inside a running program -- this answers in
 * that shape. The journal, the sound output, the volume, the bundle and the
 * registry are the system's own, made here before any process; what only a
 * process has is asked of the run's first process across its link, and the
 * page's input goes to the process started last of those standing, as it
 * goes to a child the moment it starts.
 *
 * @param {{ options: import('../app-options.js').AppOptions, events: any, system: any,
 *     translationStore: any, reader: import('@bottlify/cellar').Reader | null,
 *     now: () => number,
 *     across: () => { image: string, id: number,
 *         link: ReturnType<typeof import('../system/link.js').openLink> }[],
 *     libraries: () => string[] }} deps
 *     `across`: the processes standing in workers, oldest first; `libraries`:
 *     the system libraries the run's own program knew, once it is over; `reader`:
 *     the run's cache, which the session's pieces are kept in
 */
export async function buildSystemHost(deps){
    const { options, events, system, translationStore, reader, now, across, libraries } = deps;
    const core = await assembleModules({
        ...Object.fromEntries(defaultModules().map(module=>[module.name, false])),
        log: { categories: { ...CALLS_OFF, ...options.log?.categories },
            capacity: options.log?.capacity, bytes: options.log?.bytes, now },
        filesystem: { volume: system.volume },
    });
    const filesystem = core.api('filesystem');
    const journal = core.api('log');
    journalEvents(events, journal.journal?.() ?? journal, { shaders: options.log?.shaders });
    system.registry = createRunRegistry({
        windows: options.windows,
        // A 64-bit Windows keeps its machine keys in both views: a volume laid
        // out by one has them so whatever machine runs it.
        machine: options.layout ?? options.machine,
        directx: options.graphicsApi
            ? GRAPHICS_CHOICES[options.graphicsApi].directx ?? undefined : undefined,
        processorMhz: CORK_TSC_MHZ,
        processorName: processorName(SETTINGS, await engineVersion(options.cork)),
        // The keys a process in a worker reads are these: they name as many
        // processors as its cpu layer will say it has.
        processors: processorsFor({ executors: options.cpu?.cores }),
    });
    system.windows = createWindowDirectory();
    const { seeded, saver, stopSavingRegistry } = await openSession({ options, events,
        filesystem, registry: system.registry, inherited: false, system });
    // Cork's own decoder reads the bundle's blocks: no processor is asked.
    const blocks = await furnishVolume({ options, events, filesystem,
        blocks: await mountBundle({ options, events, translationStore }), seeded, reader,
        registry: system.registry });
    system.bundle = blocks;
    // The output every process plays into, each in a span of its arena lent
    // it; the page's worklet reads the table. One the page did not hand in is
    // held in the run's cache, for the run's life.
    const given = options.audio?.memory;
    const memory = given && 'table' in given ? given : undefined;
    const held = memory ? null : cacheSpace(reader, 'sound').hold('run', TABLE_BYTES);
    if (!memory && held === null)
    {
        throw new Error('run: no room in the run\'s cache for the sound output');
    }
    const output = createMixer({ sampleRate: options.audio?.sampleRate, memory,
        made: held ? { table: held.bytes, release: held.release } : undefined });

    /** The run's own program: the first process standing. */
    const first = ()=>across()[0] ?? null;
    /**
     * What only a process has, asked of the run's own program.
     *
     * @param {string} path  a member of its machine, `debug.read`
     * @param {any[]} [args]
     */
    const ask = (path, args = [])=>{
        const process = first();
        return process
            ? process.link.call('facade', 'call', [path, args]).then(eventFrom)
            : Promise.reject(new Error(`${path}: no process of the run stands`));
    };
    /** Every process standing, told the same. @param {string} method */
    const tellAll = method=>{
        for (const process of across())
        {
            process.link.call('control', method, []).catch(()=>{});
        }
    };
    /** Whether the run was last told to pause, for a tool that must draw a frame. */
    let pausedByCaller = false;
    /** The canvas the page's pointer is measured on, once attached. @type {any} */
    let viewport = null;
    /**
     * The run's own program's tables, as it last answered or as it ended:
     * what a reader of the run's diagnostics wants of its processor, its
     * pacing and its devices is there, not on this thread.
     *
     * @type {any[]}
     */
    let programTables = [];
    /**
     * The tables this thread keeps for the run -- its journal, its sound
     * output, the window manager -- under the names a program's own tables
     * have where it runs on this thread. The program's journal and sound
     * (its phases, frames, pumps, buffers) are what a reader of a run wants
     * under those names, as with one process; this thread's go beside them,
     * always under the name given here, so a name says whose table it is.
     */
    const ownTables = new Map([['log', 'system-log'], ['audio', 'system-audio'],
        ['windows', 'windows']]);

    return {
        log: {
            /** @param {'error' | 'warn' | 'info'} level @param {string} category @param {string} text */
            write: (level, category, text)=>journal.write(level, category, '{0}', text),
            /** @param {number} [since] @param {number} [limit] */
            drain: (since, limit)=>journal.drain(since, limit),
            /** @param {number} [count] */
            recent: count=>journal.recent(count),
            journal: ()=>journal.journal?.() ?? null,
            /** @param {string} category @param {string | number} level */
            setLevel: (category, level)=>journal.setLevel(category, level),
            /** @param {string | number} level */
            setDefaultLevel: level=>journal.setDefaultLevel(level),
            /** @param {number} [worst] */
            profile: worst=>journal.profile(worst),
            /** @param {number} [count] */
            frames: count=>journal.frames(count),
            memory: ()=>journal.memory(),
        },
        audio: {
            /** @param {number} bytes */
            lend: bytes=>output.lend(bytes),
            /** @param {number} offset @param {number} bytes */
            takeBack: (offset, bytes)=>output.takeBack(offset, bytes),
            table: ()=>output.table,
            memory: ()=>output.memory,
            format: ()=>({ sampleRate: output.sampleRate, channels: output.channels }),
        },
        media: { instance: ()=>null },
        input: {
            /** @param {any} canvas */
            attach: canvas=>{
                viewport = canvas;
                return null;
            },
            detach: ()=>{
                viewport = null;
            },
            /** @param {any} event */
            send: event=>{
                // To the process of the window the run's manager says should
                // have it (`inputTarget`, where `routedInput` explains the rest).
                const standing = across();
                const { target, dropped } = inputRecipient(system.windows?.manager, event);
                if (dropped)
                {
                    return false;
                }
                const process = standing.find(each=>each.id === target) ?? standing.at(-1);
                process?.link.call('input', 'send', [event, viewport
                    ? { width: viewport.width, height: viewport.height } : null]).catch(()=>{});
                return Boolean(process);
            },
            poll: ()=>{},
            // The page's half has the keyboard's field; this thread has no page.
            showKeyboard: ()=>false,
            hideKeyboard: ()=>{},
            keyboardShown: ()=>false,
            /** @returns {ReturnType<typeof createInputRoute>} */
            route(){
                return createInputRoute(event=>this.send(event));
            },
        },
        pause: ()=>{
            pausedByCaller = true;
            tellAll('pause');
        },
        resume: ()=>{
            pausedByCaller = false;
            tellAll('resume');
        },
        paused: ()=>pausedByCaller,
        stop: ()=>tellAll('stop'),
        answerMessageBox: ()=>false,
        on: (/** @type {string} */ name, /** @type {(payload: any) => any} */ handler)=>
            events.on(name, handler),
        off: (/** @type {string} */ name, /** @type {(payload: any) => any} */ handler)=>
            events.off(name, handler),
        /** @param {(handle: number, text: string) => void} sink */
        attachLog(sink){
            events.on('output', (/** @type {any} */ payload)=>sink(payload.handle, payload.text));
        },
        guestProfile: {
            instructionStats: ()=>ask('guestProfile.instructionStats'),
            available: ()=>ask('guestProfile.available'),
            /** @param {any} how */
            start: how=>ask('guestProfile.start', [how]),
            stop: ()=>ask('guestProfile.stop'),
            read: ()=>ask('guestProfile.read'),
        },
        debug: {
            /** @param {number} address @param {number} length */
            read: (address, length)=>ask('debug.read', [address, length]),
            /** @param {string} commandLine */
            start: commandLine=>ask('debug.start', [commandLine]),
            /** @param {number} [count] */
            ringTrace: count=>ask('debug.ringTrace', count === undefined ? [] : [count]),
            /** @param {boolean} on */
            checkDraws: on=>ask('debug.checkDraws', [on === true]),
            /** @param {boolean} on */
            handleWords: on=>ask('debug.handleWords', [on !== false]),
            modules: ()=>ask('debug.modules'),
            /** @param {number} address */
            moduleAt: address=>ask('debug.moduleAt', [address]),
            windows: ()=>ask('debug.windows'),
            desktop: ()=>ask('debug.desktop'),
            /** @param {number} address @param {any} how */
            hook: (address, how)=>ask('debug.hook', [address, how]),
            /** @param {string} [names] */
            callRingSkip: names=>ask('debug.callRingSkip', [names ?? '']),
            /**
             * Every process of the run standing, oldest first: the run's own
             * program is the first, and `diagnostics` answers for it alone --
             * an installer's real work is in the child its launcher started.
             */
            processes: ()=>across().map(each=>({ id: each.id, image: each.image })),
            /**
             * One standing process's tables, as `diagnostics` gives the first's.
             *
             * @param {number} id
             */
            diagnosticsOf: id=>{
                const process = across().find(each=>each.id === id);
                return process
                    ? process.link.call('report', 'diagnostics', [])
                    : Promise.reject(new Error(`no process ${id} stands`));
            },
            ...liveDumpOf(options.device?.worker, {
                pause: ()=>{
                    pausedByCaller = true;
                    tellAll('pause');
                },
                resume: ()=>{
                    pausedByCaller = false;
                    tellAll('resume');
                },
                paused: ()=>pausedByCaller,
            }),
        },
        trace: ()=>ask('trace'),
        report: ()=>ask('report'),
        recordedSession: ()=>ask('recordedSession'),
        registry: ()=>system.registry,
        // Asked while the program stands; once it is over, what it knew.
        systemLibraries: ()=>(across().length > 0 ? ask('systemLibraries') : libraries()),
        session: {
            export: ()=>filesystem.export(undefined, { everyName: true }),
            directories: ()=>filesystem.exportDirectories(),
            /** @param {any[]} changes @param {{ quiet?: boolean }} [how] */
            apply: (changes, how)=>filesystem.apply(changes, how),
            generation: ()=>filesystem.generation(),
            /** @param {number} mark */
            changesSince: mark=>filesystem.changesSince(mark),
            runVolume: ()=>filesystem.runVolume(),
        },
        files: {
            /** @param {string} path */
            list: path=>filesystem.list(path).map((/** @type {any} */ entry)=>({
                name: entry.name, path: entry.path, directory: entry.directory === true,
                size: entry.size ?? 0, modified: entry.modified ?? 0 })),
            /** @param {string} path */
            read: path=>readWholeFile(filesystem, blocks, path),
        },
        /** @param {string} path */
        readImage: path=>readProgramImage(filesystem, blocks, path,
            options.layout ?? options.machine),
        /**
         * The program's tables as it last answered -- asked again now, for the
         * next reader -- with the journal and the sound output this thread
         * keeps for the run.
         */
        diagnostics: ()=>{
            first()?.link.call('report', 'diagnostics', []).then(tables=>{
                if (Array.isArray(tables))
                {
                    programTables = tables;
                }
            }, ()=>{});
            const own = [...core.diagnostics(),
                { name: 'audio', status: 'ready', metrics: output.diagnostics() },
                { name: 'windows', status: 'ready',
                    metrics: system.windows.manager.diagnostics() },
                // The bundle, mounted here for every process to read.
                { name: 'system-bundle', status: 'ready',
                    metrics: { bytesHeld: { heaps: blocks?.held?.() ?? {} } } },
                // The run's translation store, which only this thread holds, and the
                // compiled modules it keeps alive for the processes in workers.
                { name: 'system-store', status: 'ready', metrics: translationStore?.stats?.()
                    ?? { measured: false, reason: 'the run has no translation store' } }];
            const theirs = programTables.filter(table=>ownTables.get(table.name) !== table.name);
            const named = new Set(theirs.map(table=>table.name));
            // The zones' sums over both threads' tables, the process's own sums
            // made again with what this thread holds.
            return withZones([...own.map(table=>({ ...table,
                name: ownTables.get(table.name) ?? table.name }))
                .filter(table=>!named.has(table.name)), ...theirs]);
        },
        /** The program's tables as it ended. @param {any[] | undefined} tables */
        ended: tables=>{
            if (Array.isArray(tables))
            {
                programTables = tables;
            }
        },
        dispose(){
            tellAll('stop');
            saver?.flush();
            stopSavingRegistry();
            return core.dispose();
        },
    };
}
