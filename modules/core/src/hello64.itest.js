/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The first x86-64 program, through `createApp`: a PE32+ image linked above
 * 4 GiB is placed below it, runs in long mode on cork's long-mode interpreter,
 * calls the host through the x64 convention and ends with the exit code it
 * computed -- also when every slice feeds the sampler, where the 32-bit
 * translator, which owns the page table in a 64-bit process, must form nothing --
 * and on that same translator, asked to form long mode itself.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createApp } from './app.js';

const FIXTURE = new URL('../test/fixtures/hello64.exe', import.meta.url);

test('an x86-64 console program prints its line and exits with 0', { timeout: 120000 }, async t=>{
    const app = await createApp({ executable: new Uint8Array(await readFile(FIXTURE)),
        engine: 'cork' });
    t.after(()=>app.dispose());
    /** @type {string[]} */
    const output = [];
    app.attachLog((/** @type {number} */ _handle, /** @type {string} */ text)=>output.push(text));
    const code = await app.run({ timeoutMs: 100000 });
    assert.equal(output.join(''), 'hello from x64, fib(25)=75025\n');
    assert.equal(code, 0, 'the program checked its own arithmetic');
    // Every system export runs at 64 bits -- its x86-64, its handler's trap,
    // or a variable -- but these, i386 alone: a new export that is i386
    // guest code and nothing else shows here, before a program calls it.
    const app64 = app.diagnostics().find((/** @type {any} */ layer)=>layer.name === 'app');
    const crt = ['msvcrt.dll', 'CRTDLL.dll', 'MSVCR71.dll', 'MSVCR80.dll', 'ucrtbase.dll'];
    assert.deepEqual([...app64.metrics.leftOutAt64].sort(), [
        ...crt.flatMap(dll=>[`${dll}!_EH_prolog`, `${dll}!_chkesp`]),
        'ntdll.dll!RtlActivateActivationContextUnsafeFast',
        'ntdll.dll!RtlDeactivateActivationContextUnsafeFast',
        'ntdll.dll!RtlInterlockedPushListSList',
    ].sort());
});

test('fed every slice, as a program that presents frames is, a 64-bit process\'s regions are'
    + ' formed by the runtime the 32-bit code runs on', { timeout: 120000 }, async t=>{
    const app = await createApp({ executable: new Uint8Array(await readFile(FIXTURE)),
        engine: 'cork', cork: { config: { feed: 'slice' } } });
    t.after(()=>app.dispose());
    /** @type {string[]} */
    const output = [];
    app.attachLog((/** @type {number} */ _handle, /** @type {string} */ text)=>output.push(text));
    const code = await app.run({ timeoutMs: 100000 });
    assert.equal(output.join(''), 'hello from x64, fib(25)=75025\n');
    assert.equal(code, 0);
    const cpu = app.diagnostics().find((/** @type {any} */ layer)=>layer.name === 'cpu');
    assert.ok(cpu.metrics.cork.regions > 0, 'the shared runtime translated it');
});
