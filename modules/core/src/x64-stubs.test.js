/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The x86-64 code the engine writes itself, run: the process's start-up
 * (`loader/internal/init.js`), what a thread's start and end tell the
 * libraries (`win32/kernel32/thread-calls.js`) and the code a callback starts
 * at (`bridge/internal/callback.js`). Each is decoded by cork's decoder and
 * stepped here over a sparse memory, the few instructions they use, so the
 * x64 convention is checked where a routine is entered -- its arguments in
 * RCX, RDX, R8 and R9, RSP eight past a multiple of 16 with the return
 * address there -- and a callee's registers are seen kept.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MODE_64, decode } from '../../cork/src/decode/decoder.js';
import { synthesiseProcessInit } from './layers/loader/internal/init.js';
import {
    DLL_THREAD_ATTACH, DLL_THREAD_DETACH, LONG_WALK_OFFSET, longThreadCallsCode,
} from './layers/win32/kernel32/thread-calls.js';
import { LONG_CALL_CODE, createCallbacks } from './layers/bridge/internal/callback.js';

const RAX = 0;
const RCX = 1;
const RDX = 2;
const RBX = 3;
const RSP = 4;
const RSI = 6;
const RDI = 7;
const R8 = 8;
const R9 = 9;
const MASK64 = (1n << 64n) - 1n;
/** The decoder's number for GS, a memory operand's `segment`. */
const SEGMENT_GS = 5;

/**
 * A routine the stepped code calls, answered here: what it saw on entry,
 * and what it answers in RAX.
 *
 * @typedef {(seen: { rcx: number, rdx: number, r8: number, r9: number, rsp: number })
 *     => number} Routine
 */

/**
 * A sparse little-endian memory of bytes.
 */
class Memory {
    constructor(){
        /** @type {Map<number, number>} */
        this.bytes = new Map();
    }

    /** @param {number} address @param {number} size */
    read(address, size){
        let value = 0n;
        for (let at = size - 1; at >= 0; at--)
        {
            value = value << 8n | BigInt(this.bytes.get(address + at) ?? 0);
        }
        return value;
    }

    /** @param {number} address @param {number} size @param {bigint} value */
    write(address, size, value){
        for (let at = 0; at < size; at++)
        {
            this.bytes.set(address + at, Number(value >> BigInt(at * 8) & 0xffn));
        }
    }

    /** @param {number} address @param {Uint8Array | readonly number[]} code */
    place(address, code){
        code.forEach((byte, at)=>this.bytes.set(address + at, byte));
    }
}

/**
 * Steps code from `rip` until it reaches an address in `stops`, calling into
 * `routines` where a call names one. Every call into a routine is checked to
 * be made with RSP a multiple of 16, as the convention has it.
 *
 * @param {Object} options
 * @param {Memory} options.memory
 * @param {number} options.rip
 * @param {bigint[]} options.r  sixteen registers, changed in place
 * @param {Map<number, Routine>} options.routines
 * @param {Set<number>} options.stops
 * @param {number} [options.gsBase]  where GS points: the thread's block
 * @returns {number} where it stopped
 */
function step({ memory, rip, r, routines, stops, gsBase = 0 }){
    let zero = false;
    /** @param {any} operand */
    const address = operand=>Number((operand.base >= 0 ? r[operand.base] : 0n)
        + (operand.index >= 0 ? r[operand.index] * BigInt(operand.scale) : 0n)
        + BigInt(operand.disp ?? 0) + BigInt(operand.segment === SEGMENT_GS ? gsBase : 0));
    /** @param {any} operand @returns {bigint} */
    const read = operand=>{
        if (operand.kind === 'reg')
        {
            return r[operand.reg] & (operand.size === 8 ? MASK64 : 0xffffffffn);
        }
        if (operand.kind === 'imm')
        {
            return BigInt.asUintN(operand.size * 8, BigInt(operand.value));
        }
        return memory.read(address(operand), operand.size);
    };
    /** @param {any} operand @param {bigint} value */
    const write = (operand, value)=>{
        if (operand.kind === 'reg')
        {
            // A 32-bit write clears the register's upper half.
            r[operand.reg] = value & (operand.size === 8 ? MASK64 : 0xffffffffn);
            return;
        }
        memory.write(address(operand), operand.size, value);
    };
    /** @param {bigint} value */
    const push = value=>{
        r[RSP] -= 8n;
        memory.write(Number(r[RSP]), 8, value);
    };
    const pop = ()=>{
        const value = memory.read(Number(r[RSP]), 8);
        r[RSP] += 8n;
        return value;
    };
    for (let count = 0; count < 10000; count++)
    {
        if (stops.has(rip))
        {
            return rip;
        }
        const instruction = /** @type {any} */ (decode(at=>Number(memory.read(at, 1)), rip,
            MODE_64));
        assert.ok(!('refused' in instruction), `an instruction at 0x${rip.toString(16)}`);
        const next = rip + instruction.length;
        const [first, second] = instruction.operands;
        rip = next;
        switch (instruction.op)
        {
            case 'mov':
                write(first, read(second));
                break;
            case 'add':
            case 'sub':
            {
                const sum = instruction.op === 'add' ? read(first) + read(second)
                    : read(first) - read(second);
                write(first, sum & MASK64);
                break;
            }
            case 'xor':
                write(first, read(first) ^ read(second));
                break;
            case 'test':
                zero = (read(first) & read(second)) === 0n;
                break;
            case 'je':
                rip = zero ? first.target : next;
                break;
            case 'push':
                push(read(first));
                break;
            case 'pop':
                write(first, pop());
                break;
            case 'ret':
                rip = Number(pop());
                break;
            case 'jmp':
                rip = first.kind === 'rel' ? first.target : Number(read(first));
                break;
            case 'call':
            {
                const target = first.kind === 'rel' ? first.target : Number(read(first));
                const routine = routines.get(target);
                if (!routine)
                {
                    push(BigInt(next));
                    rip = target;
                    break;
                }
                assert.equal(Number(r[RSP] % 16n), 0,
                    `RSP a multiple of 16 at the call to 0x${target.toString(16)}`);
                // As the routine finds them: its return address pushed.
                const rsp = Number(r[RSP]) - 8;
                r[RAX] = BigInt(routine({ rcx: Number(r[RCX]), rdx: Number(r[RDX]),
                    r8: Number(r[R8]), r9: Number(r[R9]), rsp }) >>> 0);
                // What a callee may spend.
                for (const volatile of [RCX, RDX, R8, R9, 10, 11])
                {
                    r[volatile] = 0xdead0000dead0000n;
                }
                break;
            }
            default:
                assert.fail(`no case for ${instruction.op} at 0x${(next - instruction.length)
                    .toString(16)}`);
        }
    }
    return assert.fail('the code did not reach a stop');
}

/** @returns {bigint[]} */
const registers = ()=>new Array(16).fill(0n);

test('a 64-bit process starts up in the x64 convention, and enters the program as it came', ()=>{
    const memory = new Memory();
    const at = 0x10000;
    const lock = { address: 0x600000, enter: 0x2000030, leave: 0x2000040 };
    const library = { name: 'one.dll', base: 0x3000000, entryPoint: 0x3001000,
        tls: { index: 3, blockAddress: 0x500000, callbacks: [0x3001200] } };
    const { bytes, attached, tlsImages } = synthesiseProcessInit({
        long: true, libraries: [library], entryPoint: 0x401234, loaderLock: lock,
    });
    // The thread's block, and the thread-local array it points at.
    const teb = 0x700000;
    const array = 0x710000;
    memory.write(teb + 0x58, 8, BigInt(array));
    assert.deepEqual(attached, ['one.dll']);
    assert.equal(tlsImages, 1);
    memory.place(at, bytes);

    /** @type {string[]} */
    const calls = [];
    /**
     * A library routine, called with DllMain's three arguments.
     *
     * @param {string} name @param {number} answer
     * @returns {Routine}
     */
    const told = (name, answer)=>({ rcx, rdx, r8 })=>{
        calls.push(`${name} 0x${rcx.toString(16)} ${rdx} ${r8}`);
        return answer;
    };
    /** @type {Map<number, Routine>} */
    const routines = new Map([
        [lock.enter, ({ rcx })=>(calls.push(`enter 0x${rcx.toString(16)}`), 0)],
        [lock.leave, ({ rcx })=>(calls.push(`leave 0x${rcx.toString(16)}`), 0)],
        [0x3001200, told('callback', 0)],
        [0x3001000, told('DllMain', 1)],
    ]);
    const r = registers();
    const start = 0x80008;
    r[RSP] = BigInt(start);
    const stopped = step({ memory, rip: at, r, routines, stops: new Set([0x401234]), gsBase: teb });

    assert.equal(stopped, 0x401234, 'the program is entered last');
    assert.equal(Number(r[RSP]), start, 'with the stack as the thread began, as though there');
    assert.deepEqual(calls, [
        'enter 0x600000',
        'callback 0x3000000 1 1',
        'DllMain 0x3000000 1 1',
        'leave 0x600000',
    ]);
    assert.equal(Number(memory.read(array + 3 * 8, 8)), 0x500000,
        'the image\'s block is in the thread\'s array at the image\'s index');
});

test('a 64-bit thread tells the libraries of its start, then runs as it was made', ()=>{
    const memory = new Memory();
    const at = 0x20000;
    const trap = 0x2000100;
    const lock = { address: 0x600000, enter: 0x2000030, leave: 0x2000040 };
    const table = 0x700000;
    // Two images' routines, as the trap lists them: [routine, base]..., 0.
    memory.write(table, 4, 0x3001000n);
    memory.write(table + 4, 4, 0x3000000n);
    memory.write(table + 8, 4, 0x3101000n);
    memory.write(table + 12, 4, 0x3100000n);
    memory.write(table + 16, 4, 0n);
    memory.place(at, longThreadCallsCode({ at, trap, lock }));

    /** @type {string[]} */
    const calls = [];
    /** @type {Routine} */
    const told = ({ rcx, rdx, r8, rsp })=>{
        assert.equal(rsp % 16, 8);
        calls.push(`0x${rcx.toString(16)} ${rdx} ${r8}`);
        return 1;
    };
    /** @type {Map<number, Routine>} */
    const routines = new Map([
        [lock.enter, ()=>(calls.push('enter'), 0)],
        [lock.leave, ()=>(calls.push('leave'), 0)],
        [trap, ({ rcx })=>(calls.push(`list ${rcx}`), table)],
        [0x3001000, told],
        [0x3101000, told],
    ]);
    // The kernel's x64 frame: the return address, home space above it.
    const r = registers();
    const top = 0x90008;
    r[RSP] = BigInt(top);
    memory.write(top, 8, 0x100000n);
    r[RCX] = 0x1234n;
    r[RDX] = 0x405000n;
    const stopped = step({ memory, rip: at, r, routines, stops: new Set([0x405000]) });

    assert.equal(stopped, 0x405000, 'the start routine runs last');
    assert.equal(Number(r[RCX]), 0x1234, 'with its parameter');
    assert.equal(Number(r[RSP]), top, 'and the stack the thread was made with');
    assert.equal(Number(memory.read(top, 8)), 0x100000, 'its return address untouched');
    assert.deepEqual(calls, ['enter', `list ${DLL_THREAD_ATTACH}`,
        `0x3000000 ${DLL_THREAD_ATTACH} 0`, `0x3100000 ${DLL_THREAD_ATTACH} 0`, 'leave']);
});

test('a 64-bit thread\'s end walks the list and keeps the registers a callee keeps', ()=>{
    const memory = new Memory();
    const at = 0x20000;
    const trap = 0x2000100;
    const table = 0x700000;
    memory.write(table, 4, 0x3001000n);
    memory.write(table + 4, 4, 0x3000000n);
    memory.write(table + 8, 4, 0n);
    memory.place(at, longThreadCallsCode({ at, trap, lock: null }));

    /** @type {string[]} */
    const calls = [];
    /** @type {Map<number, Routine>} */
    const routines = new Map([
        [trap, ({ rcx })=>(calls.push(`list ${rcx}`), table)],
        [0x3001000, ({ rcx, rdx })=>(calls.push(`0x${rcx.toString(16)} ${rdx}`), 1)],
    ]);
    const r = registers();
    const top = 0x90008;
    r[RSP] = BigInt(top);
    memory.write(top, 8, 0x100000n);
    r[RCX] = BigInt(DLL_THREAD_DETACH);
    r[RBX] = 0x1111111122222222n;
    r[RSI] = 0x3333333344444444n;
    r[RDI] = 0x5555555566666666n;
    const stopped = step({ memory, rip: at + LONG_WALK_OFFSET, r, routines,
        stops: new Set([0x100000]) });

    assert.equal(stopped, 0x100000, 'the walk returns to its caller');
    assert.equal(Number(r[RSP]), top + 8, 'having taken only its return address');
    assert.deepEqual(calls, [`list ${DLL_THREAD_DETACH}`, `0x3000000 ${DLL_THREAD_DETACH}`]);
    assert.equal(r[RBX], 0x1111111122222222n);
    assert.equal(r[RSI], 0x3333333344444444n);
    assert.equal(r[RDI], 0x5555555566666666n);
});

test('a callback in a 64-bit process enters its routine in the x64 convention', ()=>{
    const memory = new Memory();
    const sentinel = 0x100010;
    const code = 0x5000;
    const worker = { name: 'main' };
    /** @type {any[]} */
    const resumed = [];
    /** @type {Uint8Array[]} */
    const placed = [];
    const callbacks = createCallbacks({
        cpu: { readReg32: ()=>0, bits: ()=>64 },
        kernel: {
            threads: ()=>[worker],
            /** @param {any} thread @param {any} where */
            scheduleResume: (thread, where)=>resumed.push(where),
        },
        memory: {
            /** @param {number} address @param {number} value */
            writeU32: (address, value)=>memory.write(address, 4, BigInt(value >>> 0)),
        },
        reserveTrap: ()=>({ id: 1, address: sentinel }),
    });
    callbacks.reserve();
    callbacks.placeLongCall(bytes=>{
        placed.push(bytes);
        memory.place(code, bytes);
        return code;
    });
    const entry = 0x401230;
    const args = [0x11, 0x22, 0x33, 0x44, 0x55, 0x66];
    // Not aligned, on purpose: the frame is.
    const resting = 0x2ff7f4;
    void callbacks.call({ thread: worker, entry, args, stackAtRest: resting });
    void callbacks.call({ thread: worker, entry, args: [], stackAtRest: resting - 0x200 });
    assert.equal(placed.length, 1, 'the call code is placed once');
    assert.deepEqual([...placed[0]], [...LONG_CALL_CODE]);

    const { eip, esp, registers: given } = resumed[0];
    assert.equal(eip, code, 'the thread starts at the call code');
    assert.deepEqual(given, { eax: entry }, 'with the routine in EAX');

    const r = registers();
    // The resume sets EAX's low dword alone; its upper half is whatever was there.
    r[RAX] = 0xfeedface00000000n | BigInt(given.eax);
    r[RSP] = BigInt(esp);
    step({ memory, rip: eip, r, routines: new Map(), stops: new Set([entry]) });
    const seen = { rcx: Number(r[RCX]), rdx: Number(r[RDX]), r8: Number(r[R8]),
        r9: Number(r[R9]), rsp: Number(r[RSP]) };
    assert.deepEqual([seen.rcx, seen.rdx, seen.r8, seen.r9], [0x11, 0x22, 0x33, 0x44],
        'the first four in RCX, RDX, R8 and R9');
    assert.equal(seen.rsp % 16, 8, 'RSP eight past a multiple of 16');
    assert.equal(Number(memory.read(seen.rsp, 8)), sentinel, 'the sentinel to return to');
    assert.equal(Number(memory.read(seen.rsp + 0x28, 8)), 0x55, 'the fifth past the home space');
    assert.equal(Number(memory.read(seen.rsp + 0x30, 8)), 0x66);
    assert.ok(seen.rsp + 0x38 + 8 <= resting, 'and a spare quadword below the resting stack');
    assert.equal(Number(memory.read(seen.rsp + 8, 8)), 0x11, 'the home space holds the four');
});
