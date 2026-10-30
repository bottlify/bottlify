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

/**
 * The minimum of the memory a module imports, in pages, from its import section.
 *
 * @param {Uint8Array} wasm
 */
function importedMemoryMinimum(wasm){
    let at = 8;
    const leb = ()=>{
        let result = 0;
        let shift = 0;
        for (;;)
        {
            const byte = wasm[at++];
            result += (byte & 0x7f) * 2 ** shift;
            shift += 7;
            if ((byte & 0x80) === 0)
            {
                return result;
            }
        }
    };
    const name = ()=>{
        const length = leb();
        at += length;
    };
    while (at < wasm.length)
    {
        const id = wasm[at++];
        const size = leb();
        const end = at + size;
        if (id === 2)
        {
            for (let count = leb(); count > 0; count--)
            {
                name();
                name();
                const kind = wasm[at++];
                if (kind === 2)
                {
                    leb();
                    return leb();
                }
                if (kind === 0)
                {
                    leb();
                }
                else if (kind === 1)
                {
                    at++;
                    const flags = leb();
                    leb();
                    if (flags & 1)
                    {
                        leb();
                    }
                }
                else
                {
                    at += 2;
                }
            }
        }
        at = end;
    }
    return -1;
}

test('a region\'s module asks for a memory that holds the guest\'s RAM', ()=>{
    // mov eax, [0x402044]; ret: a constant address the compiler can take as in bounds.
    for (const [ramSize, ramBase] of [[16 << 20, 0x10000], [1 << 30, 0], [3 << 20, 0x10000]])
    {
        const { wasm } = regionModule({ code: [0xa1, 0x44, 0x20, 0x40, 0x00, 0xc3], at: 0x400000,
            ramSize, ramBase });
        assert.equal(importedMemoryMinimum(wasm), Math.ceil((ramBase + ramSize) / 65536),
            `RAM ${ramSize} at ${ramBase}`);
    }
});
