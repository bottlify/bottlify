/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Long-mode code run as translated regions: a start met `hot` times becomes a
 * region of `emit.js` -- the blocks its known jumps reach -- compiled where it
 * is met, and from then on runs as one wasm call until it jumps out or spends
 * its budget; what no region holds -- a cold start, the instruction a block
 * stopped before -- runs on the long-mode interpreter (`interp64.js`) over the
 * same state block.
 *
 * A region's bytes are marked as translated code in the page table, so a
 * store into them -- which a region itself never makes, it stops before --
 * reaches the interpreter, and the interpreter's `onCodeWrite` drops every
 * region with bytes on the page (`invalidate`).
 */

import { MODE_64, decode } from '../decode/decoder.js';
import { pageFlagsAt } from '../runtime/layout.js';
import { PageFlag } from '../runtime/pages.js';
import { interpret64 } from '../interp64.js';
import { LongExit, emitRegions, endsBlock, translates } from './emit.js';

/** Instructions a block holds at most. */
const BLOCK_LIMIT = 64;
/** Blocks a region holds at most. */
const REGION_LIMIT = 32;

/**
 * A start: the region translated from it, or none (`run` null) where its
 * first instruction is the interpreter's.
 *
 * @typedef {Object} LongEntry
 * @property {number} entry
 * @property {[number, number][]} ranges  the bytes it was made of, [from, to)
 * @property {(() => number) | null} run
 * @property {WebAssembly.Global | null} budget  its module's
 */

/**
 * @param {{ memory: WebAssembly.Memory,
 *     layout: import('../../../core/src/layers/cpu/engine.js').StateLayout,
 *     pages: import('../runtime/pages.js').PageTable,
 *     hot?: number, below?: number }} options  `below`: no block starts under it
 *     (the host's null range, whose fetch faults on the interpreter)
 */
export function createLongRunner({ memory, layout, pages, hot = 2, below = 0x10000 }){
    /** @type {Map<number, LongEntry>} */
    const entries = new Map();
    /** @type {Map<number, number>} */
    const visits = new Map();
    /** The starts whose regions have bytes on each page. @type {Map<number, Set<number>>} */
    const byPage = new Map();
    const limits = memoryLimits(memory);
    const stats = { regions: 0, blocks: 0, translated: 0, interpreted: 0, exits: 0, dropped: 0 };
    let view = new DataView(memory.buffer);
    let bytes = new Uint8Array(memory.buffer);
    const flagsAt = pageFlagsAt(layout);
    const fresh = ()=>{
        if (view.byteLength === 0 || view.buffer !== memory.buffer)
        {
            view = new DataView(memory.buffer);
            bytes = new Uint8Array(memory.buffer);
        }
    };

    /** A byte of code, or a fault the decoder takes as the end. @param {number} address */
    const fetch = address=>{
        if (address >= 2 ** 32
            || (bytes[flagsAt + (address >>> 12)] & PageFlag.INACCESSIBLE) !== 0)
        {
            throw new RangeError('closed');
        }
        return bytes[layout.ramBase + address];
    };

    /**
     * The instructions of the block at `entry`: up to a branch, an instruction
     * the emitter has no case for, or the limit.
     *
     * @param {number} entry
     */
    const blockAt = entry=>{
        /** @type {import('../decode/decoder.js').Instruction[]} */
        const instructions = [];
        let at = entry;
        if (entry < below)
        {
            return instructions;
        }
        while (instructions.length < BLOCK_LIMIT)
        {
            let instruction;
            try
            {
                instruction = decode(fetch, at, MODE_64);
            }
            catch {
                break;
            }
            if ('refused' in instruction || !translates(instruction))
            {
                break;
            }
            instructions.push(instruction);
            at += instruction.length;
            if (endsBlock(instruction.op))
            {
                break;
            }
        }
        return instructions;
    };

    /**
     * Where a block goes when it ends, as far as its bytes say: both ways of a
     * conditional jump, a direct jump's target, the next instruction of a
     * block cut short.
     *
     * @param {import('../decode/decoder.js').Instruction[]} instructions
     */
    const successors = instructions=>{
        const last = instructions[instructions.length - 1];
        const next = last.eip + last.length;
        if (!endsBlock(last.op))
        {
            return [next];
        }
        const [operand] = last.operands;
        if (last.op === 'call' || operand?.kind !== 'rel')
        {
            return [];
        }
        const target = /** @type {number} */ (operand.target);
        return last.op === 'jmp' ? [target] : [target, next];
    };

    /**
     * The region from `entry`: the blocks its known jumps reach, decoded,
     * emitted, compiled, their pages marked.
     *
     * @param {number} entry
     */
    const form = entry=>{
        /** @type {import('./emit.js').LongBlock[]} */
        const blocks = [];
        const first = blockAt(entry);
        if (first.length > 0)
        {
            /** @type {Set<number>} */
            const seen = new Set([entry]);
            const queue = [{ entry, instructions: first }];
            while (queue.length > 0 && blocks.length < REGION_LIMIT)
            {
                const block = /** @type {import('./emit.js').LongBlock} */ (queue.shift());
                blocks.push(block);
                for (const to of successors(block.instructions))
                {
                    if (!seen.has(to))
                    {
                        seen.add(to);
                        const instructions = blockAt(to);
                        if (instructions.length > 0)
                        {
                            queue.push({ entry: to, instructions });
                        }
                    }
                }
            }
        }
        /** @type {LongEntry} */
        const record = { entry, ranges: [], run: null, budget: null };
        if (blocks.length > 0)
        {
            const module = new WebAssembly.Module(emitRegions(layout, limits, [{ blocks }]));
            const instance = new WebAssembly.Instance(module, { env: { memory } });
            record.run = /** @type {() => number} */ (instance.exports.r0);
            record.budget = /** @type {WebAssembly.Global} */ (instance.exports.budget);
            for (const block of blocks)
            {
                const last = block.instructions[block.instructions.length - 1];
                record.ranges.push([block.entry, last.eip + last.length]);
            }
            stats.regions++;
            stats.blocks += blocks.length;
        }
        else
        {
            // A start left to the interpreter is held as its first byte: a
            // store there drops the decision with the code it was made on.
            record.ranges.push([entry, entry + 1]);
        }
        for (const [from, to] of record.ranges)
        {
            pages.markCode(from, to - from);
            for (let page = from >>> 12; page <= (to - 1) >>> 12; page++)
            {
                let starts = byPage.get(page);
                if (starts === undefined)
                {
                    starts = new Set();
                    byPage.set(page, starts);
                }
                starts.add(entry);
            }
        }
        entries.set(entry, record);
        return record;
    };

    return {
        stats,

        /**
         * Runs up to about `budget` instructions from the block's RIP; stops
         * after a trap-port write or a `hlt`, as `interpret64` does. Counts
         * what it retired in `state.retired`; a fault is thrown from the
         * interpreter with the state at the instruction.
         *
         * @param {ReturnType<typeof import('../interp64.js').blockState64>} state  over the
         *     same block
         * @param {number} budget
         * @param {{ onStep?: (at: number, jumped: boolean) => void }} [options]  heard at each
         *     interpreted run's start
         * @returns {number}  retired
         */
        run(state, budget, options = {}){
            fresh();
            const before = state.retired;
            /** Up to `count` instructions interpreted, to the next jump. @param {number} count */
            const step = count=>{
                state.syncIn();
                stats.interpreted += interpret64(state, count,
                    { force: true, shouldStop: ()=>true, onStep: options.onStep });
                state.syncOut();
            };
            state.syncOut();
            while (state.retired - before < budget && !state.halted && state.trapped.length === 0)
            {
                const rip = view.getBigUint64(layout.eip, true);
                const at = Number(rip);
                let block = rip < 2n ** 32n ? entries.get(at) : undefined;
                if (block === undefined && rip < 2n ** 32n)
                {
                    const seen = (visits.get(at) ?? 0) + 1;
                    visits.set(at, seen);
                    if (seen >= hot)
                    {
                        visits.delete(at);
                        block = form(at);
                    }
                }
                if (block?.run === null)
                {
                    // A start whose first instruction no block holds: that one
                    // instruction here, and a block from the next.
                    step(1);
                    continue;
                }
                if (block !== undefined)
                {
                    /** @type {WebAssembly.Global} */ (block.budget).value =
                        budget - (state.retired - before);
                    const answer = /** @type {() => number} */ (block.run)();
                    state.retired += answer >>> 2;
                    stats.translated += answer >>> 2;
                    if ((answer & 3) === LongExit.NEXT)
                    {
                        continue;
                    }
                    stats.exits++;
                    // One instruction, the one the block stopped before.
                    step(1);
                    continue;
                }
                // Cold: one run on the interpreter, to the next jump.
                step(budget - (state.retired - before));
            }
            // RIP and the flags as the last block left them, for a caller that
            // writes the state back.
            state.syncIn();
            return state.retired - before;
        },

        /**
         * Drops every region with bytes on the pages a store reached, and their marks.
         *
         * @param {number} address @param {number} size
         */
        invalidate(address, size){
            for (let page = address >>> 12; page <= (address + size - 1) >>> 12; page++)
            {
                const starts = byPage.get(page);
                if (starts === undefined)
                {
                    continue;
                }
                byPage.delete(page);
                for (const entry of starts)
                {
                    const record = entries.get(entry);
                    entries.delete(entry);
                    stats.dropped++;
                    // Its other pages keep a start that is gone.
                    for (const [from, to] of record?.ranges ?? [])
                    {
                        for (let other = from >>> 12; other <= (to - 1) >>> 12; other++)
                        {
                            byPage.get(other)?.delete(entry);
                        }
                    }
                }
                pages.clearCode(page);
            }
        },
    };
}

/**
 * The limits a module importing `memory` declares: its current size at least,
 * and its maximum and sharing when a shared memory has them.
 *
 * @param {WebAssembly.Memory} memory
 */
function memoryLimits(memory){
    const min = memory.buffer.byteLength / 65536;
    const shared = typeof SharedArrayBuffer !== 'undefined'
        && memory.buffer instanceof SharedArrayBuffer;
    return shared ? { min, max: maxPages(memory), shared: true } : { min };
}

/** A shared memory's maximum in pages, which a module importing it must declare. @param {WebAssembly.Memory} memory */
function maxPages(memory){
    const growable = /** @type {{ maxByteLength?: number }} */ (/** @type {unknown} */ (memory.buffer));
    return growable.maxByteLength === undefined ? memory.buffer.byteLength / 65536
        : growable.maxByteLength / 65536;
}
