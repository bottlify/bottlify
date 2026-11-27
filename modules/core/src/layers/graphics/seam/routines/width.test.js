/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A routine built for a 64-bit process (`X64`) on cork's long-mode machine,
 * called as the x64 convention calls: what it answers in the guest, and that
 * every case it leaves to the host reaches the trap with the call as it came
 * - RCX, RDX, R8, R9 and RSP as at the entry - so the bridge's 64-bit trap
 * reads the arguments the program passed. GetRenderState stands for every
 * routine built through `routine` and `Width`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CODE_64, HIGH_64, KEPT_64, STACK_64, argumentOf, callLong, longMachine }
    from '../../../../../scripts/guest-code/long.mjs';
import { ifRoom } from '../../../../../../cork/src/testing/memory64.js';
import { I386, X64 } from './assemble.js';
import { getRenderStateCode } from './getters.js';
import { FLAG_SLOW_PATH, SHADOW } from '../block.js';

const TRAP = 0x0e00;
const RETURN = 0x0f00;
const THIS = 0x200000;
const BLOCK = 0x210000;
const OUT = 0x230000;

/** A machine with an interface whose block holds render state 7 as valid, value 0x1234. */
const world = (/** @type {Parameters<typeof longMachine>[0]} */ options = {})=>{
    const m = longMachine(options);
    m.write(TRAP, [0xf4]);
    m.write(RETURN, [0xf4]);
    m.write(CODE_64, getRenderStateCode(CODE_64, TRAP, X64));
    m.setQuad(THIS, 0x7000n);
    m.setQuad(THIS + 8, BigInt(BLOCK));
    m.write(BLOCK + SHADOW.RENDER_STATE_VALID, [1 << 7]);
    m.write(BLOCK + SHADOW.RENDER_STATES + 7 * 4, [0x34, 0x12, 0, 0]);
    return m;
};

/** @param {ReturnType<typeof longMachine>} m @param {bigint[]} args */
const run = (m, args)=>callLong(m, CODE_64, { args, returnTo: RETURN });

test('GetRenderState at 64 bits answers from the block, keeps what the convention keeps', ()=>{
    const m = world();
    const call = run(m, [BigInt(THIS), argumentOf(7, 1), BigInt(OUT)]);
    assert.equal(m.rip(), RETURN + 1);
    assert.equal(m.reg('rax') & 0xffffffffn, 0n);
    assert.deepEqual([...m.read(OUT, 4)], [0x34, 0x12, 0, 0]);
    assert.equal(m.reg('rsp'), BigInt(STACK_64 + 8));
    for (const name of KEPT_64.filter(n=>n !== 'rsp'))
    {
        assert.equal(m.reg(name), call.entry[name], name);
    }
});

for (const [why, change] of /** @type {[string, (m: any, a: bigint[]) => void][]} */ ([
    ['the host wants the slow path', m=>m.write(BLOCK, [FLAG_SLOW_PATH])],
    ['a state the device refuses', (m, a)=>{ a[1] = argumentOf(8, 1); }],
    ['a null pointer', (m, a)=>{ a[2] = 0n; }],
    ['no block', m=>m.setQuad(THIS + 8, 0n)],
]))
{
    test(`GetRenderState at 64 bits leaves ${why} to the trap with the call as it came`, ()=>{
        const m = world();
        const args = [BigInt(THIS), argumentOf(7, 1), BigInt(OUT)];
        change(m, args);
        const call = run(m, args);
        assert.equal(m.rip(), TRAP + 1);
        for (const name of ['rcx', 'rdx', 'r8', 'r9', 'rsp'])
        {
            assert.equal(m.reg(name), call.entry[name], name);
        }
        assert.deepEqual([...m.read(OUT, 4)], [0, 0, 0, 0]);
    });
}

test('the i386 width keeps a 32-bit routine as it was', ()=>{
    assert.deepEqual(getRenderStateCode(CODE_64, TRAP), getRenderStateCode(CODE_64, TRAP, I386));
    assert.deepEqual([...I386.entry(), ...I386.reload()], []);
});

test('GetRenderState at 64 bits writes through a pointer past 4 GiB, not its low half', ifRoom(()=>{
    // On the interpreter: the translator's wide window has its own gate.
    const m = world({ window: 2 ** 33, config: { translate: false } });
    run(m, [BigInt(THIS), argumentOf(7, 1), BigInt(HIGH_64 + OUT)]);
    assert.equal(m.rip(), RETURN + 1);
    assert.deepEqual([...m.read(HIGH_64 + OUT, 4)], [0x34, 0x12, 0, 0]);
    assert.deepEqual([...m.read(OUT, 4)], [0, 0, 0, 0]);
}));
