/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * LoadLibrary of the program's own file, through `createApp`: the handle it
 * already has, the image's base, with no file read. An engine asks for its own
 * module by path to look its exports up, hundreds of times while it loads, and
 * each ask read the whole executable from the volume again before handing the
 * loaded module back.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from './app.js';
import { buildExe } from '../../../tools/make-pe.mjs';

/** @param {number} value @returns {number[]} */
const u32 = value=>[value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24 & 0xff];
/** @param {string} text */
const cString = text=>[...new TextEncoder().encode(text), 0];

const SELF = 'C:\\App\\self.exe';

test('LoadLibrary of the program\'s own path answers its base and reads no file',
    { timeout: 60000 }, async t=>{
        const program = buildExe({
            imports: { 'KERNEL32.dll': ['LoadLibraryA', 'ExitProcess'] },
            data: { self: cString(SELF) },
            code: ({ iat, at })=>{
                /** @type {number[]} */
                const bytes = [];
                for (let ask = 0; ask < 3; ask++)
                {
                    bytes.push(0x68, ...u32(at('self'))); // push path
                    bytes.push(0xff, 0x15, ...u32(iat('LoadLibraryA')));
                }
                bytes.push(0xc1, 0xe8, 0x10); // shr eax, 16: the base's high half
                bytes.push(0x50, 0xff, 0x15, ...u32(iat('ExitProcess')));
                return bytes;
            },
        });
        const app = await createApp({
            executable: program, imagePath: SELF,
            storage: { load: async()=>({ files: [{ path: SELF, bytes: program }] }) },
        });
        t.after(()=>app.dispose());
        assert.equal(await app.run({ timeoutMs: 50000 }), 0x40, 'the image\'s base, 0x400000');
        const files = /** @type {any} */ (app.diagnostics().find((/** @type {any} */ layer)=>layer.name === 'filesystem'))
            ?.metrics?.handles?.byPath ?? {};
        const opened = Object.entries(files).filter(([path])=>/self\.exe$/i.test(path));
        assert.deepEqual(opened, [], 'the executable was not read again');
    });
