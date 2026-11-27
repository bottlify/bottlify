/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The gate of a hoisted loop's read streams tested against RAM alone
 * (`emitStreamWindow` in memory.js): where reads go untested, a stream that
 * only reads needs its reach in RAM, a read there being the one wrapped into
 * RAM, and no page's flags. Seeded copy loops -- a dword read off one pointer,
 * stored through another -- whose source runs off RAM's end, or below its
 * start, run translated without `precise` against the model reading as the wrap
 * does: a window that let the unchecked copy read past RAM would read cork's
 * tables there. And a string instruction's read, tested where other reads
 * wrap: `movs` loops whose source meets a page inside RAM that cannot be read
 * fault where the model faults.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestMachine } from '../testing/machine.js';
import { decode } from '../decode/decoder.js';
import { createState, evaluate } from '../ir.js';
import { PageFlag } from '../runtime/pages.js';

const RAM = 1 << 20;
/** The code, the stack and the destination, mid-RAM, where no source reaches. */
const AT = 0x80000;
const OUT = 0x90000;
const NAMES = ['eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi'];

/** @param {number} value */
const le = value=>[value & 0xff, value >> 8 & 0xff, value >> 16 & 0xff, value >>> 24];

/** @param {number} seed */
function random(seed){
    let state = seed >>> 0;
    /** @param {number} n */
    return n=>{
        state = (Math.imul(state, 1103515245) + 12345) >>> 0;
        return (state >>> 8) % n;
    };
}

/** A RAM whose every byte is its address's own mix. */
function fill(){
    const ram = new Uint8Array(RAM);
    for (let i = 0; i < RAM; i++)
    {
        ram[i] = 1 + ((i * 2654435761 >>> 24) ^ i) % 255;
    }
    return ram;
}

/**
 * Runs `code` at AT on a machine without `precise` and on the model, whose
 * reads wrap into RAM and fault on page `bad`.
 *
 * @param {number[]} code @param {Uint8Array} ram @param {number} bad
 */
function judge(code, ram, bad = -1){
    const m = createTestMachine({ precise: false, ramSize: RAM });
    m.write(0, ram);
    m.write(AT, code);
    if (bad >= 0)
    {
        m.pages.set(bad, PageFlag.INACCESSIBLE);
    }
    m.setReg('esp', AT + 0x8000);
    m.setEflags(2);
    const exit = m.runProgram(AT);
    const model = ram.slice();
    model.set(code, AT);
    const view = new DataView(model.buffer);
    const state = createState({
        read: (address, size)=>{
            if (address >>> 12 === bad)
            {
                throw new Error('#GP');
            }
            const at = address & RAM - 1;
            return size === 1 ? model[at] : size === 2 ? view.getUint16(at, true)
                : view.getUint32(at, true);
        },
        write: (address, size, value)=>{
            if (size === 1)
            {
                model[address] = value;
            }
            else
            {
                view.setUint32(address, value, true);
            }
        },
    }, { eip: AT, esp: AT + 0x8000, fsBase: 0 });
    state.eflags = 2;
    let fault = false;
    let at = state.eip;
    try
    {
        while (!state.halted && state.retired < 1_000_000)
        {
            at = state.eip;
            const decoded = decode(address=>model[address], state.eip);
            if ('refused' in decoded)
            {
                break;
            }
            evaluate(decoded, state);
        }
    }
    catch {
        fault = true;
    }
    return { m, exit, state, model, fault, at };
}

test('a copy loop whose source runs off RAM reads what the wrap into RAM reads', ()=>{
    for (let seed = 1; seed <= 200; seed++)
    {
        const pick = random(seed * 7919);
        // A byte or a dword read; a dword stream stays aligned, so what wraps
        // into RAM lies inside it whole.
        const size = pick(2) === 0 ? 1 : 4;
        const magnitude = size === 1 ? [1, 2, 3, 4, 8][pick(5)] : [4, 8, 12][pick(3)];
        const stride = pick(2) === 0 ? magnitude : -magnitude;
        // Half of them at the edge of the first window: as `planLoop` makes it,
        // 1 + 4096 / widest turns (the destination's 4 among the strides), its
        // reach ending an element either side of RAM's end, the loop going on.
        const window = 1 + Math.floor(4096 / Math.max(4, magnitude));
        const edge = pick(2) === 0;
        const turns = edge ? window + 5 : [3, 40, 300, 1000, 3000][pick(5)];
        // Else the source's last turns past RAM's end (or below its start), by
        // nothing, an element, or many; or all of it inside RAM, ending at its end.
        const beyond = edge ? (pick(3) - 1) * size : [0, 0, 1, 4, pick(turns)][pick(5)] * magnitude;
        const start = edge
            ? (stride > 0 ? RAM - (window - 1) * magnitude - size + beyond
                : (window - 1) * magnitude - beyond)
            : stride > 0 ? RAM - turns * magnitude + beyond : (turns - 1) * magnitude - beyond;
        // Off esi itself: a displacement would take its wrapped sum
        // (`wrappedFirst`), which near RAM's end is not the address wrapped whole.
        const code = [
            0xbe, ...le(start >>> 0),                      // mov esi, start
            0xbf, ...le(OUT),                              // mov edi, out
            0xb9, ...le(turns),                            // mov ecx, turns
            ...size === 1 ? [0x0f, 0xb6, 0x06]             // movzx eax, byte [esi]
                : [0x8b, 0x46, 0x00],                      // mov eax, [esi + 0]
            0x89, 0x07,                                    // mov [edi], eax
            ...stride > 0 ? [0x83, 0xc6, stride] : [0x83, 0xee, -stride], // add/sub esi
            0x83, 0xc7, 0x04,                              // add edi, 4
            0x49,                                          // dec ecx
            0x75, 0xf2,                                    // jnz to the read (3 bytes)
            0xf4,
        ];
        const { m, exit, state, model } = judge(code, fill());
        assert.equal(exit.kind, 3, `seed ${seed}: halted`);
        assert.ok(state.halted, `seed ${seed}: the model halted`);
        for (let r = 0; r < 8; r++)
        {
            assert.equal(m.reg(NAMES[r]), state.reg[r], `seed ${seed}: ${NAMES[r]}`);
        }
        assert.deepEqual([...m.read(OUT, 4 * turns)], [...model.subarray(OUT, OUT + 4 * turns)],
            `seed ${seed}: what the loop stored`);
    }
});

test('a movs loop whose source meets a page it cannot read faults where the model does', ()=>{
    let faults = 0;
    for (let seed = 1; seed <= 120; seed++)
    {
        const pick = random(seed * 104729);
        const size = [1, 4][pick(2)];
        const turns = [5, 300, 1000, 2000][pick(4)];
        const start = 0x20000 + pick(0x1000) * 4;
        const bad = start + pick(turns * size + 0x2000) - 0x1000 >>> 12;
        const code = [
            0xbe, ...le(start), 0xbf, ...le(OUT), 0xb9, ...le(turns), 0xfc, // cld
            size === 1 ? 0xa4 : 0xa5,                      // movsb / movsd
            0x49, 0x75, 0xfc,                              // dec ecx; jnz to the movs
            0xf4,
        ];
        const { m, exit, state, fault, at } = judge(code, fill(), bad);
        faults += fault ? 1 : 0;
        assert.equal(exit.kind, fault ? 4 : 3, `seed ${seed}: ${fault ? 'faulted' : 'halted'}`);
        assert.equal(m.eip(), fault ? at : state.eip, `seed ${seed}: eip`);
        for (let r = 0; r < 8; r++)
        {
            assert.equal(m.reg(NAMES[r]), state.reg[r], `seed ${seed}: ${NAMES[r]}`);
        }
    }
    assert.ok(faults > 30, `${faults} loops meet the page`);
});
