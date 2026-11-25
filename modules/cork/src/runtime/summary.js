/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * summary — what the runtime needs of a formed region to publish its stored
 * translation, kept in the region's record so a later run takes the
 * translation without forming the region.
 *
 * A stored translation is taken when the bytes its code was made of are as
 * they were: the region's hash says so, and the hash is taken over spans of
 * bytes a record can name (`hashPlan`). Forming the region again to learn
 * those spans decoded every instruction of it and tested every callee for a
 * leaf, half a millisecond a region, for an answer the record already had:
 * a game's warm start formed thousands of regions it then took from the
 * store whole.
 *
 * What stands for the region then (`regionOfSummary`) answers what
 * publishing asks - its pages, its blocks' spans, the bytes it read, the
 * calls it makes, which of its entries do nothing - from the summary, and
 * forms the region the first time anything asks for an instruction of it
 * (`blocks`).
 */

import { codeSpans, emptyCode, hashOfPlan, hashPlan } from '../region.js';
import { isX87, trackRegion } from '../emit/x87.js';

/**
 * @typedef {Object} RegionSummary
 * @property {import('../region.js').HashPlan} plan  what the hash is taken over
 * @property {number} bytes               the region's code bytes
 * @property {number[]} pages             `Region.pages`
 * @property {number[]} reads             `Region.reads`
 * @property {number[]} formable          `Region.formable`
 * @property {[number, number][]} read    the spans of `Region.sources`
 * @property {boolean} x87                whether it holds x87 code (`usesX87`)
 * @property {boolean} stack              whether it reaches memory through esp alone
 *     (`throughStack`)
 * @property {[number, number][]} calls   each direct call out of it: the callee, and the
 *     x87 top the call is made at, -1 for the entry's own in a region with no x87
 * @property {[number, number][]} empties  each block start that does nothing, with what
 *     `emptyCode` says of it
 * @property {[string, number][]} crt     the C runtime functions formed in, and how often
 */

/** Whether a region holds x87 code: what makes it a variant of its entry's top.
 * @param {import('../region.js').Region} region @returns {boolean} */
export const usesX87 = region=>(/** @type {SummedRegion} */ (region).summary?.x87
    ?? region.blocks.some(block=>block.instructions.some(isX87)));

/**
 * Whether a region's code reaches memory through esp alone (a push, a call,
 * an operand off esp with no index): the accesses a loose region leaves
 * untested.
 *
 * @param {import('../region.js').Region} region @returns {boolean}
 */
export const throughStack = region=>(/** @type {SummedRegion} */ (region).summary?.stack
    ?? region.blocks.some(block=>block.instructions.some(
        ({ op, operands })=>op.startsWith('push') || op === 'call' || op === 'enter'
            || operands.some(operand=>operand.kind === 'mem' && operand.base === 4
                && (operand.index ?? -1) < 0))));

/**
 * The direct calls out of a region, each with the x87 top it is made at: the
 * top the tracker has at the call's block where the region holds x87, the
 * entry's otherwise.
 *
 * @param {import('../region.js').Region} region @param {number} entryTop
 * @param {RegionSummary | null} [summary]  the region's, where it has been made
 * @returns {[number, number][]}
 */
export function callsOf(region, entryTop, summary = undefined){
    const summed = summary ?? /** @type {SummedRegion} */ (region).summary;
    if (summed !== undefined)
    {
        // A region with no x87 in it calls at the top it was entered at, whichever.
        return summed.calls.map(([callee, top])=>[callee, top < 0 ? entryTop : top]);
    }
    const tracked = usesX87(region) ? trackRegion(region, entryTop) : null;
    /** @type {[number, number][]} */
    const calls = [];
    region.blocks.forEach((block, at)=>{
        if (block.exit.kind === 'call')
        {
            const end = tracked === null ? null : tracked.ends[at];
            calls.push([block.exit.targets[0], end === null ? entryTop : end.top]);
        }
    });
    return calls;
}

/**
 * The spans of a region's blocks, in address order.
 * @param {import('../region.js').Region} region @returns {[number, number][]}
 */
export const spansOf = region=>(/** @type {SummedRegion} */ (region).summary?.plan.spans
    ?? region.blocks.map(block=>[block.start, block.end]));

/**
 * The bytes a region's code is made of (`codeSpans`): its blocks' spans, and
 * the runtime helpers and stubs formed in.
 * @param {import('../region.js').Region} region @returns {[number, number][]}
 */
export function codeSpansOf(region){
    const summed = /** @type {SummedRegion} */ (region).summary;
    return summed === undefined ? codeSpans(region)
        : [...summed.plan.spans,
            ...summed.plan.helpers.map(([address, length])=>
                /** @type {[number, number]} */ ([address, address + length]))];
}

/**
 * What `emptyCode` says of each block start of a region that does nothing.
 * @param {import('../region.js').Region} region @returns {Map<number, number>}
 */
export function emptiesOf(region){
    const summed = /** @type {SummedRegion} */ (region).summary;
    if (summed !== undefined)
    {
        return new Map(summed.empties);
    }
    const blockAt = new Map(region.blocks.map(block=>[block.start, block]));
    /** @type {Map<number, number>} */
    const empties = new Map();
    for (const block of region.blocks)
    {
        const code = emptyCode(at=>blockAt.get(at), block.start);
        if (code !== 0)
        {
            empties.set(block.start, code);
        }
    }
    return empties;
}

/**
 * The C runtime functions formed into a region, and how often each.
 * @param {import('../region.js').Region} region @returns {[string, number][]}
 */
export function crtOf(region){
    const summed = /** @type {SummedRegion} */ (region).summary;
    if (summed !== undefined)
    {
        return summed.crt;
    }
    /** @type {Map<string, number>} */
    const counted = new Map();
    for (const block of region.blocks)
    {
        for (const instruction of block.instructions)
        {
            if (instruction.crt !== undefined)
            {
                counted.set(instruction.crt, (counted.get(instruction.crt) ?? 0) + 1);
            }
        }
    }
    return [...counted];
}

/**
 * A formed region's summary, for its record: null for one that kept no
 * account of what it read (`sources`), which a region formed by the runtime
 * always does.
 *
 * @param {import('../region.js').Region} region @param {number} entryTop
 * @returns {RegionSummary | null}
 */
export function summaryOf(region, entryTop){
    const summed = /** @type {SummedRegion} */ (region).summary;
    if (summed !== undefined)
    {
        return summed;
    }
    if (region.sources === undefined || region.reads === undefined
        || region.formable === undefined)
    {
        return null;
    }
    // Asked as the region is formed, again for its record and again as it is
    // published; a region runtimes share is entered at each one's own top.
    let made = summaries.get(region);
    if (made === undefined)
    {
        made = new Map();
        summaries.set(region, made);
    }
    let summary = made.get(entryTop);
    if (summary === undefined)
    {
        summary = summarise(region, entryTop);
        made.set(entryTop, summary);
    }
    return summary;
}

/** @type {WeakMap<import('../region.js').Region, Map<number, RegionSummary>>} */
const summaries = new WeakMap();

/** @param {import('../region.js').Region} region @param {number} entryTop
 * @returns {RegionSummary} */
function summarise(region, entryTop){
    const x87 = usesX87(region);
    return {
        plan: hashPlan(region),
        bytes: region.bytes,
        pages: [...region.pages],
        reads: [...region.reads ?? []],
        formable: [...region.formable ?? []],
        read: /** @type {NonNullable<typeof region.sources>} */ (region.sources)
            .map(({ start, bytes })=>[start, start + bytes.length]),
        x87,
        stack: throughStack(region),
        calls: callsOf(region, entryTop).map(([callee, top])=>[callee, x87 ? top : -1]),
        empties: [...emptiesOf(region)],
        crt: crtOf(region),
    };
}

/**
 * A region that answers from its summary, and forms itself when asked for
 * its blocks.
 * @typedef {import('../region.js').Region & { summary?: RegionSummary }} SummedRegion
 */

/**
 * The region a record's summary stands for, as the bytes are now: null when
 * a page it was formed on may no longer hold code here, a page forming read
 * is out of reach, or its bytes hash otherwise than `hash` - it is formed
 * then, as a region with no record is.
 *
 * @param {number} entry @param {string} hash @param {RegionSummary} summary
 * @param {{ read: (address: number) => number,
 *     bytesOf: (start: number, end: number) => Uint8Array | null,
 *     formable: (address: number) => boolean,
 *     form: () => import('../region.js').Region }} from
 *     `bytesOf` a span's bytes at once, null where they are not to be had so;
 *     `form` the region formed as the record says, for what the summary does not hold
 * @returns {SummedRegion | null}
 */
export function regionOfSummary(entry, hash, summary, { read, bytesOf, formable, form }){
    for (const page of summary.formable)
    {
        if (!formable(page * 4096))
        {
            return null;
        }
    }
    /** @type {{ start: number, bytes: Uint8Array }[]} */
    const sources = [];
    for (const [start, end] of summary.read)
    {
        const now = bytesOf(start, end);
        if (now === null)
        {
            return null;
        }
        sources.push({ start, bytes: now.slice() });
    }
    // The hash is taken over the copies: what is kept as read is what was hashed.
    // The span read last, tried first: the hash reads a span's bytes in a run.
    let last = sources[0];
    const copied = (/** @type {number} */ address)=>{
        if (last !== undefined && address >= last.start && address < last.start + last.bytes.length)
        {
            return last.bytes[address - last.start];
        }
        for (const source of sources)
        {
            if (address >= source.start && address < source.start + source.bytes.length)
            {
                last = source;
                return source.bytes[address - source.start];
            }
        }
        return read(address);
    };
    if (hashOfPlan(copied, summary.plan) !== hash)
    {
        return null;
    }
    /** @type {import('../region.js').Region | null} */
    let formed = null;
    const whole = ()=>(formed ??= form());
    return {
        entry,
        hash,
        entries: summary.plan.spans.map(([start])=>start),
        bytes: summary.bytes,
        pages: new Set(summary.pages),
        reads: new Set(summary.reads),
        formable: new Set(summary.formable),
        sources,
        refused: new Map(),
        summary,
        get blocks(){ return whole().blocks; },
        get tables(){ return whole().tables; },
    };
}
