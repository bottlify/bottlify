/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VALIDATOR_MESSAGE, createShaderValidator } from './shader-validator.js';

const S_OK = 0;
const E_FAIL = 0x80004005 | 0;
const CALLBACK = 0x7000;
const CONTEXT = 0x7100;
const FILE = 0x7200;
const TOKENS = 0x1000;

/** A validator over flat memory, its callbacks recorded as Windows' arguments. */
function harness(){
    const bytes = new Uint8Array(0x10000);
    let free = 0x8000;
    /** @type {{ file: number, line: number, id: number, message: number, context: number }[]} */
    const heard = [];
    const memory = {
        /** @param {number} at @param {number} length */
        readMemory: (at, length)=>bytes.slice(at, at + length),
        /** @param {number} at @param {Uint8Array} data */
        writeMemory: (at, data)=>bytes.set(data, at),
    };
    const validator = createShaderValidator({
        memory,
        callGuest: async({ entry, args })=>{
            assert.equal(entry, CALLBACK);
            const [file, line, , id, message, context] = args;
            heard.push({ file, line: line | 0, id, message, context });
            return S_OK;
        },
        allocate: size=>{
            const at = free;
            free += size;
            return at;
        },
    });
    /** @param {number[]} words */
    const put = words=>{
        bytes.set(new Uint8Array(new Uint32Array(words).buffer), TOKENS);
        return [TOKENS, words.length];
    };
    /** @param {number} at */
    const text = at=>{
        let end = at;
        while (bytes[end] !== 0)
        {
            end++;
        }
        return String.fromCharCode(...bytes.slice(at, end));
    };
    return { validator, heard, put, text };
}

test('an instruction before the version is no shader, and its validation stays open', async()=>{
    // Wine's d3d9 test_shader_validator.
    const { validator, heard, put, text } = harness();
    assert.equal(validator.Begin([CALLBACK, CONTEXT, 0]), S_OK);
    const mov = put([0x00000001, 0x800f0000, 0x90e40000]);
    assert.equal(await validator.Instruction([FILE, 28, ...mov]), E_FAIL);
    assert.deepEqual(heard.map(({ file, line, id, context })=>[file, line, id, context]), [
        [0, -1, VALIDATOR_MESSAGE.NO_VERSION, CONTEXT],
        [0, 0, VALIDATOR_MESSAGE.NOT_A_SHADER, CONTEXT],
    ]);
    assert.ok(text(heard[0].message).length > 0, 'a message the program can print');
    heard.length = 0;
    assert.equal(validator.End(), E_FAIL);
    assert.equal(heard.length, 0);
    assert.equal(await validator.Begin([CALLBACK, CONTEXT + 4, 0]), E_FAIL, 'still open');
    assert.deepEqual(heard.map(({ id, context })=>[id, context]),
        [[VALIDATOR_MESSAGE.BEGUN, CONTEXT + 4]]);
    assert.equal(validator.Begin([0, CONTEXT, 0]), E_FAIL);
});

test('an input register past the version\'s last is said where it was, and End fails', async()=>{
    const { validator, heard, put } = harness();
    /** @param {number[]} instruction @param {number[] | null} declaration */
    const run = async(instruction, declaration = null)=>{
        heard.length = 0;
        assert.equal(validator.Begin([CALLBACK, CONTEXT, 0]), S_OK);
        assert.equal(await validator.Instruction([FILE, 1, ...put([0xffff0300])]), S_OK);
        if (declaration)
        {
            assert.equal(await validator.Instruction([FILE, 3, ...put(declaration)]), S_OK);
            assert.equal(heard.length, 0);
        }
        assert.equal(await validator.Instruction([FILE, 3, ...put(instruction)]), S_OK,
            'the instruction itself answers S_OK');
        const said = heard.map(({ file, line, id })=>[file, line, id]);
        assert.equal(await validator.Instruction([FILE, 5, ...put([0x0000ffff])]), S_OK);
        return { said, end: validator.End() };
    };
    const dclTexcoord = (/** @type {number} */ index, /** @type {number} */ register)=>
        [0x0200001f, 0x80000005 | (index << 16), 0x902f0000 | register];
    assert.deepEqual(await run(dclTexcoord(9, 9)), { said: [], end: S_OK });
    assert.deepEqual(await run(dclTexcoord(9, 10)),
        { said: [[FILE, 3, VALIDATOR_MESSAGE.DECLARED_PAST]], end: E_FAIL });
    assert.deepEqual(await run(dclTexcoord(10, 9)), { said: [], end: S_OK },
        'a usage index past nine is no register');
    assert.deepEqual(await run([0x02000001, 0x80220002, 0x90ff0009], dclTexcoord(9, 9)),
        { said: [], end: S_OK });
    assert.deepEqual(await run([0x02000001, 0x80220002, 0x90ff000a]),
        { said: [[FILE, 3, VALIDATOR_MESSAGE.READ_PAST]], end: E_FAIL });
});

test('with no callback, nothing is told and the answers are the same', ()=>{
    const { validator, put } = harness();
    assert.equal(validator.Begin([0, CONTEXT, 0]), S_OK);
    assert.equal(validator.Instruction([0, 1, ...put([0xffff0300])]), S_OK);
    assert.equal(validator.Instruction([0, 3, ...put([0x02000001, 0x80220002, 0x90ff000a])]), S_OK);
    assert.equal(validator.Instruction([0, 3, TOKENS, 0]), E_FAIL, 'no tokens');
    assert.equal(validator.End(), E_FAIL);
});
