/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A region that leaves on a spent budget, or for a block it does not hold,
 * from the back edge of a loop whose body exchanges x87 registers: the edge
 * has already put the registers where the target reads them, and the exit must
 * write back from there, not from where the block left them.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestMachine } from '../testing/machine.js';
import { Exit } from './region.js';

const CODE = 0x1000;
const DATA = 0x2000;

/** @param {number} a */
const at = a=>[a & 255, a >> 8 & 255, 0, 0];

/**
 * fld dword [DATA]; fld dword [DATA+4]; L: fxch st1; fadd st0, st1; dec ecx; jnz L;
 * fstp dword [DATA+8]; fstp dword [DATA+12]; hlt.
 */
const PROGRAM = [
    0xb9, 6, 0, 0, 0,
    0xd9, 0x05, ...at(DATA), 0xd9, 0x05, ...at(DATA + 4),
    0xd9, 0xc9, 0xd8, 0xc1, 0x49, 0x75, 0xf9,
    0xd9, 0x1d, ...at(DATA + 8), 0xd9, 0x1d, ...at(DATA + 12), 0xf4,
];

/** @param {number} budget @param {Record<string, any>} [translate] */
function outcome(budget, translate = { speculate: true }){
    const m = createTestMachine();
    const view = new DataView(m.memory.buffer);
    view.setUint8(m.layout.x87Empty, 0xff);
    view.setUint16(m.layout.x87Control, 0x37f, true);
    view.setFloat32(m.layout.ramBase + DATA, 1.5, true);
    view.setFloat32(m.layout.ramBase + DATA + 4, 3, true);
    m.write(CODE, PROGRAM);
    m.setReg('esp', 0x80000);
    const unit = m.translate(CODE, translate);
    let exit = unit.run(CODE, budget);
    let budgetExits = 0;
    while (exit.kind === Exit.BUDGET)
    {
        budgetExits++;
        exit = unit.run(m.eip(), budget);
    }
    assert.equal(exit.kind, Exit.HALT);
    return {
        budgetExits,
        stored: [view.getFloat32(m.layout.ramBase + DATA + 8, true),
            view.getFloat32(m.layout.ramBase + DATA + 12, true)],
        ecx: m.reg('ecx'),
    };
}

test('a spent budget on the back edge of an exchanging loop keeps the registers',
    ()=>{
        const whole = outcome(1_000_000);
        assert.equal(whole.budgetExits, 0);
        for (const budget of [1, 2, 3, 4, 5, 7, 9])
        {
            const run = outcome(budget);
            assert.ok(run.budgetExits > 0, `budget ${budget} runs out`);
            assert.deepEqual({ ...run, budgetExits: 0 }, whole, `budget ${budget}`);
        }
    });

test('the same when the region is not speculated', ()=>{
    const whole = outcome(1_000_000, {});
    for (const budget of [1, 3, 5])
    {
        assert.deepEqual({ ...outcome(budget, {}), budgetExits: 0 }, whole, `budget ${budget}`);
    }
});
