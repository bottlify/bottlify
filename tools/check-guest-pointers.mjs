/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Fails when a host handler throws anything but a guest access fault on a
 * guest pointer it was handed -- or an exception it raises in the guest on
 * purpose, as Windows' function does.
 *
 * A host call answers a bad pointer, an empty string or a wrong length as
 * Windows does: an error code, or the access violation the processor would
 * have raised in the DLL. Memory reports the second as an error whose `code`
 * is GUEST_ACCESS (`modules/core/src/layers/memory/internal/faults.js`), the
 * one exception a handler may let through. Anything else -- a TypeError off a
 * structure that was not there, a typed array of length -1, the filesystem's
 * INVALID_PATH for an empty name, a string longer than a cap of the handler's
 * own -- stops the run with a host exception where Windows went on: an
 * installer's atom name of 256 characters, Wine's kernel32, user32, msi,
 * cabinet, version, shlwapi and shell32 tests each stopped so.
 *
 * Every handler of every library the win32 layer builds is called with each
 * argument NULL, then a pointer to memory that is not there, then a pointer
 * to bytes with no terminator before their region ends, then a pointer to a
 * string of 64 KiB -- longer than any cap a handler might keep, as long as
 * Windows lets a string be -- then the empty string, then a tab: a path the
 * filesystem refuses outright, in either width. The layer runs over
 * the real memory accessors and filesystem, and over stand-ins for the
 * kernel and the bridge: a call that reaches a stand-in's missing member is
 * counted as not measured, not as passing. A library's alias (d3dx9_24 to
 * d3dx9_43, the C runtimes) shares its handlers and is called once. What
 * ends the process or the thread is left out: its answer is not a return.
 *
 * KNOWN lists what throws today, each with whose it is and why: a new throw
 * fails, and so does a known one that no longer throws, so the list only
 * shrinks.
 *
 *     node tools/check-guest-pointers.mjs [--list]
 *
 * `--list` prints every call that threw, known or not.
 */

import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const LAYERS = join(ROOT, 'modules', 'core', 'src', 'layers');

/** What memory calls a refused guest access. */
const GUEST_ACCESS = 'GUEST_ACCESS';
/** An exception a handler raises in the guest on purpose (`win32/common/raise.js`). */
const GUEST_EXCEPTION = 'GUEST_EXCEPTION';
/** What a stand-in throws for a member it does not have. */
export const STAND_IN = 'STAND_IN';

/** Calls whose answer is the end of the process or thread, not a return. */
const ENDS = /^(ExitProcess|ExitThread|FatalAppExit[AW]|FatalExit|FreeLibraryAndExitThread|RtlExitUserThread|RtlExitUserProcess|(Nt|Zw)Terminate(Process|Thread)|Terminate(Process|Thread|JobObject)|_?_?c?exit|_Exit|_amsg_exit|quick_exit|abort)$/;

/**
 * Throws today, by `library!function`, with whose it is and why.
 *
 * @type {Map<string, string>}
 */
export const KNOWN = new Map([
    // Windows raises EXCEPTION_INT_DIVIDE_BY_ZERO; msvcrt's handler says so
    // instead of raising it (`common/raise.js` raises it).
    // Guest code whose handler is the reference only: the guest's routine
    // reads registers or the x87 stack no handler is passed.
    ['ntdll.dll!_allshl', 'guest code: EDX:EAX and CL, which no handler is passed'],
    ['ntdll.dll!_allshr', 'guest code: EDX:EAX and CL, which no handler is passed'],
    ['ntdll.dll!_aullshr', 'guest code: EDX:EAX and CL, which no handler is passed'],
    ['d3dx9_24.dll!D3DXMatrixDeterminant', 'guest code: answers on the x87 stack'],
    ['d3dx9_24.dll!D3DXFresnelTerm', 'guest code: answers on the x87 stack'],
    // Gaps of their libraries' own, outside the host-crash package that
    // made this list.
    ['ole32.dll!FreePropVariantArray', 'ole32: a count read as a VARIANT recurses for ever'],
    ['SHLWAPI.dll!PathFileExistsA', 'shlwapi: a path the filesystem refuses (INVALID_PATH)'],
    ['SHLWAPI.dll!PathFileExistsW', 'shlwapi: a path the filesystem refuses (INVALID_PATH)'],
    ['SHLWAPI.dll!PathIsDirectoryA', 'shlwapi: a path the filesystem refuses (INVALID_PATH)'],
    ['SHLWAPI.dll!PathIsDirectoryW', 'shlwapi: a path the filesystem refuses (INVALID_PATH)'],
    ['WINTRUST.dll!CryptCATOpen', 'wintrust: an empty path, or one refused (INVALID_PATH)'],
]);

/**
 * What one call's exception says about the handler.
 *
 * @param {unknown} error
 * @returns {'fault' | 'unmeasured' | 'throw'}
 */
export function classify(error){
    const code = /** @type {{ code?: unknown }} */ (error)?.code;
    return code === GUEST_ACCESS || code === GUEST_EXCEPTION ? 'fault'
        : code === STAND_IN ? 'unmeasured' : 'throw';
}

/**
 * @typedef {Object} Offence
 * @property {string} key  `library!function`
 * @property {string} label  Which arguments.
 * @property {string} message
 * @property {string} at  The frame it was thrown from.
 */

/**
 * Calls every handler of every library once per argument set and keeps what
 * threw other than a fault.
 *
 * A promise is given one turn of the event loop to settle: an answer that
 * waits on a thread, a timer or the program is no answer this can read, and
 * waiting longer turns a sweep of thousands of calls into minutes.
 *
 * @param {Record<string, Record<string, any>>} libraries
 * @param {[string, number][]} sets  A label and the value every argument takes.
 * @param {() => void} [prepare]  Puts the memory the values point at back as
 *     it was, before each call: a handler writes through what it is handed.
 * @returns {Promise<{ handlers: number, calls: number, offences: Offence[],
 *     unmeasured: Set<string> }>}
 */
export async function sweep(libraries, sets, prepare = ()=>{}){
    /** @type {Set<Function>} */
    const seen = new Set();
    /** @type {Offence[]} */
    const offences = [];
    /** @type {Set<string>} */
    const unmeasured = new Set();
    let handlers = 0;
    let calls = 0;
    for (const [library, table] of Object.entries(libraries))
    {
        for (const [name, entry] of Object.entries(table ?? {}))
        {
            const handler = entry?.handler;
            if (typeof handler !== 'function' || seen.has(handler) || ENDS.test(name))
            {
                continue;
            }
            seen.add(handler);
            handlers++;
            const key = `${library}!${name}`;
            const count = Math.max(1, (entry.argBytes ?? 16) >>> 2);
            for (const [label, value] of sets)
            {
                calls++;
                prepare();
                const error = await outcome(handler, new Array(count).fill(value));
                const kind = error === null ? 'fault' : classify(error);
                if (kind === 'unmeasured')
                {
                    unmeasured.add(key);
                }
                else if (kind === 'throw')
                {
                    const thrown = /** @type {{ message?: unknown, stack?: unknown }} */ (error);
                    offences.push({
                        key,
                        label,
                        message: String(thrown?.message ?? error),
                        at: String(thrown?.stack ?? '').split('\n')[1]?.trim() ?? '',
                    });
                }
            }
        }
    }
    return { handlers, calls, offences, unmeasured };
}

/**
 * What a call threw, or the promise it answered rejected with; null when it
 * answered, or has not settled within a turn.
 *
 * @param {Function} handler @param {number[]} args
 * @returns {Promise<unknown>}
 */
async function outcome(handler, args){
    try
    {
        const answer = handler(args);
        if (typeof answer?.then !== 'function')
        {
            return null;
        }
        return await Promise.race([
            Promise.resolve(answer).then(()=>null, e=>e ?? new Error('rejected')),
            new Promise(settle=>setImmediate(()=>settle(null))),
        ]);
    }
    catch (e){
        return e ?? new Error('threw');
    }
}

/**
 * A stand-in for an API: the members given, and for any other a function
 * that throws STAND_IN when called -- and whose own members are the same, so
 * `kernel.processes.all()` is not measured rather than a TypeError.
 *
 * @param {string} what @param {Record<string | symbol, any>} [given]
 * @returns {any}
 */
export function standIn(what, given = {}){
    /** @param {string} path @returns {any} */
    const missing = path=>new Proxy(function(){}, {
        get: (_, key)=>(typeof key === 'symbol' ? undefined : missing(`${path}.${key}`)),
        apply: ()=>{
            throw Object.assign(new Error(`stand-in ${path}`), { code: STAND_IN });
        },
    });
    return new Proxy(given, {
        get: (target, key)=>(key in target || typeof key === 'symbol' ? target[key]
            : missing(`${what}.${String(key)}`)),
    });
}

/** Where the memory under the sweep is, and the bytes with no terminator. */
const HEAP = { base: 0x100000, size: 0x100000 };
const UNENDED = 0x40;
/** The long string, terminated, at the start of the heap; the short ones after it. */
const LONG = 0x10000;
const EMPTY = LONG + 0x10;
const TAB = LONG + 0x20;

/**
 * The win32 layer's libraries over real memory and a real filesystem, the
 * kernel and the bridge stood in for.
 *
 * @returns {Promise<{ libraries: Record<string, Record<string, any>>,
 *     sets: [string, number][], prepare: () => void, dispose: () => Promise<void> }>}
 */
async function build(){
    /** @param {string} path */
    const load = path=>import(pathToFileURL(join(LAYERS, path)).href);
    const { createMemoryModule } = await load('memory/module.js');
    const { createFilesystemModule } = await load('filesystem/module.js');
    const { win32Module } = await load('win32/module.js');

    const bytes = new Uint8Array(HEAP.base + HEAP.size);
    const raw = {
        /** @param {number} at @param {number} length */
        readPhysical: (at, length)=>bytes.subarray(at, at + length),
        /** @param {number} at @param {Uint8Array} data */
        writePhysical: (at, data)=>bytes.set(data, at),
    };
    const memoryModule = createMemoryModule();
    const memory = await memoryModule.create({}, /** @type {any} */ ({
        requireApi: (/** @type {string} */ name)=>(name === 'cpu' ? raw : {}),
    }));
    memory.register({ name: 'heap', base: HEAP.base, size: HEAP.size,
        kind: memory.RegionKind.STACK, access: memory.Access.READ_WRITE });
    const tail = HEAP.base + HEAP.size - UNENDED;
    bytes.fill(0x41, HEAP.base, HEAP.base + LONG);
    bytes[HEAP.base + TAB] = 0x09;
    bytes.fill(0x41, tail);
    /** @type {[number, Buffer][]} */
    const pristine = [[HEAP.base, Buffer.from(bytes.subarray(HEAP.base, HEAP.base + LONG + 0x40))],
        [tail, Buffer.from(bytes.subarray(tail))]];
    // Compared before it is copied: most calls write nothing there, and a
    // comparison is a fraction of a 64 KiB copy.
    const prepare = ()=>{
        for (const [at, was] of pristine)
        {
            const now = Buffer.from(bytes.buffer, bytes.byteOffset + at, was.length);
            if (!now.equals(was))
            {
                bytes.set(was, at);
            }
        }
    };
    const filesystemModule = createFilesystemModule();
    const filesystem = await filesystemModule.create({});

    const thread = { id: 1, tebAddress: 0 };
    /** @type {Map<number, { type: string, object: any }>} */
    const opened = new Map();
    let next = 0x100;
    /** @type {Record<string, any>} */
    const apis = {
        memory,
        filesystem,
        log: standIn('log', { enabled: ()=>false, Level: {}, write: ()=>{} }),
        kernel: standIn('kernel', {
            handles: standIn('kernel.handles', {
                /** @param {string} type @param {any} object */
                open(type, object){
                    next += 4;
                    opened.set(next, { type, object });
                    return next;
                },
                /** @param {number} handle */
                close: handle=>(opened.delete(handle) ? true : null),
                /** @param {number} handle */
                resolve: handle=>opened.get(handle)?.object ?? null,
                /** @param {number} handle */
                typeOf: handle=>opened.get(handle)?.type ?? null,
            }),
            clock: standIn('kernel.clock', { virtualTime: ()=>0, wallClock: ()=>0 }),
            currentThread: ()=>thread,
            processors: ()=>1,
            // What the layer's assembly itself asks for.
            exitThread: ()=>{},
            setEvent: ()=>{},
            onTimeout: ()=>{},
        }),
        bridge: standIn('bridge', {
            register: ()=>0,
            park: ()=>0,
            useHeap: ()=>{},
            publishInterface: ()=>0,
            label: ()=>{},
            // Handlers are called here directly, not through the dispatcher:
            // a fault stays the error it is, which this counts as allowed.
            onGuestFault: ()=>{},
            callerThread: ()=>thread,
            callGuest: ()=>new Promise(()=>{}),
            /** @param {unknown} _ @param {() => unknown} fn */
            answering: (_, fn)=>fn(),
        }),
    };
    const host = {
        /** @param {string} name */
        requireApi: name=>apis[name] ?? standIn(name),
        provide: ()=>{},
    };
    const api = await win32Module.create(/** @type {any} */ ({
        arena: { base: HEAP.base + 2 * LONG, size: HEAP.size - 4 * LONG },
        // Nothing to wait for: a call that would idle until the program
        // acts waits for ever, rather than spinning the sweep's turn.
        idle: ()=>new Promise(()=>{}),
        fpu: standIn('fpu'),
        modules: { find: ()=>null, byBase: ()=>null, imagePath: ()=>'C:\\app.exe',
            versionInfo: ()=>null },
    }), /** @type {any} */ (host));
    return {
        libraries: api.libraries(),
        sets: [['NULL', 0], ['unmapped', 0xdeadbeef], ['unterminated', tail],
            ['a long string', HEAP.base], ['the empty string', HEAP.base + EMPTY],
            ['a tab', HEAP.base + TAB]],
        prepare,
        dispose: async()=>{
            await win32Module.dispose();
            await filesystemModule.dispose();
            await memoryModule.dispose();
        },
    };
}

async function main(){
    const { libraries, sets, prepare, dispose } = await build();
    const { handlers, calls, offences, unmeasured } = await sweep(libraries, sets, prepare);
    await dispose();
    if (process.argv.includes('--list'))
    {
        for (const offence of offences)
        {
            console.log(`${offence.key} (${offence.label}): ${offence.message}  ${offence.at}`);
        }
    }
    const threw = new Set(offences.map(offence=>offence.key));
    const fresh = offences.filter(offence=>!KNOWN.has(offence.key));
    const stale = [...KNOWN.keys()].filter(key=>!threw.has(key));
    for (const offence of fresh)
    {
        console.error(`${offence.key} with every argument ${offence.label}: ${offence.message}`
            + `\n    ${offence.at}`);
    }
    for (const key of stale)
    {
        console.error(`${key} no longer throws: take it off KNOWN`
            + ' in tools/check-guest-pointers.mjs');
    }
    console.log(`guest pointers: ${handlers} handlers, ${calls} calls, `
        + `${fresh.length} new host throws, ${threw.size - new Set(fresh.map(f=>f.key)).size}`
        + ` known, ${unmeasured.size} not measured`);
    process.exitCode = fresh.length > 0 || stale.length > 0 ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
{
    await main();
    // A call left waiting holds a timer or a promise open; the answer is in.
    process.exit(process.exitCode ?? 0);
}
