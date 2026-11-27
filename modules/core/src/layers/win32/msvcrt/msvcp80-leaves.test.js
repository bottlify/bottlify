/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * MSVCP80's x86-64 leaves as code (`LONG_LEAVES`), run on the long-mode
 * machine: each leaves what its host handler answers - a constant in RAX or
 * XMM0, a byte moved, `this` handed back - and returns.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LONG_LEAVES } from './msvcp80.js';
import { CODE_64, callLong, longMachine } from '../../../../scripts/guest-code/long.mjs';

const RETURN = 0x0f00;

/** @param {Uint8Array} code @param {bigint[]} [args] */
function call(code, args = []){
    const m = longMachine();
    m.write(CODE_64, code);
    m.write(RETURN, [0xf4]);
    m.write(0x200000, [0x11, 0x22]);
    const { halted } = callLong(m, CODE_64, { args, returnTo: RETURN });
    assert.ok(halted && m.rip() === RETURN + 1, 'returned to its caller');
    return m;
}

test('the constants are numeric_limits\' own, a float\'s and a double\'s in XMM0', ()=>{
    assert.equal(call(LONG_LEAVES.byteMax).reg('rax') & 0xffn, 0xffn);
    assert.equal(call(LONG_LEAVES.shortMax).reg('rax') & 0xffffn, 0x7fffn);
    assert.equal(call(LONG_LEAVES.every).reg('rax'), 0xffffffffffffffffn);
    const single = new DataView(call(LONG_LEAVES.floatMax).xmm(0).buffer);
    assert.equal(single.getFloat32(0, true), 3.4028234663852886e38);
    const double = new DataView(call(LONG_LEAVES.doubleMax).xmm(0).buffer);
    assert.equal(double.getFloat64(0, true), Number.MAX_VALUE);
});

test('construct moves the one char, the constructors hand `this` back, destroy does nothing',
    ()=>{
        const m = call(LONG_LEAVES.construct, [0x1234n, 0x200001n, 0x200000n]);
        assert.deepEqual([...m.read(0x200000, 2)], [0x11, 0x11]);
        assert.equal(call(LONG_LEAVES.self, [0x123456789an]).reg('rax'), 0x123456789an);
        const idle = call(LONG_LEAVES.nothing, [0x200000n]);
        assert.deepEqual([...idle.read(0x200000, 2)], [0x11, 0x22]);
    });
