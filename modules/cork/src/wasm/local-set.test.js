/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LocalSet } from './local-set.js';

/** A seeded xorshift, so a failing sequence is the same again. @param {number} seed */
const random = seed=>{
    let x = seed >>> 0 || 1;
    return (/** @type {number} */ below)=>{
        x ^= x << 13;
        x ^= x >>> 17;
        x ^= x << 5;
        return (x >>> 0) % below;
    };
};

test('a set of locals answers as a Set of the same numbers, seeded operations', ()=>{
    for (let seed = 1; seed <= 200; seed++)
    {
        const next = random(seed);
        // Past the first two words too: a region's xmm and x87 locals run past 64.
        const span = [8, 40, 70, 300][seed % 4];
        const sets = Array.from({ length: 4 }, ()=>({ bits: new LocalSet(), plain: new Set() }));
        for (let step = 0; step < 60; step++)
        {
            const one = sets[next(4)];
            const other = sets[next(4)];
            const kill = sets[next(4)];
            const op = next(6);
            if (op <= 1)
            {
                const local = next(span);
                one.bits.add(local);
                one.plain.add(local);
            }
            else if (op === 2)
            {
                const before = one.plain.size;
                for (const local of [...other.plain])
                {
                    one.plain.add(local);
                }
                assert.equal(one.bits.addAll(other.bits), one.plain.size !== before);
            }
            else if (op === 3)
            {
                const before = one.plain.size;
                for (const local of [...other.plain])
                {
                    if (!kill.plain.has(local))
                    {
                        one.plain.add(local);
                    }
                }
                assert.equal(one.bits.addAllBut(other.bits, kill.bits), one.plain.size !== before);
            }
            else if (op === 4)
            {
                one.bits.retainAll(other.bits);
                one.plain = new Set([...one.plain].filter(local=>other.plain.has(local)));
            }
            else
            {
                const copy = one.bits.copy();
                copy.add(span);
                assert.equal(one.bits.has(span), one.plain.has(span), 'a copy is its own');
            }
            for (const { bits, plain } of sets)
            {
                assert.deepEqual([...bits], [...plain].sort((a, b)=>a - b), `seed ${seed}`);
                const local = next(span + 40);
                assert.equal(bits.has(local), plain.has(local));
            }
        }
    }
});

test('a set given its locals holds them, and none killed stays out', ()=>{
    const set = new LocalSet([3, 64, 99]);
    assert.deepEqual([...set], [3, 64, 99]);
    const into = new LocalSet([1]);
    assert.equal(into.addAllBut(set, new LocalSet([64])), true);
    assert.deepEqual([...into], [1, 3, 99]);
    assert.equal(into.addAllBut(set, new LocalSet([64])), false);
    assert.equal(into.addAllBut(set, undefined), true);
    assert.deepEqual([...into], [1, 3, 64, 99]);
});
