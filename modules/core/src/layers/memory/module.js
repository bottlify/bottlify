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

export const memoryModule = {
    name: 'memory',
    version: '0.1.0',
    requires: /** @type {readonly string[]} */ (['cpu']),

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
        regions = createRegionMap();
        accessors = createAccessors({ raw: cpu, regions });

        return {
            Access,
            RegionKind,

            /** @param {any} region */
            register: region=>regions.register(region),
            /** @param {string} name @param {string} access */
            protect: (name, access)=>regions.protect(name, access),
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
