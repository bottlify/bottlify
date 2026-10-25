/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What a run may hold in memory, in three zones that grow for different
 * reasons: the guest's, what the program fills of its RAM; the translator's, which
 * grows with the code the program reaches; and the engine's own heaps --
 * decoded and fetched bundle blocks, mirrors of guest memory behind a played
 * device, texels kept for a reader, sound rings -- which grow with what the
 * program reads and draws. A phone's browser ends a tab past a line it does
 * not announce, so each zone has a ceiling and the ceilings sum to the tab's
 * limit with nothing past it: memory no zone counts has no room in the tab.
 *
 * Each layer says what it holds in its diagnostics as `bytesHeld`, by zone and
 * pool -- `{ heaps: { blockCache: 1048576, mirror: 'not measured' } }` -- and
 * the run's report sums them here (`zonesTable`). A zone of no tab's -- what a
 * device holds in the GPU's process -- is reported beside them, not summed.
 */

import { TRANSLATION_ZONE_BYTES } from './layers/cpu/module.js';

const MIB = 1024 * 1024;

/** The most a tab running one program holds, all zones together. */
export const TAB_MEMORY_LIMIT = 1536 * MIB;

/**
 * Each zone's ceiling, on what is held, not on what could be. The guest's is
 * on what the program holds of its RAM -- its images, its threads' stacks, the
 * heap's blocks it was handed -- and not on the RAM, which is an address space
 * (the system's shared page is at 0x7FFE0000, which only two gigabytes reach)
 * whose pages the program never touched are no memory of the tab's. The
 * translator's zone holds its tables and modules (`TRANSLATION_ZONE_BYTES`);
 * the heaps' is the rest.
 */
export const MEMORY_ZONES = Object.freeze({
    guest: 1024 * MIB,
    translation: TRANSLATION_ZONE_BYTES,
    heaps: 256 * MIB,
});

/**
 * The heaps' pools that let go of what they hold to stay under a ceiling of
 * their own, inside the heaps' zone.
 *
 * `blockCache`: a bundle's fetched blocks where no durable store takes them (a
 * browser without the origin's file system in a worker), the least recently
 * read let go first: what a start reads before its first frame fits.
 * `decodedBlocks`: the bundle's blocks decoded for guest reads, kept for the
 * reads after them -- a block is a quarter of a mebibyte by default, and the
 * tiers hold two dozen.
 */
export const HEAP_POOLS = Object.freeze({
    blockCache: 64 * MIB,
    decodedBlocks: 16 * MIB,
});

/** What a pool says when nothing can measure it. */
export const NOT_MEASURED = 'not measured';

/**
 * @typedef {Record<string, Record<string, number | string>>} BytesHeld
 *     By zone, each pool's bytes, or `NOT_MEASURED`.
 */

/**
 * The zones' sums over a run's diagnostics tables: for each zone its ceiling,
 * the bytes measured, by `<table>.<pool>`, and the pools that could not say.
 * A table with no `bytesHeld` at all is named in `unreported`: what it holds
 * is counted nowhere, which the sums must not hide. A zone not of the tab
 * (`device`) is listed in `outside`, apart from the total.
 *
 * @param {{ name: string, metrics?: any }[]} tables
 * @returns {{ name: string, version: string, status: string, metrics: any }}
 */
export function zonesTable(tables){
    /** @type {Record<string, { ceiling: number, bytes: number, free: number, over: boolean,
     *     pools: Record<string, number>, notMeasured: string[] }>} */
    const zones = {};
    for (const [zone, ceiling] of Object.entries(MEMORY_ZONES))
    {
        zones[zone] = { ceiling, bytes: 0, free: ceiling, over: false, pools: {}, notMeasured: [] };
    }
    /** @type {Record<string, Record<string, number | string>>} */
    const outside = {};
    /** @type {string[]} */
    const unreported = [];
    for (const table of tables)
    {
        if (table.name === 'zones')
        {
            continue;
        }
        const held = table.metrics?.bytesHeld;
        if (held === null || typeof held !== 'object')
        {
            unreported.push(table.name);
            continue;
        }
        for (const [zone, pools] of Object.entries(held))
        {
            for (const [pool, bytes] of Object.entries(pools ?? {}))
            {
                const key = `${table.name}.${pool}`;
                const into = zones[zone];
                if (into === undefined)
                {
                    (outside[zone] ??= {})[key] = bytes;
                }
                else if (typeof bytes === 'number')
                {
                    into.pools[key] = bytes;
                    into.bytes += bytes;
                }
                else
                {
                    into.notMeasured.push(key);
                }
            }
        }
    }
    let total = 0;
    for (const zone of Object.values(zones))
    {
        zone.free = zone.ceiling - zone.bytes;
        zone.over = zone.bytes > zone.ceiling;
        total += zone.bytes;
    }
    const over = Object.values(zones).some(zone=>zone.over) || total > TAB_MEMORY_LIMIT;
    return {
        name: 'zones',
        version: '0.1.0',
        status: over ? 'over' : 'ready',
        metrics: { limit: TAB_MEMORY_LIMIT, total, zones, outside, unreported },
    };
}

/**
 * A run's tables with the zones' sums over them last, in place of any the
 * tables carried: a process's own sums, read on the page, are made again over
 * the page's tables and the process's together.
 *
 * @template {{ name: string, metrics?: any }} T
 * @param {T[]} tables
 * @returns {(T | ReturnType<typeof zonesTable>)[]}
 */
export function withZones(tables){
    const rest = tables.filter(table=>table.name !== 'zones');
    return [...rest, zonesTable(rest)];
}
