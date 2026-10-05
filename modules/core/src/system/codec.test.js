/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeValue, encodeValue } from './codec.js';

/** @param {number} seed */
const random = seed=>()=>{
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

/**
 * A value of every kind the codec carries, nested.
 *
 * @param {() => number} next @param {number} depth
 * @returns {any}
 */
const anyValue = (next, depth)=>{
    const pick = Math.floor(next() * (depth > 3 ? 8 : 10));
    switch (pick)
    {
        case 0: return undefined;
        case 1: return null;
        case 2: return next() < 0.5;
        case 3: return (next() * 2 ** 32 | 0);
        case 4: return [next() * 1e300, -0, NaN, Infinity, 2 ** 40, 0xffffffff][
            Math.floor(next() * 6)];
        case 5: return Array.from({ length: Math.floor(next() * 12) },
            ()=>String.fromCodePoint(Math.floor(next() * 0x2ffff))).join('')
            // A lone surrogate, as a wide string from a program may hold.
            + (next() < 0.3 ? String.fromCharCode(0xd800 + Math.floor(next() * 0x800)) : '');
        case 6: return Uint8Array.from({ length: Math.floor(next() * 40) },
            ()=>Math.floor(next() * 256));
        case 7: return '';
        case 8: return Array.from({ length: Math.floor(next() * 5) },
            ()=>anyValue(next, depth + 1));
        default: return Object.fromEntries(Array.from({ length: Math.floor(next() * 5) },
            (_, i)=>[`k${i}${Math.floor(next() * 9)}`, anyValue(next, depth + 1)]));
    }
};

test('every value the codec carries comes back as it went', ()=>{
    const next = random(7);
    for (let round = 0; round < 2000; round++)
    {
        const value = anyValue(next, 0);
        assert.deepStrictEqual(decodeValue(encodeValue(value)), value);
    }
});

test('a byte array comes back a copy, whatever it was a view of', ()=>{
    const backing = Uint8Array.of(9, 1, 2, 3, 9);
    const encoded = encodeValue({ bytes: backing.subarray(1, 4) });
    const decoded = decodeValue(encoded);
    assert.deepEqual(decoded.bytes, Uint8Array.of(1, 2, 3));
    encoded.fill(0);
    assert.deepEqual(decoded.bytes, Uint8Array.of(1, 2, 3), 'not a view of the encoded bytes');
});

test('what cannot cross is refused when written, not mangled', ()=>{
    for (const value of [new Map(), new Date(0), ()=>0, Symbol('s'), 1n, new Uint16Array(2),
        Object.create(null)])
    {
        assert.throws(()=>encodeValue({ value }), /cannot cross/);
    }
    assert.throws(()=>decodeValue(Uint8Array.of(4, 1, 0, 0, 0, 0)), /after the value/);
});
