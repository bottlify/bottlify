/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * One object, every spelling of its name: an event kernel32 makes as
 * `Global\Meet` is the one ntdll opens as `\BaseNamedObjects\Meet` and
 * kernel32 opens again as `Local\Meet`, as on Windows, where kernel32's
 * names are paths below the session's BaseNamedObjects and Global\ and
 * Local\ are its links (decisions.md A271).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../../../app.js';
import { assemble, buildExe } from '../../../../../../tools/fixtures/make-pe.mjs';

/** @param {number} value */
const u32 = value=>[0, 8, 16, 24].map(at=>(value >>> at) & 0xff);
/** @param {string} text */
const ansi = text=>[...text].map(c=>c.charCodeAt(0)).concat(0);
/** @param {string} text */
const wide = text=>[...text].flatMap(c=>[c.charCodeAt(0), 0]).concat(0, 0);

const EVENT_ALL_ACCESS = 0x1f0003;
const NATIVE = '\\BaseNamedObjects\\Meet';
/** The exit code when OpenEventA found nothing. */
const NOT_FOUND = 0xbad;

/**
 * CreateEventA("Global\Meet"), NtOpenEvent(\BaseNamedObjects\Meet), SetEvent
 * through the first, a wait through the second, then OpenEventA("Local\Meet")
 * and a wait through it: 0 when all three are one signalled event, the first
 * status or wait result that is not otherwise.
 */
const program = buildExe({
    imports: {
        'KERNEL32.dll': ['CreateEventA', 'SetEvent', 'WaitForSingleObject', 'OpenEventA',
            'ExitProcess'],
        'ntdll.dll': ['NtOpenEvent'],
    },
    data: {
        global: ansi('Global\\Meet'), local: ansi('Local\\Meet'), native: wide(NATIVE),
        // UNICODE_STRING: Length, MaximumLength, Buffer (written by the code).
        string: [...u32(NATIVE.length * 2 | (NATIVE.length * 2 + 2) << 16), ...u32(0)],
        // OBJECT_ATTRIBUTES: Length, RootDirectory, ObjectName (written), Attributes, SD, QoS.
        attributes: [...u32(24), ...u32(0), ...u32(0), ...u32(0), ...u32(0), ...u32(0)],
        first: u32(0), second: u32(0),
    },
    codeSize: 0xa0,
    code: ({ iat, at })=>assemble([
        0x68, ...u32(at('global')), 0x6a, 0, 0x6a, 1, 0x6a, 0,
        0xff, 0x15, ...u32(iat('CreateEventA')),
        0xa3, ...u32(at('first')),
        0xc7, 0x05, ...u32(at('string') + 4), ...u32(at('native')),
        0xc7, 0x05, ...u32(at('attributes') + 8), ...u32(at('string')),
        0x68, ...u32(at('attributes')), 0x68, ...u32(EVENT_ALL_ACCESS), 0x68, ...u32(at('second')),
        0xff, 0x15, ...u32(iat('NtOpenEvent')),
        0x85, 0xc0, { jump: 'jnz', to: 'out' },
        0xff, 0x35, ...u32(at('first')), 0xff, 0x15, ...u32(iat('SetEvent')),
        0x6a, 0, 0xff, 0x35, ...u32(at('second')), 0xff, 0x15, ...u32(iat('WaitForSingleObject')),
        0x85, 0xc0, { jump: 'jnz', to: 'out' },
        0x68, ...u32(at('local')), 0x6a, 0, 0x68, ...u32(EVENT_ALL_ACCESS),
        0xff, 0x15, ...u32(iat('OpenEventA')),
        0xb9, ...u32(NOT_FOUND), 0x85, 0xc0, 0x0f, 0x44, 0xc1, // mov ecx, NOT_FOUND; cmovz eax, ecx
        { jump: 'jz', to: 'out' },
        0x6a, 0, 0x50, 0xff, 0x15, ...u32(iat('WaitForSingleObject')),
        { label: 'out' },
        0x50, 0xff, 0x15, ...u32(iat('ExitProcess')),
    ]),
});

test('an event kernel32 makes as Global\\X is the one ntdll opens by its path and kernel32'
    + ' opens as Local\\X', { timeout: 60_000 }, async()=>{
    const app = await createApp({ executable: program, imagePath: 'C:\\names.exe' });
    try
    {
        assert.equal(await app.run({ timeoutMs: 30_000 }), 0);
    }
    finally
    {
        await app.dispose();
    }
});
