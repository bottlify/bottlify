/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A machine for the emitter's tests: cork's own layout over a small memory,
 * code written where a test says, a region formed and translated at an
 * entry, the function run, the state read back. No host, no runtime:
 * the smallest thing that executes translated code.
 */

import { formRegion } from '../region.js';
import { ModuleBuilder } from '../wasm/encoder.js';
import { features } from '../wasm/features.js';
import {
    TIER_SLOT, emitRegion, enterRegion, finishModule, prepareModule, mathImports,
} from '../emit/region.js';
import { buildHelpersModule } from '../emit/helpers.js';
import {
    PAGE, Tables, basesOf, executorBytes, executorLayout, ownLayout, pagesFor, sharedLayout,
    tablesSize,
} from '../runtime/layout.js';
import { createPageTable } from '../runtime/pages.js';
import { ANY_TOP, createEntries } from '../runtime/entries.js';
import { SHAPE, isX87 } from '../emit/x87.js';
import { PRECISION } from '../emit/memory.js';
import { eflagsOf, setEflags } from '../emit/flags.js';

const REGISTERS = ['eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi'];

/**
 * @param {{ ramSize?: number, trapPort?: number,
 *     trap?: (value: number) => number, rdtsc?: () => bigint,
 *     leaveOut?: string[], precise?: boolean, structure?: boolean,
 *     resume?: boolean, looseStacks?: boolean, executor?: number, hashSlots?: number,
 *     processors?: number, shared?: boolean,
 *     features?: Partial<import('../wasm/features.js').Features> }} [given]
 *     trapPort: `out dx, eax` to it calls
 *     `trap` from inside the region (answering 1 when it moved EIP), as under a host with
 *     a call channel; without `trap`, one that answers 0; precise: nothing relaxed -- on
 *     unless a test asks, since the tests and the corpus judge the processor's behaviour;
 *     structure: the regions' loops as wasm loops (`prepareModule`), as the emitter's default
 *     unless a test asks or `CORK_STRUCTURE` in the environment says 0 or 1, so a suite can
 *     be run under the other form; resume: a miss of the hash calls what `setTier` put in the
 *     table's `TIER_SLOT`; looseStacks: a store through esp alone tests no page, outside
 *     precise (`prepareModule`); executor: the machine is that executor of a memory with room
 *     for it, its state page and tables past the first's (`executorLayout`), 0 by default;
 *     processors: the executors `cpuid` says the machine has (`ownLayout`), one by default;
 *     shared: regions translated for the process's shared layout (`sharedLayout`) and run
 *     here with this executor's bases, as every executor of a process runs them; features:
 *     another host's engine in place of this one's (`features`), the regions translated as
 *     that host's translator makes them -- an arm64 one's default NaN is positive
 */
export function createTestMachine(given = {}){
    const { ramSize = 1 << 20, trapPort, trap, rdtsc, leaveOut = [],
        precise = true, resume = false, looseStacks = false, executor = 0, shared = false } = given;
    const forced = globalThis.process?.env?.CORK_STRUCTURE;
    const structure = given.structure
        ?? (forced === '1' ? true : forced === '0' ? false : undefined);
    // A small entry hash: a test's program has few block starts, and a machine
    // per test zeroing the engine's default would be most of the suite's time.
    const first = ownLayout({ ramSize, hashSlots: given.hashSlots ?? 1 << 16,
        processors: given.processors ?? 1 });
    const firstPages = pagesFor(first, tablesSize(first));
    const layout = executor === 0 ? first
        : executorLayout(first, firstPages * PAGE + (executor - 1) * executorBytes(first),
            executor);
    // What regions are translated for, and the two globals that place them here.
    const emitLayout = shared ? sharedLayout(first) : layout;
    const bases = shared ? Object.fromEntries(Object.entries(basesOf(layout)).map(([name, value])=>
        [name, new WebAssembly.Global({ value: 'i32', mutable: false }, value)])) : {};
    const memory = new WebAssembly.Memory({
        initial: firstPages + executor * executorBytes(first) / PAGE });
    const pages = createPageTable(memory, layout);
    // The x87 as a fresh processor has it: every register empty, the
    // default control word.
    new DataView(memory.buffer).setUint8(layout.x87Empty, 0xff);
    new DataView(memory.buffer).setUint16(layout.x87Control, 0x37f, true);
    new DataView(memory.buffer).setUint32(layout.mxcsr, 0x1f80, true);
    const view = ()=>new DataView(memory.buffer);
    const bytes = ()=>new Uint8Array(memory.buffer);
    const found = { ...features(), ...given.features };
    // The function table and the entry hash a runtime keeps, so a program
    // run through `runProgram` transfers between its regions as the
    // runtime's would.
    const table = found.tailCalls
        ? new WebAssembly.Table({ element: 'anyfunc', initial: resume ? TIER_SLOT + 1 : 0 })
        : null;
    const entries = createEntries(table
        ? { memory, hashBase: layout.tables + Tables.HASH, shift: layout.hashShift ?? 16 } : {});
    // The shared helpers module, one instance per machine, over its memory.
    /** @type {any} */
    let helperInstance = null;
    const helperImports = ()=>{
        if (helperInstance === null)
        {
            const module = new WebAssembly.Module(
                /** @type {Uint8Array<ArrayBuffer>} */ (buildHelpersModule(layout)));
            helperInstance = new WebAssembly.Instance(module, { env: { memory } }).exports;
        }
        return helperInstance;
    };
    return {
        layout,
        memory,
        pages,
        /** @param {number} address @param {number[] | Uint8Array} data */
        write(address, data){
            bytes().set(data, layout.ramBase + address);
        },
        /** @param {number} address @param {number} length */
        read(address, length){
            return bytes().slice(layout.ramBase + address, layout.ramBase + address + length);
        },
        /** @param {number} address */
        readU32(address){
            return view().getUint32(layout.ramBase + address, true);
        },
        /** @param {number} address @param {number} value */
        writeU32(address, value){
            view().setUint32(layout.ramBase + address, value >>> 0, true);
        },
        /** @param {string} name */
        reg(name){
            return view().getUint32(layout.regs + REGISTERS.indexOf(name) * 4, true);
        },
        /** @param {string} name @param {number} value */
        setReg(name, value){
            view().setUint32(layout.regs + REGISTERS.indexOf(name) * 4, value >>> 0, true);
        },
        eflags(){
            return eflagsOf(view(), layout);
        },
        /** @param {number} value */
        setEflags(value){
            setEflags(view(), layout, value);
        },
        eip(){
            return view().getUint32(layout.eip, true);
        },
        counter(){
            return view().getUint32(layout.counter, true);
        },
        /** @param {number} value */
        setFsBase(value){
            view().setUint32(layout.fsBase, value >>> 0, true);
        },
        /** The function a miss of the hash calls under `resume`: the interpreter tier's
         * entry, or a stand-in. @param {Function} entry */
        setTier(entry){
            /** @type {WebAssembly.Table} */ (table).set(TIER_SLOT, entry);
        },
        /**
         * Forms and translates a region at `entry` and returns a runner over
         * it, plus what the emitter said.
         *
         * @param {number} entry
         * @param {{ maxBlocks?: number, maxBytes?: number, undoLog?: boolean,
         *     entryTop?: number, hash?: boolean, leafCalls?: boolean, wide?: boolean,
         *     narrow?: boolean, speculate?: boolean, callTargets?: Map<number, number[]>,
         *     copies?: boolean,
         *     helpers?: boolean | readonly import('../helpers.js').RuntimeHelper[] }} [options]
         *     hash: register the region's entries in the machine's hash, so a transfer from
         *     another region finds them; wide: compiled for the wide precision controls;
         *     narrow: compiled for single precision;
         *     speculate: an x87 region's entries test the stack's shape its blocks were
         *     compiled for, and leave with `SHAPE` when it is not the machine's -- off, the
         *     region is the `checked` one, which runs from any stack; copies: as `emitRegion`
         *     takes it, on unless false
         */
        translate(entry, options = {}){
            const { undoLog = false, entryTop = 0, hash = false, wide = false, narrow = false,
                speculate = false, copies = true, ...regionOptions } = options;
            const read = (/** @type {number} */ address)=>bytes()[layout.ramBase + address];
            const region = formRegion(read, entry, regionOptions);
            const m = new ModuleBuilder();
            const context = prepareModule(m, emitLayout, found, {}, {
                undoLog, hash: table !== null && hash, wide, narrow, precise, resume, looseStacks,
                ...(structure === undefined ? {} : { structure }),
                ...(trapPort === undefined ? {} : { trapPort }), leaveOut: new Set(leaveOut),
            });
            const translation = emitRegion(context, region,
                { entryTop, checked: !speculate, copies });
            finishModule(context, [translation.functionIndex]);
            m.exportFunction('region', translation.functionIndex);
            const built = m.toBytes();
            if (!WebAssembly.validate(built))
            {
                new WebAssembly.Module(built); // throws with the engine's message
            }
            const instance = new WebAssembly.Instance(new WebAssembly.Module(built), {
                env: {
                    memory, ...mathImports(), ...helperImports(), ...(table ? { table } : {}),
                    trap: trap ?? (()=>0),
                    rdtsc: rdtsc ?? (()=>0n), ...bases,
                },
            });
            const run = /** @type {import('../runtime/entries.js').Entry['fn']} */ (
                /** @type {any} */ (instance.exports).region);
            /** @type {number[]} the hash entries this region made */
            const slots = [];
            if (table && hash)
            {
                const index = table.grow(1);
                table.set(index, run);
                const top = translation.cut.size > 0
                    || region.blocks.some(block=>block.instructions.some(isX87))
                    ? entryTop : ANY_TOP;
                for (const [eip, label] of translation.labels)
                {
                    if (!translation.cut.has(label))
                    {
                        const slot = entries.add(eip, run, label, top, index);
                        if (entries.at(slot).fn === run)
                        {
                            slots.push(slot);
                        }
                    }
                }
            }
            return {
                region,
                translation,
                bytes: built,
                /** Takes the region's entries out of the hash. */
                drop(){
                    for (const slot of slots.splice(0))
                    {
                        entries.remove(slot);
                    }
                },
                /**
                 * Runs from a block start with a budget; answers the exit.
                 *
                 * @param {number} eip @param {number} [budget]
                 */
                run(eip, budget = 1_000_000){
                    const label = translation.labels.get(eip);
                    if (label === undefined)
                    {
                        throw new Error(`no block starts at 0x${eip.toString(16)}`);
                    }
                    const code = enterRegion(run, label, budget, view(), layout) >>> 0;
                    return { kind: code & 0xff, vector: code >>> 8 };
                },
            };
        },
        /**
         * Runs a whole program from `entry`: a region is translated at every
         * address execution reaches that has none yet, and run until it
         * halts, faults, runs out of budget, or meets an instruction the
         * emitter leaves out. The smallest runtime there is, for tests.
         *
         * @param {number} entry
         * @param {{ budget?: number, maxRegions?: number, undoLog?: boolean,
         *     leafCalls?: boolean, wide?: boolean, speculate?: boolean,
         *     callTargets?: Map<number, number[]>,
         *     helpers?: boolean | readonly import('../helpers.js').RuntimeHelper[] }} [options]
         *     wide: x87 regions compiled for the wide precision controls until one finds
         *     single set, then everything again for single until one finds another, then
         *     everything again with a test at every rounding operation -- as the runtime does;
         *     speculate: x87 regions compiled for the stack's shape at their entries until
         *     an entry finds another, then everything again `checked` (the runtime counts
         *     such exits per region and leaves the block to its interpreter meanwhile; with
         *     no interpreter here, the checked translation runs it)
         * @returns {{ kind: number, vector: number, eip: number, regions: number, runs: number,
         *     unsupported: Map<string, number>, retired: number }}  runs: times a region
         *     function was called from here (a transfer between regions is not one)
         */
        runProgram(entry, options = {}){
            const { budget = 10_000_000, maxRegions = 2000, undoLog = false,
                leafCalls = true, callTargets, helpers } = options;
            /** @type {'wide' | 'narrow' | 'mixed'} */
            let precision = options.wide ?? true ? 'wide' : 'mixed';
            let speculate = options.speculate ?? true;
            /** @type {Map<number, ReturnType<typeof this.translate>>} */
            const translated = new Map();
            /** @type {ReturnType<typeof this.translate>[]} */
            const made = [];
            /** @type {Map<string, number>} */
            const unsupported = new Map();
            let eip = entry;
            let left = budget;
            let regions = 0;
            let runs = 0;
            view().setUint32(layout.eip, eip, true);
            for (;;)
            {
                const top = view().getUint8(layout.x87Top);
                let unit = translated.get(eip * 16 + top);
                if (!unit)
                {
                    if (regions >= maxRegions)
                    {
                        return {
                            kind: -1, vector: 0, eip, regions, runs, unsupported,
                            retired: budget - left,
                        };
                    }
                    unit = this.translate(eip, { undoLog, entryTop: top, hash: true, leafCalls,
                        wide: precision === 'wide', narrow: precision === 'narrow', speculate,
                        ...(callTargets ? { callTargets } : {}),
                        ...(helpers === undefined ? {} : { helpers }) });
                    made.push(unit);
                    regions++;
                    for (const [opcode, count] of unit.translation.unsupported)
                    {
                        unsupported.set(opcode, (unsupported.get(opcode) ?? 0) + count);
                    }
                    // A cut block is no entry, as the runtime keeps none: a run
                    // that leaves at one has a region formed there for the top
                    // the machine then has.
                    for (const [start, label] of unit.translation.labels)
                    {
                        if (start === eip || !unit.translation.cut.has(label))
                        {
                            translated.set(start * 16 + top, unit);
                        }
                    }
                }
                const before = this.counter();
                const from = eip;
                const exit = unit.run(eip, left);
                runs++;
                left -= this.counter() - before;
                eip = this.eip();
                if (exit.kind === 0 && exit.vector === PRECISION && precision !== 'mixed')
                {
                    // Another precision control seen: translated again for it,
                    // and out of the hash too, so a transfer finds the new ones.
                    precision = precision === 'wide' ? 'narrow' : 'mixed';
                    translated.clear();
                    for (const one of made)
                    {
                        one.drop();
                    }
                    continue;
                }
                if (exit.kind === 0 && exit.vector === SHAPE && speculate)
                {
                    // Out of the hash too, so a transfer finds the checked ones.
                    speculate = false;
                    translated.clear();
                    for (const one of made)
                    {
                        one.drop();
                    }
                    continue;
                }
                if (exit.kind !== 0 || left <= 0)
                {
                    return { ...exit, eip, regions, runs, unsupported, retired: budget - left };
                }
                // Back where it started with nothing retired: the emitter cut
                // the region before the instruction at this address, and
                // running it again would come straight back again.
                if (eip === from && this.counter() === before)
                {
                    return {
                        kind: -2, vector: 0, eip, regions, runs, unsupported,
                        retired: budget - left,
                    };
                }
            }
        },
    };
}
