/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guestOver } from '../common/guest.fixture.js';
import { createRandomFunctions } from './random.js';

const machine = ()=>{
    const memory = new Uint8Array(0x100);
    const view = new DataView(memory.buffer);
    const fns = createRandomFunctions({ guest: guestOver(memory) });
    return { view, fns };
};

test('RtlUniform is Lehmer\'s generator with MAXLONG for its modulus, the seed written back', ()=>{
    const { view, fns } = machine();
    for (const [seed, expected] of [[0, 0x7fffffc3], [0x80000000, 0x7fffffb1],
        [0x7fffffff, 0x7fffffc3]])
    {
        view.setUint32(0x10, seed, true);
        assert.equal(fns.RtlUniform.handler([0x10]) >>> 0, expected, `seed ${seed}`);
        assert.equal(view.getUint32(0x10, true), expected);
    }
});

test('RtlRandom answers numbers apart from the seed and from each other', ()=>{
    const { view, fns } = machine();
    view.setUint32(0x10, 0, true);
    const seen = new Set();
    for (let at = 0; at < 512; at++)
    {
        const value = fns.RtlRandom.handler([0x10]) >>> 0;
        assert.notEqual(value, view.getUint32(0x10, true), `${at}: the seed`);
        assert.equal(seen.has(value), false, `${at}: ${value} again`);
        seen.add(value);
    }
});
