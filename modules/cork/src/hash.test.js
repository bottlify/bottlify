/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FNV_OFFSET, POSITION_OFFSET, fnv1aStep, fnv1aString, positionStep } from './hash.js';
import { moduleDigest } from './runtime/cache.js';
import { keptName } from './runtime/kept.js';
import { layoutId } from './runtime/layout.js';
import { fingerprint, maskedFingerprint } from './helpers.js';
import { hashOfPlan } from './region.js';

/** xorshift32: the same inputs every run. @param {number} seed */
const random = seed=>{
    let state = seed >>> 0 || 1;
    return (/** @type {number} */ below)=>{
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        return (state >>> 0) % below;
    };
};
const next = random(0xbb67ae85);
const ROUNDS = 300;
const bytesOf = ()=>Uint8Array.from({ length: next(301) }, ()=>next(256));
/** Every UTF-16 unit, lone surrogates included. */
const textOf = ()=>String.fromCharCode(...Array.from({ length: next(120) },
    ()=>(next(4) === 0 ? next(0x10000) : 0x20 + next(0x5f))));

// The code these replaced, verbatim, each to its own output: every one of these
// answers is a key something kept compares.

/** runtime/cache.js. @param {Uint8Array} bytes */
function moduleDigestBefore(bytes){
    let low = 0x811c9dc5;
    let high = 0x050c5d1f;
    for (let i = 0; i < bytes.length; i++)
    {
        low = Math.imul(low ^ bytes[i], 0x01000193);
        high = Math.imul(high ^ bytes[i] ^ i & 0xff, 0x01000193);
    }
    return `${(high >>> 0).toString(16)}${(low >>> 0).toString(16).padStart(8, '0')}`
        + `-${bytes.length.toString(16)}`;
}

/** runtime/kept.js. @param {string} key */
function keptNameBefore(key){
    let a = 0x811c9dc5;
    let b = 0x01000193;
    for (let i = 0; i < key.length; i++)
    {
        const unit = key.charCodeAt(i);
        a = Math.imul(a ^ unit, 0x01000193);
        b = Math.imul(b ^ (unit + i), 0x01000193);
    }
    return `${(a >>> 0).toString(36)}.${(b >>> 0).toString(36)}`;
}

/** runtime/layout.js. @param {Record<string, number | string>} fields */
function layoutIdBefore(fields){
    let hash = 0x811c9dc5;
    for (const key of Object.keys(fields).sort())
    {
        for (const char of `${key}=${fields[key]};`)
        {
            hash = Math.imul(hash ^ char.charCodeAt(0), 0x01000193) >>> 0;
        }
    }
    return hash.toString(16).padStart(8, '0');
}

/**
 * helpers.js.
 *
 * @param {(address: number) => number} read
 * @param {number} address @param {number} length
 */
function fingerprintBefore(read, address, length){
    let low = 0x811c9dc5;
    let high = 0x050c5d1f;
    for (let at = 0; at < length; at++)
    {
        const byte = read(address + at);
        low = Math.imul(low ^ byte, 0x01000193);
        high = Math.imul(high ^ byte ^ at & 0xff, 0x01000193);
    }
    return (high >>> 0).toString(16).padStart(8, '0') + (low >>> 0).toString(16).padStart(8, '0');
}

/**
 * helpers.js, `maskedFingerprint` over `maskedHash`.
 *
 * @param {(address: number) => number} read
 * @param {number} address
 * @param {readonly (readonly number[])[]} spans
 * @param {readonly number[]} masks
 */
function maskedFingerprintBefore(read, address, spans, masks){
    let low = 0x811c9dc5;
    let high = 0x050c5d1f;
    let at = 0;
    let mask = 0;
    for (const [offset, length] of spans)
    {
        for (let k = 0; k < length; k++, at++)
        {
            const where = offset + k;
            while (mask < masks.length && masks[mask] < where)
            {
                mask++;
            }
            const byte = mask < masks.length && masks[mask] === where ? 0 : read(address + where);
            low = Math.imul(low ^ byte, 0x01000193);
            high = Math.imul(high ^ byte ^ at & 0xff, 0x01000193);
        }
    }
    return (high >>> 0).toString(16).padStart(8, '0') + (low >>> 0).toString(16).padStart(8, '0');
}

/**
 * region.js.
 *
 * @param {(address: number) => number} read
 * @param {{ spans: number[][], named: number[], tables: number[][], helpers: number[][] }} plan
 */
function hashOfPlanBefore(read, { spans, named, tables, helpers }){
    let low = 0x811c9dc5;
    let high = 0x050c5d1f;
    let at = 0;
    /** @param {number} byte */
    const mix = byte=>{
        low = Math.imul(low ^ byte, 0x01000193);
        high = Math.imul(high ^ byte ^ at++ & 0xff, 0x01000193);
    };
    for (const [start, end] of spans)
    {
        for (let address = start; address < end; address++)
        {
            mix(read(address));
        }
    }
    for (const target of named)
    {
        for (let shift = 0; shift < 32; shift += 8)
        {
            mix(target >>> shift & 0xff);
        }
    }
    for (const [address, length] of tables)
    {
        for (let byte = address; byte < address + length; byte++)
        {
            mix(read(byte));
        }
    }
    for (const [address, length] of helpers)
    {
        // Tagged, so the same bytes formed in as a leaf callee are keyed apart.
        mix(0x48);
        for (let byte = address; byte < address + length; byte++)
        {
            mix(read(byte));
        }
    }
    return (high >>> 0).toString(16).padStart(8, '0') + (low >>> 0).toString(16).padStart(8, '0');
}

const ascii = (/** @type {string} */ text)=>Array.from(text, c=>c.charCodeAt(0));

test('FNV-1a, 32 bits: the published vectors, a step at a time and whole', ()=>{
    for (const [text, hash] of /** @type {[string, number][]} */ ([['', 0x811c9dc5],
        ['a', 0xe40c292c], ['foobar', 0xbf9cf968]]))
    {
        assert.equal(ascii(text).reduce(fnv1aStep, FNV_OFFSET) >>> 0, hash, text);
        assert.equal(fnv1aString(text), hash, text);
    }
    assert.equal(fnv1aString('bar', fnv1aString('foo')), 0xbf9cf968, 'it continues');
});

test('the position lane mixes a byte\'s place, its low byte only', ()=>{
    assert.equal(positionStep(POSITION_OFFSET, 7, 0), fnv1aStep(POSITION_OFFSET, 7));
    assert.equal(positionStep(POSITION_OFFSET, 7, 0x103), fnv1aStep(POSITION_OFFSET, 7 ^ 3));
});

test('the keys cork kept answer what they answered before the hash was shared', ()=>{
    const memory = Uint8Array.from({ length: 0x2000 }, ()=>next(256));
    const read = (/** @type {number} */ address)=>memory[address & 0x1fff];
    for (let round = 0; round < ROUNDS; round++)
    {
        const bytes = bytesOf();
        assert.equal(moduleDigest(bytes), moduleDigestBefore(bytes));
        const key = textOf();
        assert.equal(keptName(key), keptNameBefore(key));
        // A layout's fields are names and numbers: the code before took a
        // character outside the BMP by its first unit only, which no layout has.
        /** @type {Record<string, number | string>} */
        const fields = {};
        const nameOf = ()=>String.fromCharCode(...Array.from({ length: 1 + next(12) },
            ()=>0x20 + next(0x5f)));
        for (let at = next(8); at > 0; at--)
        {
            fields[nameOf()] = next(2) === 0 ? next(0x100000) : nameOf();
        }
        assert.equal(layoutId(fields), layoutIdBefore(fields));
        const address = next(0x1000);
        const length = next(300);
        assert.equal(fingerprint(read, address, length), fingerprintBefore(read, address, length));
        const spans = Array.from({ length: 1 + next(4) }, (_, k)=>[k * 64 + next(16), next(48)]);
        const masks = [...new Set(Array.from({ length: next(12) }, ()=>next(256)))]
            .sort((a, b)=>a - b);
        assert.equal(maskedFingerprint(read, address, spans, masks),
            maskedFingerprintBefore(read, address, spans, masks));
        const plan = {
            spans: Array.from({ length: next(4) }, ()=>{
                const start = next(0x1000);
                return [start, start + next(200)];
            }),
            named: Array.from({ length: next(5) },
                ()=>(next(0x10000) * 0x10000 + next(0x10000)) >>> 0),
            tables: Array.from({ length: next(3) }, ()=>[next(0x1000), next(64)]),
            helpers: Array.from({ length: next(3) }, ()=>[next(0x1000), next(64)]),
        };
        assert.equal(hashOfPlan(read, /** @type {any} */ (plan)), hashOfPlanBefore(read, plan));
    }
});
