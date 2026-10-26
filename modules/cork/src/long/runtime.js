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
 * same state block. A direct call from one region into another is a wasm
 * call through a table holding every region at its address's slot, and a
 * region that leaves for an address another region holds a block at goes on
 * there through the entry hash in the layout's tables (`entries.js`, the
 * 32-bit translator's), with a tail call: the host is crossed only where a
 * call nests too deep, the budget is spent, or no region holds the address.
 *
 * A region's bytes are marked as translated code in the page table, so a
 * store into them -- which a region itself never makes, it stops before --
 * reaches the interpreter, and the interpreter's `onCodeWrite` drops every
 * region with bytes on the page (`invalidate`).
 */

import { MODE_64, decode } from '../decode/decoder.js';
import { Tables, pageFlagsAt } from '../runtime/layout.js';
import { ANY_TOP, createEntries } from '../runtime/entries.js';
import { features } from '../wasm/features.js';
import { PageFlag } from '../runtime/pages.js';
import { interpret64 } from '../interp64.js';
import { LongExit, emitRegions, endsBlock, foldFunction, missFunction, translates }
    from './emit.js';

/** Instructions a block holds at most. */
const BLOCK_LIMIT = 64;
/**
 * Blocks and bytes of code a region holds at most: the 32-bit translator's
 * own (`formRegion`'s `maxBlocks` and `maxBytes`), so that a loop of many
 * blocks is one region rather than several going round through the transfer.
 */
const REGION_LIMIT = 128;
const REGION_BYTES = 8192;

/**
 * A start: the region translated from it, or none (`run` null) where its
 * first instruction is the interpreter's.
 *
 * @typedef {Object} LongEntry
 * @property {number} entry
 * @property {[number, number][]} ranges  the bytes it was made of, [from, to)
 * @property {(() => number) | null} run
 * @property {number[]} hashed  its blocks' indices in the entry hash
 * @property {boolean} wrapped  made while reads wrapped into RAM untested
 * @property {boolean} loose  made while stores through rsp went untested (`looseStacks`)
 */

/**
 * @param {{ memory: WebAssembly.Memory,
 *     layout: import('../../../core/src/layers/cpu/engine.js').StateLayout,
 *     pages: import('../runtime/pages.js').PageTable,
 *     hot?: number, below?: number, transfers?: boolean, checkReads?: boolean,
 *     looseStacks?: boolean }} settings
 *     `below`: no block starts under it (the host's null range, whose fetch faults on
 *     the interpreter); `transfers`: regions go on into each other through the entry
 *     hash with tail calls, where the host has them (off where a tail call into another
 *     instance faults: iOS's `crossTailCalls`); `checkReads`: true, translated reads
 *     test their pages; false, they wrap into RAM for good; unset, they wrap until
 *     the program faults on a page it cannot reach (`readsFaulted`), as the 32-bit
 *     runtime's do; `looseStacks`, unless false, a store through rsp alone tests no page
 *     until code is translated on a page of a thread's stack (`noteStack`), as the
 *     32-bit runtime's do
 */
export function createLongRunner(settings){
    const { memory, layout, pages, hot = 2, below = 0x10000,
        transfers = features().tailCalls } = settings;
    let readsChecked = settings.checkReads === true;
    /** Whether regions are made loose: until code is translated on a stack. */
    let loose = settings.looseStacks !== false;
    /** The pages of the threads' stacks the host named (`noteStack`). @type {Set<number>} */
    const stackPages = new Set();
    /** @type {Map<number, LongEntry>} */
    const entries = new Map();
    /** @type {Map<number, number>} */
    const visits = new Map();
    /** The starts whose regions have bytes on each page. @type {Map<number, Set<number>>} */
    const byPage = new Map();
    const limits = memoryLimits(memory);
    const stats = { regions: 0, blocks: 0, translated: 0, interpreted: 0, exits: 0, dropped: 0,
        entered: 0, readSwitches: 0, stackSwitches: 0 };
    /**
     * The instructions run on the interpreter one at a time -- the one a block
     * stopped before, or a start no block holds -- by mnemonic, counted each
     * time: where translated code is missing, weighted by how often.
     *
     * @type {Map<string, number>}
     */
    const steppedOps = new Map();
    /** The mnemonic at an address, decoded once. @type {Map<number, string>} */
    const opAt = new Map();
    let view = new DataView(memory.buffer);
    let bytes = new Uint8Array(memory.buffer);
    const flagsAt = pageFlagsAt(layout);
    // The regions by slot, which calls from region to region go through: a
    // slot is an address's for good, holding the miss function while the
    // address has no region.
    const table = new WebAssembly.Table({ element: 'anyfunc', initial: 256 });
    const miss = new WebAssembly.Instance(new WebAssembly.Module(missFunction())).exports.miss;
    // The record a run of regions leaves in the state block, folded into the
    // flags word before anything but translated code looks at it.
    const fold = /** @type {() => void} */ (new WebAssembly.Instance(
        new WebAssembly.Module(foldFunction(layout, memoryLimits(memory))),
        { env: { memory } }).exports.fold);
    /** @type {Map<number, number>} */
    const slots = new Map();
    /** @param {number} address */
    const slotOf = address=>{
        let slot = slots.get(address);
        if (slot === undefined)
        {
            slot = slots.size;
            if (slot >= table.length)
            {
                table.grow(table.length);
            }
            table.set(slot, miss);
            slots.set(address, slot);
        }
        return slot;
    };
    const budgetGlobal = new WebAssembly.Global({ value: 'i32', mutable: true }, 0);
    const depth = new WebAssembly.Global({ value: 'i32', mutable: true }, 0);
    const label = new WebAssembly.Global({ value: 'i32', mutable: true }, 0);
    const expect = new WebAssembly.Global({ value: 'i64', mutable: true }, -1n);
    // Every block of every region, by address: what a region's transfer probes
    // (in memory) and the host's loop looks up (in its map).
    const hashed = createEntries({ memory, hashBase: layout.tables + Tables.HASH,
        shift: layout.hashShift });
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
        if (last.op === 'call')
        {
            // The callee is a region of its own, called; its return comes back here.
            return [next];
        }
        const [operand] = last.operands;
        if (operand?.kind !== 'rel')
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
            let size = 0;
            while (queue.length > 0 && blocks.length < REGION_LIMIT && size < REGION_BYTES)
            {
                const block = /** @type {import('./emit.js').LongBlock} */ (queue.shift());
                blocks.push(block);
                const last = block.instructions[block.instructions.length - 1];
                size += last.eip + last.length - block.entry;
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
        const record = { entry, ranges: [], run: null, hashed: [], wrapped: false, loose };
        if (blocks.length > 0)
        {
            record.wrapped = !readsChecked;
            const module = new WebAssembly.Module(emitRegions(layout, limits, [{ blocks }],
                slotOf, { transfers, checkReads: readsChecked, looseStacks: loose }));
            const instance = new WebAssembly.Instance(module,
                { env: { memory, table, budget: budgetGlobal, depth, label, expect } });
            const run = /** @type {() => number} */ (instance.exports.r0);
            record.run = run;
            const slot = slotOf(entry);
            table.set(slot, run);
            // Block i, in the address order the emitter lays them out in, is label i + 1;
            // a block another region's entry already names stays that region's, which
            // alone may take the entry away when it goes.
            [...blocks].sort((x, y)=>x.entry - y.entry).forEach((block, index)=>{
                if (hashed.entryOf(block.entry) < 0)
                {
                    record.hashed.push(hashed.add(block.entry, run, index + 1, ANY_TOP, slot));
                }
            });
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
        if (loose && record.ranges.some(([from, to])=>{
            for (let page = from >>> 12; page <= (to - 1) >>> 12; page++)
            {
                if (stackPages.has(page))
                {
                    return true;
                }
            }
            return false;
        }))
        {
            // Made loose on a stack: made again, tested.
            stackCodeSeen();
            return form(entry);
        }
        return record;
    };

    /**
     * Code is translated on a page of a thread's stack: the regions that store
     * through rsp untested go, and every region from now on tests them -- a
     * store through rsp could write the code itself. Once a run, as the 32-bit
     * runtime's `stackCodeSeen`.
     */
    const stackCodeSeen = ()=>{
        if (!loose)
        {
            return;
        }
        loose = false;
        stats.stackSwitches++;
        for (const record of [...entries.values()])
        {
            if (record.loose && record.run !== null)
            {
                drop(record.entry);
            }
        }
    };

    /**
     * Forgets the start at `entry` and its region: its table slot misses from
     * now on, and so do transfers to its blocks.
     *
     * @param {number} entry
     */
    const drop = entry=>{
        const record = entries.get(entry);
        entries.delete(entry);
        if (record?.run)
        {
            table.set(slotOf(entry), miss);
            for (const index of record.hashed)
            {
                hashed.remove(index);
            }
        }
        stats.dropped++;
        // Its pages keep a start that is gone.
        for (const [from, to] of record?.ranges ?? [])
        {
            for (let page = from >>> 12; page <= (to - 1) >>> 12; page++)
            {
                byPage.get(page)?.delete(entry);
            }
        }
    };

    return {
        stats,

        /** The counts, and the twenty instructions most often stepped one at a time. */
        diagnostics: ()=>({
            ...stats,
            stepped: Object.fromEntries([...steppedOps].sort((a, b)=>b[1] - a[1]).slice(0, 20)),
        }),

        /**
         * Runs up to about `budget` instructions from the block's RIP; stops
         * after a trap-port write or a `hlt`, as `interpret64` does. Counts
         * what it retired in `state.retired`; a fault is thrown from the
         * interpreter with the state at the instruction.
         *
         * @param {ReturnType<typeof import('../interp64.js').blockState64>} state  over the
         *     same block
         * @param {number} budget
         * @param {{ onStep?: (at: number, jumped: boolean) => void, interpretLimit?: number }}
         *     [options]  `onStep` heard at each interpreted run's start; `interpretLimit`, the
         *     instructions it interprets before it comes back, the rest of the budget aside
         * @returns {number}  retired
         */
        run(state, budget, options = {}){
            fresh();
            const before = state.retired;
            const interpretedBefore = stats.interpreted;
            const limit = options.interpretLimit ?? Infinity;
            /** Up to `count` instructions interpreted, to the next jump. @param {number} count */
            const step = count=>{
                if (count === 1)
                {
                    const at = Number(view.getBigUint64(layout.eip, true));
                    let op = opAt.get(at);
                    if (op === undefined)
                    {
                        try
                        {
                            const instruction = decode(fetch, at, MODE_64);
                            op = 'refused' in instruction ? '(refused)' : instruction.op;
                        }
                        catch {
                            op = '(fault)';
                        }
                        opAt.set(at, op);
                    }
                    steppedOps.set(op, (steppedOps.get(op) ?? 0) + 1);
                }
                state.syncIn();
                stats.interpreted += interpret64(state, count,
                    { force: true, shouldStop: ()=>true, onStep: options.onStep });
                state.syncOut();
            };
            state.syncOut();
            while (state.retired - before < budget && !state.halted && state.trapped.length === 0
                && stats.interpreted - interpretedBefore < limit)
            {
                const rip = view.getBigUint64(layout.eip, true);
                const at = Number(rip);
                /** @type {(() => number) | null} */
                let run = null;
                let entryLabel = 0;
                if (rip < 2n ** 32n)
                {
                    const index = hashed.entryOf(at);
                    if (index >= 0)
                    {
                        const found = hashed.at(index);
                        run = /** @type {() => number} */ (/** @type {unknown} */ (found.fn));
                        entryLabel = found.label;
                    }
                    else
                    {
                        let block = entries.get(at);
                        if (block === undefined)
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
                        run = block?.run ?? null;
                    }
                }
                if (run !== null)
                {
                    const left = budget - (state.retired - before);
                    budgetGlobal.value = left;
                    depth.value = 0;
                    label.value = entryLabel;
                    expect.value = -1n;
                    stats.entered++;
                    const answer = run();
                    fold();
                    const retired = left - budgetGlobal.value;
                    state.retired += retired;
                    stats.translated += retired;
                    if (answer !== LongExit.INTERPRET)
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
                for (const entry of [...starts])
                {
                    drop(entry);
                }
                byPage.delete(page);
                pages.clearCode(page);
            }
        },

        /**
         * The program faulted on a page it cannot reach: reads test their pages
         * from now on, and the regions that wrapped theirs into RAM go -- the
         * same instruction would read RAM there where the interpreter faults.
         * Once a run, as the 32-bit runtime's `readsFaulted`.
         */
        /**
         * A thread's stack, as the host names it: code translated on it ends
         * the stores through rsp that test no page.
         *
         * @param {number} base @param {number} size
         */
        noteStack(base, size){
            const first = base >>> 12;
            const last = (base + Math.max(size, 1) - 1) >>> 12;
            for (let page = first; page <= last; page++)
            {
                stackPages.add(page);
                if (byPage.has(page))
                {
                    stackCodeSeen();
                }
            }
        },

        readsFaulted(){
            if (readsChecked || settings.checkReads === false)
            {
                return;
            }
            readsChecked = true;
            stats.readSwitches++;
            for (const record of [...entries.values()])
            {
                if (record.wrapped)
                {
                    drop(record.entry);
                }
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
