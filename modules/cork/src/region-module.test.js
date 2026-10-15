/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { regionModule } from './region-module.js';

test('a region told instruction by instruction what each took in wasm', ()=>{
    // call +0x10; mov eax, ebx; ret -- as a game's region is emitted, entry hash and
    // wasm calls on, so `tools/cork-expansion.mjs` measures what a game runs.
    /** @type {{ eip: number, op: string, bytes: number, lowered: boolean }[]} */
    const told = [];
    const { wasm } = regionModule({
        code: [0xe8, 0x10, 0x00, 0x00, 0x00, 0x8b, 0xc3, 0xc3], at: 0x400000,
        hash: true, callReturn: true, looseStacks: true,
        expansion: (instruction, bytes, lowered)=>told.push({ eip: instruction.eip,
            op: instruction.op, bytes, lowered }),
    });
    assert.ok(WebAssembly.validate(wasm), 'the module is valid as emitted');
    assert.deepEqual(told.map(one=>[one.eip, one.op, one.lowered]),
        [[0x400000, 'call', true], [0x400005, 'mov', true], [0x400007, 'ret', true]]);
    const [call, move, ret] = told.map(one=>one.bytes);
    assert.ok(move > 0 && move <= 8, `a register move is a get and a set: ${move} bytes`);
    assert.ok(call > move && ret > move, 'a call and a return each more than a move');
});

test('without a listener nothing is told and the module is the same', ()=>{
    const code = [0x01, 0xd8, 0x8b, 0x4b, 0x04, 0xc3];
    const plain = regionModule({ code, at: 0x400000 }).wasm;
    let told = 0;
    const listened = regionModule({ code, at: 0x400000, expansion: ()=>{
        told++;
    } }).wasm;
    assert.equal(told, 3);
    assert.deepEqual(listened, plain, 'listening changes no byte emitted');
});
