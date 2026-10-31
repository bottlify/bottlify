/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A named pipe between two guest processes, the way a browser hands a child
 * its end of one: the parent makes the pipe, opens the client end
 * inheritable, starts the child with bInheritHandles and the handle's number
 * on its command line; the child writes through that number, the parent
 * reads through its server end what the child wrote.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../../../app.js';
import { buildExe } from '../../../../../../tools/make-pe.mjs';

/** @param {number} value @returns {number[]} */
const u32 = value=>[
    value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff,
];
/** @param {string} text */
const cString = text=>[...text].map(c=>c.charCodeAt(0)).concat(0);
/** @param {number} size */
const zeros = size=>new Array(size).fill(0);

const CHILD = 'C:\\App\\child.exe';

/** The child: its handle from its command line, two bytes written through it. */
const child = ()=>buildExe({
    imports: {
        'KERNEL32.dll': ['GetCommandLineA', 'WriteFile', 'ExitProcess'],
        'msvcrt.dll': ['strrchr', 'atoi'],
    },
    data: { hi: cString('hi'), count: zeros(4) },
    codeSize: 0x60,
    code: ({ iat, at })=>[
        0xff, 0x15, ...u32(iat('GetCommandLineA')),
        0x6a, 0x20, //                                  push ' '
        0x50, //                                        push eax
        0xff, 0x15, ...u32(iat('strrchr')),
        0x83, 0xc4, 0x08, //                            add esp, 8
        0x50, //                                        push eax: " <handle>"
        0xff, 0x15, ...u32(iat('atoi')),
        0x83, 0xc4, 0x04, //                            add esp, 4
        0x89, 0xc6, //                                  mov esi, eax
        0x6a, 0x00, //                                  push 0: no OVERLAPPED
        0x68, ...u32(at('count')),
        0x6a, 0x02, //                                  push 2
        0x68, ...u32(at('hi')),
        0x56, //                                        push esi: the inherited end
        0xff, 0x15, ...u32(iat('WriteFile')),
        0x50, //                                        push eax: TRUE when written
        0xff, 0x15, ...u32(iat('ExitProcess')),
    ],
});

/** The parent: the pipe, the inheritable client end, the child, then the read. */
const parent = ()=>buildExe({
    imports: {
        'KERNEL32.dll': ['CreateNamedPipeA', 'CreateFileA', 'CreateProcessA',
            'WaitForSingleObject', 'ReadFile', 'ExitProcess'],
        'USER32.dll': ['wsprintfA'],
    },
    data: {
        name: cString('\\\\.\\pipe\\bottlify_inherit'),
        format: cString(`${CHILD} %d`),
        // SECURITY_ATTRIBUTES: nLength, lpSecurityDescriptor, bInheritHandle.
        sa: [...u32(12), ...u32(0), ...u32(1)],
        si: [...u32(68), ...zeros(64)],
        pi: zeros(16),
        line: zeros(64),
        buffer: zeros(16),
        count: zeros(4),
    },
    codeSize: 0xc0,
    code: ({ iat, at })=>[
        // server = CreateNamedPipeA(name, PIPE_ACCESS_DUPLEX, 0, 1, 0, 0, 0, NULL)
        0x6a, 0x00, 0x6a, 0x00, 0x6a, 0x00, 0x6a, 0x00, 0x6a, 0x01, 0x6a, 0x00, 0x6a, 0x03,
        0x68, ...u32(at('name')),
        0xff, 0x15, ...u32(iat('CreateNamedPipeA')),
        0x89, 0xc6, //                                  mov esi, eax
        // client = CreateFileA(name, GENERIC_READ | GENERIC_WRITE, 0, &sa, OPEN_EXISTING, 0, 0)
        0x6a, 0x00, 0x6a, 0x00, 0x6a, 0x03,
        0x68, ...u32(at('sa')),
        0x6a, 0x00,
        0x68, ...u32(0xc0000000),
        0x68, ...u32(at('name')),
        0xff, 0x15, ...u32(iat('CreateFileA')),
        0x89, 0xc7, //                                  mov edi, eax
        // wsprintfA(line, format, client)
        0x57,
        0x68, ...u32(at('format')),
        0x68, ...u32(at('line')),
        0xff, 0x15, ...u32(iat('wsprintfA')),
        0x83, 0xc4, 0x0c, //                            add esp, 12
        // CreateProcessA(NULL, line, NULL, NULL, TRUE, 0, NULL, NULL, &si, &pi)
        0x68, ...u32(at('pi')),
        0x68, ...u32(at('si')),
        0x6a, 0x00, 0x6a, 0x00, 0x6a, 0x00, 0x6a, 0x01, 0x6a, 0x00, 0x6a, 0x00,
        0x68, ...u32(at('line')),
        0x6a, 0x00,
        0xff, 0x15, ...u32(iat('CreateProcessA')),
        // WaitForSingleObject(pi.hProcess, INFINITE)
        0x6a, 0xff,
        0xff, 0x35, ...u32(at('pi')),
        0xff, 0x15, ...u32(iat('WaitForSingleObject')),
        // ReadFile(server, buffer, 16, &count, NULL)
        0x6a, 0x00,
        0x68, ...u32(at('count')),
        0x6a, 0x10,
        0x68, ...u32(at('buffer')),
        0x56,
        0xff, 0x15, ...u32(iat('ReadFile')),
        // exit (count << 8) | buffer[0], or 0 when the read failed
        0x85, 0xc0, //                                  test eax, eax
        0x74, 0x11, //                                  jz +17: past the arithmetic
        0xa1, ...u32(at('count')), //                   mov eax, [count]
        0xc1, 0xe0, 0x08, //                            shl eax, 8
        0x0f, 0xb6, 0x0d, ...u32(at('buffer')), //      movzx ecx, byte [buffer]
        0x09, 0xc8, //                                  or eax, ecx
        0x50,
        0xff, 0x15, ...u32(iat('ExitProcess')),
    ],
});

test('a child writes through the pipe end it inherited, and its parent reads it',
    { timeout: 120000 }, async t=>{
        const app = await createApp({
            executable: parent(),
            imagePath: 'C:\\App\\parent.exe',
            files: [{ path: CHILD, bytes: child() }],
        });
        t.after(()=>app.dispose());
        /** @type {number[]} */
        const children = [];
        app.on('process-resumed', (/** @type {any} */ event)=>children.push(event.code));
        const code = await app.run({ timeoutMs: 60000 });
        assert.deepEqual(children, [1], 'the child\'s WriteFile through its inherited end');
        assert.equal(code, (2 << 8) | 'h'.charCodeAt(0), 'two bytes, "hi", read by the parent');
    });
