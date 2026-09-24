/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The interpreter's compiled steps against `evaluate`: each form run both ways
 * from the same random states must leave the same registers, flags and
 * memory. The hardware corpus judges the common forms; these are the ones it
 * reaches rarely or not at all -- a shift by a count of zero, an imul that
 * overflows, an fs: operand, a memory xchg.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decode } from './decode/decoder.js';
import { compileFast } from './fast.js';
import { createState, evaluate } from './ir.js';

/** @param {Uint8Array} ram */
function memoryOf(ram){
    const view = new DataView(ram.buffer);
    return {
        /** @param {number} address @param {number} size */
        read: (address, size)=>size === 1 ? ram[address]
            : size === 2 ? view.getUint16(address, true) : view.getUint32(address, true),
        /** @param {number} address @param {number} size @param {number} value */
        write: (address, size, value)=>{
            if (size === 1)
            {
                ram[address] = value;
            }
            else if (size === 2)
            {
                view.setUint16(address, value, true);
            }
            else
            {
                view.setUint32(address, value, true);
            }
        },
    };
}

const FORMS = {
    'shl eax, 3': [0xc1, 0xe0, 0x03],
    'shr dword [ebx+4], cl': [0xd3, 0x6b, 0x04],
    'sar cx, 1': [0x66, 0xd1, 0xf9],
    'rol byte [esi], cl': [0xd2, 0x06],
    'rcr edx, cl': [0xd3, 0xda],
    'rcl al, 1': [0xd0, 0xd0],
    'imul eax, ecx': [0x0f, 0xaf, 0xc1],
    'imul edx, [ebx+8], 0x12345': [0x69, 0x53, 0x08, 0x45, 0x23, 0x01, 0x00],
    'imul si, [edi], -3': [0x66, 0x6b, 0x37, 0xfd],
    'imul eax, [ebx]': [0x0f, 0xaf, 0x03],
    'cdq': [0x99],
    'xchg eax, [ebx]': [0x87, 0x03],
    'xchg cl, dh': [0x86, 0xf1],
    'mov eax, fs:[ebx]': [0x64, 0x8b, 0x03],
    'mov fs:[8], ecx': [0x64, 0x89, 0x0d, 0x08, 0x00, 0x00, 0x00],
};

test('a compiled step leaves what evaluate leaves', ()=>{
    let seed = 0x1234567;
    const random = ()=>{
        seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
        return seed;
    };
    for (const [name, bytes] of Object.entries(FORMS))
    {
        const at = 0x1000;
        const decoded = decode(address=>bytes[address - at] ?? 0, at);
        assert.ok(!('refused' in decoded), name);
        const step = compileFast(/** @type {import('./decode/decoder.js').Instruction} */ (decoded));
        assert.ok(step, `${name} is compiled`);
        for (let round = 0; round < 200; round++)
        {
            const ram = new Uint8Array(0x10000);
            for (let i = 0x2000; i < 0x8000; i++)
            {
                ram[i] = random() >>> 24;
            }
            const regs = Array.from({ length: 8 }, (_, r)=>
                // Base registers point into the filled memory; ecx keeps a
                // count of zero now and then, eax and ecx a big value.
                r === 1 && round % 4 === 0 ? random() & ~31
                    : r === 0 && round % 3 === 0 ? random()
                        : 0x2000 + (random() & 0x3fff));
            const eflags = (random() & 0x8d5) | 0x2;
            const fsBase = 0x2000 + (random() & 0xfff);
            const run = (/** @type {boolean} */ compiled)=>{
                const copy = ram.slice();
                const state = createState(memoryOf(copy), { eip: at, fsBase });
                state.reg.set(regs);
                state.eflags = eflags;
                if (compiled)
                {
                    state.eip = (at + decoded.length) >>> 0;
                    state.retired++;
                    /** @type {NonNullable<typeof step>} */ (step)(state);
                }
                else
                {
                    evaluate(/** @type {import('./decode/decoder.js').Instruction} */ (decoded), state);
                }
                return { reg: [...state.reg], eflags: state.eflags, eip: state.eip, ram: copy };
            };
            const want = run(false);
            const got = run(true);
            assert.deepEqual(got.reg, want.reg, `${name} round ${round}: registers`);
            assert.equal(got.eflags, want.eflags, `${name} round ${round}: flags`);
            assert.equal(got.eip, want.eip, `${name} round ${round}: eip`);
            assert.ok(Buffer.compare(got.ram, want.ram) === 0, `${name} round ${round}: memory`);
        }
    }
});
