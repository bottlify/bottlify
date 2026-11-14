/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A handle made inheritable is the child's under the same number when the
 * child is started with bInheritHandles, as on Windows: a parent makes an
 * event with SECURITY_ATTRIBUTES.bInheritHandle set, names its number on the
 * child's command line, and the child signals it (an NGen worker so tells
 * ngen it has started). One not inheritable is not the child's.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../../../app.js';
import { assemble, buildExe } from '../../../../../../tools/fixtures/make-pe.mjs';

/** @param {number} value */
const u32 = value=>[0, 8, 16, 24].map(at=>(value >>> at) & 0xff);
/** @param {string} text */
const ansi = text=>[...text].map(c=>c.charCodeAt(0)).concat(0);

/**
 * CreateEventA(&sa, TRUE, FALSE, NULL), its number into the child's command
 * line, CreateProcessA(..., bInheritHandles = TRUE, ...), a wait for the
 * child, then WaitForSingleObject(event, 0): the exit code, 0 when the child
 * signalled it.
 *
 * @param {boolean} inheritable
 */
const parent = inheritable=>buildExe({
    imports: { 'KERNEL32.dll': ['CreateEventA', 'CreateProcessA', 'WaitForSingleObject',
        'ExitProcess'], 'USER32.dll': ['wsprintfA'] },
    data: {
        attributes: [...u32(12), ...u32(0), ...u32(inheritable ? 1 : 0)],
        format: ansi('C:\\child.exe %u'),
        command: new Array(64).fill(0),
        startup: [...u32(68), ...new Array(64).fill(0)],
        info: new Array(16).fill(0),
        event: u32(0),
    },
    codeSize: 0xa0,
    code: ({ iat, at })=>assemble([
        0x6a, 0, 0x6a, 0, 0x6a, 1, 0x68, ...u32(at('attributes')),
        0xff, 0x15, ...u32(iat('CreateEventA')),
        0xa3, ...u32(at('event')), //                  mov [event], eax
        0x50, 0x68, ...u32(at('format')), 0x68, ...u32(at('command')),
        0xff, 0x15, ...u32(iat('wsprintfA')),
        0x83, 0xc4, 0x0c, //                           add esp, 12
        0x68, ...u32(at('info')), 0x68, ...u32(at('startup')),
        0x6a, 0, 0x6a, 0, 0x6a, 0, 0x6a, 1, 0x6a, 0, 0x6a, 0,
        0x68, ...u32(at('command')), 0x6a, 0,
        0xff, 0x15, ...u32(iat('CreateProcessA')),
        0x6a, 0xff, 0xff, 0x35, ...u32(at('info')),
        0xff, 0x15, ...u32(iat('WaitForSingleObject')),
        0x6a, 0, 0xff, 0x35, ...u32(at('event')),
        0xff, 0x15, ...u32(iat('WaitForSingleObject')),
        0x50, 0xff, 0x15, ...u32(iat('ExitProcess')),
    ]),
});

/** SetEvent(the number its command line ends with), then ExitProcess(0). */
const child = buildExe({
    imports: { 'KERNEL32.dll': ['GetCommandLineA', 'SetEvent', 'ExitProcess'],
        'msvcrt.dll': ['atoi'] },
    codeSize: 0x60,
    code: ({ iat })=>assemble([
        0xff, 0x15, ...u32(iat('GetCommandLineA')),
        0x89, 0xc6, //                                 mov esi, eax
        { label: 'end' },
        0x80, 0x3e, 0x00, { jump: 'jz', to: 'back' }, // cmp byte [esi], 0
        0x46, { jump: 'jmp', to: 'end' }, //           inc esi
        { label: 'back' },
        0x4e, 0x80, 0x3e, 0x20, { jump: 'jnz', to: 'back' }, // dec esi; cmp byte [esi], ' '
        0x46, 0x56, 0xff, 0x15, ...u32(iat('atoi')), // inc esi; push esi; call atoi
        0x83, 0xc4, 0x04,
        0x50, 0xff, 0x15, ...u32(iat('SetEvent')),
        0x6a, 0, 0xff, 0x15, ...u32(iat('ExitProcess')),
    ]),
});

/** @param {boolean} inheritable */
async function run(inheritable){
    const executable = parent(inheritable);
    const app = await createApp({ executable, imagePath: 'C:\\parent.exe',
        files: [{ path: 'C:\\child.exe', bytes: child }] });
    try
    {
        return (await app.run({ timeoutMs: 60_000 })) >>> 0;
    }
    finally
    {
        await app.dispose();
    }
}

test('an inheritable event is the child\'s under its number, and signalled there',
    { timeout: 120_000 }, async()=>{
        assert.equal(await run(true), 0, 'WAIT_OBJECT_0: the child set it');
        assert.equal(await run(false), 0x102, 'WAIT_TIMEOUT: not the child\'s to set');
    });
