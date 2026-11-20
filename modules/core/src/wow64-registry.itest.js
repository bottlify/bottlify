/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * WOW64's registry redirection as a 32-bit program on a 64-bit Windows meets
 * it (`wow64-registry.js`): a key it makes under HKLM\SOFTWARE is under
 * Wow6432Node; asked for with KEY_WOW64_64KEY it is where it is named. On a
 * 32-bit Windows there is one view.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from './app.js';
import { buildExe } from '../../../tools/fixtures/make-pe.mjs';
import { HKEY_LOCAL_MACHINE } from './layers/win32/advapi32/registry.js';

/** @param {number} value */
const u32 = value=>[0, 8, 16, 24].map(at=>(value >>> at) & 0xff);
/** @param {string} text */
const ansi = text=>[...Buffer.from(`${text}\0`, 'latin1')];

const KEY_ALL_ACCESS = 0xf003f;
const KEY_WOW64_64KEY = 0x100;

/** Makes SOFTWARE\Bottlify\Plain with no view named and ...\Native with the 64-bit one. */
function program(){
    return buildExe({
        imports: { 'ADVAPI32.dll': ['RegCreateKeyExA', 'RegCloseKey'],
            'KERNEL32.dll': ['ExitProcess'] },
        data: { plain: ansi('SOFTWARE\\Bottlify\\Plain'),
            native: ansi('SOFTWARE\\Bottlify\\Native'),
            key: [0, 0, 0, 0] },
        codeSize: 0x80,
        code: ({ iat, at })=>{
            /** @param {string} name @param {number} sam */
            const create = (name, sam)=>[
                0x6a, 0x00,                                      // lpdwDisposition
                0x68, ...u32(at('key')),                         // phkResult
                0x6a, 0x00,                                      // lpSecurityAttributes
                0x68, ...u32(sam),                               // samDesired
                0x6a, 0x00, 0x6a, 0x00, 0x6a, 0x00,              // options, class, reserved
                0x68, ...u32(at(name)),
                0x68, ...u32(HKEY_LOCAL_MACHINE),
                0xff, 0x15, ...u32(iat('RegCreateKeyExA')),
                0xff, 0x35, ...u32(at('key')), 0xff, 0x15, ...u32(iat('RegCloseKey')),
            ];
            return [...create('plain', KEY_ALL_ACCESS),
                ...create('native', KEY_ALL_ACCESS | KEY_WOW64_64KEY),
                0x6a, 0x00, 0xff, 0x15, ...u32(iat('ExitProcess'))];
        },
    });
}

/** @param {any} app @param {string} path */
const has = (app, path)=>{
    const hive = app.registry();
    return hive.open(hive.root(HKEY_LOCAL_MACHINE), path) !== null;
};

test('a 32-bit program on a 64-bit Windows makes its HKLM\\SOFTWARE keys under Wow6432Node,'
    + ' and with KEY_WOW64_64KEY where it names them', { timeout: 60000 }, async t=>{
    const app = await createApp({ executable: program(), machine: 'amd64' });
    t.after(()=>app.dispose());
    assert.equal(await app.run({ timeoutMs: 50000 }), 0);
    assert.ok(has(app, 'SOFTWARE\\Wow6432Node\\Bottlify\\Plain'));
    assert.ok(!has(app, 'SOFTWARE\\Bottlify\\Plain'));
    assert.ok(has(app, 'SOFTWARE\\Bottlify\\Native'));
    assert.ok(!has(app, 'SOFTWARE\\Wow6432Node\\Bottlify\\Native'));
});

test('a 32-bit program on a 32-bit Windows has one view', { timeout: 60000 }, async t=>{
    const app = await createApp({ executable: program() });
    t.after(()=>app.dispose());
    assert.equal(await app.run({ timeoutMs: 50000 }), 0);
    assert.ok(has(app, 'SOFTWARE\\Bottlify\\Plain'));
    assert.ok(has(app, 'SOFTWARE\\Bottlify\\Native'), 'the flag names no other view there');
    assert.ok(!has(app, 'SOFTWARE\\Wow6432Node'));
});
