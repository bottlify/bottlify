/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A cursor a program makes of its own bitmaps, through `createApp`: drawn as
 * the bitmaps say. A windowing library hides the pointer so -- a cursor whose
 * mask lets every pixel through -- and with the bitmaps' pixels out of user32's
 * reach the cursor had no picture and the page showed the standard arrow,
 * stuck where the game kept centring the pointer. The same cursor set by a
 * child the program starts reaches the page wherever the child runs: in its
 * parent's place, or in a worker of its own.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from './app.js';
import { buildExe } from '../../../tools/fixtures/make-pe.mjs';

/** @param {number} value @returns {number[]} */
const u32 = value=>[value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24 & 0xff];

/** A program that sets a cursor of its own bitmaps, every pixel transparent, and exits. */
function buildBlankCursor(){
    // 32 x 32: the AND half all ones, the XOR half all zeros (a 4-byte
    // line per row of a monochrome bitmap, 64 rows).
    const bits = [...new Array(32 * 4).fill(0xff), ...new Array(32 * 4).fill(0)];
    return buildExe({
        codeSize: 0x100,
        imports: { 'GDI32.dll': ['CreateBitmap'],
            'USER32.dll': ['CreateIconIndirect', 'SetCursor'],
            'KERNEL32.dll': ['ExitProcess'] },
        // ICONINFO: fIcon, xHotspot, yHotspot, hbmMask, hbmColor.
        data: { bits, info: new Array(20).fill(0) },
        code: ({ iat, at })=>[
            0x68, ...u32(at('bits')), 0x6a, 0x01, 0x6a, 0x01, 0x6a, 0x40, 0x6a, 0x20,
            0xff, 0x15, ...u32(iat('CreateBitmap')), // CreateBitmap(32, 64, 1, 1, bits)
            0xa3, ...u32(at('info') + 12), // mov [info.hbmMask], eax
            0x68, ...u32(at('info')),
            0xff, 0x15, ...u32(iat('CreateIconIndirect')),
            0x50, 0xff, 0x15, ...u32(iat('SetCursor')),
            0x6a, 0x00, 0xff, 0x15, ...u32(iat('ExitProcess')),
        ],
    });
}

/** A program that starts C:\App\child.exe, waits for it and exits. */
function buildParent(){
    const startupSize = 68;
    return buildExe({
        codeSize: 0x100,
        imports: { 'KERNEL32.dll': ['CreateProcessA', 'WaitForSingleObject', 'ExitProcess'] },
        data: { child: [...'C:\\App\\child.exe'].map(c=>c.charCodeAt(0)).concat(0),
            startup: [...u32(startupSize), ...new Array(startupSize - 4).fill(0)],
            info: new Array(16).fill(0) },
        code: ({ iat, at })=>[
            // CreateProcessA(child, NULL, NULL, NULL, FALSE, 0, NULL, NULL, &startup, &info)
            0x68, ...u32(at('info')), 0x68, ...u32(at('startup')),
            0x6a, 0x00, 0x6a, 0x00, 0x6a, 0x00, 0x6a, 0x00, 0x6a, 0x00, 0x6a, 0x00, 0x6a, 0x00,
            0x68, ...u32(at('child')),
            0xff, 0x15, ...u32(iat('CreateProcessA')),
            0x6a, 0xff, 0xff, 0x35, ...u32(at('info')), // WaitForSingleObject(hProcess, INFINITE)
            0xff, 0x15, ...u32(iat('WaitForSingleObject')),
            0x6a, 0x00, 0xff, 0x15, ...u32(iat('ExitProcess')),
        ],
    });
}

for (const [where, options] of /** @type {[string, any][]} */ ([
    ['', null],
    [', set by a child in its parent\'s place', {}],
    [', set by a child in a worker of its own', { concurrency: 2 }],
]))
{
    test(`a cursor made of a mask that lets everything through is shown as nothing${where}`,
        { timeout: 60000 }, async t=>{
            const program = buildBlankCursor();
            const app = await createApp(options === null ? { executable: program }
                : { executable: buildParent(), imagePath: 'C:\\App\\parent.exe',
                    files: [{ path: 'C:\\App\\child.exe', bytes: program }], ...options });
            t.after(()=>app.dispose());
            /** @type {any[]} */
            const shown = [];
            app.on('cursor', (/** @type {any} */ cursor)=>shown.push(cursor));
            assert.equal(await app.run({ timeoutMs: 50000 }), 0);
            const last = shown.at(-1);
            assert.ok(last?.bgra, 'a picture of its own, not the standard arrow');
            assert.deepEqual([last.width, last.height], [32, 32]);
            assert.ok(last.bgra.every((/** @type {number} */ byte, /** @type {number} */ at)=>
                at % 4 !== 3 || byte === 0), 'every pixel transparent');
        });
}
