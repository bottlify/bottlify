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
import { WasmExit } from '../interp-wasm.js';
import { formRegion as formShape } from '../region.js';
import { createX87Calls } from './x87.js';
import { LongExit, emitRegions, foldFunction, missFunction, translates } from './emit.js';

/**
 * Indirect-call prediction, as the 32-bit runtime's `callTargets` settings:
 * the samples of a call before its callees are looked at, the share of them
 * a callee formed in must take (one in this many), the callees a call
 * compares with, and how often a call's regions are formed again for it.
 */
const PREDICT_AFTER = 48;
const PREDICT_SHARE = 8;
const PREDICT_CALLEES = 4;
const REFORMS = 3;
/**
 * The share of the run's time the regions formed again for their calls'
 * callees may take: a decision due past it waits for more samples. The
 * 32-bit runtime forms them again on its translator's thread; here the
 * forming is the run's own, and x264's 183 sites, each a large region formed
 * again, took more of a 15 s run than the callees formed in gave back.
 */
const REFORM_SHARE = 0.05;

/**
 * Regions formed, each a module of its own, before they are gathered into
 * one (`pack`): a call or transfer between instances, every region with its
 * own copy of the transfer, cost calls512-scatter-x64 (512 functions called
 * through a table) 24 ns an instruction where one module of them took 4.
 */
const PACK_REGIONS = 32;

/**
 * The times a store leaves its region at one address before the region is
 * formed again testing it to the granule (`granular`): a store to a page that
 * holds code leaves for the interpreter, which drops what it wrote over; one
 * that keeps leaving writes beside the code, data on the code's page, and is
 * let through when it reaches no translated code. Only such stores carry the
 * test: on every store, its code alone cost large regions a fifth of their speed.
 */
const GRANULAR_AFTER = 16;

/**
 * A page whose code is written again and again -- a span drawer storing its
 * steps into its own immediates, a mixer patching a voice in -- is left to
 * the interpreter, as the 32-bit runtime's `volatileAfter`,
 * `volatileWindowMs` and `volatileHoldMs`: the writes that dropped its
 * regions, this many within the window of each other, and it is left for the
 * hold, twice as long each time it is left again. Translated again at every
 * write, such code costs a module a write.
 */
const VOLATILE_AFTER = 8;
const VOLATILE_WINDOW_MS = 100;
const VOLATILE_HOLD_MS = 2000;

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
 * @property {import('./emit.js').LongRegion} [region]  what it was emitted from, its body kept
 *     for a pack (`pack`)
 */

/**
 * @param {{ memory: WebAssembly.Memory,
 *     layout: import('../../../core/src/layers/cpu/engine.js').StateLayout,
 *     pages: import('../runtime/pages.js').PageTable,
 *     hot?: number, below?: number, transfers?: boolean, checkReads?: boolean,
 *     looseStacks?: boolean, defaultNaNNegative?: boolean, leafCalls?: boolean,
 *     callTargets?: boolean, volatileWindowMs?: number, packRegions?: number,
 *     trapPort?: number, tier?: import('../../../core/src/layers/cpu/engine.js').WasmInterpreter
 *         | null }} settings
 *     `below`: no block starts under it (the host's null range, whose fetch faults on
 *     the interpreter); `transfers`: regions go on into each other through the entry
 *     hash with tail calls, where the host has them (off where a tail call into another
 *     instance faults: iOS's `crossTailCalls`); `checkReads`: true, translated reads
 *     test their pages; false, they wrap into RAM for good; unset, they wrap until
 *     the program faults on a page it cannot reach (`readsFaulted`), as the 32-bit
 *     runtime's do; `looseStacks`, unless false, a store through rsp alone tests no page
 *     until code is translated on a page of a thread's stack (`noteStack`), as the
 *     32-bit runtime's do; `defaultNaNNegative`, the host's own (`features`), false
 *     where float arithmetic puts an invalid operation's NaN right; `leafCalls`, unless
 *     false, a direct call's small callee is formed into its caller (`formRegion`); false,
 *     every call is a wasm call, one into the region's own blocks too; `callTargets`,
 *     true, indirect calls are sampled and the small callees a call goes to formed
 *     into its region (`sampleCalls`) -- off by default: its regions formed again on the
 *     run's own thread, then started again on the engine's first tier, cost x264 and
 *     zstd more than the callees formed in gave back (roadmap/negative-results.md,
 *     2026-10-26); `volatileWindowMs`, the window a page's
 *     code is written `VOLATILE_AFTER` times in before it is left to the interpreter;
 *     `packRegions`, the regions formed before they are gathered into one module;
 *     `trapPort`, the port whose `out dx, eax` is the host's call channel: a region
 *     leaves past it with the value in the state's `trapped`, as the interpreter's
 *     write records it (unset, the interpreter runs every `out`); `tier`, the
 *     interpreter tier in wasm over the same block (`createWasmInterpreter`, long
 *     mode's build): what no region holds runs there, `interp64.js` taking only the
 *     instructions it hands back and its faults
 */
export function createLongRunner(settings){
    const { memory, layout, pages, hot = 2, below = 0x10000,
        transfers = features().tailCalls, leafCalls = true, callTargets = false,
        defaultNaNNegative = features().defaultNaNNegative,
        volatileWindowMs = VOLATILE_WINDOW_MS, packRegions = PACK_REGIONS, trapPort = -1,
        tier = null } = settings;
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
        entered: 0, readSwitches: 0, stackSwitches: 0, switches: 0, leaves: 0, predicted: 0,
        quiet: 0, deferred: 0, volatilePages: 0, granular: 0, packs: 0, packed: 0, traps: 0 };
    /** The regions formed since the last pack, each its own module. @type {LongEntry[]} */
    const unpacked = [];
    /** By address, the times a region left before the instruction there. @type {Map<number, number>} */
    const exitsAt = new Map();
    /** The stores tested to the granule (`GRANULAR_AFTER`). @type {Set<number>} */
    const granular = new Set();
    /**
     * By page, the writes that dropped its regions: how many since `since`, the
     * window's start, and how many times it was left to the interpreter.
     * @type {Map<number, { times: number, since: number, left: number }>}
     */
    const rewritten = new Map();
    /** By page left to the interpreter, when it is translated again. @type {Map<number, number>} */
    const volatileUntil = new Map();
    /**
     * Whether the page is left to the interpreter, its hold lifted when it is over.
     * @param {number} page
     */
    const volatile = page=>{
        const until = volatileUntil.get(page);
        if (until === undefined)
        {
            return false;
        }
        const now = performance.now();
        if (now < until)
        {
            return true;
        }
        volatileUntil.delete(page);
        const record = /** @type {{ times: number, since: number }} */ (rewritten.get(page));
        record.times = 0;
        record.since = now;
        return false;
    };
    /**
     * A write dropped the page's regions: counted, and the page left to the
     * interpreter at the `VOLATILE_AFTER`th in the window.
     * @param {number} page
     */
    const noteRewritten = page=>{
        const now = performance.now();
        let record = rewritten.get(page);
        if (record === undefined)
        {
            record = { times: 0, since: now, left: 0 };
            rewritten.set(page, record);
        }
        if (now - record.since > volatileWindowMs)
        {
            record.times = 0;
            record.since = now;
        }
        if (++record.times === VOLATILE_AFTER && !volatileUntil.has(page))
        {
            volatileUntil.set(page, now + VOLATILE_HOLD_MS * 2 ** Math.min(record.left, 5));
            record.left++;
            stats.volatilePages++;
        }
    };
    // Indirect-call prediction: the layout's call profile (`callProfile`) the
    // regions note their indirect calls in while its flag is up.
    const profileAt = callTargets && leafCalls ? layout.callProfile ?? -1 : -1;
    /** By call site, the targets sampled. @type {Map<number, { total: number,
     * targets: Map<number, number> }>} */
    const callSamples = new Map();
    /**
     * By call site, the callees formed into its regions: none for a call that
     * has nothing to form in, which is sampled no more (`quiet`).
     * @type {Map<number, number[]>}
     */
    const predictions = new Map();
    /** By call site, how often its regions were formed again for it. @type {Map<number, number>} */
    const reformsOf = new Map();
    /** The regions dropped to be formed again with their calls' callees, and what forming them cost. */
    const reforming = new Set();
    let reformMs = 0;
    const born = performance.now();
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
    // The x87 model the regions call (`x87.js`).
    const x87 = createX87Calls({ memory, layout });
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
     * Whether an instruction's bytes lie on pages the program may run and the
     * interpreter does not hold: forming reads a closed page as `hlt`
     * (`codeByte`), and an instruction reaching into one is the interpreter's,
     * whose fetch faults there.
     *
     * @param {number} at @param {number} length
     */
    const open = (at, length)=>{
        for (let page = at >>> 12; page <= (at + length - 1) >>> 12; page++)
        {
            if ((bytes[flagsAt + page] & PageFlag.INACCESSIBLE) !== 0
                || volatileUntil.size > 0 && volatile(page))
            {
                return false;
            }
        }
        return true;
    };
    /** A byte of code as forming reads it. @param {number} address */
    const codeByte = address=>(address < 2 ** 32
        && (bytes[flagsAt + (address >>> 12)] & PageFlag.INACCESSIBLE) === 0
        ? bytes[layout.ramBase + address] : 0xf4);
    /**
     * What the emitter here translates, of what forming decodes: `call $+5`, a
     * push that ends no block there, is left to the interpreter, as the
     * emitter takes every call for a block's end.
     *
     * @param {import('../decode/decoder.js').Instruction} instruction
     */
    const formable = instruction=>translates(instruction) && !(instruction.op === 'call'
        && instruction.operands[0].kind === 'rel'
        && instruction.operands[0].target === instruction.eip + instruction.length);

    /**
     * The region from `entry`, formed by the 32-bit translator's `formRegion`
     * in long mode -- the entry's own function first, its small callees formed
     * in, a switch's cases joined -- taken as the blocks the emitter here
     * makes: the entry's first, each cut before an instruction the emitter has
     * no case for, a switch's cases and a predicted call's callees on the
     * blocks whose jump or call goes to them.
     *
     * @param {number} entry
     * @returns {import('./emit.js').LongBlock[]}
     */
    const blocksFrom = entry=>{
        const region = formShape(codeByte, entry, {
            mode: MODE_64, translatable: at=>at >= below && open(at, 1), translates: formable,
            leafCalls, callTargets: predictions, helpers: false, baseOf: registerValue,
        });
        const starts = new Set(region.entries);
        /** @type {import('./emit.js').LongBlock[]} */
        const blocks = [];
        for (const block of region.blocks)
        {
            const cut = block.instructions.findIndex(one=>!open(one.eip, one.length));
            const instructions = cut < 0 ? block.instructions : block.instructions.slice(0, cut);
            if (instructions.length === 0)
            {
                continue;
            }
            /** @type {import('./emit.js').LongBlock} */
            const made = { entry: block.start, instructions };
            const { table: cases, predicted, quiet, targets, kind } = block.exit;
            if (cut < 0 && cases !== undefined)
            {
                const before = cases.before === undefined ? -1
                    : instructions.findIndex(one=>one.eip === cases.before);
                if (cases.before === undefined || before >= 0)
                {
                    made.switch = { index: cases.index, cases: cases.entries,
                        ...before >= 0 ? { before } : {} };
                    stats.switches++;
                }
            }
            if (cut < 0 && predicted === true)
            {
                // Its callees decided: those formed in, and the call sampled no more.
                made.targets = targets.filter(target=>starts.has(target));
                made.quiet = true;
            }
            else if (cut < 0 && quiet === true)
            {
                made.quiet = true;
            }
            if (cut < 0 && kind === 'call' && starts.has(targets[0]))
            {
                stats.leaves++;
            }
            if (block.start === entry)
            {
                blocks.unshift(made);
            }
            else
            {
                blocks.push(made);
            }
        }
        return blocks[0]?.entry === entry ? blocks : [];
    };

    /**
     * The region from `entry`: its blocks (`blocksFrom`), emitted, compiled,
     * their pages marked. A direct call's small callee is formed in with it,
     * the call a push and a jump and the callee's returns jumps back.
     *
     * @param {number} entry
     */
    const form = entry=>{
        if (!reforming.delete(entry))
        {
            return formRegion(entry);
        }
        const start = performance.now();
        const record = formRegion(entry);
        reformMs += performance.now() - start;
        return record;
    };

    /** `form`'s work. @param {number} entry @returns {LongEntry} */
    const formRegion = entry=>{
        const blocks = blocksFrom(entry);
        /** @type {LongEntry} */
        const record = { entry, ranges: [], run: null, hashed: [], wrapped: false, loose };
        if (blocks.length > 0)
        {
            record.wrapped = !readsChecked;
            /** @type {import('./emit.js').LongRegion} */
            const region = { blocks };
            record.region = region;
            const run = instantiate([region])[0];
            record.run = run;
            unpacked.push(record);
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
     * A module of the regions given, instantiated: their functions in their
     * order. A region emitted before is taken as its body stands (`LongRegion`).
     *
     * @param {import('./emit.js').LongRegion[]} regions
     * @returns {(() => number)[]}
     */
    const instantiate = regions=>{
        const module = new WebAssembly.Module(emitRegions(layout, limits, regions, slotOf,
            { transfers, checkReads: readsChecked, looseStacks: loose, defaultNaNNegative,
                x87Id: run=>x87.add(run), granular, trapPort, formCalls: leafCalls,
                profileCalls: profileAt >= 0 }));
        const { exports } = new WebAssembly.Instance(module,
            { env: { memory, table, budget: budgetGlobal, depth, label, expect, x87: x87.call } });
        return regions.map((_, index)=>/** @type {() => number} */ (exports[`r${index}`]));
    };

    /**
     * Gathers the regions formed since the last pack that are still live into
     * one module (`PACK_REGIONS`): their bodies as emitted, each table slot and
     * entry moved to its function there. Only between runs, with no frame of a
     * module it leaves on the stack.
     */
    const pack = ()=>{
        const live = unpacked.filter(record=>entries.get(record.entry) === record
            && record.run !== null);
        unpacked.length = 0;
        if (live.length < 2)
        {
            unpacked.push(...live);
            return;
        }
        const runs = instantiate(live.map(record=>
            /** @type {import('./emit.js').LongRegion} */ (record.region)));
        live.forEach((record, index)=>{
            const slot = slotOf(record.entry);
            table.set(slot, runs[index]);
            record.run = runs[index];
            for (const at of record.hashed)
            {
                hashed.retable(at, runs[index], slot);
            }
        });
        stats.packs++;
        stats.packed += live.length;
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

    /**
     * A region left before the instruction at `at`: the `GRANULAR_AFTER`th
     * time, an instruction with a memory operand is tested to the granule
     * from then on, its regions dropped to be formed so.
     *
     * @param {number} at
     */
    const noteExit = at=>{
        const times = (exitsAt.get(at) ?? 0) + 1;
        exitsAt.set(at, times);
        if (times !== GRANULAR_AFTER)
        {
            return;
        }
        let instruction;
        try
        {
            instruction = decode(fetch, at, MODE_64);
        }
        catch {
            // Not there to read: the interpreter faults it.
            return;
        }
        if ('refused' in instruction || !instruction.operands.some(operand=>operand.kind === 'mem'))
        {
            return;
        }
        granular.add(at);
        stats.granular++;
        for (const entry of [...byPage.get(at >>> 12) ?? []])
        {
            if (entries.get(entry)?.ranges.some(([from, to])=>at >= from && at < to))
            {
                drop(entry);
            }
        }
    };

    /**
     * A register's value in the state block, as it stands while a region is
     * formed: for a switch's table base set before its block (`region-switch64.js`).
     *
     * @param {number} reg
     */
    const registerValue = reg=>Number(view.getBigUint64(layout.regs + reg * 8, true));

    /**
     * Decides an indirect call sampled `PREDICT_AFTER` times, as the 32-bit
     * runtime's `reformStep` does: the callees that took a share of its
     * samples, formed in where forming finds them small enough (`formRegion`'s
     * leaves), and its regions dropped to be formed again with them. A call
     * with none to form in, or formed again `REFORMS` times, is quiet: its
     * regions, when they are formed again for another reason, form it as an
     * indirect call that no longer samples. A decision that would take the
     * forming past `REFORM_SHARE` of the run waits for the next samples.
     *
     * @param {number} site
     */
    const decide = site=>{
        const seen = /** @type {{ total: number, targets: Map<number, number> }} */ (
            callSamples.get(site));
        callSamples.delete(site);
        if (reformMs > REFORM_SHARE * (performance.now() - born))
        {
            // Sampled again, and decided when the run has time for it.
            stats.deferred++;
            return;
        }
        const reforms = (reformsOf.get(site) ?? 0) + 1;
        reformsOf.set(site, reforms);
        const formed = reforms > REFORMS ? [] : [...seen.targets]
            .filter(([, count])=>count * PREDICT_SHARE >= seen.total)
            .sort((x, y)=>y[1] - x[1]).slice(0, PREDICT_CALLEES)
            .map(([target])=>target);
        predictions.set(site, formed);
        stats.predicted += formed.length;
        stats.quiet += formed.length === 0 ? 1 : 0;
        if (formed.length === 0)
        {
            // Quiet: its regions stay as they are, sampling it still while the
            // profile is up; its samples are passed over. Formed again only
            // for that, x264's regions took as long as the callees formed in.
            return;
        }
        for (const entry of [...byPage.get(site >>> 12) ?? []])
        {
            if (entries.get(entry)?.ranges.some(([from, to])=>site >= from && site < to))
            {
                drop(entry);
                reforming.add(entry);
            }
        }
    };

    /**
     * Reads the indirect calls the regions noted since the last reading and
     * turns the profile on or off, as the 32-bit runtime's `sampleCalls`: on
     * for one run in two, so the sixteen pairs are the last calls of a stretch
     * of the run. Nothing is noted with the profile off but its flag's load.
     */
    const sampleCalls = ()=>{
        if (view.getUint32(profileAt, true) === 0)
        {
            view.setUint32(profileAt + 4, 0, true);
            for (let i = 0; i < 16; i++)
            {
                view.setUint32(profileAt + 8 + i * 8, 0, true);
            }
            view.setUint32(profileAt, 1, true);
            return;
        }
        view.setUint32(profileAt, 0, true);
        for (let i = 0; i < 16; i++)
        {
            const site = view.getUint32(profileAt + 8 + i * 8, true);
            if (site === 0 || predictions.has(site))
            {
                continue;
            }
            const target = view.getUint32(profileAt + 12 + i * 8, true);
            let seen = callSamples.get(site);
            if (seen === undefined)
            {
                seen = { total: 0, targets: new Map() };
                callSamples.set(site, seen);
            }
            seen.targets.set(target, (seen.targets.get(target) ?? 0) + 1);
            if (++seen.total === PREDICT_AFTER)
            {
                decide(site);
            }
        }
    };

    const runner = {
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
            if (unpacked.length >= packRegions)
            {
                pack();
            }
            fresh();
            x87.fresh();
            if (profileAt >= 0)
            {
                sampleCalls();
            }
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
            /**
             * Up to `count` instructions on the tier, over the block: it stops at a
             * start with a region, a hot one (formed here), a trap, a halt; an
             * instruction it hands back, or faults on before its effect, runs on
             * `interp64.js`, which raises the fault with its address.
             * @param {number} count
             */
            const tiered = count=>{
                const code = /** @type {NonNullable<typeof tier>} */ (tier).run(count);
                const ran = /** @type {NonNullable<typeof tier>} */ (tier).retired();
                state.retired += ran;
                stats.interpreted += ran;
                const at = Number(view.getBigUint64(layout.eip, true));
                switch (code)
                {
                    case WasmExit.CODE_WRITE:
                        runner.invalidate(/** @type {NonNullable<typeof tier>} */ (tier)
                            .exitValue(), /** @type {NonNullable<typeof tier>} */ (tier).exitSize());
                        return;
                    case WasmExit.HOT:
                        if (hashed.entryOf(at) < 0 && !entries.has(at))
                        {
                            visits.delete(at);
                            form(at);
                        }
                        return;
                    case WasmExit.TRAP:
                        state.trapped.push(/** @type {NonNullable<typeof tier>} */ (tier)
                            .exitValue());
                        return;
                    case WasmExit.HALT:
                        state.halted = true;
                        return;
                    case WasmExit.UNSUPPORTED: case WasmExit.FAULT:
                        step(1);
                        return;
                    default: // BUDGET, ENTRY
                }
            };
            /** What no region holds: on the tier where there is one, else one run on the
             * interpreter, to the next jump. */
            const cold = ()=>{
                if (tier !== null)
                {
                    tiered(Math.min(budget - (state.retired - before),
                        limit - (stats.interpreted - interpretedBefore)));
                }
                else
                {
                    step(budget - (state.retired - before));
                }
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
                        if (block === undefined && volatileUntil.size > 0 && volatile(at >>> 12))
                        {
                            // Left to the interpreter: to the next jump, nothing formed.
                            cold();
                            continue;
                        }
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
                    if (answer === LongExit.TRAP)
                    {
                        stats.traps++;
                        state.trapped.push(view.getUint32(layout.regs, true));
                        continue;
                    }
                    if (answer !== LongExit.INTERPRET)
                    {
                        continue;
                    }
                    stats.exits++;
                    noteExit(Number(view.getBigUint64(layout.eip, true)));
                    // One instruction, the one the block stopped before.
                    step(1);
                    continue;
                }
                cold();
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
            const first = address >>> 12;
            const last = (address + size - 1) >>> 12;
            // A call's prediction is of the code that was there: one whose call
            // or callee lay on a page written is made again from samples of what
            // is there now. Kept, a callee's address in code since rewritten
            // formed whatever stands there, data among it, and its pages taken
            // for code made every store to them a way out.
            for (const [site, callees] of predictions)
            {
                if ([site, ...callees].some(at=>at >>> 12 >= first && at >>> 12 <= last))
                {
                    predictions.delete(site);
                }
            }
            for (let page = first; page <= last; page++)
            {
                const starts = byPage.get(page);
                if (starts === undefined)
                {
                    continue;
                }
                // Only a write that cost a region counts towards leaving the
                // page: a loader writes a page many times before anything on it runs.
                if (starts.size > 0)
                {
                    noteRewritten(page);
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

        /**
         * The program faulted on a page it cannot reach: reads test their pages
         * from now on, and the regions that wrapped theirs into RAM go -- the
         * same instruction would read RAM there where the interpreter faults.
         * Once a run, as the 32-bit runtime's `readsFaulted`.
         */
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
    return runner;
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
