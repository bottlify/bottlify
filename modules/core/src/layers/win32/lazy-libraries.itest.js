/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The engine's libraries are made when first read: in a later process of the
 * runtime, which follows the machine's layout, every one of them is made when
 * its module is first placed, and only the class servers register COM classes
 * as they are made (the win32 layer throws for any other, `CLASS_SERVERS`).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createApp } from '../../app.js';
import { buildExe } from '../../../../../tools/fixtures/make-pe.mjs';

/** @param {number} value */
const u32 = value=>[value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24 & 0xff];

const EXIT = buildExe({
    imports: { 'KERNEL32.dll': ['ExitProcess'] },
    codeSize: 0x10,
    code: ({ iat })=>[0x6a, 0x00, 0xff, 0x15, ...u32(iat('ExitProcess'))],
});
const HELLO64 = new URL('../../../test/fixtures/hello64.exe', import.meta.url);

for (const [width, executable] of /** @type {const} */ ([
    ['32-bit', async()=>EXIT],
    ['64-bit', async()=>new Uint8Array(await readFile(HELLO64))]]))
{
    test(`a later process makes each library at its first place (${width})`,
        { timeout: 300000 }, async()=>{
            // The first process of the runtime lays the machine out.
            const first = await createApp({ executable: await executable() });
            await first.dispose();
            const app = await createApp({ executable: await executable() });
            try
            {
                let placed = 0;
                for (const { name } of app.debug.modules())
                {
                    // Asking a system library for its first export by number
                    // places it, which makes its table; the program's own
                    // image answers null.
                    if (app.debug.exported(name, null, 1) !== null)
                    {
                        placed++;
                    }
                }
                assert.ok(placed > 100, `${placed} libraries placed`);
            }
            finally
            {
                await app.dispose();
            }
        });
}
