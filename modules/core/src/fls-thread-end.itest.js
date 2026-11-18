/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A thread that returns with a fibre-local value its index has a callback for
 * has the callback called on it with that value, before the thread is gone, as
 * a C runtime frees a thread's data that way. The thread's own call has
 * returned by then: the callback was once called as if it were still answering
 * one, and the bridge refused it ("a guest callback must know where the
 * thread's stack is"), which stopped an XNA title as its first worker ended.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from './app.js';
import { buildExe } from '../../../tools/fixtures/make-pe.mjs';

/** @param {number} value @returns {number[]} */
const u32 = value=>[
    value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff,
];

/** What the thread sets, and what the program exits with once called back. */
const VALUE = 0x2a;

function buildProgram(){
    return buildExe({
        imports: {
            'KERNEL32.dll': ['FlsAlloc', 'FlsSetValue', 'CreateThread',
                'ExitProcess'],
        },
        codeSize: 0x100,
        code: ({ iat, code })=>{
            /** @param {string} fn */
            const call = fn=>[0xff, 0x15, ...u32(iat(fn))];
            /** @param {{ thread: number, callback: number, index: number, seen: number }} at */
            const main = at=>[
                0x68, ...u32(at.callback), ...call('FlsAlloc'), //   push callback; FlsAlloc
                0xa3, ...u32(at.index), //                             mov [index], eax
                0x6a, 0x00, 0x6a, 0x00, 0x6a, 0x00, //                 id, flags, parameter
                0x68, ...u32(at.thread), 0x6a, 0x00, 0x6a, 0x00, //    start, stack, attributes
                ...call('CreateThread'),
                // Running, not waiting, as the thread ends: the bridge then has
                // this thread's call in hand, not the one that ended.
                0x83, 0x3d, ...u32(at.seen), 0x00, //                  spin: cmp dword [seen], 0
                0x74, 0xf7, //                                         je spin
                0xff, 0x35, ...u32(at.seen), ...call('ExitProcess'), // push [seen]; ExitProcess
            ];
            /** @param {{ index: number }} at */
            const thread = at=>[
                0x6a, VALUE, 0xff, 0x35, ...u32(at.index), //          push VALUE; push [index]
                ...call('FlsSetValue'),
                0x31, 0xc0, 0xc2, 0x04, 0x00, //                       xor eax, eax; ret 4
            ];
            /** @param {{ seen: number }} at */
            const callback = at=>[
                0x8b, 0x44, 0x24, 0x04, //                             mov eax, [esp+4]
                0xa3, ...u32(at.seen), //                              mov [seen], eax
                0xc2, 0x04, 0x00, //                                   ret 4
            ];
            const zero = { thread: 0, callback: 0, index: 0, seen: 0 };
            const threadAt = main(zero).length;
            const callbackAt = threadAt + thread(zero).length;
            const indexAt = callbackAt + callback(zero).length;
            const at = { thread: code(threadAt), callback: code(callbackAt),
                index: code(indexAt), seen: code(indexAt + 4) };
            return [...main(at), ...thread(at), ...callback(at), ...u32(0), ...u32(0)];
        },
    });
}

test('a thread\'s fibre-local value is called back on it when it returns', { timeout: 60000 },
    async t=>{
        const app = await createApp({ executable: buildProgram(), imagePath: 'C:\\App\\Fls.exe',
            cpu: { cores: 2 } });
        t.after(()=>app.dispose());
        assert.equal(await app.run({ timeoutMs: 40000 }), VALUE);
    });
