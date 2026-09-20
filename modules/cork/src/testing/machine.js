/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A machine for the emitter's tests: cork's own layout over a small memory,
 * code written where a test says, a region formed and translated at an
 * entry, the function run, the state read back. No emulator, no runtime:
 * the smallest thing that executes translated code.
 */

import { formRegion } from '../region.js';
import { ModuleBuilder } from '../wasm/encoder.js';
import { features } from '../wasm/features.js';
import { emitRegion, prepareModule, mathImports } from '../emit/region.js';
import { Tables, ownLayout, pagesFor } from '../runtime/layout.js';
import { createPageTable } from '../runtime/pages.js';

const REGISTERS = ['eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi'];

/**
 * @param {{ ramSize?: number, codePages?: boolean }} [options]
 */
export function createTestMachine({ ramSize = 1 << 20, codePages = false } = {}){
    // With `codePages`, the undo ring's area doubles as another executor's
    // byte-per-page code table, for the tests of a store into its pages.
    const own = ownLayout({ ramSize });
    const layout = codePages ? { ...own, codePages: own.tables + Tables.UNDO_RING } : own;
    const memory = new WebAssembly.Memory({ initial: pagesFor(layout, Tables.SIZE) });
    const pages = createPageTable(memory, layout);
    // The x87 as a fresh processor has it: every register empty, the
    // default control word.
    new DataView(memory.buffer).setUint8(layout.x87Empty, 0xff);
    new DataView(memory.buffer).setUint16(layout.x87Control, 0x37f, true);
    const view = ()=>new DataView(memory.buffer);
    const bytes = ()=>new Uint8Array(memory.buffer);
    const found = features();
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
            return view().getUint32(layout.eflags, true);
        },
        /** @param {number} value */
        setEflags(value){
            view().setUint32(layout.eflags, value >>> 0, true);
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
        /**
         * Forms and translates a region at `entry` and returns a runner over
         * it, plus what the emitter said.
         *
         * @param {number} entry
         * @param {{ maxBlocks?: number, maxBytes?: number, undoLog?: boolean,
         *     entryTop?: number }} [options]
         */
        translate(entry, options = {}){
            const { undoLog = false, entryTop = 0, ...regionOptions } = options;
            const read = (/** @type {number} */ address)=>bytes()[layout.ramBase + address];
            const region = formRegion(read, entry, regionOptions);
            const m = new ModuleBuilder();
            const context = prepareModule(m, layout, found, {}, { undoLog });
            const translation = emitRegion(context, region, { entryTop });
            m.exportFunction('region', translation.functionIndex);
            const built = m.toBytes();
            if (!WebAssembly.validate(built))
            {
                new WebAssembly.Module(built); // throws with the engine's message
            }
            const instance = new WebAssembly.Instance(new WebAssembly.Module(built), {
                env: { memory, ...mathImports() },
            });
            const run = /** @type {(label: number, budget: number) => number} */ (
                /** @type {any} */ (instance.exports).region);
            return {
                region,
                translation,
                bytes: built,
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
                    const code = run(label, budget) >>> 0;
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
         * @param {{ budget?: number, maxRegions?: number, undoLog?: boolean }} [options]
         * @returns {{ kind: number, vector: number, eip: number, regions: number,
         *     unsupported: Map<string, number>, retired: number }}
         */
        runProgram(entry, { budget = 10_000_000, maxRegions = 2000, undoLog = false } = {}){
            /** @type {Map<number, ReturnType<typeof this.translate>>} */
            const translated = new Map();
            /** @type {Map<string, number>} */
            const unsupported = new Map();
            let eip = entry;
            let left = budget;
            let regions = 0;
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
                            kind: -1, vector: 0, eip, regions, unsupported, retired: budget - left,
                        };
                    }
                    unit = this.translate(eip, { undoLog, entryTop: top });
                    regions++;
                    for (const [opcode, count] of unit.translation.unsupported)
                    {
                        unsupported.set(opcode, (unsupported.get(opcode) ?? 0) + count);
                    }
                    for (const start of unit.translation.labels.keys())
                    {
                        translated.set(start * 16 + top, unit);
                    }
                }
                const before = this.counter();
                const from = eip;
                const exit = unit.run(eip, left);
                left -= this.counter() - before;
                eip = this.eip();
                if (exit.kind !== 0 || left <= 0)
                {
                    return { ...exit, eip, regions, unsupported, retired: budget - left };
                }
                // Back where it started with nothing retired: the emitter cut
                // the region before the instruction at this address, and
                // running it again would come straight back again.
                if (eip === from && this.counter() === before)
                {
                    return {
                        kind: -2, vector: 0, eip, regions, unsupported, retired: budget - left,
                    };
                }
            }
        },
    };
}
