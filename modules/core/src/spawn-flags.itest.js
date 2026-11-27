/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A child inherits each inheritable handle with its flags, wherever it runs:
 * in its parent's place or in a worker of its own, across the link. A handle
 * not inheritable is not the child's. The flags cross with the handle, as
 * Wine's server copies a handle's entry, its flags in it, into the child's
 * table.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from './app.js';
import { buildExe } from '../../../tools/fixtures/make-pe.mjs';

/** @param {number} value */
const le32 = value=>[value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24 & 0xff];
/** @param {string} text */
const cstring = text=>[...text].map(c=>c.charCodeAt(0)).concat(0);

/**
 * CreateFileA C:\App\kept.txt inheritable, then SetHandleInformation(it,
 * HANDLE_FLAG_PROTECT_FROM_CLOSE, set), and C:\App\not.txt not inheritable;
 * the two as the child's hStdInput and hStdOutput (STARTF_USESTDHANDLES);
 * CreateProcessA with bInheritHandles, a wait for the child, and its exit
 * code as this one's.
 */
function buildParent(){
    const startupSize = 68;
    return buildExe({
        imports: { 'KERNEL32.dll': ['CreateFileA', 'SetHandleInformation', 'CreateProcessA',
            'WaitForSingleObject', 'GetExitCodeProcess', 'ExitProcess'] },
        data: {
            kept: cstring('C:\\App\\kept.txt'), not: cstring('C:\\App\\not.txt'),
            child: cstring('C:\\App\\child.exe'),
            startup: [...le32(startupSize), ...new Array(startupSize - 4).fill(0)],
            info: new Array(16).fill(0), code: [0, 0, 0, 0],
            // SECURITY_ATTRIBUTES: nLength 12, no descriptor, bInheritHandle.
            inheritable: [...le32(12), ...le32(0), ...le32(1)],
        },
        codeSize: 0x100,
        code: ({ iat, at })=>{
            const call = (/** @type {string} */ name)=>[0xff, 0x15, ...le32(iat(name))];
            const push = (/** @type {number} */ value)=>[0x68, ...le32(value)];
            const pushAt = (/** @type {number} */ address)=>[0xff, 0x35, ...le32(address)];
            /** CreateFileA(path, read and write, shared, attributes, CREATE_ALWAYS) */
            const create = (/** @type {number} */ path, /** @type {number} */ attributes)=>[
                ...push(0), ...push(0x80), ...push(2), ...push(attributes), ...push(3),
                ...push(0xc0000000), ...push(path), ...call('CreateFileA')];
            const bytes = [
                // STARTF_USESTDHANDLES
                0xc7, 0x05, ...le32(at('startup') + 44), ...le32(0x100),
                ...create(at('kept'), at('inheritable')),
                0xa3, ...le32(at('startup') + 56),                           // hStdInput
                ...push(2), ...push(2), ...pushAt(at('startup') + 56),
                ...call('SetHandleInformation'),
                ...create(at('not'), 0),
                0xa3, ...le32(at('startup') + 60),                           // hStdOutput
                ...push(at('info')), ...push(at('startup')), ...push(0), ...push(0), ...push(0),
                ...push(1), ...push(0), ...push(0), ...push(at('child')), ...push(0),
                ...call('CreateProcessA'),
                ...push(0xffffffff), ...pushAt(at('info')), ...call('WaitForSingleObject'),
                ...push(at('code')), ...pushAt(at('info')), ...call('GetExitCodeProcess'),
                ...pushAt(at('code')), ...call('ExitProcess'),
            ];
            return bytes.concat(new Array(0x100 - bytes.length).fill(0xcc));
        },
    });
}

/**
 * GetHandleInformation of its standard input and output: the exit code is the
 * input's answer, its flags shifted one up, and 8 when the output's answers.
 * 7: the inheritable handle is here, inheritable and protected from close
 * still; the other is not here.
 */
function buildChild(){
    return buildExe({
        subsystem: 3,
        imports: { 'KERNEL32.dll': ['GetStdHandle', 'GetHandleInformation', 'ExitProcess'] },
        data: { input: [0, 0, 0, 0], output: [0, 0, 0, 0] },
        codeSize: 0x60,
        code: ({ iat, at })=>{
            const call = (/** @type {string} */ name)=>[0xff, 0x15, ...le32(iat(name))];
            const bytes = [
                0x6a, 0xf6, ...call('GetStdHandle'), 0x89, 0xc6,         // esi = STD_INPUT
                0x6a, 0xf5, ...call('GetStdHandle'), 0x89, 0xc7,         // edi = STD_OUTPUT
                0x68, ...le32(at('input')), 0x56, ...call('GetHandleInformation'),
                0x89, 0xc3,                                               // mov ebx, eax
                0xa1, ...le32(at('input')), 0xd1, 0xe0, 0x09, 0xc3,       // ebx |= flags << 1
                0x68, ...le32(at('output')), 0x57, ...call('GetHandleInformation'),
                0xc1, 0xe0, 0x03, 0x09, 0xc3,                             // ebx |= answer << 3
                0x53, ...call('ExitProcess'),
            ];
            return bytes.concat(new Array(0x60 - bytes.length).fill(0xcc));
        },
    });
}

for (const [where, options] of /** @type {[string, any][]} */ ([
    ['in its parent\'s place', {}],
    ['in a worker of its own', { concurrency: 2 }],
]))
{
    test(`a child ${where} holds only the inheritable handle, with the flags its parent's had`,
        { timeout: 120000 }, async t=>{
            const app = await createApp({
                executable: buildParent(),
                imagePath: 'C:\\App\\parent.exe',
                files: [{ path: 'C:\\App\\child.exe', bytes: buildChild() }],
                ...options,
            });
            t.after(()=>app.dispose());
            assert.equal(await app.run({ timeoutMs: 120_000 }), 7,
                'inheritable and protected from close there; the other not handed');
        });
}
