/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A process holds in the engine's heap what it uses, not the whole engine: the
 * libraries' tables are made when first read, the system modules' layout is
 * one a runtime's processes share, and a module is built only where a process
 * places it (decisions A280, A281). Every process built every table and every
 * module's exports once, about 36 MiB of heap each for a program that imports
 * kernel32 alone; a setup that runs dozens of processes paid that each time.
 * Processes kept alive side by side, the heap each one adds is measured.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { createApp } from './app.js';
import { buildExe } from '../../../tools/fixtures/make-pe.mjs';

/** @param {number} value */
const u32 = value=>[value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24 & 0xff];

const EXECUTABLE = buildExe({
    imports: { 'KERNEL32.dll': ['ExitProcess'] },
    codeSize: 0x10,
    code: ({ iat })=>[0x6a, 0x00, 0xff, 0x15, ...u32(iat('ExitProcess'))],
});

/** The heap past which a process's own share means its tables are built whole again. */
const PROCESS_HEAP_LIMIT = 16 * 2 ** 20;

test('a process kept beside others adds the heap of what it uses, not of the whole engine',
    { timeout: 300000 }, async t=>{
        setFlagsFromString('--expose-gc');
        const gc = runInNewContext('gc');
        /** Collected until two readings agree. */
        const heap = async()=>{
            let last = -1;
            for (let round = 0; round < 50; round++)
            {
                gc();
                await new Promise(done=>setTimeout(done, 20));
                gc();
                const now = process.memoryUsage().heapUsed;
                if (Math.abs(now - last) < 2 ** 18)
                {
                    return now;
                }
                last = now;
            }
            return last;
        };
        /** @type {any[]} */
        const apps = [];
        t.after(()=>apps.forEach(app=>app.dispose()));
        const start = async()=>{
            const app = await createApp({ executable: EXECUTABLE });
            apps.push(app);
            assert.equal(await app.run({ timeoutMs: 60000 }), 0);
        };
        // Two first, for what the first process of a thread makes and keeps
        // (the layout, the tables a library makes once).
        await start();
        await start();
        const before = await heap();
        const added = 6;
        for (let i = 0; i < added; i++)
        {
            await start();
        }
        const each = (await heap() - before) / added;
        t.diagnostic(`${(each / 2 ** 20).toFixed(1)} MiB of heap a process`);
        assert.ok(each < PROCESS_HEAP_LIMIT, `${(each / 2 ** 20).toFixed(1)} MiB a process`);
    });
