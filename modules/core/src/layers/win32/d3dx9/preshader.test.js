/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PreshaderError, readPreshader } from './preshader.js';

/** A comment token and its body, the tag first. @param {number} tag @param {number[]} body */
const comment = (tag, body)=>[((body.length + 1) << 16 | 0xfffe) >>> 0, tag, ...body];

/**
 * A constant table of float4 constants, each a vector of four at its register.
 *
 * @param {[string, number][]} constants  name, register
 */
function ctab(constants){
    const header = 28;
    const infos = header;
    const typeAt = infos + constants.length * 20;
    const namesAt = typeAt + 16;
    /** @type {number[]} */
    const bytes = new Array(namesAt).fill(0);
    const put32 = (/** @type {number} */ at, /** @type {number} */ v)=>{
        for (let i = 0; i < 4; i++)
        {
            bytes[at + i] = (v >>> (i * 8)) & 0xff;
        }
    };
    const put16 = (/** @type {number} */ at, /** @type {number} */ v)=>{
        bytes[at] = v & 0xff;
        bytes[at + 1] = v >>> 8;
    };
    put32(0, header);
    put32(12, constants.length);
    put32(16, infos);
    put16(typeAt, 1); // a vector
    put16(typeAt + 2, 3); // of floats
    put16(typeAt + 4, 1);
    put16(typeAt + 6, 4);
    put16(typeAt + 8, 1);
    constants.forEach(([name, register], i)=>{
        const at = infos + i * 20;
        put32(at, bytes.length);
        bytes.push(...[...name].map(c=>c.charCodeAt(0)), 0);
        put16(at + 4, 2); // FLOAT4
        put16(at + 6, register);
        put16(at + 8, 1);
        put32(at + 12, typeAt);
    });
    while (bytes.length % 4)
    {
        bytes.push(0);
    }
    return Array.from(new Uint32Array(Uint8Array.from(bytes).buffer));
}

/** Two doubles' words. @param {number[]} values */
const doubles = values=>Array.from(new Uint32Array(Float64Array.from(values).buffer));

/** An operand: no index, then the table and the component offset. */
const reg = (/** @type {number} */ table, /** @type {number} */ offset)=>[0, table, offset];

test('an expression reads its parameters through its constant table and writes the outputs', ()=>{
    // oc0.xy = (c0.xy + c1.xy) * imm0; oc1.x = dot(c0.xyz, c1.xyz); oc1.y = c0.x >= 0 ? 7 : 9
    const code = [4,
        0x20400002, 2, ...reg(2, 0), ...reg(2, 4), ...reg(7, 0),
        0xa0500002, 2, ...reg(1, 0), ...reg(7, 0), ...reg(4, 0),
        0x50000003, 2, ...reg(2, 0), ...reg(2, 4), ...reg(4, 4),
        0x30000001, 3, ...reg(2, 0), ...reg(1, 4), ...reg(1, 8), ...reg(4, 5)];
    const words = Uint32Array.from([0x46580201,
        ...comment(0x42415443, ctab([['a', 0], ['b', 1]])),
        ...comment(0x54494c43, [12, ...doubles([0.5, 0, 0, 0, 7, 0, 0, 0, 9, 0, 0, 0])]),
        ...comment(0x434c5846, code)]);
    const program = readPreshader(words);
    assert.deepEqual(program.inputs.map(c=>c.name), ['a', 'b']);
    const out = program.run(c=>(c.name === 'a' ? [1, 2, 3, 4] : [10, 20, 30, 40]));
    assert.deepEqual(out.slice(0, 6), [5.5, 11, 0, 0, 1 * 10 + 2 * 20 + 3 * 30, 7]);
    assert.equal(program.run(c=>(c.name === 'a' ? [-1, 0, 0, 0] : [0, 0, 0, 0]))[5], 9);
    assert.equal(program.run(()=>null)[0], 0, 'a parameter the effect lacks reads as zero');
});

test('an instruction D3DX does not know is refused, not guessed', ()=>{
    const words = Uint32Array.from([0x46580201,
        ...comment(0x434c5846, [1, 0x7ff00001, 1, ...reg(2, 0), ...reg(4, 0)])]);
    assert.throws(()=>readPreshader(words), PreshaderError);
});
