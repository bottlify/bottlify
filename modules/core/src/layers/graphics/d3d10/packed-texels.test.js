/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The unsigned 11- and 10-bit floats a shader packs a texel of
 * R11G11B10_FLOAT in (`PACKED_TEXELS`), run as the translator writes them
 * (`wgsl-run.js`): every code read back as the float it is, every float of a
 * code packed to that code, the halfway floats between two codes to the
 * even one, and what Direct3D's functional specification (3.2.4) makes of
 * negatives, NaN, infinity and what is past the largest.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HELPERS, PACKED_TEXELS } from './wgsl.js';
import { runWgsl } from './wgsl-run.js';

const { packedUf, unpackedUf } = runWgsl(HELPERS.unsignedFloat.text.join('\n'));
const word = new Uint32Array(1);
const float = new Float32Array(word.buffer);
/** @param {number} value */
const bitsOf = value=>{
    float[0] = value;
    return word[0];
};
/** @param {number} bits */
const floatOf = bits=>{
    word[0] = bits;
    return float[0];
};
/** What a code is, from its definition. @param {number} code @param {number} m */
const valueOf = (code, m)=>{
    const e = code >> m;
    const f = code & ((1 << m) - 1);
    if (e === 31)
    {
        return f ? NaN : Infinity;
    }
    return e === 0 ? f * 2 ** (-14 - m) : (1 + f / 2 ** m) * 2 ** (e - 15);
};

test('every 11- and 10-bit code reads back as its float and packs back to itself', ()=>{
    for (const m of [6, 5])
    {
        for (let code = 0; code < 1 << (m + 5); code++)
        {
            const value = valueOf(code, m);
            const read = floatOf(unpackedUf(code, m));
            if (Number.isNaN(value))
            {
                assert.ok(Number.isNaN(read), `${m}: ${code}`);
                assert.ok(packedUf(bitsOf(read), m) >> m === 31
                    && (packedUf(bitsOf(read), m) & ((1 << m) - 1)) !== 0, 'NaN stays NaN');
                continue;
            }
            assert.equal(read, value, `${m}: code ${code}`);
            assert.equal(packedUf(bitsOf(value), m), code, `${m}: ${value}`);
        }
    }
});

test('a float between two codes packs to the nearer, a tie to the even one; negatives to zero,'
    + ' what is past the largest to infinity', ()=>{
    for (const m of [6, 5])
    {
        const top = 31 << m;
        for (let code = 0; code < top - 1; code++)
        {
            const low = valueOf(code, m);
            const high = valueOf(code + 1, m);
            const middle = (low + high) / 2;
            assert.equal(packedUf(bitsOf(middle), m), code % 2 === 0 ? code : code + 1,
                `${m}: tie between ${code} and ${code + 1}`);
            assert.equal(packedUf(bitsOf(low + (high - low) * 0.25), m), code);
            assert.equal(packedUf(bitsOf(low + (high - low) * 0.75), m), code + 1);
        }
        assert.equal(packedUf(bitsOf(-1), m), 0);
        assert.equal(packedUf(bitsOf(-0), m), 0);
        assert.equal(packedUf(bitsOf(-Infinity), m), 0);
        assert.equal(packedUf(bitsOf(Infinity), m), top);
        assert.equal(packedUf(bitsOf(1e30), m), top);
        assert.equal(packedUf(bitsOf(2 ** -40), m), 0, 'below half the least denormal');
    }
});

test('each packed format is a word, a half or a byte, and packs and unpacks through v and b',
    ()=>{
        for (const [format, texel] of Object.entries(PACKED_TEXELS))
        {
            assert.ok([1, 2, 4].includes(texel.bytes), format);
            assert.match(texel.pack, /\bv\b/, format);
            assert.match(texel.unpack, /\bb\b/, format);
            assert.match(texel.unpack, /^(vec4<u32>|bitcast<vec4<u32>>)\(/, format);
        }
    });
