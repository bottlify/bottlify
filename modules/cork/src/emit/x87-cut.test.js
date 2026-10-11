/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A block reached with two x87 tops is compiled for one of them and tests the
 * machine's at its start: the way in with the other leaves there, the stack
 * words as that way left them, and the way in with its own runs it. The block
 * emitted just before it -- one that ends in a `ret` or a `hlt`, its pushes
 * and pops written on its own ways out -- must not reach into either.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestMachine } from '../testing/machine.js';
import { Exit } from './region.js';

const CODE = 0x1000;

/**
 * test eax, eax; jz J; cmp ecx, 5; je X; fld1; jmp C; J: jmp C; X: fld1; <end>; C: hlt --
 * C is reached at top 7 and at top 0, and compiled for one of them; X, the
 * block before it, never runs.
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
    test(`a block met with two tops leaves or runs with the stack its way in left, not the`
        + ` ${name} before it`, ()=>{
        const C = CODE + program(end).length - 1;
        // C is compiled for the top that reaches it first; whichever way in
        // brings the other leaves at its test.
        const ways = [[0, 0, 0xff], [1, 7, 0x7f]].map(([eax, top, empty])=>
            ({ ...run(program(end), eax), top, empty, eax }));
        assert.deepEqual(ways.map(way=>way.exit.kind).sort(), [Exit.UNTRANSLATED, Exit.HALT].sort(),
            'one way in runs C, the other leaves at its test');
        for (const way of ways)
        {
            if (way.exit.kind === Exit.UNTRANSLATED)
            {
                assert.equal(way.eip, C, `eax ${way.eax}: left at the block`);
            }
        }
        const [empty, pushed] = ways.map(way=>run(program(end), way.eax));
        assert.equal(empty.top, 0, 'nothing pushed on the way taken');
        assert.equal(empty.empty, 0xff);
        assert.equal(pushed.top, 7, 'fld1 on the way taken');
        assert.equal(pushed.empty, 0x7f);
    });
}
