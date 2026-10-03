/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A block reached with two x87 tops is cut: compiled as an exit at its start,
 * which leaves the stack words as the way to it left them. The block emitted
 * just before it -- one that ends in a `ret` or a `hlt`, its pushes and pops
 * written on its own ways out -- must not reach into that exit.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestMachine } from '../testing/machine.js';
import { Exit } from './region.js';

const CODE = 0x1000;

/**
 * test eax, eax; jz J; cmp ecx, 5; je X; fld1; jmp C; J: jmp C; X: fld1; <end>; C: hlt --
 * C is reached at top 7 and at top 0, so it is cut; X, the block before it, never runs.
 *
 * @param {number[]} end  X's last instruction
 */
const program = end=>[
    0x85, 0xc0, 0x74, 0x09, 0x83, 0xf9, 0x05, 0x74, 0x06, 0xd9, 0xe8, 0xeb, 0x04 + end.length,
    0xeb, 0x02 + end.length, 0xd9, 0xe8, ...end, 0xf4,
];

/** @param {number[]} code @param {number} eax */
function run(code, eax){
    const m = createTestMachine();
    const view = new DataView(m.memory.buffer);
    view.setUint8(m.layout.x87Empty, 0xff);
    view.setUint16(m.layout.x87Control, 0x37f, true);
    m.write(CODE, code);
    m.setReg('esp', 0x80000);
    m.setReg('eax', eax);
    m.setReg('ecx', 0);
    const exit = m.translate(CODE).run(CODE, 1_000_000);
    return {
        exit,
        eip: m.eip(),
        top: view.getUint8(m.layout.x87Top),
        empty: view.getUint8(m.layout.x87Empty),
    };
}

/** @type {[string, number[]][]} */
const ENDS = [['hlt', [0xf4]], ['ret', [0xc3]]];

for (const [name, end] of ENDS)
{
    test(`a cut block leaves the stack as its way in left it, not as the ${name} before it`, ()=>{
        const C = CODE + program(end).length - 1;
        const empty = run(program(end), 0);
        assert.equal(empty.exit.kind, Exit.UNTRANSLATED);
        assert.equal(empty.eip, C, 'left at the cut block');
        assert.equal(empty.top, 0, 'nothing pushed on the way taken');
        assert.equal(empty.empty, 0xff);
        const pushed = run(program(end), 1);
        assert.equal(pushed.exit.kind, Exit.UNTRANSLATED);
        assert.equal(pushed.eip, C);
        assert.equal(pushed.top, 7, 'fld1 on the way taken');
        assert.equal(pushed.empty, 0x7f);
    });
}
