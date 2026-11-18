/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkText, layoutOf } from './check-wide-arguments.mjs';

test('a signature is laid out as the 32-bit stack has it', ()=>{
    const layout = layoutOf('AUDCLNT_SHAREMODE mode, DWORD flags, REFERENCE_TIME duration,'
        + ' REFERENCE_TIME period, const WAVEFORMATEX *format, LPCGUID session');
    assert.deepEqual(layout.quad, [2, 4]);
    assert.deepEqual(layoutOf('double x, float y, GUID g, POINT p').floats, { 0: 'f64', 2: 'f32' });
    assert.deepEqual(layoutOf('CLSID clsid, POINT pt').structs, { 0: 4 });
    assert.deepEqual(layoutOf('void').quad, []);
});

test('a spec is held to its signature: undeclared, misdeclared, declared, by a helper', ()=>{
    const problem = (/** @type {string} */ text)=>checkText(text).map(one=>one.problem);
    const signature = '/** HRESULT Seek(LARGE_INTEGER move, DWORD origin, ULARGE_INTEGER *out) */\n';
    assert.match(String(problem(`${signature}{ name: 'Seek', argBytes: 20, invoke: ()=>0 },`)[0]),
        /quadwords .* not declared/);
    assert.match(String(problem(
        `${signature}{ name: 'Seek', argBytes: 20, quadwords: [2], invoke: ()=>0 },`)[0]),
    /where the signature has/);
    assert.deepEqual(problem(
        `${signature}{ name: 'Seek', argBytes: 20, quadwords: [1], invoke: ()=>0 },`), [null]);
    assert.deepEqual(problem('const make = n=>({ argBytes: 12, quadwords: [0], handler: ()=>0 });\n'
        + '/** BOOL Free(TRACEHANDLE handle) */\nFree: make(1),'), [null],
    'a helper\'s own literal');
    assert.deepEqual(problem('/** float Late(int a, int b, int c, int d, float e) */\n'
        + 'Late: { argBytes: 20, handler: ()=>0 },'), [null],
    'a float past the fourth slot needs nothing');
});
