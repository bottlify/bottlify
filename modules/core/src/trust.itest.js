/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The root store a program's WinVerifyTrust judges against is the one
 * `createApp` was given as `win32.trustedRoots`: a program that verifies a
 * cabinet signed by a chain of this test's own is told it is trusted when the
 * test's root was configured, and CERT_E_CHAINING under the default store,
 * which holds only Microsoft's root. The program exits with the answer.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from './app.js';
import { buildExe } from '../../../tools/make-pe.mjs';
import { certificates, signedCabinet } from './layers/win32/wintrust/fixtures.test.js';

const CERT_E_CHAINING = 0x800b010a;

/** @param {number} value @returns {number[]} */
const u32 = value=>[
    value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff,
];

/** @param {string} text */
const wide = text=>[...text, '\0'].flatMap(c=>[c.charCodeAt(0), 0]);

/**
 * WinVerifyTrust(INVALID_HANDLE_VALUE, WINTRUST_ACTION_GENERIC_VERIFY_V2, the
 * cabinet), then its answer as the exit code.
 */
function buildProgram(){
    const WTD_UI_NONE = 2;
    const WTD_CHOICE_FILE = 1;
    return buildExe({
        imports: { 'WINTRUST.dll': ['WinVerifyTrust'], 'KERNEL32.dll': ['ExitProcess'] },
        data: {
            // {00AAC56B-CD44-11D0-8CC2-00C04FC295EE}
            action: [0x6b, 0xc5, 0xaa, 0x00, 0x44, 0xcd, 0xd0, 0x11,
                0x8c, 0xc2, 0x00, 0xc0, 0x4f, 0xc2, 0x95, 0xee],
            path: wide('C:\\App\\signed.cab'),
            file: [...u32(16), ...u32(0), ...u32(0), ...u32(0)],
            data: [...u32(48), ...u32(0), ...u32(0), ...u32(WTD_UI_NONE), ...u32(0),
                ...u32(WTD_CHOICE_FILE), ...new Array(24).fill(0)],
        },
        code: ({ iat, at })=>[
            0xc7, 0x05, ...u32(at('file') + 4), ...u32(at('path')), // mov [file + 4], path
            0xc7, 0x05, ...u32(at('data') + 24), ...u32(at('file')), // mov [data.pFile], file
            0x68, ...u32(at('data')), //                               push data
            0x68, ...u32(at('action')), //                             push action
            0x6a, 0xff, //                                             push INVALID_HANDLE_VALUE
            0xff, 0x15, ...u32(iat('WinVerifyTrust')), //              call [WinVerifyTrust]
            0x50, //                                                   push eax
            0xff, 0x15, ...u32(iat('ExitProcess')), //                 call [ExitProcess]
        ],
    });
}

/** @param {{ win32?: { trustedRoots?: (Uint8Array | string)[] } }} options */
async function verified(options){
    const app = await createApp({
        executable: buildProgram(),
        imagePath: 'C:\\App\\Trust.exe',
        files: [{ path: 'C:\\App\\signed.cab', bytes: signedCabinet() }],
        ...options,
    });
    try
    {
        return (await app.run({ timeoutMs: 40000 })) >>> 0;
    }
    finally
    {
        await app.dispose();
    }
}

test('the roots createApp is given are the ones WinVerifyTrust trusts', { timeout: 120000 },
    async()=>{
        const { root } = certificates();
        assert.equal(await verified({ win32: { trustedRoots: [root] } }), 0);
        assert.equal(await verified({}), CERT_E_CHAINING,
            'the default store holds only Microsoft\'s');
    });
