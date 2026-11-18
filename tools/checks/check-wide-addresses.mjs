/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Fails when a 64-bit process's host handler answers otherwise for the same
 * call because its memory lies at another address: what a handler does may
 * depend on the bytes it is handed, never on where they are.
 *
 * Two win32 layers of a 64-bit process are built side by side, each over a
 * window of memory of its own - the arguments' bytes and the layer's arena,
 * whose allocations a handler hands back - one at a low base and one at a
 * base past 2 GiB (`HIGH`), the same bytes at the same offsets. Every handler
 * of every library is called on both, in the same order, with the same
 * arguments relative to its base, read as the bridge reads a 64-bit call
 * (`readLongCall`: each argument's low dword, its high dword beside it). A
 * difference is an offence:
 *
 * - the answer as the bridge puts it into RAX (a dword sign-extended, a
 *   bigint whole) differs other than by the bases' distance, for an answer
 *   that points into the window - VirtualAlloc, HeapAlloc, strchr answered
 *   0xFFFFFFFF_9... from a dword a host computes past 2 GiB;
 * - a dword the call wrote differs between the windows, unless its value
 *   differs by exactly the distance (a pointer written into an out-structure);
 *   a pointer written signed, its upper dword 0xFFFFFFFF, is a difference;
 * - one of the two throws what the other did not.
 *
 * Each handler is called once per argument place, that argument a pointer at
 * the window's data and every other a small count: a pointer read as a size
 * or a flag would itself differ by the base. A call that reaches a stand-in
 * on either side is not measured. The two layers keep their state from call
 * to call; a handler that answered otherwise may part their arenas for the
 * calls after it, which is why only the dwords a call itself writes are
 * compared.
 *
 * The kernel and the bridge are stood in for as in check-guest-pointers.mjs.
 * KNOWN lists what differs today, by `library!function`, so the gate runs
 * green while saying what is open: a new difference fails, and so does a
 * known one that no longer differs - the list only shrinks.
 *
 *     node tools/checks/check-wide-addresses.mjs [--list] [--high 0x90000000]
 *
 * `--list` prints every difference, known or not; `--high` moves the second
 * window (past 4 GiB once a 64-bit process's addresses reach there: the
 * memory accessors here take any number below 2^53).
 */

import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { isMain } from '../lib/common.mjs';
import { ORIGINAL_EXPORT } from '../../modules/core/src/layers/win32/msvcrt/invalid-parameter.js';
import { standIn } from './check-guest-pointers.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const LAYERS = join(ROOT, 'modules', 'core', 'src', 'layers');
const KNOWN_FILE = new URL('./wide-addresses-known.json', import.meta.url);

/** Where the two windows start: the low one where a 32-bit-safe program's memory is. */
export const LOW = 0x00100000;
export const HIGH = 0x90100000;
/** Each window's bytes: the arguments' data first, then the layer's arena. */
const WINDOW = 0x200000;
const DATA = 0x10000;
const ARENA = { offset: 0x40000, size: WINDOW - 0x40000 };

/** What a stand-in throws for a member it does not have (`check-guest-pointers.mjs`). */
const STAND_IN = 'STAND_IN';
/** The places a pointer is tried at, and what every other argument is. */
const MOST_PLACES = 8;
const SMALL = 0x10;

/** Calls whose answer is the end of the process or thread, not a return. */
const ENDS = /^(ExitProcess|ExitThread|FatalAppExit[AW]|FatalExit|FreeLibraryAndExitThread|RtlExitUserThread|RtlExitUserProcess|(Nt|Zw)Terminate(Process|Thread)|Terminate(Process|Thread|JobObject)|_?_?c?exit|_Exit|_amsg_exit|quick_exit|abort)$/;

/**
 * What differs today, by `library!function`: the list only shrinks.
 *
 * @returns {Set<string>}
 */
export function known(){
    return new Set(Object.keys(JSON.parse(readFileSync(KNOWN_FILE, 'utf8')).known));
}

/**
 * The bytes the arguments point at: a short string, a wide one, words of
 * small counts and flags, zeros - what most handlers read as a name, a
 * structure or a size.
 *
 * @returns {Uint8Array}
 */
function argumentBytes(){
    const bytes = new Uint8Array(ARENA.offset - DATA);
    const view = new DataView(bytes.buffer);
    bytes.set(new TextEncoder().encode('abc.txt\0'), 0);
    [...'abc.txt\0'].forEach((c, i)=>view.setUint16(0x20 + 2 * i, c.charCodeAt(0), true));
    for (let i = 0; i < 16; i++)
    {
        view.setUint32(0x40 + 4 * i, [0x10, 4, 1, 0, 0x20, 2, 8, 0][i % 8], true);
    }
    return bytes;
}

/**
 * A win32 layer of a 64-bit process over one window at `base`.
 *
 * @param {number} base
 */
async function layerAt(base){
    /** @param {string} path */
    const load = path=>import(`${pathToFileURL(join(LAYERS, path)).href}?at=${base}`);
    const { createMemoryModule } = await load('memory/module.js');
    const { createFilesystemModule } = await load('filesystem/module.js');
    const { win32Module } = await load('win32/module.js');
    const window = new Uint8Array(WINDOW);
    /** @param {number} at @param {number} length */
    const slice = (at, length)=>{
        const from = at - base;
        if (from < 0 || from + length > WINDOW)
        {
            throw Object.assign(new Error(`outside the window: 0x${at.toString(16)}`),
                { code: 'GUEST_ACCESS' });
        }
        return window.subarray(from, from + length);
    };
    const raw = {
        readPhysical: slice,
        /** @param {number} at @param {Uint8Array} data */
        writePhysical: (at, data)=>slice(at, data.length).set(data),
    };
    const memoryModule = createMemoryModule();
    const memory = await memoryModule.create({}, /** @type {any} */ ({
        requireApi: (/** @type {string} */ name)=>(name === 'cpu' ? raw : {}),
    }));
    memory.register({ name: 'window', base, size: WINDOW,
        kind: memory.RegionKind.STACK, access: memory.Access.READ_WRITE });
    window.set(argumentBytes(), DATA);
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
            placeLongCall: ()=>{},
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
        bits: 64,
        arena: { base: base + ARENA.offset, size: ARENA.size },
        idle: ()=>new Promise(()=>{}),
        fpu: standIn('fpu'),
        modules: { find: ()=>null, byBase: ()=>null, imagePath: ()=>'C:\\app.exe',
            versionInfo: ()=>null },
    }), /** @type {any} */ (host));
    return {
        base,
        window,
        libraries: api.libraries(),
        dispose: async()=>{
            await win32Module.dispose();
            await filesystemModule.dispose();
            await memoryModule.dispose();
        },
    };
}

/**
 * RAX as the bridge writes it for a 64-bit call (dispatch.js, `long`): a
 * bigint whole, a dword sign-extended.
 *
 * @param {unknown} answer
 * @returns {bigint | null}  null for no number (a promise left waiting, nothing)
 */
export function raxOf(answer){
    if (typeof answer === 'bigint')
    {
        return BigInt.asUintN(64, answer);
    }
    if (typeof answer === 'number')
    {
        return BigInt.asUintN(64, BigInt(answer | 0));
    }
    return null;
}

/**
 * Whether two answers are the same call's at two bases: equal, or each
 * pointing at the same offset of its own window.
 *
 * @param {bigint | null} low @param {bigint | null} high @param {number} lowBase
 * @param {number} highBase
 */
export function sameAnswer(low, high, lowBase, highBase){
    if (low === high)
    {
        return true;
    }
    if (low === null || high === null)
    {
        return false;
    }
    const inLow = low >= BigInt(lowBase) && low < BigInt(lowBase + WINDOW);
    return inLow && high - low === BigInt(highBase - lowBase);
}

/**
 * The offsets of the dwords one call wrote that differ between the two
 * windows other than by a pointer moved by the bases' distance: a dword at a
 * 4-byte boundary whose value is the low one's plus the distance, mod 2^32,
 * and points into the low window. Only what the call changed is compared - a
 * window the layers had already parted on before it is not this call's.
 *
 * @param {Uint8Array} lowBefore @param {Uint8Array} low
 * @param {Uint8Array} highBefore @param {Uint8Array} high
 * @param {number} lowBase @param {number} highBase
 * @returns {number[]}  the first few offsets, empty when the calls agree
 */
export function writeDifferences(lowBefore, low, highBefore, high, lowBase, highBase){
    /** @type {number[]} */
    const found = [];
    const view = (/** @type {Uint8Array} */ b)=>new DataView(b.buffer, b.byteOffset, b.length);
    const [lb, la, hb, ha] = [lowBefore, low, highBefore, high].map(view);
    const distance = (highBase - lowBase) >>> 0;
    for (let at = 0; at + 4 <= low.length && found.length < 4; at += 4)
    {
        const a = la.getUint32(at, true);
        const b = ha.getUint32(at, true);
        if (a === lb.getUint32(at, true) && b === hb.getUint32(at, true))
        {
            continue;
        }
        const moved = ((a + distance) >>> 0) === b && a >= lowBase && a < lowBase + WINDOW;
        if (a !== b && !moved)
        {
            found.push(at);
        }
    }
    return found;
}

/**
 * A handler's answer, or what it threw: a promise is given one turn.
 *
 * @param {Function} handler @param {number[]} args
 * @returns {Promise<{ answer?: unknown, threw?: string }>}
 */
async function outcome(handler, args){
    try
    {
        const answer = handler(args);
        if (typeof answer?.then !== 'function')
        {
            return { answer };
        }
        return await Promise.race([
            Promise.resolve(answer).then(value=>({ answer: value }),
                e=>({ threw: String(e?.code ?? e?.message ?? e) })),
            new Promise(settle=>setImmediate(()=>settle({ answer: undefined }))),
        ]);
    }
    catch (e){
        const error = /** @type {{ code?: unknown, message?: unknown }} */ (e);
        return { threw: String(error?.code ?? error?.message ?? e) };
    }
}

/**
 * The arguments of one call relative to a base, as the bridge hands a 64-bit
 * call: low dwords signed, the high dwords in `high`.
 *
 * @param {(number | 'p')[]} shape  'p' a pointer at the window's data, else a value
 * @param {number} base
 */
function argumentsAt(shape, base){
    const values = shape.map(v=>(v === 'p' ? base + DATA : v));
    const args = values.map(v=>Number(BigInt.asIntN(32, BigInt(v))));
    /** @type {any} */ (args).high = values.map(v=>Math.floor(v / 2 ** 32) >>> 0);
    return args;
}

/**
 * @typedef {Object} Difference
 * @property {string} key  `library!function`
 * @property {string} label  which arguments
 * @property {string} detail
 */

/**
 * Calls every handler on both layers in the same order and keeps what differs.
 *
 * @param {Awaited<ReturnType<typeof layerAt>>} low
 * @param {Awaited<ReturnType<typeof layerAt>>} high
 * @returns {Promise<{ handlers: number, calls: number, differences: Difference[],
 *     unmeasured: Set<string> }>}
 */
export async function compare(low, high){
    /** @type {Difference[]} */
    const differences = [];
    /** @type {Set<Function>} */
    const seen = new Set();
    /** @type {Set<string>} */
    const unmeasured = new Set();
    let handlers = 0;
    let calls = 0;
    const pristine = Uint8Array.from(low.window);
    for (const [library, table] of Object.entries(low.libraries))
    {
        for (const [name, entry] of Object.entries(table ?? {}))
        {
            const handler = (entry?.[ORIGINAL_EXPORT] ?? entry)?.handler;
            const twin = high.libraries[library]?.[name];
            const other = (twin?.[ORIGINAL_EXPORT] ?? twin)?.handler;
            if (typeof handler !== 'function' || typeof other !== 'function'
                || seen.has(handler) || ENDS.test(name))
            {
                continue;
            }
            seen.add(handler);
            handlers++;
            const count = Math.max(1, (entry.argBytes ?? 16) >>> 2);
            // One argument a pointer at a time, every other a small count: a
            // pointer read as a size or a flag would itself differ by the base.
            /** @type {[string, (number | 'p')[]][]} */
            const shapes = Array.from({ length: Math.min(count, MOST_PLACES) }, (_, place)=>[
                `argument ${place + 1} a pointer`,
                Array.from({ length: count }, (__, i)=>(i === place ? 'p' : SMALL))]);
            for (const [label, shape] of shapes)
            {
                calls++;
                // Each window as it was: a handler writes through what it is handed.
                low.window.set(pristine.subarray(0, ARENA.offset));
                high.window.set(pristine.subarray(0, ARENA.offset));
                const lowBefore = Uint8Array.from(low.window);
                const highBefore = Uint8Array.from(high.window);
                const a = await outcome(handler, argumentsAt(shape, low.base));
                const b = await outcome(other, argumentsAt(shape, high.base));
                const key = `${library}!${name}`;
                if (a.threw === STAND_IN || b.threw === STAND_IN)
                {
                    unmeasured.add(key);
                    continue;
                }
                if ((a.threw ?? null) !== (b.threw ?? null))
                {
                    differences.push({ key, label,
                        detail: `threw ${a.threw ?? 'nothing'} low,`
                            + ` ${b.threw ?? 'nothing'} high` });
                    continue;
                }
                const lowRax = raxOf(a.answer);
                const highRax = raxOf(b.answer);
                if (!sameAnswer(lowRax, highRax, low.base, high.base))
                {
                    differences.push({ key, label, detail: `RAX 0x${lowRax?.toString(16)} low,`
                        + ` 0x${highRax?.toString(16)} high` });
                    continue;
                }
                const at = writeDifferences(lowBefore, low.window, highBefore, high.window,
                    low.base, high.base);
                if (at.length > 0)
                {
                    differences.push({ key, label, detail: 'memory differs at window offset '
                        + at.map(o=>`0x${o.toString(16)}`).join(', ') });
                }
            }
        }
    }
    return { handlers, calls, differences, unmeasured };
}

async function main(){
    const at = process.argv.indexOf('--high');
    const highBase = at > 0 ? Number(process.argv[at + 1]) : HIGH;
    const low = await layerAt(LOW);
    const high = await layerAt(highBase);
    const { handlers, calls, differences, unmeasured } = await compare(low, high);
    await low.dispose();
    await high.dispose();
    const list = known();
    const differing = new Set(differences.map(d=>d.key));
    if (process.argv.includes('--list'))
    {
        for (const d of differences)
        {
            console.log(`${d.key} (${d.label}): ${d.detail}`);
        }
    }
    const fresh = differences.filter(d=>!list.has(d.key));
    const stale = [...list].filter(key=>!differing.has(key));
    for (const d of fresh)
    {
        console.error(`${d.key} with ${d.label}: ${d.detail}`);
    }
    for (const key of stale)
    {
        console.error(`${key} no longer differs: take it off tools/checks/wide-addresses-known.json`);
    }
    console.log(`wide addresses: ${handlers} handlers, ${calls} calls at 0x${LOW.toString(16)} and`
        + ` 0x${highBase.toString(16)}, ${new Set(fresh.map(d=>d.key)).size} new differences,`
        + ` ${differing.size - new Set(fresh.map(d=>d.key)).size} known,`
        + ` ${unmeasured.size} not measured (a stand-in reached)`);
    process.exitCode = fresh.length > 0 || stale.length > 0 ? 1 : 0;
}

if (isMain(import.meta.url))
{
    await main();
    process.exit(process.exitCode ?? 0);
}
