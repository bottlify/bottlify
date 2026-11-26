/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The run-level lines of a game report (`tools/run/game.mjs`): which process
 * the report is of, and the run's cache as its keeper stood. Both are the
 * run's, not a process's, and both say "not measured" where nothing answered.
 */

/** @param {number} bytes */
const mib = bytes=>(bytes / (1024 * 1024)).toFixed(1);

/**
 * The run's cache in one line: its budget, the segments and bytes placed now
 * and at most, hot and cold bodies, what went to the run's folder and back.
 *
 * @param {any} figures  `app.runCache()`: the keeper's figures, or why there are none
 * @returns {string}
 */
export function describeRunCache(figures){
    if (figures === null || typeof figures !== 'object')
    {
        return `run cache: ${typeof figures === 'string' ? figures : 'not measured'}`;
    }
    return `run cache: budget ${mib(figures.budget)} MiB,`
        + ` segments ${figures.segments} (${mib(figures.segmentBytes)} MiB,`
        + ` at most ${mib(figures.peakSegmentBytes)}),`
        + ` placed ${mib(figures.placedBytes)} MiB (at most ${mib(figures.peakPlacedBytes)}),`
        + ` hot ${figures.hot} (${mib(figures.hotBytes)} MiB), cold ${figures.cold}`
        + ` (${mib(figures.coldBytes)} MiB), written ${figures.written}`
        + ` (${mib(figures.writtenBytes)} MiB), cooled ${figures.cooled ?? 0},`
        + ` raised ${figures.raised ?? 0}, gone ${figures.gone},`
        + ` refused for room ${figures.refusedRoom ?? 0}, too large ${figures.refusedLarge ?? 0}`
        + describeSpaces(figures.spaces)
        + (figures.peakRoundingBytes === undefined ? '; at the most placed: not measured'
            : `; at the most placed (${mib(figures.peakPlacedBytes)} MiB), rounding`
                + ` ${mib(figures.peakRoundingBytes)} MiB${describeSpaces(figures.peakSpaces)}`);
}

/** What rounding to blocks costs a space: a share of the blocks it holds. */
const roundingOf = (/** @type {{ hotBytes: number, placedBytes: number }} */ one)=>(
    one.placedBytes > 0
        ? `${Math.round((one.placedBytes - one.hotBytes) / one.placedBytes * 100)} %` : 'none');

/**
 * Each space of the run's cache, by the part of a name before its first '/':
 * its bodies, those in memory and the blocks they take, and what rounding to
 * blocks costs it.
 *
 * @param {Record<string, { bodies: number, bytes: number, hotBytes: number,
 *     placedBytes: number }> | undefined} spaces
 */
const describeSpaces = spaces=>{
    if (spaces === undefined)
    {
        return '; spaces not measured';
    }
    return Object.entries(spaces).map(([name, one])=>`; ${name}: ${one.bodies} bodies`
        + ` (${mib(one.bytes)} MiB), in memory ${mib(one.hotBytes)} MiB in blocks of`
        + ` ${mib(one.placedBytes)} MiB, rounding ${roundingOf(one)}`)
        .join('');
};

/**
 * Which process the report is of, with the frames every process presented:
 * the facade speaks for the process started last, the report for the one that
 * presented the most.
 *
 * @param {{ image: string, frames: number | null, worker: boolean, chosen: boolean }[]
 *     | undefined} processes
 * @returns {string[]}
 */
export function describeProcesses(processes){
    if (!processes || processes.length === 0)
    {
        return ['processes: not measured'];
    }
    const chosen = processes.find(one=>one.chosen);
    return [chosen ? `report of ${chosen.image}, the process that presented the most frames`
        : 'report of the process the facade speaks for (the newest); no other presented more',
    ...processes.map(one=>`  ${one.chosen ? '*' : ' '} ${one.image}`
        + `${one.worker ? ' (worker)' : ''}:`
        + ` ${one.frames === null ? 'frames not measured' : `${one.frames} frames`}`)];
}
