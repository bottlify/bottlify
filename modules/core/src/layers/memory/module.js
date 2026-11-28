/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { Access, RegionKind, createRegionMap } from './internal/regions.js';
import { createAccessors } from './internal/accessors.js';
import { DwordReader } from './internal/reader.js';
import { WRITER_COLUMNS, WRITER_COUNTS, WRITER_ROWS, createWriterAccount } from './internal/writers.js';
import { createPort } from '../../system/port.js';

/** @typedef {import('../../system/port.js').Port} Port */

/**
 * memory — the guest address space: what is mapped, who may touch it, and typed
 * access to it.
 *
 * Sits on cpu because that is where the raw bytes are; everything above should
 * come through here rather than poking physical memory directly, so that an
 * unmapped or wrongly-permitted access is an error instead of a silent write.
 */

/**
 * The layout as published: name as a dictionary id, base, size, and access
 * as its index in `Access`. A program of this era maps a few hundred images
 * and stacks; the rows past that are not published, and `regions` in the
 * diagnostics says how many there really are.
 */
export const REGION_COLUMNS = ['name', 'base', 'size', 'access'];
const REGION_ROWS = 1024;

/**
 * What this layer publishes as numbers. Both are the frame's rather than the
 * run's: which host call wrote most into the guest during the frame that just
 * closed, and how much. The run's totals are in the writers table, which is
 * cumulative.
 */
export const MEMORY_COUNTERS = ['frameWriter', 'frameWriterBytes'];

/** The empty answer `readBytes`/`window` give once this instance is disposed. */
const EMPTY = new Uint8Array(0);

/**
 * A number some bitwise operator made a signed dword, as the address or value it
 * names: no guest address is negative.
 *
 * @param {number} value
 */
const unsigned = value=>(value < 0 ? value >>> 0 : value);

/**
 * Whether a pointer is a quadword: 8 bytes in a 64-bit process, 4 in a 32-bit
 * one; any other width is a caller's mistake, refused rather than guessed.
 *
 * @param {number} bytes
 */
const pointerWide = bytes=>{
    if (bytes !== 4 && bytes !== 8)
    {
        throw new Error(`memory: a pointer is 4 or 8 bytes, not ${bytes}`);
    }
    return bytes === 8;
};

/**
 * Whether `bytes` at `address` lie inside a shared view of the RAM: an address
 * past it - a wide window's past 4 GiB, where the view may not reach - goes by
 * the accessors, never by an index that `>>>` wrapped onto another word.
 *
 * @param {Int32Array | BigInt64Array} view @param {number} address @param {number} bytes
 */
const within = (view, address, bytes)=>unsigned(address) + bytes <= view.byteLength;

/** Where a quadword pointer is put together before it is written in one store. */
const pointerBytes = new Uint8Array(8);
const pointerScratch = new DataView(pointerBytes.buffer);

/** The memory layer's module for one graph; see `defaultModules`. */
export function createMemoryModule(){
    /**
     * The instance this module object made last, for `diagnostics()` and
     * `dispose()`. Every graph is given module objects of its own
     * (`defaultModules`), so a child's graph built beside its parent's has
     * its own and neither one's going reaches the other's.
     *
     * The module contract puts both on the module rather than on the api, so
     * something outside a `create()` call has to be able to see in. That is
     * the only reason this exists, and it holds a reference rather than the
     * state itself -- the region map and the writer account belong to the
     * closure `create()` returns, so a second instance in one realm cannot
     * take the first one's layout.
     *
     * @type {any}
     */
    let current = null;

    return {
        name: 'memory',
        version: '0.1.0',
        requires: /** @type {readonly string[]} */ (['cpu', 'log']),

        /**
         * @param {any} config
         * @param {import('../../system/contract.js').ScopedModuleHost} host
         * @returns {Promise<any>}
         */
        async create(config, host){
            // The module contract describes an API as an open record, so the shape
            // this layer needs from cpu is asserted here rather than inferred.
            const cpu = /** @type {import('./internal/accessors.js').RawMemory} */ (
                /** @type {unknown} */ (host.requireApi('cpu')));
            const log = host.requireApi('log');

            /**
             * Everything this instance owns, and whether it is still open.
             *
             * The calls an api hands out close over this object rather than over
             * module-level bindings, because `create()` may run more than once in
             * one realm -- a process replacement does, and the plan for more than
             * one machine in a worker needs two at once -- so each run keeps its
             * own region map, accessors and writer account.
             *
             * @type {{ regions: any, accessors: any,
             *          reader: DwordReader | null,
             *          writers: import('./internal/writers.js').WriterAccount | null,
             *          disposed: boolean }}
             */
            const state = {
                regions: null, accessors: null, reader: null, writers: null, disposed: false,
            };
            state.regions = createRegionMap();

            // Who wrote what into the guest, by name.
            const account = createWriterAccount({ table: log.metrics.table('memory', 'writers',
                { rows: WRITER_ROWS, columns: WRITER_COLUMNS, counting: WRITER_COUNTS }),
            intern: log.intern });
            state.writers = account;
            const counters = log.metrics.counters('memory', MEMORY_COUNTERS);
            log.metrics.onFrame(()=>{
                const busiest = account.publish();
                counters.set(0, 0, busiest.writer);
                counters.set(0, 1, busiest.bytes);
            });
            state.reader = new DwordReader(state.regions,
                /** @type {import('./internal/reader.js').ReaderMachine} */ (cpu));
            state.accessors = createAccessors({
                raw: cpu, regions: state.regions, charge: account.charge,
                reader: state.reader,
            });

            // The layout as a table a reader elsewhere can name a page from:
            // one row per region, its name as a dictionary id. Written when a
            // region is registered or reprotected, which is rare, and never
            // walked on request.
            const table = log.metrics.table('memory', 'regions',
                { rows: REGION_ROWS, columns: REGION_COLUMNS });
            const publish = ()=>{
                const mapped = state.regions.list();
                const rows = Math.min(mapped.length, table.rows);
                for (let row = 0; row < rows; row++)
                {
                    const region = mapped[row];
                    table.set(row, 0, log.intern(region.name));
                    table.set(row, 1, region.base);
                    table.set(row, 2, region.size);
                    table.set(row, 3, Object.values(Access).indexOf(region.access));
                }
                table.use(rows);
            };

            /**
             * Whether this instance is still open. A call still in flight when
             * the machine was disposed must not find the region map gone: it
             * answers the harmless value below -- an empty read, a write that
             * does nothing -- rather than dereferencing what disposal took away.
             */
            const live = ()=>!state.disposed;
            /** The RAM as dwords, where it is shared with other threads; null where not. */
            /** @type {Int32Array | null | undefined} */
            let ramWords;
            const sharedWords = ()=>{
                if (ramWords === undefined)
                {
                    /** @type {Uint8Array | null} */
                    let ram;
                    try
                    {
                        ram = /** @type {any} */ (cpu).ramView();
                    }
                    catch {
                        // No machine yet: asked again next time.
                        return null;
                    }
                    ramWords = ram && typeof SharedArrayBuffer === 'function'
                        && ram.buffer instanceof SharedArrayBuffer && ram.byteOffset % 4 === 0
                        ? new Int32Array(ram.buffer, ram.byteOffset,
                            Math.floor(ram.byteLength / 4))
                        : null;
                }
                return ramWords;
            };
            /** The same RAM by quadword, for the 64-bit swap. @type {BigInt64Array | null | undefined} */
            let ramQuads;
            const sharedQuads = ()=>{
                if (ramQuads === undefined)
                {
                    const words = sharedWords();
                    if (words === null)
                    {
                        return null;
                    }
                    ramQuads = words.byteOffset % 8 === 0
                        ? new BigInt64Array(words.buffer, words.byteOffset,
                            Math.floor(words.length / 2))
                        : null;
                }
                return ramQuads;
            };
            // A memory that grows as the guest is given more: these views end where
            // it ended, and are taken again.
            /** @type {any} */ (cpu).onGrow(()=>{
                ramWords = undefined;
                ramQuads = undefined;
            });

            current = state;
            /** The port at each pointer width, made once. @type {Record<number, Port>} */
            const ports = {};
            const api = {
                Access,
                RegionKind,

                /**
                 * The guest memory port at a process's pointer width
                 * (`system/port.js`): how every layer reads and writes the
                 * guest's memory, over this layer's checked accessors.
                 *
                 * @param {4 | 8} [pointerSize] @returns {Port}
                 */
                port: (pointerSize = 4)=>(ports[pointerSize] ??= createPort(api, pointerSize)),

                /** @param {any} region */
                register: region=>{
                    if (!live())
                    {
                        return null;
                    }
                    // An image mapped is the guest's to write: given, and counted
                    // against the machine's memory, refused where it has no room.
                    if (region?.kind === RegionKind.IMAGE
                        && /** @type {any} */ (cpu).chargeGuest(region.size ?? 0) === false)
                    {
                        throw Object.assign(new Error(`memory: the machine's memory has no room`
                            + ` for ${region.name ?? 'an image'}`), { code: 'MACHINE_MEMORY' });
                    }
                    const made = state.regions.register(region);
                    publish();
                    return made;
                },
                /** @param {string} name */
                unregister: name=>{
                    if (!live())
                    {
                        return;
                    }
                    state.regions.unregister(name);
                    publish();
                },
                /** @param {string} name @param {string} access */
                protect: (name, access)=>{
                    if (!live())
                    {
                        return;
                    }
                    state.regions.protect(name, access);
                    publish();
                },
                /**
                 * Opens or closes pages to the program: a reservation's commit,
                 * VirtualProtect. False where the processor does not fault a read
                 * of a closed page (the cpu layer's `pageAccess`).
                 *
                 * @param {number} address @param {number} length @param {boolean} open
                 * @returns {boolean}
                 */
                pageAccess: (address, length, open)=>live()
                    && /** @type {any} */ (cpu).pageAccess(address, length, open) === true,
                /**
                 * Where the process may reserve past 4 GiB (the cpu layer's far
                 * chunks), and the chunk a frame stands for: each chunk there the
                 * program commits is given a frame of the window (`mapFar`). Null
                 * where it may not.
                 *
                 * @returns {{ base: number, top: number, chunk: number, direct?: number,
                 *     table?: number } | null}
                 */
                farSpace: ()=>(live() ? /** @type {any} */ (cpu).farSpace() : null),
                /**
                 * Gives the far chunk `address` lies in the window's frame `frame`,
                 * or takes its frame (-1).
                 *
                 * @param {number} address @param {number} frame
                 */
                mapFar: (address, frame)=>{
                    if (live())
                    {
                        /** @type {any} */ (cpu).mapFar(address, frame);
                    }
                },
                /**
                 * Grows the guest's memory to hold `end` bytes of RAM, where it grows
                 * as the guest is given more (the cpu layer's `growTo`): what gives the
                 * guest memory -- an allocator placing a block, a mapping -- asks for
                 * its reach first. Answers the RAM held, less than `end` where the
                 * memory could not grow.
                 *
                 * @param {number} end
                 * @returns {number}
                 */
                reach: end=>(live() ? /** @type {any} */ (cpu).growTo(end) : 0),
                /**
                 * Bytes the guest is given -- a heap's reach past its highest, a
                 * commit, a stack -- taken from the machine's memory (the cpu
                 * layer's `chargeGuest`); false where it has no room, and what asked
                 * fails as an allocation Windows has no memory for.
                 *
                 * @param {number} bytes
                 * @returns {boolean}
                 */
                charge: bytes=>!live() || /** @type {any} */ (cpu).chargeGuest(bytes) !== false,
                /** Bytes the guest was given back. @param {number} bytes */
                uncharge: bytes=>{
                    if (live())
                    {
                        /** @type {any} */ (cpu).giveGuest(bytes);
                    }
                },
                /** The RAM the guest's memory holds now. @returns {number} */
                held: ()=>(live() ? /** @type {any} */ (cpu).ramHeld() : 0),
                /** Whether the guest's memory grows as the guest is given more. */
                growing: ()=>live() && /** @type {any} */ (cpu).growing() === true,
                /**
                 * Called with the RAM held each time the guest's memory grows.
                 *
                 * @param {(held: number) => void} listener
                 */
                onGrow: listener=>/** @type {any} */ (cpu).onGrow(listener),
                /** The guest range the engine keeps for its tables; empty where none. */
                engineRange: ()=>/** @type {any} */ (cpu).engineRange(),
                /** @param {number} address */
                find: address=>live() ? state.regions.find(address) : undefined,
                /** @param {number} address */
                nextRegionAfter: address=>(live()
                    ? state.regions.nextRegionAfter(address) : undefined),
                list: ()=>live() ? state.regions.list() : [],
                /**
                 * @param {number} address
                 * @param {number} length
                 * @param {'read' | 'write' | 'execute'} mode
                 */
                assert: (address, length, mode)=>live()
                    ? state.regions.assert(address, length, mode) : undefined,

                /**
                 * The slot a name's writes are charged to, resolved once by
                 * whoever registers the name rather than per write.
                 *
                 * @param {string} name
                 */
                writer: name=>live() ? (state.writers?.writer(name) ?? -1) : -1,
                /**
                 * Charges what follows to a slot and answers who was being
                 * charged, for the caller to put back on the way out.
                 *
                 * @param {number} slot
                 */
                charging: slot=>live() ? (state.writers?.charging(slot) ?? -1) : -1,
                /**
                 * The slot being charged, as a cell a caller that brackets
                 * every host call sets and puts back itself (`charging`
                 * without the call); null where nothing keeps the account.
                 *
                 * @returns {Int32Array | null}
                 */
                chargeSlot: ()=>live() ? state.writers?.slot ?? null : null,
                /**
                 * The checked dword reads as an object whose methods are one
                 * set for the realm: a caller on every host call's path calls
                 * them without a closure of this instance's in the way.
                 */
                reader: ()=>live() ? state.reader : null,

                readBytes: (/** @type {number} */ address, /** @type {number} */ length)=>
                    live() ? state.accessors.readBytes(address, length) : EMPTY,
                writeBytes: (/** @type {number} */ address, /** @type {Uint8Array} */ bytes)=>{
                    if (live())
                    {
                        state.accessors.writeBytes(address, bytes);
                    }
                },
                fillBytes: (/** @type {number} */ address, /** @type {number} */ value,
                    /** @type {number} */ length)=>
                {
                    if (live())
                    {
                        state.accessors.fillBytes(address, value, length);
                    }
                },
                window: (/** @type {number} */ address, /** @type {number} */ length)=>
                    live() ? state.accessors.window(address, length) : EMPTY,
                /**
                 * Watches the range for writes, the program's and the host's: the
                 * caller reads the bytes after this, and the watch's `take`
                 * answers the pages that may differ since. Null where the engine
                 * cannot say, and every byte is to be looked at.
                 *
                 * @param {number} address @param {number} length
                 * @returns {{ take: (address: number, length: number) => number[] } | null}
                 */
                watchWrites: (/** @type {number} */ address, /** @type {number} */ length)=>
                    (live() ? /** @type {any} */ (cpu).watchWrites(address, length) : null),
                /**
                 * The RAM as a view over a SharedArrayBuffer, byte 0 at address
                 * 0, for a worker to read and write in place; null where the
                 * memory is not shared.
                 *
                 * @returns {Uint8Array | null}
                 */
                shared: ()=>{
                    /** @type {Uint8Array | null} */
                    let ram = null;
                    try
                    {
                        ram = live() ? /** @type {any} */ (cpu).ramView() : null;
                    }
                    catch {
                        // No machine yet: nothing to share.
                    }
                    return ram && typeof SharedArrayBuffer === 'function'
                        && ram.buffer instanceof SharedArrayBuffer ? ram : null;
                },
                /**
                 * What a worker wrote into the shared RAM, taken as a write of
                 * this thread's (`accessors.adopt`).
                 *
                 * @param {number} address @param {number} length
                 */
                adopt: (/** @type {number} */ address, /** @type {number} */ length)=>{
                    if (live())
                    {
                        state.accessors.adopt(address, length);
                    }
                },
                readU8: (/** @type {number} */ address)=>live() ? state.accessors.readU8(address) : 0,
                readU16: (/** @type {number} */ address)=>
                    live() ? state.accessors.readU16(address) : 0,
                readU32: (/** @type {number} */ address)=>
                    live() ? state.accessors.readU32(address) : 0,
                readU32sInto: (/** @type {number} */ address, /** @type {number} */ count,
                    /** @type {number[]} */ into, /** @type {number} */ at = 0)=>
                {
                    if (live())
                    {
                        state.accessors.readU32sInto(address, count, into, at);
                        return;
                    }
                    for (let word = 0; word < count; word++)
                    {
                        into[at + word] = 0;
                    }
                },
                readF32sInto: (/** @type {number} */ address, /** @type {number} */ count,
                    /** @type {number[] | Float32Array} */ into)=>
                {
                    if (live())
                    {
                        state.accessors.readF32sInto(address, count, into);
                        return;
                    }
                    for (let word = 0; word < count; word++)
                    {
                        into[word] = 0;
                    }
                },
                writeU8: (/** @type {number} */ address, /** @type {number} */ value)=>{
                    if (live())
                    {
                        state.accessors.writeU8(address, value);
                    }
                },
                writeU16: (/** @type {number} */ address, /** @type {number} */ value)=>{
                    if (live())
                    {
                        state.accessors.writeU16(address, value);
                    }
                },
                writeU32: (/** @type {number} */ address, /** @type {number} */ value)=>{
                    if (live())
                    {
                        state.accessors.writeU32(address, value);
                    }
                },
                /**
                 * The dwords of [address, address + length) as an array over the
                 * RAM itself, for a block the engine keeps and the program only
                 * reads -- a clock it moves at every turn: a store through it is
                 * charged to nothing and reaches no translated code nor a write
                 * watch (`watchWrites`), and costs a store. Null where the RAM is
                 * not shared (it can move as it grows) or the address is not
                 * 4-aligned.
                 *
                 * @param {number} address @param {number} length  bytes
                 * @returns {Int32Array | null}
                 */
                wordsOver: (address, length)=>{
                    const shared = live() ? sharedWords() : null;
                    const at = unsigned(address);
                    if (shared === null || (at & 3) !== 0 || at + length > shared.byteLength)
                    {
                        return null;
                    }
                    // By division, not `>>> 2`, which names a dword below 4 GiB only.
                    return shared.subarray(at / 4, at / 4 + Math.ceil(length / 4));
                },
                /**
                 * The dword at `address`, read as one indivisible step that also
                 * orders this read after the store it finds: a word a guest routine
                 * on another executor publishes with `xchg` or a `lock` prefix, so
                 * what that routine wrote before it is seen too. A plain read gives
                 * no such order on a host that reorders stores (arm64).
                 *
                 * @param {number} address  4-aligned
                 * @returns {number}
                 */
                loadU32: address=>{
                    if (!live())
                    {
                        return 0;
                    }
                    const shared = sharedWords();
                    if (shared !== null && (address & 3) === 0 && within(shared, address, 4))
                    {
                        return Atomics.load(shared, unsigned(address) / 4) >>> 0;
                    }
                    return state.accessors.readU32(address);
                },
                /**
                 * The dword at `address` replaced by `value` if it is `expected`, as
                 * one indivisible step against the threads running on other
                 * executors where the RAM is shared; answers what it was. How the
                 * host takes a lock the guest's own code takes with `xchg`.
                 *
                 * @param {number} address  4-aligned @param {number} expected
                 * @param {number} value
                 * @returns {number}
                 */
                compareExchangeU32: (address, expected, value)=>{
                    if (!live())
                    {
                        return 0;
                    }
                    const shared = sharedWords();
                    if (shared !== null && (address & 3) === 0 && within(shared, address, 4))
                    {
                        const was = Atomics.compareExchange(shared, unsigned(address) / 4,
                            expected | 0, value | 0) >>> 0;
                        if (was === expected >>> 0)
                        {
                            state.accessors.adopt(address, 4);
                        }
                        return was;
                    }
                    const was = state.accessors.readU32(address);
                    if (was === expected >>> 0)
                    {
                        state.accessors.writeU32(address, value);
                    }
                    return was;
                },
                /**
                 * The same for a quadword, as `lock cmpxchg8b` takes one: a
                 * 64-bit word the guest's threads move that way -- a counter's
                 * last answer, an SList's header -- moved by the host too.
                 * Indivisible where the RAM is shared and the address
                 * 8-aligned; a read then a write elsewhere.
                 *
                 * @param {number} address @param {bigint} expected @param {bigint} value
                 * @returns {bigint}  what the quadword held, unsigned
                 */
                compareExchangeU64: (address, expected, value)=>{
                    if (!live())
                    {
                        return 0n;
                    }
                    const shared = sharedQuads();
                    if (shared !== null && (address & 7) === 0 && within(shared, address, 8))
                    {
                        const was = BigInt.asUintN(64, Atomics.compareExchange(shared,
                            unsigned(address) / 8, BigInt.asIntN(64, expected),
                            BigInt.asIntN(64, value)));
                        if (was === BigInt.asUintN(64, expected))
                        {
                            state.accessors.adopt(address, 8);
                        }
                        return was;
                    }
                    const was = BigInt(state.accessors.readU32(address))
                        | BigInt(state.accessors.readU32(address + 4)) << 32n;
                    if (was === BigInt.asUintN(64, expected))
                    {
                        const bytes = new Uint8Array(8);
                        new DataView(bytes.buffer).setBigUint64(0, BigInt.asUintN(64, value), true);
                        state.accessors.writeBytes(address, bytes);
                    }
                    return was;
                },
                /**
                 * A pointer of `bytes` bytes - 4 in a 32-bit process, 8 in a
                 * 64-bit one - read whole: an address up to 2^53 as a number.
                 * The one reader of a pointer in guest memory every layer goes
                 * through, so that no copy of it keeps only the low dword.
                 *
                 * @param {number} address @param {4 | 8} bytes
                 * @returns {number}
                 */
                readPointer: (address, bytes)=>{
                    if (!live())
                    {
                        return 0;
                    }
                    const low = state.accessors.readU32(address);
                    return pointerWide(bytes)
                        ? low + state.accessors.readU32(unsigned(address) + 4) * 2 ** 32 : low;
                },
                /**
                 * A pointer of `bytes` bytes written whole: its upper dword is
                 * the value's own, zero for an address below 4 GiB, never left
                 * as it was. A negative value is a dword some bitwise operator
                 * made signed and names the same address (`unsigned`).
                 *
                 * @param {number} address @param {number} value @param {4 | 8} bytes
                 */
                writePointer: (address, value, bytes)=>{
                    if (!live())
                    {
                        return;
                    }
                    const whole = unsigned(value);
                    if (!pointerWide(bytes))
                    {
                        state.accessors.writeU32(address, whole);
                        return;
                    }
                    pointerScratch.setUint32(0, whole % 2 ** 32, true);
                    pointerScratch.setUint32(4, Math.floor(whole / 2 ** 32), true);
                    state.accessors.writeBytes(address, pointerBytes);
                },
                /** @param {number} address @param {number} [limit] */
                readCString: (address, limit)=>
                    live() ? state.accessors.readCString(address, limit) : '',
                /**
                 * @param {number} address @param {number} [limit]
                 * @param {Uint8Array} [wanted]  Byte values that end the scan.
                 */
                scanCString: (address, limit, wanted)=>live()
                    ? state.accessors.scanCString(address, limit, wanted)
                    : { index: -1, byte: 0 },
                /** @param {number} address @param {number} [limit] */
                readWideString: (address, limit)=>
                    live() ? state.accessors.readWideString(address, limit) : '',
                /** @param {number} address @param {number} [limit] */
                scanWideString: (address, limit)=>
                    live() ? state.accessors.scanWideString(address, limit) : -1,
            };
            return api;
        },

        /** @returns {import('../../system/contract.js').ModuleDiagnostics} */
        diagnostics(){
            const instance = current;
            if (!instance || instance.disposed)
            {
                return { name: 'memory', version: '0.1.0', status: 'created', metrics: {} };
            }
            const mapped = instance.regions.list();
            return {
                name: 'memory',
                version: '0.1.0',
                status: 'ready',
                metrics: {
                    regions: mapped.length,
                    // Worth having in a snapshot: a layout that looks wrong usually
                    // explains a fault faster than the fault itself does.
                    layout: mapped.map((/** @type {any} */ region)=>
                        `${region.name} 0x${region.base.toString(16)}`
                        + `+0x${region.size.toString(16)} ${region.access}`),
                },
            };
        },

        async dispose(){
            if (current)
            {
                current.disposed = true;
            }
            current = null;
        },
    };
}

/** One graph's worth, for the boundary check and for a test that builds this layer alone. */
export const memoryModule = createMemoryModule();
