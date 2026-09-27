/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { Access, RegionKind, createRegionMap } from './internal/regions.js';
import { createAccessors } from './internal/accessors.js';
import { DwordReader } from './internal/reader.js';
import { WRITER_COLUMNS, WRITER_ROWS, createWriterAccount } from './internal/writers.js';

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
export const REGION_ROWS = 1024;

/**
 * What this layer publishes as numbers. Both are the frame's rather than the
 * run's: which host call wrote most into the guest during the frame that just
 * closed, and how much. The run's totals are in the writers table, which is
 * cumulative.
 */
export const MEMORY_COUNTERS = ['frameWriter', 'frameWriterBytes'];

/** The empty answer `readBytes`/`window` give once this instance is disposed. */
const EMPTY = new Uint8Array(0);

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

            // Who wrote what into the guest, by name. Nothing published means no
            // charge at all: the write path takes a branch rather than a call, and
            // a build without the log's tables pays nothing for the account.
            const writerTable = typeof log.metrics?.table === 'function'
                ? log.metrics.table('memory', 'writers',
                    { rows: WRITER_ROWS, columns: WRITER_COLUMNS })
                : null;
            const account = writerTable
                ? createWriterAccount({ table: writerTable, intern: log.intern })
                : null;
            state.writers = account;
            if (account && typeof log.metrics?.counters === 'function')
            {
                const counters = log.metrics.counters('memory', MEMORY_COUNTERS);
                log.metrics.onFrame(()=>{
                    const busiest = account.publish();
                    counters[0] = busiest.writer;
                    counters[1] = busiest.bytes;
                });
            }
            state.reader = typeof cpu.readU32 === 'function'
                ? new DwordReader(state.regions,
                    /** @type {import('./internal/reader.js').ReaderMachine} */ (cpu))
                : null;
            state.accessors = createAccessors({
                raw: cpu, regions: state.regions, charge: account?.charge ?? null,
                reader: state.reader,
            });

            // The layout as a table a reader elsewhere can name a page from:
            // one row per region, its name as a dictionary id. Written when a
            // region is registered or reprotected, which is rare, and never
            // walked on request.
            const table = typeof log.metrics?.table === 'function'
                ? log.metrics.table('memory', 'regions',
                    { rows: REGION_ROWS, columns: REGION_COLUMNS })
                : null;
            const publish = ()=>{
                if (!table)
                {
                    return;
                }
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
                table.used(rows);
            };

            /**
             * Whether this instance is still open. A call still in flight when
             * the machine was disposed must not find the region map gone: it
             * answers the harmless value below -- an empty read, a write that
             * does nothing -- rather than dereferencing what disposal took away.
             */
            const live = ()=>!state.disposed;

            current = state;
            return {
                Access,
                RegionKind,

                /** @param {any} region */
                register: region=>{
                    if (!live())
                    {
                        return null;
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
            };
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
