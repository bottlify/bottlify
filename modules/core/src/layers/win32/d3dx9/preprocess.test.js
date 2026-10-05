/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, preprocess } from './preprocess.js';
import { createD3dxFunctions } from './functions.js';

test('macros expand, with and without parameters, and the program\'s own are defined', async()=>{
    const result = await preprocess([
        '#define SCALE 2.0',
        '#define MUL(a, b) ((a) * (b))',
        'float x = MUL(SCALE, y); // a comment',
        'float z = QUALITY;',
        '#undef SCALE',
        'float w = SCALE;',
    ].join('\n'), { defines: [['QUALITY', '3']] });
    assert.deepEqual(result, { text: ['', '', 'float x = ((2.0) * (y)); ', 'float z = 3;', '',
        'float w = SCALE;'].join('\n') });
});

test('conditions take their branch, and every source line keeps a line of the output', async()=>{
    const source = [
        '#if defined(SM3) && LEVEL > 1',
        'three',
        '#elif LEVEL == 1',
        'one',
        '#else',
        'other',
        '#endif',
        '#ifndef SM3',
        'no sm3',
        '#endif',
        '/* a block',
        '   comment */ after',
        'joined \\',
        'line',
    ].join('\n');
    const one = await preprocess(source, { defines: [['LEVEL', '1']] });
    assert.ok('text' in one);
    const lines = one.text.split('\n');
    assert.equal(lines.length, 14, 'line for line');
    assert.deepEqual(lines.map(line=>line.trim()).filter(Boolean),
        ['one', 'no sm3', 'after', 'joined line']);
    const three = await preprocess(source, { defines: [['LEVEL', '2'], ['SM3', '']] });
    assert.ok('text' in three);
    assert.deepEqual(three.text.split('\n').map(line=>line.trim()).filter(Boolean),
        ['three', 'after', 'joined line']);
});

test('an include is asked for and read in place; one that cannot be opened is an error', async()=>{
    /** @type {string[]} */
    const asked = [];
    const result = await preprocess('#include "common.fxh"\nfloat a = SHARED;', {
        include: name=>{
            asked.push(name);
            return Promise.resolve(name === 'common.fxh' ? '#define SHARED 4\n' : null);
        },
    });
    assert.deepEqual(asked, ['common.fxh']);
    assert.ok('text' in result && result.text.endsWith('float a = 4;'));
    assert.deepEqual(await preprocess('#include <missing.h>', { include: ()=>null }),
        { error: 'memory(1): cannot open include file \'missing.h\'' });
    assert.deepEqual(await preprocess('#error stop here'),
        { error: 'memory(1): #error stop here' });
});

test('#if expressions follow C', ()=>{
    const macros = new Map([['A', { params: null, body: '3' }]]);
    assert.equal(evaluate('A * 2 + 1 == 7 && !defined B', macros), 1);
    assert.equal(evaluate('(A << 2) | 1', macros), 13);
    assert.equal(evaluate('A > 5 ? 10 : 20', macros), 20);
    assert.equal(evaluate('UNDEFINED', macros), 0);
});

test('D3DXPreprocessShader answers the text in a buffer; D3DXCompileShader fails on an error',
    async()=>{
        const memory = new Uint8Array(0x8000);
        const view = new DataView(memory.buffer);
        let free = 0x4000;
        /** @type {any[]} */
        const published = [];
        /** @type {string[]} */
        const said = [];
        const fns = /** @type {any} */ (createD3dxFunctions({
            readMemory: (address, length)=>memory.subarray(address, address + length),
            writeMemory: (address, bytes)=>memory.set(bytes, address),
            heap: { allocate: bytes=>{
                const at = free;
                free += bytes + 15 & ~15;
                return at;
            }, free: ()=>{} },
            vtables: { publish: object=>{
                published.push(object);
                return 0x100 + published.length * 0x10;
            } },
            divergence: api=>said.push(api),
        }));
        const source = new TextEncoder().encode('#define K 2\nfloat x = K;');
        memory.set(source, 0x1000);
        memory.set(new TextEncoder().encode('LIGHTS\x004\0'), 0x1100);
        view.setUint32(0x1200, 0x1100, true);
        view.setUint32(0x1204, 0x1107, true);
        assert.equal(fns.D3DXPreprocessShader.argBytes, 24);
        assert.equal(await fns.D3DXPreprocessShader.handler([0x1000, source.length, 0x1200, 0,
            0x50, 0x54]), 0);
        assert.equal(view.getUint32(0x50, true), 0x110);
        const text = published[0].state;
        assert.equal(new TextDecoder().decode(memory.subarray(text.data, text.data + text.size)),
            '\nfloat x = 2;\0', 'the text, ended by a NUL');

        memory.set(new TextEncoder().encode('main\0ps_2_0\0'), 0x1300);
        assert.equal(fns.D3DXCompileShader.argBytes, 40);
        assert.equal(await fns.D3DXCompileShader.handler([0x1000, source.length, 0, 0, 0x1300,
            0x1305, 0, 0x60, 0x64, 0x68]) >>> 0, 0x80004005, 'E_FAIL');
        assert.deepEqual([0x60, 0x68].map(at=>view.getUint32(at, true)), [0, 0],
            'no shader, no table');
        const errors = published[1].state;
        const message = memory.subarray(errors.data, errors.data + errors.size);
        assert.match(new TextDecoder().decode(message),
            /error X3501: 'main': entrypoint not found/);
        assert.deepEqual(said, ['D3DXCompileShader']);
    });

test('an #include goes to the program\'s ID3DXInclude, Open then Close, on the caller\'s thread',
    async()=>{
        const memory = new Uint8Array(0x8000);
        const view = new DataView(memory.buffer);
        let free = 0x4000;
        /** @type {{ entry: number, thread: any }[]} */
        const calls = [];
        const fns = /** @type {any} */ (createD3dxFunctions({
            readMemory: (address, length)=>memory.subarray(address, address + length),
            writeMemory: (address, bytes)=>memory.set(bytes, address),
            heap: { allocate: bytes=>{
                const at = free;
                free += bytes + 15 & ~15;
                return at;
            }, free: ()=>{} },
            vtables: { publish: ()=>0x700 },
            currentThread: ()=>'main',
            callGuest: ({ entry, args, thread })=>{
                calls.push({ entry, thread });
                if (entry === 0x900)
                {
                    // Open: the file's text at 0x3000, its length after.
                    memory.set(new TextEncoder().encode('#define N 5\n'), 0x3000);
                    view.setUint32(args[4], 0x3000, true);
                    view.setUint32(args[5], 12, true);
                }
                return Promise.resolve(0);
            },
        }));
        // An ID3DXInclude: its vtable's two slots, Open and Close.
        view.setUint32(0x2000, 0x2100, true);
        view.setUint32(0x2100, 0x900, true);
        view.setUint32(0x2104, 0x904, true);
        const source = new TextEncoder().encode('#include "n.fxh"\nfloat n = N;');
        memory.set(source, 0x1000);
        assert.equal(await fns.D3DXPreprocessShader.handler([0x1000, source.length, 0, 0x2000,
            0x50, 0]), 0);
        assert.deepEqual(calls,
            [{ entry: 0x900, thread: 'main' }, { entry: 0x904, thread: 'main' }]);
    });
