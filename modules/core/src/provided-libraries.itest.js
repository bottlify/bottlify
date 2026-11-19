/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Libraries a program imports that its setup need not have put in the bottle,
 * answered by the engine: Visual C++ 2008's runtime (MSVCR90, MSVCP90), as on
 * a Windows the redistributable was installed on, and the ones Windows ships -
 * the OLE dialogs (OLEDLG), which every MFC program imports. A program
 * importing them loads, and its calls are answered through the import.
 *
 * Each program exits with what its checks found: 0, or the number of the
 * first that failed, unless said otherwise.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from './app.js';
import { buildExe } from '../../../tools/fixtures/make-pe.mjs';

/** @param {number} value */
const u32 = value=>[value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24 & 0xff];

const STRING = '?$basic_string@DU?$char_traits@D@std@@V?$allocator@D@2@@std@@';

/** @param {Uint8Array} executable */
async function exitCodeOf(executable){
    const app = await createApp({ executable });
    try
    {
        return await app.run({ maxTurns: 200000, timeoutMs: 600000 });
    }
    finally
    {
        await app.dispose();
    }
}

/**
 * strlen through MSVCR90, then a std::string made from text through MSVCP90's
 * constructor and its text read back through c_str and measured again.
 */
function buildVc90Exe(){
    const ctor = `??0${STRING}QAE@PBD@Z`;
    const text = `?c_str@${STRING}QBEPBDXZ`;
    const dtor = `??1${STRING}QAE@XZ`;
    return buildExe({
        imports: { 'MSVCR90.dll': ['strlen'], 'MSVCP90.dll': [ctor, text, dtor],
            'KERNEL32.dll': ['ExitProcess'] },
        data: { hello: [...new TextEncoder().encode('hello'), 0], string: new Array(32).fill(0) },
        codeSize: 0x100,
        code: ({ iat, at })=>[
            0x68, ...u32(at('hello')), 0xff, 0x15, ...u32(iat('strlen')), 0x83, 0xc4, 0x04,
            0x83, 0xf8, 0x05, 0x75, 0x3d,                         // cmp eax, 5; jne fail1
            0x68, ...u32(at('hello')), 0xb9, ...u32(at('string')), // push text; mov ecx, string
            0xff, 0x15, ...u32(iat(ctor)),
            0xb9, ...u32(at('string')), 0xff, 0x15, ...u32(iat(text)),
            0x50, 0xff, 0x15, ...u32(iat('strlen')), 0x83, 0xc4, 0x04,
            0x83, 0xf8, 0x05, 0x75, 0x1b,                         // cmp eax, 5; jne fail2
            0xb9, ...u32(at('string')), 0xff, 0x15, ...u32(iat(dtor)),
            0x6a, 0x00, 0xff, 0x15, ...u32(iat('ExitProcess')),
            0x6a, 0x01, 0xff, 0x15, ...u32(iat('ExitProcess')),   // fail1
            0x6a, 0x02, 0xff, 0x15, ...u32(iat('ExitProcess')),   // fail2
        ],
    });
}

test('a program importing Visual C++ 2008\'s runtime, no copy in the bottle, runs on the engine\'s',
    async()=>{
        assert.equal(await exitCodeOf(buildVc90Exe()), 0);
    });

/**
 * OleUIBusyA through the import, by number as MFC imports it: a structure of
 * the size it must have is answered Cancel, the dialog not being shown.
 */
function buildOledlgExe(){
    return buildExe({
        imports: { 'OLEDLG.dll': ['OleUIBusyA'], 'KERNEL32.dll': ['ExitProcess'] },
        data: { busy: [...u32(44), ...new Array(40).fill(0)] },
        codeSize: 0x40,
        code: ({ iat, at })=>[
            0x68, ...u32(at('busy')), 0xff, 0x15, ...u32(iat('OleUIBusyA')),
            0x50, 0xff, 0x15, ...u32(iat('ExitProcess')),
        ],
    });
}

test('a program importing the OLE dialogs runs, a dialog answered Cancel (2)', async()=>{
    assert.equal(await exitCodeOf(buildOledlgExe()), 2);
});
