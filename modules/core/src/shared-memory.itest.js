/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The engine runs over shared memory and only there: where there is none -- a
 * page that is not cross-origin isolated has no SharedArrayBuffer -- a run is
 * refused before anything is built, with what turns it on, and the engine's
 * modules still load so the refusal can be said. Executors asked for where the
 * engine's thread may not block on that memory (a page's window) run the
 * program on one, and the cpu's report says why; the launch does not fail.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from './app.js';
import { spawnSync } from 'node:child_process';
import { buildExe } from '../../../tools/fixtures/make-pe.mjs';

/** @param {number} value @returns {number[]} */
const u32 = value=>[
    value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff,
];

test('three executors on a thread that may not block run the program on one and say why',
    { timeout: 60_000 }, async()=>{
        // A page's window shares memory once cross-origin isolated, but may not
        // block on it: the process's executor would wait on the others there.
        const executable = buildExe({
            imports: { 'KERNEL32.dll': ['ExitProcess'] },
            code: ({ iat })=>[0x6a, 0x07, 0xff, 0x15, ...u32(iat('ExitProcess'))],
        });
        const wait = Atomics.wait;
        Atomics.wait = ()=>{
            throw new TypeError('Atomics.wait cannot be called in this context');
        };
        try
        {
            const app = await createApp({ executable, cpu: { cores: 3 } });
            try
            {
                assert.equal(await app.run({ timeoutMs: 30_000 }), 7);
                const tables = await app.diagnostics();
                const cpu = (Array.isArray(tables) ? tables : [])
                    .find(table=>table.name === 'cpu');
                assert.match(String(cpu?.metrics?.executorsRefused),
                    /3 asked, 1 run: .*may not block/);
                assert.deepEqual(cpu?.metrics?.executors, []);
            }
            finally
            {
                await app.dispose();
            }
        }
        finally
        {
            Atomics.wait = wait;
        }
    });

test('a run where SharedArrayBuffer is gone is refused before it is built, and says which headers'
    + ' turn it on', { timeout: 60_000 }, async()=>{
    const executable = buildExe({
        imports: { 'KERNEL32.dll': ['ExitProcess'] },
        code: ({ iat })=>[0x6a, 0x07, 0xff, 0x15, ...u32(iat('ExitProcess'))],
    });
    const shared = globalThis.SharedArrayBuffer;
    // As on a page served without COOP/COEP.
    // @ts-ignore -- removed for the run, put back below
    delete globalThis.SharedArrayBuffer;
    try
    {
        await assert.rejects(createApp({ executable }),
            /needs shared memory.*Cross-Origin-Opener-Policy: same-origin/s);
    }
    finally
    {
        globalThis.SharedArrayBuffer = shared;
    }
});

test('the mode option is refused as removed, so a stale caller learns why', async()=>{
    const executable = buildExe({
        imports: { 'KERNEL32.dll': ['ExitProcess'] },
        code: ({ iat })=>[0x6a, 0x07, 0xff, 0x15, ...u32(iat('ExitProcess'))],
    });
    for (const mode of ['compatible', 'isolated', 'auto'])
    {
        await assert.rejects(createApp(/** @type {any} */ ({ executable, mode })),
            /unknown option mode .*removed/);
    }
});

test('where SharedArrayBuffer never existed the engine\'s modules load, and the run is refused',
    { timeout: 60_000 },
    ()=>{
        // A page served without COOP/COEP has none from its first module on: a
        // module that makes one as it loads would stop the page before the
        // refusal could be said, which removing it after the import above
        // cannot see.
        const app = new URL('./app.js', import.meta.url).href;
        const pe = new URL('../../../tools/fixtures/make-pe.mjs', import.meta.url).href;
        const script = `delete globalThis.SharedArrayBuffer;
            const { createApp } = await import(${JSON.stringify(app)});
            const { buildExe } = await import(${JSON.stringify(pe)});
            const executable = buildExe({ imports: { 'KERNEL32.dll': ['ExitProcess'] },
                code: ({ iat })=>{ const at = iat('ExitProcess');
                    return [0x6a, 0x07, 0xff, 0x15, at & 0xff, (at >>> 8) & 0xff,
                        (at >>> 16) & 0xff, (at >>> 24) & 0xff]; } });
            try { await createApp({ executable }); process.stdout.write('built'); }
            catch (e) { process.stdout.write('refused: ' + e.message); }`;
        const child = spawnSync(process.execPath, ['--input-type=module', '-e', script],
            { encoding: 'utf8', timeout: 50_000 });
        assert.match(child.stdout.trim(), /^refused: the engine needs shared memory/,
            child.stderr.slice(0, 2000));
    });
