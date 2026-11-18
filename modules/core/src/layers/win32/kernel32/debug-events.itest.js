/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A parent that starts its child with DEBUG_PROCESS hears the child's
 * events in WaitForDebugEvent, each stopping the child until
 * ContinueDebugEvent (`debug-events.js`): its creation, the libraries mapped
 * with it, the loader's breakpoint, what it says through OutputDebugString,
 * an exception first and - declined by the debugger and by the child's own
 * handlers - again, and its exit with its code.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../../../app.js';
import { assemble, buildExe } from '../../../../../../tools/fixtures/make-pe.mjs';

/** @param {number} value */
const u32 = value=>[0, 8, 16, 24].map(at=>(value >>> at) & 0xff);
/** @param {string} text */
const ansi = text=>[...text].map(c=>c.charCodeAt(0)).concat(0);

const DEBUG_PROCESS = 1;
const DBG_CONTINUE = 0x00010002;
const DBG_EXCEPTION_NOT_HANDLED = 0x80010001;

/**
 * The debugger: CreateProcessA(..., DEBUG_PROCESS, ...), then
 * WaitForDebugEvent and ContinueDebugEvent until EXIT_PROCESS_DEBUG_EVENT,
 * counting each kind - an exception continued with `answer`, every other
 * event with DBG_CONTINUE. It exits with the counts packed: CREATE_PROCESS in
 * bits 0-3, EXCEPTION 4-7, OUTPUT_DEBUG_STRING 8-11, LOAD_DLL (up to 15)
 * 12-15, and the child's exit code's low byte in 16-23; 0xee when a wait
 * fails.
 *
 * @param {number} answer
 */
const debuggerOf = answer=>buildExe({
    imports: { 'KERNEL32.dll': ['CreateProcessA', 'WaitForDebugEvent', 'ContinueDebugEvent',
        'ExitProcess'] },
    data: {
        command: ansi('C:\\child.exe'),
        startup: [...u32(68), ...new Array(64).fill(0)],
        info: new Array(16).fill(0),
        event: new Array(96).fill(0),
        counts: new Array(36).fill(0),
    },
    codeSize: 0x100,
    code: ({ iat, at })=>assemble([
        0x68, ...u32(at('info')), 0x68, ...u32(at('startup')),
        0x6a, 0, 0x6a, 0, 0x6a, DEBUG_PROCESS, 0x6a, 0, 0x6a, 0, 0x6a, 0,
        0x68, ...u32(at('command')), 0x6a, 0,
        0xff, 0x15, ...u32(iat('CreateProcessA')),
        { label: 'loop' },
        0x6a, 0xff, 0x68, ...u32(at('event')), //       push INFINITE; push event
        0xff, 0x15, ...u32(iat('WaitForDebugEvent')),
        0x85, 0xc0, { jump: 'jz', to: 'fail' }, //      test eax, eax
        0xa1, ...u32(at('event')), //                   mov eax, [event]
        0xff, 0x04, 0x85, ...u32(at('counts')), //      inc dword [counts + eax*4]
        0x83, 0xf8, 0x05, { jump: 'jz', to: 'done' }, // cmp eax, EXIT_PROCESS
        0xb9, ...u32(DBG_CONTINUE), //                  mov ecx, DBG_CONTINUE
        0x83, 0xf8, 0x01, { jump: 'jnz', to: 'go' }, // cmp eax, EXCEPTION
        0xb9, ...u32(answer), //                        mov ecx, answer
        { label: 'go' },
        0x51, 0xff, 0x35, ...u32(at('event') + 8), 0xff, 0x35, ...u32(at('event') + 4),
        0xff, 0x15, ...u32(iat('ContinueDebugEvent')),
        { jump: 'jmp', to: 'loop' },
        { label: 'done' },
        0xa1, ...u32(at('event') + 12), //              mov eax, exit code
        0x25, ...u32(0xff), 0xc1, 0xe0, 0x10, //        and eax, 0xff; shl eax, 16
        0x0b, 0x05, ...u32(at('counts') + 12), //       or eax, [CREATE_PROCESS]
        0x8b, 0x0d, ...u32(at('counts') + 4), 0xc1, 0xe1, 0x04, 0x09, 0xc8,
        0x8b, 0x0d, ...u32(at('counts') + 32), 0xc1, 0xe1, 0x08, 0x09, 0xc8,
        0x8b, 0x0d, ...u32(at('counts') + 24), //       mov ecx, [LOAD_DLL]
        0x83, 0xf9, 0x0f, { jump: 'jbe', to: 'few' }, 0xb9, ...u32(15),
        { label: 'few' },
        0xc1, 0xe1, 0x0c, 0x09, 0xc8,
        0x50, 0xff, 0x15, ...u32(iat('ExitProcess')),
        { label: 'fail' },
        0x68, ...u32(0xee), 0xff, 0x15, ...u32(iat('ExitProcess')),
    ]),
});

/** OutputDebugStringA("hi"), then ExitProcess(7). */
const talking = buildExe({
    imports: { 'KERNEL32.dll': ['OutputDebugStringA', 'ExitProcess'] },
    data: { text: ansi('hi') },
    code: ({ iat, at })=>[
        0x68, ...u32(at('text')), 0xff, 0x15, ...u32(iat('OutputDebugStringA')),
        0x6a, 7, 0xff, 0x15, ...u32(iat('ExitProcess')),
    ],
});

/** An undefined instruction, no handler of its own, then ExitProcess(7). */
const faulting = buildExe({
    imports: { 'KERNEL32.dll': ['ExitProcess'] },
    code: ({ iat })=>[
        0x0f, 0x0b, //                                  ud2
        0x6a, 7, 0xff, 0x15, ...u32(iat('ExitProcess')),
    ],
});

/** @param {Uint8Array} executable @param {Uint8Array} child */
async function run(executable, child){
    const app = await createApp({ executable, imagePath: 'C:\\debugger.exe',
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

/** @param {number} code */
const unpack = code=>({ created: code & 0xf, exceptions: code >>> 4 & 0xf,
    said: code >>> 8 & 0xf, libraries: code >>> 12 & 0xf, exit: code >>> 16 & 0xff });

test('a debugged child reports its start, its words and its exit, each continued',
    { timeout: 120_000 }, async()=>{
        const heard = unpack(await run(debuggerOf(DBG_CONTINUE), talking));
        assert.equal(heard.created, 1, 'CREATE_PROCESS_DEBUG_EVENT');
        assert.ok(heard.libraries >= 2, `a LOAD_DLL for each library mapped: ${heard.libraries}`);
        assert.equal(heard.exceptions, 1, 'the loader\'s breakpoint');
        assert.equal(heard.said, 1, 'OUTPUT_DEBUG_STRING_EVENT');
        assert.equal(heard.exit, 7, 'EXIT_PROCESS_DEBUG_EVENT with its code');
    });

test('an exception the debugger and the child decline is reported twice and ends the child',
    { timeout: 120_000 }, async()=>{
        const heard = unpack(await run(debuggerOf(DBG_EXCEPTION_NOT_HANDLED), faulting));
        assert.equal(heard.exceptions, 3, 'the breakpoint, then the first and the second chance');
        assert.equal(heard.exit, 0x1d, 'ended with STATUS_ILLEGAL_INSTRUCTION (its low byte)');
    });
