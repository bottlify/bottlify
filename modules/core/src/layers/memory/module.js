/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { Access, RegionKind, createRegionMap } from './internal/regions.js';
import { createAccessors } from './internal/accessors.js';

/**
 * memory — the guest address space: what is mapped, who may touch it, and typed
 * access to it.
 *
 * Sits on cpu because that is where the raw bytes are; everything above should
 * come through here rather than poking physical memory directly, so that an
 * unmapped or wrongly-permitted access is an error instead of a silent write.
 */

/** @type {any} */
let regions = null;
/** @type {any} */
let accessors = null;

/**
 * The layout as published: name as a dictionary id, base, size, and access
 * as its index in `Access`. A program of this era maps a few hundred images
 * and stacks; the rows past that are not published, and `regions` in the
 * diagnostics says how many there really are.
 */
export const REGION_COLUMNS = ['name', 'base', 'size', 'access'];
export const REGION_ROWS = 1024;

export const memoryModule = {
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
        regions = createRegionMap();
        accessors = createAccessors({ raw: cpu, regions });

        // The layout as a table a reader elsewhere can name a page from:
        // one row per region, its name as a dictionary id. Written when a
        // region is registered or reprotected, which is rare, and never
        // walked on request.
        const table = typeof log.metrics?.table === 'function'
            ? log.metrics.table('memory', 'regions', { rows: REGION_ROWS, columns: REGION_COLUMNS })
            : null;
        const publish = ()=>{
            if (!table)
            {
                return;
            }
            const mapped = regions.list();
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

        return {
            Access,
            RegionKind,

            /** @param {any} region */
            register: region=>{
                const made = regions.register(region);
                publish();
                return made;
            },
            /** @param {string} name @param {string} access */
            protect: (name, access)=>{
                regions.protect(name, access);
                publish();
            },
            /** @param {number} address */
            find: address=>regions.find(address),
            list: ()=>regions.list(),
            /**
             * @param {number} address
             * @param {number} length
             * @param {'read' | 'write' | 'execute'} mode
             */
            assert: (address, length, mode)=>regions.assert(address, length, mode),

            readBytes: accessors.readBytes,
            writeBytes: accessors.writeBytes,
            window: accessors.window,
            readU8: accessors.readU8,
            readU16: accessors.readU16,
            readU32: accessors.readU32,
            writeU8: accessors.writeU8,
            writeU16: accessors.writeU16,
            writeU32: accessors.writeU32,
            /** @param {number} address @param {number} [limit] */
            readCString: (address, limit)=>accessors.readCString(address, limit),
            /** @param {number} address @param {number} [limit] */
            readWideString: (address, limit)=>accessors.readWideString(address, limit),
        };
    },

    /** @returns {import('../../system/contract.js').ModuleDiagnostics} */
    diagnostics(){
        const mapped = regions ? regions.list() : [];
        return {
            name: 'memory',
            version: '0.1.0',
            status: regions ? 'ready' : 'created',
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
        regions = null;
        accessors = null;
    },
};
