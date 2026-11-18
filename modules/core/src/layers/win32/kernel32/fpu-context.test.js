/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    doubleToExtended, extendedImage, extendedToDouble, floatSaveArea, quadwordToExtended,
    restoreExtended, restoreFloatSave,
} from './fpu-context.js';

/** The translator's 32-bit state block, as far as the floating-point state goes. */
const LAYOUT = { x87: 64, x87Top: 192, x87Empty: 193, x87Control: 194, x87Status: 196,
    x87Exact: 198, xmm: 208, mxcsr: 336 };

/** @param {number} seed */
const seeded = seed=>{
    let state = seed >>> 0 || 1;
    return ()=>{
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        return (state >>> 0) / 2 ** 32;
    };
};

/** @param {number} value */
const bitsOf = value=>{
    const view = new DataView(new ArrayBuffer(8));
    view.setFloat64(0, value, true);
    return view.getBigUint64(0, true);
};

test('extended values: a double is held exactly and read back as itself, a quadword exactly', ()=>{
    // 1.0 is 0x3fff 8000000000000000 (Intel SDM's extended format).
    assert.deepEqual(doubleToExtended(1), [0, 0x80000000, 0x3fff]);
    assert.deepEqual(doubleToExtended(-2), [0, 0x80000000, 0xc000]);
    assert.deepEqual(doubleToExtended(Infinity), [0, 0x80000000, 0x7fff]);
    const next = seeded(7);
    const view = new DataView(new ArrayBuffer(8));
    for (let k = 0; k < 2000; k++)
    {
        view.setUint32(0, next() * 2 ** 32 >>> 0, true);
        view.setUint32(4, next() * 2 ** 32 >>> 0, true);
        // Every class: normal, denormal (a zero exponent), zero, infinity, NaN.
        if (k % 5 === 1)
        {
            view.setUint32(4, view.getUint32(4, true) & 0x800fffff, true);
        }
        const value = view.getFloat64(0, true);
        const { value: back, exact } = extendedToDouble(...doubleToExtended(value));
        assert.equal(exact, null);
        assert.equal(bitsOf(back), Number.isNaN(value) ? bitsOf(back) : bitsOf(value),
            `${value} as an extended value and back`);
        assert.equal(Number.isNaN(back), Number.isNaN(value));
    }
    for (const integer of [2n ** 53n + 1n, -(2n ** 62n) - 3n, 2n ** 63n - 1n, -(2n ** 63n) + 1n])
    {
        const { value, exact } = extendedToDouble(...quadwordToExtended(integer));
        assert.equal(exact, integer, `${integer}, which no double holds`);
        assert.equal(value, Number(integer));
    }
    assert.equal(extendedToDouble(...quadwordToExtended(12345n)).exact, null,
        'one a double holds needs no quadword');
});

/**
 * A stopped thread's context with an x87 stack and SSE state of its own.
 *
 * @param {() => number} next
 */
const contextFrom = next=>{
    const block = new Uint8Array(512);
    const view = new DataView(block.buffer);
    const top = Math.floor(next() * 8);
    block[LAYOUT.x87Top] = top;
    block[LAYOUT.x87Empty] = Math.floor(next() * 256);
    view.setUint16(LAYOUT.x87Control, 0x27f | Math.floor(next() * 4) << 10, true);
    view.setUint16(LAYOUT.x87Status, Math.floor(next() * 0x10000) & ~0x3800, true);
    let exact = 0;
    for (let k = 0; k < 8; k++)
    {
        const kind = Math.floor(next() * 4);
        view.setFloat64(LAYOUT.x87 + k * 16, kind === 0 ? 0 : kind === 1 ? -Infinity
            : (next() - 0.5) * 2 ** Math.floor(next() * 200 - 100), true);
        if (kind === 3 && (block[LAYOUT.x87Empty] >>> k & 1) === 0)
        {
            const integer = 2n ** 60n + BigInt(Math.floor(next() * 1e9));
            view.setBigInt64(LAYOUT.x87 + k * 16 + 8, integer, true);
            view.setFloat64(LAYOUT.x87 + k * 16, Number(integer), true);
            exact |= 1 << k;
        }
    }
    block[LAYOUT.x87Exact] = exact;
    for (let i = 0; i < 128; i++)
    {
        block[LAYOUT.xmm + i] = Math.floor(next() * 256);
    }
    view.setUint32(LAYOUT.mxcsr, 0x1f80 | Math.floor(next() * 0x40), true);
    return { block, layout: LAYOUT };
};

/** What a context's floating-point state is, as a program can see it. @param {any} context */
const state = context=>({
    extended: [...extendedImage(context)],
    floatSave: [...floatSaveArea(context)],
});

test('FXSAVE\'s image and the FLOATING_SAVE_AREA of a context, and either put back, are the'
    + ' context, over seeded states', ()=>{
    const next = seeded(11);
    for (let round = 0; round < 300; round++)
    {
        const context = contextFrom(next);
        const image = extendedImage(context);
        const view = new DataView(image.buffer);
        const top = context.block[LAYOUT.x87Top];
        assert.equal(view.getUint16(2, true) >>> 11 & 7, top, 'TOP in the status word');
        assert.equal(image[4], ~context.block[LAYOUT.x87Empty] & 0xff, 'the abridged tag');
        const exactTop = (context.block[LAYOUT.x87Exact] >>> top & 1) !== 0;
        const blockView = new DataView(context.block.buffer);
        assert.deepEqual(
            [view.getUint32(32, true), view.getUint32(36, true), view.getUint16(40, true)],
            exactTop ? quadwordToExtended(blockView.getBigInt64(LAYOUT.x87 + top * 16 + 8, true))
                : doubleToExtended(blockView.getFloat64(LAYOUT.x87 + top * 16, true)),
            'ST(0) first: the physical register at the top');
        assert.deepEqual([...image.subarray(160, 288)],
            [...context.block.subarray(LAYOUT.xmm, LAYOUT.xmm + 128)], 'XMM0 to XMM7');
        const seen = state(context);

        const fromExtended = { block: new Uint8Array(512), layout: LAYOUT };
        restoreExtended(fromExtended, image);
        assert.deepEqual(state(fromExtended), seen, `round ${round}: FXRSTOR`);

        const fromFloatSave = { block: new Uint8Array(512), layout: LAYOUT };
        fromFloatSave.block.set(context.block.subarray(LAYOUT.xmm, LAYOUT.mxcsr + 4), LAYOUT.xmm);
        restoreFloatSave(fromFloatSave, floatSaveArea(context));
        assert.deepEqual(state(fromFloatSave), seen, `round ${round}: FRSTOR`);
    }
});
