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
 * or a flag would itself differ by the base. One whose signature has no
 * address among its arguments is called once with small counts alone, for
 * its answer and what it writes. A call that reaches a stand-in
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
 *     node tools/checks/check-wide-addresses.mjs [--list] [--high 0x90000000] [--only RE]
 *         [--trace] [--known FILE] [--write-known]
 *
 * `--list` prints every difference, known or not; `--high` moves the second
 * window (past 4 GiB once a 64-bit process's addresses reach there: the
 * memory accessors here take any number below 2^53); `--only` calls just the
 * functions whose `library!function` matches the expression, and checks the
 * known list for those alone; `--trace` names each call on stderr before it is
 * made, so a run that stops in a handler says which. `--known` names the list
 * a run is held to (`wide-addresses-high.json` for the window at 0x140000000)
 * and `--write-known` writes it from what the run found.
 */

import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { isMain } from '../lib/common.mjs';
import { noCache } from '../../modules/core/src/layers/cache/module.js';
import { ORIGINAL_EXPORT } from '../../modules/core/src/layers/win32/msvcrt/invalid-parameter.js';
import { standIn } from './check-guest-pointers.mjs';
import { checkReturns, pointersOf } from './check-wide-arguments.mjs';
import { longAnswer, wholeAddresses, zeroExtendsOf } from '../../modules/core/src/layers/bridge/internal/dispatch.js';

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
/** The sizes of the heap blocks whose places say whether two layers' arenas parted. */
const PROBES = [16, 0x8000];

/** Calls whose answer is the end of the process or thread, not a return. */
const ENDS = /^(ExitProcess|ExitThread|FatalAppExit[AW]|FatalExit|FreeLibraryAndExitThread|RtlExitUserThread|RtlExitUserProcess|(Nt|Zw)Terminate(Process|Thread)|Terminate(Process|Thread|JobObject)|_?_?c?exit|_Exit|_amsg_exit|quick_exit|abort)$/;

/**
 * What differs today, by `library!function`: the list only shrinks.
 *
 * @returns {Set<string>}
 */
export function known(file = KNOWN_FILE){
    return new Set(Object.keys(JSON.parse(readFileSync(file, 'utf8')).known));
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
 * A win32 layer of a 64-bit process over one window at `base`, made of the
 * modules loaded for that base: made again once the two have parted.
 *
 * @param {number} base
 */
async function layerAt(base){
    const query = `?at=${base}`;
    /** @param {string} path */
    const load = path=>import(`${pathToFileURL(join(LAYERS, path)).href}${query}`);
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
        // The run's cache as a machine built alone has it: none, every read a miss.
        cache: noCache,
        log: standIn('log', { enabled: ()=>false, Level: {}, write: ()=>{} }),
        kernel: standIn('kernel', {
            // Where the win32 layer lends the pool its thread stacks, at create.
            lendStacks: ()=>{},
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
 * RAX as the bridge writes it for a 64-bit call: its own `longAnswer`, the
 * spec's type deciding (`zeroExtendsOf`) - an address zero-extended, any other
 * dword sign-extended.
 *
 * @param {unknown} answer @param {{ returns?: string }} [spec]
 * @returns {bigint | null}  null for no number (a promise left waiting, nothing)
 */
export function raxOf(answer, spec = {}){
    if (typeof answer === 'bigint' || typeof answer === 'number')
    {
        return longAnswer(answer, null, zeroExtendsOf(spec));
    }
    return null;
}

/**
 * The functions whose signature comment types their result as no address
 * (`checkReturns` over the layers' sources), by name: an `int` or a `DWORD`
 * the bridge sign-extends by its type, whose value may be anything a call
 * makes of an address it was handed. A name typed both ways somewhere is left
 * out, and so is one with no comment the check can read.
 *
 * @returns {Set<string>}
 */
export function valueResults(){
    return signatures().values;
}

/**
 * What the layers' signature comments say of each function, by name: the
 * results typed as no address (`valueResults`), and the dwords of its
 * parameters that hold an address (`pointersOf`), where every comment of that
 * name agrees.
 *
 * @returns {{ values: Set<string>, pointers: Map<string, number[]> }}
 */
export function signatures(){
    /** @type {Map<string, boolean>} */
    const typed = new Map();
    /** @type {Map<string, string | null>} */
    const places = new Map();
    /**
     * The other spelling of a name a comment gives one of (`PathIsUNCA` over a
     * maker of both, `CreateFile` over CreateFileA and CreateFileW): taken
     * where no comment of its own names it.
     *
     * @type {Map<string, string | null>}
     */
    const spelled = new Map();
    /** @param {Map<string, string | null>} into @param {string} name @param {string | null} list */
    const agree = (into, name, list)=>into.set(name,
        into.has(name) && into.get(name) !== list ? null : list);
    /** @param {string} name @returns {string | null} */
    const otherSpelling = name=>(/^\w{3,}[AW]$/.test(name)
        ? `${name.slice(0, -1)}${name.endsWith('A') ? 'W' : 'A'}` : null);
    /** @param {string} dir */
    const walk = dir=>{
        for (const name of readdirSync(dir))
        {
            const path = join(dir, name);
            if (statSync(path).isDirectory())
            {
                walk(path);
            }
            else if (name.endsWith('.js') && !/\.(i?test|fixture|x86|x64)\.js$/.test(name))
            {
                for (const one of checkReturns(readFileSync(path, 'utf8'), { exported: true }))
                {
                    const list = one.params == null ? null
                        : pointersOf(one.params, { addresses: true }).join(',');
                    const named = one.key ? [one.name, one.key] : [one.name];
                    for (const each of named)
                    {
                        typed.set(each, (typed.get(each) ?? false) || one.pointer);
                        agree(places, each, list);
                        const other = otherSpelling(each);
                        if (other)
                        {
                            agree(spelled, other, list);
                        }
                    }
                    if (one.key && one.key.startsWith(one.name)
                        && /^[AW]$/.test(one.key.slice(one.name.length)))
                    {
                        agree(spelled, `${one.name}${one.key.endsWith('A') ? 'W' : 'A'}`, list);
                    }
                }
            }
        }
    };
    walk(join(ROOT, 'modules', 'core', 'src', 'layers'));
    for (const [name, list] of spelled)
    {
        if (!places.has(name))
        {
            places.set(name, list);
        }
    }
    return {
        values: new Set([...typed].filter(([, pointer])=>!pointer).map(([name])=>name)),
        pointers: new Map([...places].filter(([, list])=>list !== null)
            .map(([name, list])=>[name, list ? String(list).split(',').map(Number) : []])),
    };
}

/** MSVC's codes of a type that is a number: `I` unsigned int, `_K` unsigned __int64. */
const MANGLED_NUMBERS = /^(?:[CDEFGHIJKMNO]|_[JKN])/;

/**
 * The address places of a function by its MSVC name (`??2@YAPAXI@Z`,
 * operator new(unsigned int); `?allocate@?$allocator@D@std@@QEAAPEAD_K@Z`,
 * a member): such a name carries no comment the gate can read, but its
 * parameter types are in it. A pointer or reference (`P`, `Q`, `A`, `E` for
 * __ptr64, a qualifier, the type it points at) is an address, and so is a
 * member's `this`, its first argument; a number is none. Null for a name read
 * otherwise (a class, a back reference, a constructor, which has no return
 * type): every place is then tried.
 *
 * @param {string} name
 * @returns {number[] | null}
 */
export function mangledPointers(name){
    const global = /^\?[^@]*@Y[A-Z]/.exec(name);
    if (global)
    {
        return mangledPlaces(name, global[0].length, false);
    }
    // A member's scope ends at an `@@` an access, `this`'s qualifiers and a
    // calling convention follow; one inside a template argument is tried and
    // fails to read.
    for (const one of name.matchAll(/@@[ABEFIJMNQRUV]E?[A-D][A-H]/g))
    {
        const places = mangledPlaces(name, (one.index ?? 0) + one[0].length, true);
        if (places)
        {
            return places;
        }
    }
    return null;
}

/**
 * @param {string} name @param {number} at  where the return type starts
 * @param {boolean} member  a `this` first
 * @returns {number[] | null}
 */
function mangledPlaces(name, at, member){
    /** @returns {boolean | null} whether the type at `at` is an address; null for one not read */
    const type = ()=>{
        const number = MANGLED_NUMBERS.exec(name.slice(at));
        if (number)
        {
            at += number[0].length;
            return false;
        }
        if (name[at] === 'X')
        {
            at += 1;
            return false;
        }
        if (/[PQA]/.test(name[at] ?? ''))
        {
            at += name[at + 1] === 'E' ? 3 : 2;
            return type() === null ? null : true;
        }
        return null;
    };
    if (type() === null)
    {
        return null;
    }
    const places = member ? [0] : [];
    for (let place = places.length; name.slice(at) !== '@Z' && name.slice(at) !== 'Z';
        place += 1)
    {
        const pointer = type();
        if (pointer === null)
        {
            return null;
        }
        if (pointer)
        {
            places.push(place);
        }
    }
    return places;
}

/**
 * Whether two answers are the same call's at two bases. Either equal, or each
 * pointing at the same offset of its own window; and by the result's type:
 * an address (`'address'`, zero-extended) is right wherever it points in its
 * own window - the two layers' arenas part once a call took a pointer for a
 * size - and a value (`'value'`, an `int` sign-extended by its type) is
 * compared in its low dword alone, the high half its sign as the type has it.
 *
 * @param {bigint | null} low @param {bigint | null} high @param {number} lowBase
 * @param {number} highBase @param {'address' | 'value'} [kind]
 */
export function sameAnswer(low, high, lowBase, highBase, kind){
    if (low === high)
    {
        return true;
    }
    if (low === null || high === null)
    {
        return false;
    }
    const inLow = low >= BigInt(lowBase) && low < BigInt(lowBase + WINDOW);
    const inHigh = high >= BigInt(highBase) && high < BigInt(highBase + WINDOW);
    if (kind === 'address')
    {
        return inLow && inHigh;
    }
    if (kind === 'value')
    {
        const l = BigInt.asUintN(32, low);
        const h = BigInt.asUintN(32, high);
        return l === h
            || BigInt.asUintN(32, h - l) === BigInt.asUintN(32, BigInt(highBase - lowBase));
    }
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

/** @typedef {Awaited<ReturnType<typeof layerAt>>} Layer */

/**
 * Where the next blocks of a layer's process heap lie, from its base: the same
 * on both layers while their arenas keep step. A small block and a large one
 * are taken and given back: a heap keeps blocks of a size apart, and a call
 * that left a large block on one side alone (a copy sized by a count read
 * from the data, kept where it then faulted) parts the large ones while the
 * small ones still agree - a later call's large block then lies over another
 * call's bytes in one window alone. Null where the heap answers nothing.
 *
 * @param {Layer} layer
 * @returns {string | null}
 */
function nextBlock(layer){
    const kernel = layer.libraries['KERNEL32.dll'];
    try
    {
        const blocks = PROBES.map(bytes=>kernel?.LocalAlloc?.handler?.([0, bytes]));
        for (const at of blocks)
        {
            if (typeof at === 'number' && at !== 0)
            {
                kernel?.LocalFree?.handler?.([at]);
            }
        }
        if (blocks.some(at=>typeof at !== 'number' || at === 0))
        {
            return null;
        }
        // A handler answers a dword: the block's place in the window by the base's
        // own low half, so a window past 4 GiB compares as one below it.
        return blocks.map(at=>((at >>> 0) - layer.base % 2 ** 32 + 2 ** 32) % 2 ** 32).join(',');
    }
    catch {
        return null;
    }
}

/**
 * Calls every handler on both layers in the same order and keeps what differs.
 * A call that sized an allocation by an address it was handed for a count
 * parts the two arenas: every block after it lies elsewhere in its window, and
 * the dwords later calls write would differ by that alone. So before each call
 * the next block of both heaps is compared, and where they parted `rebuild`
 * makes both layers again.
 *
 * @param {Layer} low @param {Layer} high
 * @param {RegExp | null} [only]  the `library!function` names to call, all where null
 * @param {((low: Layer, high: Layer) => Promise<{ low: Layer, high: Layer }>) | null} [rebuild]
 * @returns {Promise<{ handlers: number, calls: number, differences: Difference[],
 *     unmeasured: Set<string>, parted: string[], low: Layer, high: Layer }>}
 */
export async function compare(low, high, only = null, rebuild = null){
    // The layers called, made again where they parted; the order and the
    // handlers already called are the first layers'.
    let [lo, hi] = [low, high];
    /** @type {string[]} the calls after which the arenas were found parted */
    const parted = [];
    let last = '';
    /** @type {Difference[]} */
    const differences = [];
    // What a handler left to fail after its call answered - a chain it started
    // and did not await - is said of the call it came after, by the layer whose
    // module threw it (`?at=` its base), rather than ending the run.
    /** @type {unknown[]} */
    const late = [];
    const hearLate = (/** @type {unknown} */ e)=>{
        late.push(e);
    };
    process.on('unhandledRejection', hearLate);
    /** @type {Set<Function>} */
    const seen = new Set();
    /** @type {Set<string>} */
    const unmeasured = new Set();
    let handlers = 0;
    let calls = 0;
    let pristine = Uint8Array.from(low.window);
    const { values, pointers } = signatures();
    for (const [library, table] of Object.entries(low.libraries))
    {
        for (const [name, entry] of Object.entries(table ?? {}))
        {
            const handler = (entry?.[ORIGINAL_EXPORT] ?? entry)?.handler;
            const twin = high.libraries[library]?.[name];
            const other = (twin?.[ORIGINAL_EXPORT] ?? twin)?.handler;
            if (typeof handler !== 'function' || typeof other !== 'function'
                || seen.has(handler) || ENDS.test(name)
                || (only && !only.test(`${library}!${name}`)))
            {
                continue;
            }
            seen.add(handler);
            handlers++;
            const count = Math.max(1, (entry.argBytes ?? 16) >>> 2);
            // One argument a pointer at a time, every other a small count. Where
            // the signature says which are pointers only those are: a count or a
            // flag handed an address differs by the base as its own value, a
            // length of 0x90100000 is negative as an int - no width's doing.
            const typed = (pointers.get(name) ?? mangledPointers(name))
                ?.filter(place=>place < count);
            const places = typed ?? Array.from({ length: Math.min(count, MOST_PLACES) }, (_, i)=>i);
            /** @type {[string, (number | 'p')[]][]} */
            const shapes = places.map(place=>[
                `argument ${place + 1} a pointer`,
                Array.from({ length: count }, (__, i)=>(i === place ? 'p' : SMALL))]);
            // A function whose signature has no address in it is still called
            // once, for its answer: `long *__p__dstbias(void)` answers an
            // address of the window, which differs by the base or not at all.
            if (shapes.length === 0)
            {
                shapes.push(['no argument a pointer', Array.from({ length: count }, ()=>SMALL)]);
            }
            for (const [label, shape] of shapes)
            {
                calls++;
                if (rebuild && nextBlock(lo) !== nextBlock(hi))
                {
                    ({ low: lo, high: hi } = await rebuild(lo, hi));
                    pristine = Uint8Array.from(lo.window);
                    parted.push(last);
                }
                last = `${library}!${name} with ${label}`;
                if (TRACE)
                {
                    // The call a run stops in is the last line said.
                    process.stderr.write(`${last}\n`);
                }
                // Each window as it was: a handler writes through what it is handed.
                lo.window.set(pristine.subarray(0, ARENA.offset));
                hi.window.set(pristine.subarray(0, ARENA.offset));
                const lowBefore = Uint8Array.from(lo.window);
                const highBefore = Uint8Array.from(hi.window);
                const mine = lo.libraries[library]?.[name];
                const theirs = hi.libraries[library]?.[name];
                // The arguments as the bridge hands them: each the function
                // declares an address (`addresses`) whole past 4 GiB.
                const whole = mine?.addresses ?? mine?.[ORIGINAL_EXPORT]?.addresses ?? null;
                const bridged = (/** @type {any[]} */ args)=>{
                    wholeAddresses(whole, args, args.high);
                    return args;
                };
                const a = await outcome((mine?.[ORIGINAL_EXPORT] ?? mine).handler,
                    bridged(argumentsAt(shape, lo.base)));
                const b = await outcome((theirs?.[ORIGINAL_EXPORT] ?? theirs).handler,
                    bridged(argumentsAt(shape, hi.base)));
                const key = `${library}!${name}`;
                const lateBy = (/** @type {number} */ base)=>late.find(e=>String(
                    /** @type {{ stack?: unknown }} */ (e)?.stack).includes(`?at=${base}:`));
                const lateLow = lateBy(lo.base);
                const lateHigh = lateBy(hi.base);
                late.length = 0;
                if ((lateLow === undefined) !== (lateHigh === undefined))
                {
                    const said = (/** @type {any} */ e)=>(e === undefined ? 'nothing'
                        : String(e?.code ?? e?.message ?? e));
                    differences.push({ key, label, detail: `threw ${said(lateLow)} low,`
                        + ` ${said(lateHigh)} high, after it answered` });
                    continue;
                }
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
                const spec = entry?.[ORIGINAL_EXPORT] ?? entry;
                const lowRax = raxOf(a.answer, spec);
                const highRax = raxOf(b.answer, spec);
                const kind = zeroExtendsOf(spec) ? 'address'
                    : values.has(name) ? 'value' : undefined;
                if (!sameAnswer(lowRax, highRax, lo.base, hi.base, kind))
                {
                    differences.push({ key, label, detail: `RAX 0x${lowRax?.toString(16)} low,`
                        + ` 0x${highRax?.toString(16)} high` });
                    continue;
                }
                const at = writeDifferences(lowBefore, lo.window, highBefore, hi.window,
                    lo.base, hi.base);
                if (at.length > 0)
                {
                    differences.push({ key, label, detail: 'memory differs at window offset '
                        + at.map(o=>`0x${o.toString(16)}`).join(', ') });
                }
            }
        }
    }
    process.off('unhandledRejection', hearLate);
    return { handlers, calls, differences, unmeasured, parted, low: lo, high: hi };
}

/** `--trace`: each call named before it is made, for a run that never comes back. */
const TRACE = process.argv.includes('--trace');

async function main(){
    const option = (/** @type {string} */ name)=>{
        const at = process.argv.indexOf(name);
        return at > 0 ? process.argv[at + 1] : undefined;
    };
    const highBase = Number(option('--high') ?? HIGH);
    const only = option('--only') === undefined ? null : new RegExp(String(option('--only')));
    const knownFile = option('--known') ?? KNOWN_FILE;
    /** @type {{ handlers: number, calls: number, differences: { key: string, label: string,
     *     detail: string }[], unmeasured: Set<string>, parted: string[] }} */
    let found;
    const result = await compare(await layerAt(LOW), await layerAt(highBase), only,
        async(low, high)=>{
            // Made again of the same modules: a layer keeps its state in what
            // `create` answers, and modules loaded anew for each were never let go -
            // past 4 GiB, where half the calls part the arenas, the run died of them.
            await low.dispose();
            await high.dispose();
            return { low: await layerAt(LOW), high: await layerAt(highBase) };
        });
    await result.low.dispose();
    await result.high.dispose();
    found = result;
    const { handlers, calls, differences, unmeasured, parted } = found;
    if (process.argv.includes('--write-known'))
    {
        /** @type {Record<string, string>} */
        const entries = {};
        for (const d of differences)
        {
            entries[d.key] ??= `${d.label}: ${d.detail}`.slice(0, 160);
        }
        writeFileSync(knownFile, `${JSON.stringify({
            about: `What differs today between a 64-bit process's handlers at 0x${
                LOW.toString(16)} and 0x${highBase.toString(16)} (check-wide-addresses.mjs).`
                + ' Only shrinks: fix, then take the line off.',
            known: Object.fromEntries(Object.entries(entries).sort(([a], [b])=>
                (a < b ? -1 : a > b ? 1 : 0))),
        }, null, 1)}\n`);
    }
    const list = known(knownFile);
    const differing = new Set(differences.map(d=>d.key));
    if (process.argv.includes('--list'))
    {
        for (const d of differences)
        {
            console.log(`${d.key} (${d.label}): ${d.detail}`);
        }
    }
    const fresh = differences.filter(d=>!list.has(d.key));
    const stale = [...list].filter(key=>!differing.has(key) && (!only || only.test(key)));
    for (const d of fresh)
    {
        console.error(`${d.key} with ${d.label}: ${d.detail}`);
    }
    for (const key of stale)
    {
        console.error(`${key} no longer differs: take it off ${knownFile}`);
    }
    console.log(`wide addresses: ${handlers} handlers, ${calls} calls at 0x${LOW.toString(16)} and`
        + ` 0x${highBase.toString(16)}, ${new Set(fresh.map(d=>d.key)).size} new differences,`
        + ` ${differing.size - new Set(fresh.map(d=>d.key)).size} known,`
        + ` ${unmeasured.size} not measured (a stand-in reached),`
        + ` both layers made again ${parted.length} times where a call parted their arenas`
        + (parted.length > 0 ? ` (after ${parted.join('; ')})` : ''));
    process.exitCode = fresh.length > 0 || stale.length > 0 ? 1 : 0;
}

if (isMain(import.meta.url))
{
    await main();
    process.exit(process.exitCode ?? 0);
}
