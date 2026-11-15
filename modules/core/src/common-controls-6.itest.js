/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * One program with Common Controls 6 in its manifest and without: the
 * comctl32 it imports answers version 6 or 5.82, and a window of SysLink,
 * a class only version 6 registers, is made or refused (decisions.md A257).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from './app.js';
import { buildExe } from '../../../tools/fixtures/make-pe.mjs';

/** @param {number} value */
const u32 = value=>[value & 255, value >>> 8 & 255, value >>> 16 & 255, value >>> 24 & 255];

const MANIFEST = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">'
    + '<dependency><dependentAssembly><assemblyIdentity type="win32" '
    + 'name="Microsoft.Windows.Common-Controls" version="6.0.0.0" processorArchitecture="x86" '
    + 'publicKeyToken="6595b64144ccf1df" language="*"/></dependentAssembly></dependency>'
    + '</assembly>';

/**
 * Exits with DllGetVersion's major version times 16, plus 1 when a SysLink
 * window was made.
 *
 * @param {{ id: number, text: string }} [manifest]
 */
const program = manifest=>buildExe({
    codeSize: 0x80,
    ...manifest ? { manifest } : {},
    imports: { 'COMCTL32.dll': ['DllGetVersion'], 'USER32.dll': ['CreateWindowExA'],
        'KERNEL32.dll': ['ExitProcess'] },
    data: { info: [...u32(20), ...new Array(16).fill(0)],
        link: [...'SysLink'].map(unit=>unit.charCodeAt(0)).concat(0) },
    code: ({ iat, at })=>[
        0x68, ...u32(at('info')), //                  push info
        0xff, 0x15, ...u32(iat('DllGetVersion')), //  call DllGetVersion
        ...new Array(9).fill([0x6a, 0x00]).flat(), // lpParam .. dwStyle, lpWindowName: 0
        0x68, ...u32(at('link')), //                  push "SysLink"
        0x6a, 0x00, //                                push 0 (dwExStyle)
        0xff, 0x15, ...u32(iat('CreateWindowExA')),
        0xf7, 0xd8, 0x19, 0xc0, 0xf7, 0xd8, //        eax = hwnd != 0
        0x8b, 0x0d, ...u32(at('info') + 4), //        mov ecx, [info.dwMajorVersion]
        0xc1, 0xe1, 0x04, 0x09, 0xc8, //              shl ecx, 4 / or eax, ecx
        0x50, 0xff, 0x15, ...u32(iat('ExitProcess')),
    ],
});

test('a program with Common Controls 6 in its manifest gets version 6, and SysLink',
    { timeout: 60_000 }, async t=>{
        const app = await createApp({ executable: program({ id: 1, text: MANIFEST }) });
        t.after(()=>app.dispose());
        assert.equal(await app.run({ timeoutMs: 30_000 }), 6 * 16 + 1);
    });

test('the same program without it gets the 5.82 library, and no SysLink',
    { timeout: 60_000 }, async t=>{
        const app = await createApp({ executable: program() });
        t.after(()=>app.dispose());
        assert.equal(await app.run({ timeoutMs: 30_000 }), 5 * 16);
    });
