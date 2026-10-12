/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The block profile's readers (`blockProfile`): the table past cork's own
 * tables where every translated block counts its executions. A module of its
 * own, reached only behind the build's diagnostics guard, so a production
 * bundle carries none of it.
 */

import { MECHANISM_NAMES, Tables, blockProfileAt, mechanismAt } from './layout.js';

/**
 * @typedef {{ entry: number, spans: [number, number][] }} ProfiledRegion
 *     what a region record tells the profile: its entry and its blocks' spans
 */

/**
 * Every counted block as [address, executions, shared, region entry], by the
 * slot table: the entry of a region the block is in (-1 when none is), so a
 * profile of the regions' functions divides by the instructions they ran.
 *
 * @param {DataView} data  over the memory the tables are in
 * @param {{ tables: number, hashShift?: number }} layout
 * @param {Iterable<ProfiledRegion>} regions
 * @returns {[number, number, number, number][]}
 */
export function blockCounts(data, layout, regions){
    const base = layout.tables + blockProfileAt(layout);
    /** @type {Map<number, number>} */
    const regionOf = new Map();
    for (const record of regions)
    {
        for (const [start] of record.spans)
        {
            if (!regionOf.has(start))
            {
                regionOf.set(start, record.entry);
            }
        }
    }
    /** @type {[number, number, number, number][]} */
    const out = [];
    for (let slot = 0; slot < Tables.BLOCK_SLOTS; slot++)
    {
        const at = base + slot * Tables.BLOCK_SLOT;
        const count = data.getUint32(at + 4, true);
        if (count > 0)
        {
            const address = data.getUint32(at, true);
            out.push([address, count, data.getUint32(at + 8, true),
                regionOf.get(address) ?? -1]);
        }
    }
    return out.sort((one, two)=>two[1] - one[1]);
}

/** @param {DataView} data @param {{ tables: number, hashShift?: number }} layout */
export function resetBlockCounts(data, layout){
    const base = layout.tables + blockProfileAt(layout);
    for (let slot = 0; slot < Tables.BLOCK_SLOTS; slot++)
    {
        data.setUint32(base + slot * Tables.BLOCK_SLOT + 4, 0, true);
    }
    for (let mechanism = 0; mechanism < Tables.MECHANISMS; mechanism++)
    {
        data.setBigUint64(layout.tables + mechanismAt(layout, mechanism), 0n, true);
    }
}

/**
 * The run's count of each `Mechanism`, by name.
 *
 * @param {DataView} data  over the memory the tables are in
 * @param {{ tables: number, hashShift?: number }} layout
 * @returns {Record<string, number>}
 */
export function mechanismCounts(data, layout){
    /** @type {Record<string, number>} */
    const out = {};
    MECHANISM_NAMES.forEach((name, mechanism)=>{
        out[name] = Number(data.getBigUint64(layout.tables + mechanismAt(layout, mechanism), true));
    });
    return out;
}

/**
 * The forty most executed, with the region each is in.
 *
 * @param {[number, number, number, number][]} blocks
 * @param {Iterable<ProfiledRegion>} regions
 */
export function topBlocks(blocks, regions){
    return blocks.slice(0, 40).map(([address, count, shared])=>{
        let entry = -1;
        let size = 0;
        for (const record of regions)
        {
            const span = record.spans.find(([start])=>start === address);
            if (span)
            {
                entry = record.entry;
                size = span[1] - span[0];
                break;
            }
        }
        return { address, count, shared: shared !== 0, entry, bytes: size };
    });
}
