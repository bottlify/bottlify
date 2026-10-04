/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The report a person saves with one click: every layer, the phase profile,
 * where the machine stands, and the guest's own code around the addresses it
 * spent itself at -- what a question about the translator's work there is
 * answered from without asking for the program.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from './app.js';
import { buildExe } from '../../../tools/make-pe.mjs';

/** @param {number} value */
const u32 = value=>[value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24 & 0xff];

test('a report carries every layer, the profile and the code the guest spent itself in',
    { timeout: 60000 }, async t=>{
        // mov ecx, 5000000; L: inc eax; dec ecx; jnz L; push 0; call [ExitProcess]
        const loop = [0xb9, ...u32(5_000_000), 0x40, 0x49, 0x75, 0xfc];
        const executable = buildExe({
            imports: { 'KERNEL32.dll': ['ExitProcess'] },
            codeSize: 0x20,
            code: ({ iat })=>[...loop, 0x6a, 0x00, 0xff, 0x15, ...u32(iat('ExitProcess'))],
        });
        const app = await createApp({ executable, engine: 'cork' });
        t.after(()=>app.dispose());
        assert.equal(await app.run(), 0);

        const report = await app.report();
        const names = report.diagnostics.map((/** @type {{ name: string }} */ table)=>table.name);
        for (const layer of ['cpu', 'kernel', 'bridge', 'graphics', 'log', 'app'])
        {
            assert.ok(names.includes(layer), `${layer} is in it`);
        }
        assert.ok(Array.isArray(report.profile.phases), 'the phase profile');
        assert.match(report.trace, /thread/, 'where the machine stands');
        const cpu = report.diagnostics.find((/** @type {{ name: string }} */ table)=>
            table.name === 'cpu');
        const [hottest] = cpu.metrics.samples.top;
        assert.ok(hottest, 'the loop was sampled');
        const page = report.hotCode.find((/** @type {{ address: number }} */ one)=>
            one.address === (hottest.address & ~0xfff));
        assert.ok(page, 'and the page it ran in is carried');
        const bytes = Uint8Array.from(atob(page.base64), c=>c.charCodeAt(0));
        assert.equal(bytes.length, 0x1000);
        const at = (hottest.address & 0xfff);
        const near = [...bytes.subarray(Math.max(0, at - 64), at + 64)];
        const text = near.map(b=>b.toString(16).padStart(2, '0')).join('');
        assert.ok(text.includes('404975fc'), 'with the loop\'s own bytes in it');
    });

test('a report lists what was said as a divergence, which nothing else keeps',
    { timeout: 60000 }, async t=>{
        // RegSaveKeyA(HKEY_CURRENT_USER, "C:\\saved.key", NULL); ExitProcess(0)
        const executable = buildExe({
            imports: { 'ADVAPI32.dll': ['RegSaveKeyA'], 'KERNEL32.dll': ['ExitProcess'] },
            codeSize: 0x40,
            data: { file: [...Buffer.from('C:\\saved.key'), 0] },
            code: ({ iat, at })=>[
                0x6a, 0x00, 0x68, ...u32(at('file')), 0x68, ...u32(0x80000001),
                0xff, 0x15, ...u32(iat('RegSaveKeyA')),
                0x6a, 0x00, 0xff, 0x15, ...u32(iat('ExitProcess')),
            ],
        });
        const app = await createApp({ executable, engine: 'cork' });
        t.after(()=>app.dispose());
        assert.equal(await app.run(), 0);

        const report = await app.report();
        const table = report.diagnostics.find((/** @type {{ name: string }} */ one)=>
            one.name === 'app');
        assert.equal(table.metrics.emitted.divergence, 1);
        assert.deepEqual(table.metrics.divergences.length, 1);
        assert.match(table.metrics.divergences[0], /^RegSaveKey: a saved key is this engine's own/);
    });

test('a polling loop is written twice and counted, so the journal still holds what came before',
    { timeout: 60000 }, async t=>{
        // GetCurrentThreadId; mov ecx, 50000; L: push ecx; push 0; call [Sleep]; pop ecx;
        // dec ecx; jnz L; GetCurrentThreadId; push 0; call [ExitProcess]
        const executable = buildExe({
            imports: { 'KERNEL32.dll': ['GetCurrentThreadId', 'Sleep', 'ExitProcess'] },
            codeSize: 0x40,
            code: ({ iat })=>[
                0xff, 0x15, ...u32(iat('GetCurrentThreadId')),
                0xb9, ...u32(50000),
                0x51, 0x6a, 0x00, 0xff, 0x15, ...u32(iat('Sleep')), 0x59, 0x49, 0x75, 0xf3,
                0xff, 0x15, ...u32(iat('GetCurrentThreadId')),
                0x6a, 0x00, 0xff, 0x15, ...u32(iat('ExitProcess')),
            ],
        });
        const app = await createApp({ executable, engine: 'cork' });
        t.after(()=>app.dispose());
        app.log.setLevel('call.cpu', 'trace');
        assert.equal(await app.run(), 0);
        const lines = app.log.recent(4096).map((/** @type {any} */ record)=>record.text ?? '')
            .filter((/** @type {string} */ text)=>/\[main\]/.test(text));
        const sleeps = lines.filter((/** @type {string} */ text)=>/Sleep\(0x0\)/.test(text));
        assert.equal(sleeps.length, 8, 'the loop, written until it has gone round in full twice');
        const said = lines.find((/** @type {string} */ text)=>/went round again/.test(text));
        assert.ok(said, lines.slice(-12).join('\n'));
        assert.match(said, /the 1 calls before went round again: 49992 calls not written/);
        assert.equal(lines.filter((/** @type {string} */ text)=>/GetCurrentThreadId/.test(text)).length,
            2, 'what came before the loop and after it both stay');
    });
