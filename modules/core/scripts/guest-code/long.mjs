/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * x86-64 code on cork's long-mode machine, for the tests: the long-mode
 * translator's regions over its interpreter, as a 64-bit process runs them
 * (`createLongRunner`), RAM from address 0 with the engine's state pages
 * closed to stores, as the engine lays a process out.
 *
 * A call is made as the x64 convention makes one: the return address at RSP,
 * which is 8 past a multiple of 16; the 32 bytes above it the home space,
 * filled with a pattern; the arguments past the fourth in the slots above
 * that; the first four in RCX, RDX, R8 and R9. Every register is given a
 * value of its own, so a callee that leans on one it was not given, or leaves
 * one it keeps changed, shows -- and an integer argument's upper half is
 * given a pattern too, which the convention leaves undefined.
 *
 * For the tests: the machine is cork's own, not the engine.
 */

import { ownLayout, pageFlagsAt, pagesFor, tablesSize } from '../../../cork/src/runtime/layout.js';
import { PageFlag, createPageTable } from '../../../cork/src/runtime/pages.js';
import { blockState64 } from '../../../cork/src/interp64.js';
import { createLongRunner } from '../../../cork/src/long/runtime.js';

/** Where a function's code goes: above the null range, where blocks are translated. */
export const CODE_64 = 0x100000;
/** The return address's place at a call, 8 past a multiple of 16. */
export const STACK_64 = 0x3fe008;
const RAM = 0x400000;
/** The pages the engine keeps its state on, closed to the program's stores. */
const ENGINE_PAGES = [0x1000, 0x5000];

/** The sixteen registers, by their number. */
export const QUADS = Object.freeze(['rax', 'rcx', 'rdx', 'rbx', 'rsp', 'rbp', 'rsi', 'rdi',
    'r8', 'r9', 'r10', 'r11', 'r12', 'r13', 'r14', 'r15']);

/** The registers a callee keeps for its caller under the x64 convention. */
export const KEPT_64 = Object.freeze(['rbx', 'rbp', 'rsi', 'rdi', 'r12', 'r13', 'r14', 'r15']);

/** The registers a call finds, each a value no argument or address is. */
export const ENTRY_64 = Object.freeze({
    rax: 0xa5a5a5a5a5a5a5a5n, rbx: 0x1111111111111111n, rbp: 0x4444444444444444n,
    rsi: 0x2222222222222222n, rdi: 0x3333333333333333n, r10: 0xa0a0a0a0a0a0a0a0n,
    r11: 0xb1b1b1b1b1b1b1b1n, r12: 0xc2c2c2c2c2c2c2c2n, r13: 0xd3d3d3d3d3d3d3d3n,
    r14: 0xe4e4e4e4e4e4e4e4n, r15: 0xf5f5f5f5f5f5f5f5n,
});

/** The registers the first four integer arguments are passed in. */
const ARGUMENT_REGISTERS = ['rcx', 'rdx', 'r8', 'r9'];

/**
 * A word passed as an argument the convention leaves the upper half of
 * undefined: a pattern there, different for each.
 *
 * @param {number} word @param {number} index
 */
export const argumentOf = (word, index)=>BigInt(word >>> 0)
    | BigInt((0x9e3779b9 * (index + 1)) >>> 0) << 32n;

/**
 * A machine with its RAM open but for the engine's pages.
 *
 * @returns {LongMachine}
 */
export function longMachine(){
    const layout = ownLayout({ ramSize: RAM, ramBase: 0, bits: 64 });
    const memory = new WebAssembly.Memory({ initial: pagesFor(layout, tablesSize(layout)) });
    const flags = new Uint8Array(memory.buffer, pageFlagsAt(layout), 1 << 20);
    flags.fill(PageFlag.INACCESSIBLE);
    flags.fill(0, 0, RAM >>> 12);
    flags.fill(PageFlag.INACCESSIBLE, ENGINE_PAGES[0] >>> 12, ENGINE_PAGES[1] >>> 12);
    const pages = createPageTable(memory, layout);
    const runner = createLongRunner({ memory, layout, pages, hot: 1 });
    const state = blockState64({ memory, layout,
        onCodeWrite: (at, size)=>runner.invalidate(at, size) });
    const view = ()=>new DataView(memory.buffer);
    return {
        layout,
        bytes: ()=>new Uint8Array(memory.buffer),
        write(address, bytes){
            new Uint8Array(memory.buffer).set(bytes, address);
        },
        read(address, length){
            return new Uint8Array(memory.buffer).slice(address, address + length);
        },
        quad: address=>view().getBigUint64(address, true),
        setQuad(address, value){
            view().setBigUint64(address, BigInt.asUintN(64, value), true);
        },
        reg: name=>view().getBigUint64(layout.regs + QUADS.indexOf(name) * 8, true),
        rip: ()=>Number(view().getBigUint64(layout.eip, true)),
        xmm: index=>new Uint8Array(memory.buffer).slice(layout.xmm + index * 16,
            layout.xmm + index * 16 + 16),
        setXmm(index, bytes){
            new Uint8Array(memory.buffer).set(bytes, layout.xmm + index * 16);
        },
        flags: ()=>view().getUint32(layout.eflags, true),
        call(at, registers, budget = 50_000_000){
            const v = view();
            QUADS.forEach((name, i)=>v.setBigUint64(layout.regs + i * 8,
                BigInt.asUintN(64, registers[name] ?? 0n), true));
            v.setBigUint64(layout.eip, BigInt(at), true);
            v.setUint32(layout.eflags, 0x202, true);
            v.setUint32(layout.mxcsr, 0x1f80, true);
            state.syncIn();
            state.halted = false;
            state.trapped.length = 0;
            const before = state.retired;
            while (!state.halted && state.retired - before < budget)
            {
                runner.run(state, budget - (state.retired - before));
                state.syncOut();
            }
            return { halted: state.halted, retired: state.retired - before };
        },
    };
}

/**
 * @typedef {Object} LongMachine
 * @property {ReturnType<typeof ownLayout>} layout
 * @property {() => Uint8Array} bytes  The memory as it is now.
 * @property {(address: number, bytes: ArrayLike<number>) => void} write
 * @property {(address: number, length: number) => Uint8Array} read  A copy.
 * @property {(address: number) => bigint} quad
 * @property {(address: number, value: bigint) => void} setQuad
 * @property {(name: string) => bigint} reg
 * @property {() => number} rip
 * @property {(index: number) => Uint8Array} xmm  XMM register `index`'s sixteen bytes, a copy.
 * @property {(index: number, bytes: ArrayLike<number>) => void} setXmm
 * @property {() => number} flags
 * @property {(at: number, registers: Record<string, bigint>, budget?: number)
 *     => { halted: boolean, retired: number }} call
 *     Runs from `at` with the registers given (the others zero) to a `hlt`,
 *     or the budget's end; a fault is thrown with its vector.
 */

/**
 * Sets a call up as the x64 convention makes one and runs it to the halt
 * at `returnTo`: the arguments in their registers and slots, the home space
 * and every other register a pattern.
 *
 * A double or a float among the first four arguments is passed in the XMM
 * register of its place, its quadword the low half, the integer register of
 * that place left a pattern; past the fourth, in its slot as any argument.
 * Every XMM register is given sixteen bytes of its own.
 *
 * @param {LongMachine} m @param {number} at
 * @param {{ args?: bigint[], floats?: boolean[], returnTo: number,
 *     registers?: Record<string, bigint> }} call
 *     floats: which of the arguments are doubles or floats
 * @returns {{ entry: Record<string, bigint>, xmm: Uint8Array[], home: Uint8Array,
 *     slots: bigint[], halted: boolean, retired: number }}
 *     What the call was given: the registers, the XMM registers, the home
 *     space's bytes, the stack slots past it
 */
export function callLong(m, at, { args = [], floats = [], returnTo, registers = {} }){
    m.setQuad(STACK_64, BigInt(returnTo));
    m.write(STACK_64 + 8, new Uint8Array(32).fill(0xcd));
    const slots = args.slice(4);
    slots.forEach((value, i)=>m.setQuad(STACK_64 + 40 + i * 8, value));
    /** @type {Record<string, bigint>} */
    const entry = { ...ENTRY_64, rcx: 0xc5c5c5c5c5c5c5c5n, rdx: 0xd5d5d5d5d5d5d5d5n,
        r8: 0x8888888888888888n, r9: 0x9999999999999999n, ...registers, rsp: BigInt(STACK_64) };
    const xmm = Array.from({ length: 16 }, (_, i)=>Uint8Array.from({ length: 16 },
        (__, byte)=>(0x37 * (i + 1) + 0x11 * byte) & 0xff));
    args.slice(0, 4).forEach((value, i)=>{
        if (floats[i])
        {
            new DataView(xmm[i].buffer).setBigUint64(0, BigInt.asUintN(64, value), true);
            return;
        }
        entry[ARGUMENT_REGISTERS[i]] = value;
    });
    xmm.forEach((bytes, i)=>m.setXmm(i, bytes));
    const home = m.read(STACK_64 + 8, 32);
    const ran = m.call(at, entry);
    return { entry, xmm, home, slots, ...ran };
}

/** A machine per piece of code run by `runLongCode`, its translations kept. */
/** @type {WeakMap<Uint8Array, LongMachine>} */
const codeMachines = new WeakMap();

/** Where `runLongCode`'s calls return to: a `hlt`. */
const RETURN = 0x0f00;

/**
 * Runs code assembled by hand on the long-mode machine, called as the x64
 * convention calls with the arguments given: what a test holds a routine to.
 *
 * @param {Uint8Array} code @param {{ args?: bigint[], registers?: Record<string, bigint> }} input
 * @returns {{ regs: Record<string, bigint>, halted: boolean, entry: Record<string, bigint> }}
 */
export function runLongCode(code, { args = [], registers = {} }){
    let m = codeMachines.get(code);
    if (!m)
    {
        m = longMachine();
        m.write(CODE_64, code);
        m.write(RETURN, [0xf4]);
        codeMachines.set(code, m);
    }
    const machine = m;
    const { entry, halted } = callLong(machine, CODE_64, { args, returnTo: RETURN, registers });
    const regs = Object.fromEntries(QUADS.map(name=>[name, machine.reg(name)]));
    return { regs, halted: halted && machine.rip() === RETURN + 1, entry };
}
