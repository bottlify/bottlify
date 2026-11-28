/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What a run holds in memory, as one report: the run's account (Cellar's,
 * `createRunAccount`), which every process takes its memory from by kind -
 * the guests', the engine's own parts, the translator's modules, the run's
 * cache's segments - and, by name, what the layers hold that the account does
 * not count.
 *
 * Each layer says what it holds in its diagnostics as `bytesHeld`, by zone and
 * pool -- `{ heaps: { blockCache: 1048576, mirror: 'not measured' } }`. A zone
 * that is an account's kind (`guest`, `translation`) lists its pools beside the
 * account's sum, which already holds them; every other zone of the tab
 * (`heaps`) is memory no account counts, each pool named in `notAccounted`, as
 * is a table that says nothing of what it holds. A zone of no tab's -- what a
 * device holds in the GPU's process, the page file's disk -- is reported
 * beside them, not summed.
 */

/** What a pool says when nothing can measure it. */
export const NOT_MEASURED = 'not measured';

/** The zones a layer names that are kinds of the run's account. */
const ACCOUNTED_ZONES = Object.freeze({ guest: 'guest', translation: 'translation' });
/** The zones of the tab no account counts. */
const UNACCOUNTED_ZONES = Object.freeze(['heaps']);

/**
 * @typedef {Record<string, Record<string, number | string>>} BytesHeld
 *     By zone, each pool's bytes, or `NOT_MEASURED`.
 */

/**
 * The run's memory over its diagnostics tables: the account as the cpu
 * layer reads it (`machineMemory`, the same words whichever process's table
 * holds it, counted once), each accounted zone's pools beside its kind's sum,
 * the bytes no account counts by `<table>.<pool>`, and the total of both.
 *
 * @param {{ name: string, metrics?: any }[]} tables
 * @returns {{ name: string, version: string, status: string, metrics: any }}
 */
export function zonesTable(tables){
    const account = tables.find(table=>table.name === 'cpu' && table.metrics?.machineMemory)
        ?.metrics.machineMemory ?? null;
    /** @type {Record<string, { kind: string, accounted: number | string,
     *     pools: Record<string, number>, notMeasured: string[] }>} */
    const zones = {};
    for (const [zone, kind] of Object.entries(ACCOUNTED_ZONES))
    {
        zones[zone] = { kind, accounted: account?.kinds?.[kind]?.bytes ?? NOT_MEASURED, pools: {},
            notMeasured: [] };
    }
    /** @type {Record<string, number | string>} */
    const notAccounted = {};
    /** @type {Record<string, Record<string, number | string>>} */
    const outside = {};
    for (const table of tables)
    {
        if (table.name === 'zones')
        {
            continue;
        }
        const held = table.metrics?.bytesHeld;
        if (held === null || typeof held !== 'object')
        {
            notAccounted[table.name] = NOT_MEASURED;
            continue;
        }
        for (const [zone, pools] of Object.entries(held))
        {
            for (const [pool, bytes] of Object.entries(pools ?? {}))
            {
                const key = `${table.name}.${pool}`;
                const into = zones[zone];
                if (into !== undefined)
                {
                    if (typeof bytes === 'number')
                    {
                        into.pools[key] = bytes;
                    }
                    else
                    {
                        into.notMeasured.push(key);
                    }
                }
                else if (UNACCOUNTED_ZONES.includes(zone))
                {
                    notAccounted[key] = bytes;
                }
                else
                {
                    (outside[zone] ??= {})[key] = bytes;
                }
            }
        }
    }
    const unaccountedBytes = Object.values(notAccounted)
        .reduce((/** @type {number} */ sum, bytes)=>sum + (typeof bytes === 'number' ? bytes : 0), 0);
    // Without the account nothing measured the most of it: no total, not a small one.
    const total = account === null ? NOT_MEASURED : account.used + unaccountedBytes;
    const limit = account?.limit ?? null;
    return {
        name: 'zones',
        version: '0.2.0',
        status: limit !== null && typeof total === 'number' && total > limit ? 'over' : 'ready',
        metrics: {
            limit, total,
            account: account === null ? NOT_MEASURED
                : { used: account.used, peak: account.peak, refused: account.refused,
                    roomAsked: account.roomAsked, roomMade: account.roomMade,
                    kinds: Object.fromEntries(Object.entries(account.kinds ?? {})
                        .map(([kind, one])=>[kind, /** @type {any} */ (one).bytes])) },
            zones, notAccounted, outside,
        },
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
