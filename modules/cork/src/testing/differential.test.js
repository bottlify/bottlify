/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { replaySlice, retireExactly } from './differential.js';
import { snapshot } from './snapshot.js';

/**
 * A machine of arrays whose "program" is a function run once per step: it
 * stands in for both executors, since in hybrid mode both work the same
 * host, and its program is what the test varies.
 */
function fakeMachine(){
    /** @type {Record<string, number>} */
    const registers = {
        eax: 0, ecx: 0, edx: 0, ebx: 0, esp: 0x1000, ebp: 0, esi: 0, edi: 0,
        eip: 0x8000, eflags: 2,
    };
    const ram = new Uint8Array(0x10000);
    const xmm = new Uint32Array(32);
    let mxcsr = 0x1f80;
    const x87 = {
        top: 0, empty: 0xff, control: 0x37f, status: 0,
        registers: new Float64Array(8), raw: new Uint8Array(128),
    };
    let halted = false;
    const machine = {
        registers, ram, halted: ()=>halted, wake: ()=>{
            halted = false;
        },
        halt: ()=>{
            halted = true;
        },
        /** @param {string} name */
        readReg32: name=>registers[name],
        /** @param {string} name @param {number} value */
        writeReg32: (name, value)=>{
            registers[name] = value >>> 0;
        },
        /** @param {number} address @param {number} length */
        readPhysical: (address, length)=>ram.subarray(address, address + length),
        /** @param {number} address @param {Uint8Array} bytes */
        writePhysical: (address, bytes)=>ram.set(bytes, address),
        /** @param {number} index */
        readXmm: index=>xmm.slice(index * 4, index * 4 + 4),
        /** @param {number} index @param {Uint32Array} words */
        writeXmm: (index, words)=>xmm.set(words, index * 4),
        readMxcsr: ()=>mxcsr,
        /** @param {number} value */
        writeMxcsr: value=>{
            mxcsr = value;
        },
        x87State: ()=>({
            ...x87, registers: Float64Array.from(x87.registers), raw: Uint8Array.from(x87.raw),
        }),
        /** @param {import('./snapshot.js').X87State} state */
        restoreX87State: state=>{
            Object.assign(x87, {
                top: state.top, empty: state.empty, control: state.control, status: state.status,
            });
            x87.registers.set(state.registers);
            x87.raw.set(state.raw);
        },
    };
    /**
     * An executor over the machine: each instruction adds one to ecx and
     * stores the total at 0x2000, plus whatever the program does extra.
     *
     * @param {(m: typeof machine, retired: number) => void} [extra]
     */
    const executor = (extra = ()=>{})=>({
        halted: machine.halted,
        wake: machine.wake,
        /** @param {number} instructions */
        step: instructions=>{
            let retired = 0;
            while (retired < instructions && !machine.halted())
            {
                registers.ecx = (registers.ecx + 1) >>> 0;
                registers.eip += 2;
                new DataView(ram.buffer).setUint32(0x2000, registers.ecx, true);
                retired++;
                extra(machine, retired);
            }
            return retired;
        },
    });
    return { machine, executor };
}

const SPANS = [{ address: 0x2000, length: 8 }];

test('an executor that stops on boundaries is run until the count is reached', ()=>{
    let calls = 0;
    const retired = retireExactly(n=>{
        calls++;
        return Math.min(n, 3);
    }, ()=>false, 10);
    assert.equal(retired, 10);
    assert.equal(calls, 4);
    assert.equal(retireExactly(()=>0, ()=>false, 10), 0,
        'an executor that cannot move stops the loop');
    assert.equal(retireExactly(()=>5, ()=>true, 10), 0, 'a halted machine retires nothing');
});

test('the same program on both sides diffs to nothing, and both retire the count', ()=>{
    const { machine, executor } = fakeMachine();
    const state = snapshot(machine, SPANS);
    const oracle = { ...machine, ...executor() };
    const result = replaySlice({
        oracle, subject: executor(), state, instructions: 7, spans: SPANS,
    });
    assert.deepEqual(result.divergences, []);
    assert.equal(result.retiredOracle, 7);
    assert.equal(result.retiredSubject, 7);
    assert.equal(result.oracleState.reg32[1], 7, 'ecx counted the instructions');
    assert.equal(new DataView(result.subjectState.memory[0].bytes.buffer).getUint32(0, true), 7);
});

test('a subject that adds one to ecx diverges on ecx and the word it stored, nothing else', ()=>{
    const { machine, executor } = fakeMachine();
    const state = snapshot(machine, SPANS);
    const oracle = { ...machine, ...executor() };
    const subject = executor((m, retired)=>{
        if (retired === 7)
        {
            m.registers.ecx += 1;
            new DataView(m.ram.buffer).setUint32(0x2000, m.registers.ecx, true);
        }
    });
    const { divergences } = replaySlice({ oracle, subject, state, instructions: 7, spans: SPANS });
    assert.deepEqual(divergences, [
        { name: 'ecx', expected: 7, actual: 8 },
        { name: 'mem[0x2000]', expected: 7, actual: 8 },
    ]);
});

test('a subject that retires fewer instructions diverges on the count first, then on eip', ()=>{
    const { machine, executor } = fakeMachine();
    const state = snapshot(machine, SPANS);
    const oracle = { ...machine, ...executor() };
    const subject = executor((m, retired)=>{
        if (retired === 5)
        {
            m.halt();
        }
    });
    const result = replaySlice({ oracle, subject, state, instructions: 7, spans: SPANS });
    assert.equal(result.retiredSubject, 5);
    assert.deepEqual(result.divergences.map(d=>d.name), ['retired', 'ecx', 'eip', 'mem[0x2000]']);
    assert.deepEqual(result.divergences[0], { name: 'retired', expected: 7, actual: 5 });
});

test('the state is restored between the two runs, memory included', ()=>{
    const { machine, executor } = fakeMachine();
    machine.registers.ecx = 100;
    const state = snapshot(machine, SPANS);
    const oracle = { ...machine, ...executor() };
    let seenAtStart = -1;
    const subject = executor((m, retired)=>{
        if (retired === 1)
        {
            seenAtStart = m.registers.ecx - 1;
        }
    });
    replaySlice({ oracle, subject, state, instructions: 3, spans: SPANS });
    assert.equal(seenAtStart, 100,
        'the subject started from the common state, not the oracle\'s end');
});
