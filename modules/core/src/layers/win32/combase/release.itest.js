/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * combase.dll came with Windows 8: a program on 7 or XP that loads it finds
 * none, and one on 10 finds it. The .NET Framework 4.8's runtime loads it
 * where it is and then stops when a function of it is missing.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../../../app.js';
import { assemble, buildExe } from '../../../../../../tools/fixtures/make-pe.mjs';

/** @param {number} value */
const u32 = value=>[0, 8, 16, 24].map(at=>(value >>> at) & 0xff);

/** LoadLibraryA("combase.dll"): exit 1 when found, 0 when not. */
const probe = buildExe({
    imports: { 'KERNEL32.dll': ['LoadLibraryA', 'ExitProcess'] },
    data: { name: [...'combase.dll'].map(c=>c.charCodeAt(0)).concat(0) },
    code: ({ iat, at })=>assemble([
        0x68, ...u32(at('name')), 0xff, 0x15, ...u32(iat('LoadLibraryA')),
        0x85, 0xc0, 0x0f, 0x95, 0xc0, //        test eax, eax; setnz al
        0x0f, 0xb6, 0xc0, //                    movzx eax, al
        0x50, 0xff, 0x15, ...u32(iat('ExitProcess')),
    ]),
});

for (const [windows, found] of /** @type {const} */ ([['winxp', 0], ['win7', 0], ['win10', 1]]))
{
    test(`combase.dll on ${windows}: ${found ? 'there' : 'not there'}`, { timeout: 60_000 },
        async()=>{
            const app = await createApp({ executable: probe, imagePath: 'C:\\App\\probe.exe',
                windows });
            try
            {
                assert.equal(await app.run({ timeoutMs: 30_000 }), found);
            }
            finally
            {
                await app.dispose();
            }
        });
}
