/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agrees, outcomeOf } from './vcredist-matrix.mjs';
import { buildExe } from './make-pe.mjs';
import { resourceOfImage } from '../modules/core/src/app.js';

test('a run is the program running, the runtime\'s R6034 box, or a stop of another kind', ()=>{
    assert.equal(outcomeOf({ exitCode: 0 }), 'runs');
    assert.equal(outcomeOf({ exitCode: null, box: 'R6034' }), 'R6034');
    assert.equal(outcomeOf({ exitCode: null, error: 'side-by-side' }), 'did not run: side-by-side');
    assert.equal(outcomeOf({ exitCode: 1 }), 'stopped (exit 0x1)');
});

test('a run agrees with Windows when it runs where Windows does and stops where it does not', ()=>{
    assert.ok(agrees('runs', 'runs (as with the redistributable installed)'));
    assert.ok(agrees('R6034', 'R6034'));
    assert.ok(agrees('stopped (exit 0x1)', 'R6034'), 'the program does not get past it either');
    assert.ok(!agrees('runs', 'R6034'));
    assert.ok(!agrees('R6034', 'runs'));
});

test('a program built with a manifest carries it as its RT_MANIFEST 1', ()=>{
    const text = '<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0"/>';
    const exe = buildExe({ imports: { 'KERNEL32.dll': ['ExitProcess'] },
        manifest: { id: 1, text }, code: ()=>[0xc3] });
    assert.equal(new TextDecoder().decode(resourceOfImage(exe, 24, 1) ?? new Uint8Array(0)), text);
    assert.equal(resourceOfImage(exe, 24, 2), null);
    assert.equal(resourceOfImage(buildExe({ imports: { 'KERNEL32.dll': ['ExitProcess'] },
        code: ()=>[0xc3] }), 24, 1), null, 'none without one');
});
