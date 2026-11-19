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
 * fails. With `attach` it starts the child undebugged and attaches to it
 * (DebugActiveProcess) once it runs.
 *
 * @param {number} answer @param {boolean} [attach]
 */
const debuggerOf = (answer, attach = false)=>buildExe({
    imports: { 'KERNEL32.dll': ['CreateProcessA', 'WaitForDebugEvent', 'ContinueDebugEvent',
        'Sleep', 'DebugActiveProcess', 'CreateEventA', 'SetEvent', 'ExitProcess'] },
    data: {
        command: ansi('C:\\child.exe'),
        attached: ansi('attached'),
        go: new Array(4).fill(0),
        startup: [...u32(68), ...new Array(64).fill(0)],
        info: new Array(16).fill(0),
        event: new Array(96).fill(0),
        counts: new Array(36).fill(0),
    },
    codeSize: 0x140,
    code: ({ iat, at })=>assemble([
        0x68, ...u32(at('info')), 0x68, ...u32(at('startup')),
        0x6a, 0, 0x6a, 0, 0x6a, attach ? 0 : DEBUG_PROCESS, 0x6a, 0, 0x6a, 0, 0x6a, 0,
        0x68, ...u32(at('command')), 0x6a, 0,
        0xff, 0x15, ...u32(iat('CreateProcessA')),
        ...attach ? [
            0x6a, 50, 0xff, 0x15, ...u32(iat('Sleep')), //  Sleep(50): the child runs
            0xff, 0x35, ...u32(at('info') + 8), //          push dwProcessId
            0xff, 0x15, ...u32(iat('DebugActiveProcess')),
            0x85, 0xc0, { jump: /** @type {const} */ ('jz'), to: 'refused' },
            //                                          go = CreateEventA(0, 1, 0, "attached")
            0x68, ...u32(at('attached')), 0x6a, 0, 0x6a, 1, 0x6a, 0,
            0xff, 0x15, ...u32(iat('CreateEventA')), 0xa3, ...u32(at('go')),
        ] : [],
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
        // An exception heard lets an attached child go on (SetEvent(go)).
        0x51, 0xff, 0x35, ...u32(at('go')), 0xff, 0x15, ...u32(iat('SetEvent')), 0x59,
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
        { label: 'refused' },
        0x68, ...u32(0xdd), 0xff, 0x15, ...u32(iat('ExitProcess')),
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

/**
 * Waits on the event "attached", which its debugger sets once it has heard
 * the break-in, then ExitProcess(7): running until a debugger attaches, and
 * stopped while its debugger has an event of it not yet continued.
 */
const sleeping = buildExe({
    imports: { 'KERNEL32.dll': ['CreateEventA', 'WaitForSingleObject', 'ExitProcess'] },
    data: { attached: ansi('attached') },
    code: ({ iat, at })=>[
        0x68, ...u32(at('attached')), 0x6a, 0, 0x6a, 1, 0x6a, 0,
        0xff, 0x15, ...u32(iat('CreateEventA')),
        0x68, ...u32(30_000), 0x50, 0xff, 0x15, ...u32(iat('WaitForSingleObject')),
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

/**
 * @param {Uint8Array} executable @param {Uint8Array} child
 * @param {import('../../../mode.js').Concurrency} [concurrency]  above one, the debugger runs in a worker and
 *     its child beside it there
 * @param {[string, boolean][]} [started]  each process started: its image,
 *     and whether in a worker of its own
 */
async function run(executable, child, concurrency = 1, started = []){
    const app = await createApp({ executable, imagePath: 'C:\\debugger.exe', concurrency,
        files: [{ path: 'C:\\child.exe', bytes: child }] });
    app.on('process-started', (/** @type {any} */ event)=>
        started.push([event.image, event.worker === true]));
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

test('a debugger in a worker hears its child, started beside it there, the same way',
    { timeout: 120_000 }, async()=>{
        /** @type {[string, boolean][]} */
        const started = [];
        const heard = unpack(await run(debuggerOf(DBG_EXCEPTION_NOT_HANDLED), talking, 2,
            started));
        assert.deepEqual(started, [['C:\\debugger.exe', true], ['C:\\child.exe', false]],
            'the debugger in a worker, its child beside it');
        assert.equal(heard.created, 1, 'CREATE_PROCESS_DEBUG_EVENT');
        assert.ok(heard.libraries >= 2, `a LOAD_DLL for each library mapped: ${heard.libraries}`);
        assert.equal(heard.exceptions, 1, 'the loader\'s breakpoint');
        assert.equal(heard.said, 1, 'OUTPUT_DEBUG_STRING_EVENT');
        assert.equal(heard.exit, 7, 'EXIT_PROCESS_DEBUG_EVENT with its code');
    });

test('a debugger that attaches to its running child hears what it is, its break-in and its exit',
    { timeout: 120_000 }, async()=>{
        const code = await run(debuggerOf(DBG_CONTINUE, true), sleeping);
        assert.notEqual(code, 0xdd, 'DebugActiveProcess succeeded');
        const heard = unpack(code);
        assert.equal(heard.created, 1, 'CREATE_PROCESS_DEBUG_EVENT, made up for a process running');
        assert.ok(heard.libraries >= 2, `a LOAD_DLL for each library it has: ${heard.libraries}`);
        assert.equal(heard.exceptions, 1, 'the breakpoint of the thread it breaks in on');
        assert.equal(heard.exit, 7, 'EXIT_PROCESS_DEBUG_EVENT with its code');
    });

/** Where the counting child keeps its count: read off its build. */
let countAt = 0;
/**
 * Counts, a millisecond's wait on "attached" between counts, until its
 * debugger sets it, then ExitProcess(7).
 */
const counting = buildExe({
    imports: { 'KERNEL32.dll': ['CreateEventA', 'WaitForSingleObject', 'ExitProcess'] },
    data: { attached: ansi('attached'), count: new Array(4).fill(0) },
    code: ({ iat, at })=>{
        countAt = at('count');
        return assemble([
            0x68, ...u32(at('attached')), 0x6a, 0, 0x6a, 1, 0x6a, 0,
            0xff, 0x15, ...u32(iat('CreateEventA')), 0x89, 0xc6, //    mov esi, eax
            { label: 'more' },
            0xff, 0x05, ...u32(at('count')), //                        inc dword [count]
            0x6a, 1, 0x56, 0xff, 0x15, ...u32(iat('WaitForSingleObject')),
            0x85, 0xc0, { jump: /** @type {const} */ ('jnz'), to: 'more' },
            0x6a, 7, 0xff, 0x15, ...u32(iat('ExitProcess')),
        ]);
    },
});

/**
 * ReadProcessMemory(the process whose handle is at `handle`, the count,
 * `into`, 4, NULL).
 *
 * @param {(name: string) => number} iat @param {number} handle @param {number} into
 */
const readCount = (iat, handle, into)=>[0x6a, 0, 0x6a, 4, 0x68, ...u32(into),
    0x68, ...u32(countAt), 0xff, 0x35, ...u32(handle),
    0xff, 0x15, ...u32(iat('ReadProcessMemory'))];

/**
 * Starts the counting child, waits until it has counted, attaches, and at
 * the first event reads its count, then a hundred times more: ends the
 * child, and itself, with how far it moved meanwhile (0 for a child its
 * debugger holds); exits with 0xdd when the attach is refused, 0xee when a
 * wait fails.
 */
const holding = buildExe({
    imports: { 'KERNEL32.dll': ['CreateProcessA', 'ReadProcessMemory', 'DebugActiveProcess',
        'WaitForDebugEvent', 'Sleep', 'TerminateProcess', 'ExitProcess'] },
    data: {
        command: ansi('C:\\child.exe'),
        startup: [...u32(68), ...new Array(64).fill(0)],
        info: new Array(16).fill(0),
        event: new Array(96).fill(0),
        first: new Array(4).fill(0),
        second: new Array(4).fill(0),
    },
    codeSize: 0x100,
    code: ({ iat, at })=>assemble([
        0x68, ...u32(at('info')), 0x68, ...u32(at('startup')),
        0x6a, 0, 0x6a, 0, 0x6a, 0, 0x6a, 0, 0x6a, 0, 0x6a, 0,
        0x68, ...u32(at('command')), 0x6a, 0,
        0xff, 0x15, ...u32(iat('CreateProcessA')),
        { label: 'early' }, //                          until the child has counted
        0x6a, 1, 0xff, 0x15, ...u32(iat('Sleep')),
        ...readCount(iat, at('info'), at('first')),
        0x83, 0x3d, ...u32(at('first')), 0, { jump: /** @type {const} */ ('jz'), to: 'early' },
        0xff, 0x35, ...u32(at('info') + 8), 0xff, 0x15, ...u32(iat('DebugActiveProcess')),
        0x85, 0xc0, { jump: 'jz', to: 'refused' },
        0x6a, 0xff, 0x68, ...u32(at('event')), 0xff, 0x15, ...u32(iat('WaitForDebugEvent')),
        0x85, 0xc0, { jump: 'jz', to: 'fail' },
        ...readCount(iat, at('info'), at('first')),
        // A hundred looks a millisecond apart, each a call the child answers.
        0xbf, ...u32(100), //                           mov edi, 100
        { label: 'look' },
        0x6a, 1, 0xff, 0x15, ...u32(iat('Sleep')),
        ...readCount(iat, at('info'), at('second')),
        0x4f, { jump: 'jnz', to: 'look' }, //           dec edi
        0xa1, ...u32(at('second')), 0x2b, 0x05, ...u32(at('first')), // second - first
        // The child ends with the answer, and its code is the run's.
        0x89, 0xc3, 0x50, 0xff, 0x35, ...u32(at('info')),
        0xff, 0x15, ...u32(iat('TerminateProcess')),
        0x53, 0xff, 0x15, ...u32(iat('ExitProcess')),
        { label: 'fail' },
        0x68, ...u32(0xee), 0xff, 0x15, ...u32(iat('ExitProcess')),
        { label: 'refused' },
        0x68, ...u32(0xdd), 0xff, 0x15, ...u32(iat('ExitProcess')),
    ]),
});

test('a process its debugger attaches to stays stopped while what the attach reported waits',
    { timeout: 120_000 }, async()=>{
        assert.equal(await run(holding, counting), 0, 'its count did not move');
    });
