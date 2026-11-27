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

/**
 * CreateFileA(C:\out.txt, read and write, no sharing, inheritable), "AB"
 * written, its number into the child's command line, CreateProcessA with
 * bInheritHandles and CREATE_SUSPENDED, CloseHandle, an open of its own that
 * the child's handle must refuse (16), the child resumed and waited for, then
 * the file read back: the exit code is the child's, with 8 when the file holds
 * "ABCD" and 16 when the open was refused.
 */
const fileParent = buildExe({
    imports: { 'KERNEL32.dll': ['CreateFileA', 'WriteFile', 'ReadFile', 'CloseHandle',
        'CreateProcessA', 'ResumeThread', 'WaitForSingleObject', 'GetExitCodeProcess',
        'ExitProcess'],
    'USER32.dll': ['wsprintfA'] },
    data: {
        attributes: [...u32(12), ...u32(0), ...u32(1)],
        path: ansi('C:\\out.txt'),
        ab: ansi('AB'),
        format: ansi('C:\\child.exe %u'),
        command: new Array(64).fill(0),
        startup: [...u32(68), ...new Array(64).fill(0)],
        info: new Array(16).fill(0),
        file: u32(0),
        count: u32(0),
        code: u32(0),
        buffer: u32(0),
    },
    codeSize: 0x160,
    code: ({ iat, at })=>assemble([
        0x6a, 0, 0x6a, 0, 0x6a, 2, 0x68, ...u32(at('attributes')), 0x6a, 0,
        0x68, ...u32(0xc0000000), 0x68, ...u32(at('path')),
        0xff, 0x15, ...u32(iat('CreateFileA')),
        0xa3, ...u32(at('file')), //                   mov [file], eax
        0x6a, 0, 0x68, ...u32(at('count')), 0x6a, 2, 0x68, ...u32(at('ab')), 0x50,
        0xff, 0x15, ...u32(iat('WriteFile')),
        0xff, 0x35, ...u32(at('file')), 0x68, ...u32(at('format')),
        0x68, ...u32(at('command')),
        0xff, 0x15, ...u32(iat('wsprintfA')),
        0x83, 0xc4, 0x0c, //                           add esp, 12
        0x68, ...u32(at('info')), 0x68, ...u32(at('startup')),
        0x6a, 0, 0x6a, 0, 0x6a, 4, 0x6a, 1, 0x6a, 0, 0x6a, 0,
        0x68, ...u32(at('command')), 0x6a, 0,
        0xff, 0x15, ...u32(iat('CreateProcessA')),
        0xff, 0x35, ...u32(at('file')), 0xff, 0x15, ...u32(iat('CloseHandle')),
        0x31, 0xff, //                                 xor edi, edi
        0x6a, 0, 0x6a, 0, 0x6a, 3, 0x6a, 0, 0x6a, 0,
        0x68, ...u32(0x80000000), 0x68, ...u32(at('path')),
        0xff, 0x15, ...u32(iat('CreateFileA')),
        0x83, 0xf8, 0xff, { jump: 'jnz', to: 'opened' }, // cmp eax, -1
        0xbf, ...u32(16), //                           mov edi, 16
        { label: 'opened' },
        0xff, 0x35, ...u32(at('info') + 4), 0xff, 0x15, ...u32(iat('ResumeThread')),
        0x6a, 0xff, 0xff, 0x35, ...u32(at('info')),
        0xff, 0x15, ...u32(iat('WaitForSingleObject')),
        0x68, ...u32(at('code')), 0xff, 0x35, ...u32(at('info')),
        0xff, 0x15, ...u32(iat('GetExitCodeProcess')),
        0x6a, 0, 0x6a, 0, 0x6a, 3, 0x6a, 0, 0x6a, 0,
        0x68, ...u32(0x80000000), 0x68, ...u32(at('path')),
        0xff, 0x15, ...u32(iat('CreateFileA')),
        0x6a, 0, 0x68, ...u32(at('count')), 0x6a, 4, 0x68, ...u32(at('buffer')), 0x50,
        0xff, 0x15, ...u32(iat('ReadFile')),
        0xa1, ...u32(at('code')), //                   mov eax, [code]
        0x09, 0xf8, //                                 or eax, edi
        0x81, 0x3d, ...u32(at('buffer')), ...u32(0x44434241), // cmp [buffer], "ABCD"
        { jump: 'jnz', to: 'done' },
        0x83, 0xc8, 0x08, //                           or eax, 8
        { label: 'done' },
        0x50, 0xff, 0x15, ...u32(iat('ExitProcess')),
    ]),
});

/**
 * The child, with the number its command line ends with: "CD" written through
 * it (1), and C:\out.txt opened once that handle, the file's last, is closed (4).
 */
const fileChild = buildExe({
    imports: { 'KERNEL32.dll': ['GetCommandLineA', 'WriteFile', 'CreateFileA', 'CloseHandle',
        'ExitProcess'], 'msvcrt.dll': ['atoi'] },
    data: { path: ansi('C:\\out.txt'), cd: ansi('CD'), count: u32(0) },
    codeSize: 0x100,
    code: ({ iat, at })=>{
        const open = [0x6a, 0, 0x6a, 0, 0x6a, 3, 0x6a, 0, 0x6a, 0,
            0x68, ...u32(0x80000000), 0x68, ...u32(at('path')),
            0xff, 0x15, ...u32(iat('CreateFileA'))];
        return assemble([
            0xff, 0x15, ...u32(iat('GetCommandLineA')),
            0x89, 0xc6, //                             mov esi, eax
            { label: 'end' },
            0x80, 0x3e, 0x00, { jump: 'jz', to: 'back' },
            0x46, { jump: 'jmp', to: 'end' },
            { label: 'back' },
            0x4e, 0x80, 0x3e, 0x20, { jump: 'jnz', to: 'back' },
            0x46, 0x56, 0xff, 0x15, ...u32(iat('atoi')),
            0x83, 0xc4, 0x04,
            0x89, 0xc3, //                             mov ebx, eax
            0x31, 0xff, //                             xor edi, edi
            0x6a, 0, 0x68, ...u32(at('count')), 0x6a, 2, 0x68, ...u32(at('cd')), 0x53,
            0xff, 0x15, ...u32(iat('WriteFile')),
            0x85, 0xc0, { jump: 'jz', to: 'wrote' },
            0x83, 0xcf, 0x01, //                       or edi, 1
            { label: 'wrote' },
            0x53, 0xff, 0x15, ...u32(iat('CloseHandle')),
            ...open,
            0x83, 0xf8, 0xff, { jump: 'jz', to: 'out' },
            0x50, 0xff, 0x15, ...u32(iat('CloseHandle')),
            0x83, 0xcf, 0x04, //                       or edi, 4
            { label: 'out' },
            0x57, 0xff, 0x15, ...u32(iat('ExitProcess')),
        ]);
    },
});

test('an inheritable file is the child\'s under its number: one position, one hold, gone with'
    + ' the last handle', { timeout: 120_000 }, async()=>{
    const app = await createApp({ executable: fileParent, imagePath: 'C:\\parent.exe',
        files: [{ path: 'C:\\child.exe', bytes: fileChild }] });
    try
    {
        // 1: the child wrote at the parent's position; 4: the file opened after
        // the child closed its handle; 8: "ABCD"; 16: the parent's own open
        // refused once its handle was closed, the child's holding the file.
        assert.equal((await app.run({ timeoutMs: 60_000 })) >>> 0, 29);
    }
    finally
    {
        await app.dispose();
    }
});
