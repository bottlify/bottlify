/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Exceptions as compiled programs raise and handle them.
 *
 * The fixtures are built by a compiler against the system's C runtime -- see
 * `scripts/build-fixtures.mjs` -- because the frames and tables exception
 * handling runs on are the compiler's, and a hand-assembled imitation of them
 * would only test that it agrees with itself. Each fixture checks a property
 * per line and prints `ok` or `FAIL` with its name, so a failure here says
 * which property broke.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createApp } from './app.js';
import { buildExe } from '../../../tools/fixtures/make-pe.mjs';

/** @param {number} value */
const u32 = value=>[value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24 & 0xff];

/**
 * @param {import('node:test').TestContext} t
 * @param {string} name
 */
async function run(t, name){
    const exe = await readFile(new URL(`../test/fixtures/${name}.exe`, import.meta.url));
    return runExecutable(t, new Uint8Array(exe));
}

/**
 * @param {import('node:test').TestContext} t
 * @param {Uint8Array} executable
 */
async function runExecutable(t, executable){
    const app = await createApp({ executable });
    t.after(()=>app.dispose());
    /** @type {string[]} */
    const output = [];
    app.attachLog((/** @type {number} */ _handle, /** @type {string} */ text)=>output.push(text));
    /** @type {any[]} */
    const boxes = [];
    app.on('message-box', (/** @type {any} */ box)=>boxes.push(box));
    const code = await app.run({ timeoutMs: 30_000 });
    const bridge = app.diagnostics().find((/** @type {any} */ entry)=>entry.name === 'bridge');
    return { code, text: output.join(''), suspended: bridge?.metrics?.suspended, boxes };
}

/**
 * Every line the fixture printed, as property and outcome.
 *
 * @param {string} text
 */
const verdicts = text=>text.split('\r\n').filter(Boolean).map(line=>({
    ok: line.startsWith('ok   '),
    property: line.slice(5),
}));

test('structured exceptions: raised, faulted, nested, and left by longjmp', { timeout: 60000 },
    async t=>{
        const { code, text, suspended } = await run(t, 'seh');
        const lines = verdicts(text);

        assert.deepEqual(lines.filter(line=>!line.ok).map(line=>line.property), [],
            `every property holds:\n${text}`);
        assert.equal(lines.length, 9, 'and every one was reached');
        assert.equal(code, 0);
        assert.equal(suspended, 0,
            'no host call is left waiting: each handler that found its block let go of the stack');
    });

test('C++ exceptions: catch, destroy, rethrow, across a callback and two threads',
    { timeout: 60000 }, async t=>{
        const { code, text, suspended } = await run(t, 'cxxeh');
        const lines = verdicts(text);

        assert.deepEqual(lines.filter(line=>!line.ok).map(line=>line.property), [],
            `every property holds:\n${text}`);
        assert.equal(lines.length, 13, 'and every one was reached');
        assert.equal(code, 0);
        assert.equal(suspended, 0);
    });

test('a C++ exception nothing catches ends the process with its code', { timeout: 60000 },
    async t=>{
        const { code, text, boxes } = await run(t, 'unhandled');

        assert.equal(text, 'throwing\r\n', 'nothing after the throw ran');
        assert.equal(code, 0xe06d7363, 'the exception code is the exit code, as on Windows');
        assert.deepEqual(boxes, [], 'and a run that failed is not told as a game that finished');
    });

/**
 * A fault taken with the direction flag set, as one inside a copy going down
 * (`std; rep movsd`) is taken -- here an invalid opcode. The handler reads the
 * flags it runs with and the context's, fills four bytes with `rep stosb` --
 * forwards only if DF is clear -- and continues at a block of its choosing
 * with DF left set in the context, and the block reads the flags it continues
 * with.
 *
 * Exits 0, or with a bit per property that failed: 1 the handler ran with DF
 * set, 2 the context did not have it, 4 the handler's fill went down, 8 the
 * block continued without it.
 */
function buildDirectionFlagExe(){
    return buildExe({
        imports: { 'KERNEL32.dll': ['ExitProcess'] },
        data: {
            savedEsp: [0, 0, 0, 0], inHandler: [0xff, 0, 0, 0], inContext: [0, 0, 0, 0],
            fill: [0, 0, 0, 0, 0, 0, 0, 0],
        },
        codeSize: 0x180,
        code: ({ iat, at, code })=>{
            const handler = code(0x100);
            const recover = code(0x80);
            const main = [
                0x68, ...u32(handler),                           // push handler
                0x64, 0xff, 0x35, 0, 0, 0, 0,                    // push dword fs:[0]
                0x64, 0x89, 0x25, 0, 0, 0, 0,                    // mov fs:[0], esp
                0x89, 0x25, ...u32(at('savedEsp')),              // mov [savedEsp], esp
                0xfd,                                            // std
                0x0f, 0x0b,                                      // ud2
                0xfc, 0x6a, 0x10, 0xff, 0x15, ...u32(iat('ExitProcess')), // not reached
            ];
            const block = [
                0x9c, 0x5b,                                      // pushfd; pop ebx
                0xfc,                                            // cld
                0x64, 0x8f, 0x05, 0, 0, 0, 0,                    // pop dword fs:[0]
                0x83, 0xc4, 0x04,                                // add esp, 4
                0x31, 0xc0,                                      // xor eax, eax
                0x83, 0x3d, ...u32(at('inHandler')), 0x00,       // cmp dword [inHandler], 0
                0x74, 0x03, 0x83, 0xc8, 0x01,                    // je +3; or eax, 1
                0x83, 0x3d, ...u32(at('inContext')), 0x00,       // cmp dword [inContext], 0
                0x75, 0x03, 0x83, 0xc8, 0x02,                    // jne +3; or eax, 2
                0x80, 0x3d, ...u32(at('fill') + 7), 0x5a,        // cmp byte [fill+7], 0x5a
                0x74, 0x03, 0x83, 0xc8, 0x04,                    // je +3; or eax, 4
                0xf7, 0xc3, ...u32(0x400),                       // test ebx, DF
                0x75, 0x03, 0x83, 0xc8, 0x08,                    // jnz +3; or eax, 8
                0x50, 0xff, 0x15, ...u32(iat('ExitProcess')),    // exit eax
            ];
            const handle = [
                0x9c, 0x58,                                      // pushfd; pop eax
                0x25, ...u32(0x400),                             // and eax, DF
                0xa3, ...u32(at('inHandler')),                   // mov [inHandler], eax
                0x8b, 0x4c, 0x24, 0x0c,                          // mov ecx, [esp+12]: CONTEXT
                0x8b, 0x81, ...u32(0xc0),                        // mov eax, [ecx+EFlags]
                0x25, ...u32(0x400),                             // and eax, DF
                0xa3, ...u32(at('inContext')),                   // mov [inContext], eax
                0x57,                                            // push edi
                0x51,                                            // push ecx
                0xbf, ...u32(at('fill') + 4),                    // mov edi, fill+4
                0xb9, ...u32(4),                                 // mov ecx, 4
                0xb0, 0x5a,                                      // mov al, 0x5a
                0xf3, 0xaa,                                      // rep stosb
                0x59,                                            // pop ecx
                0x5f,                                            // pop edi
                0xc7, 0x81, ...u32(0xb8), ...u32(recover),       // context.Eip = block
                0xa1, ...u32(at('savedEsp')),                    // mov eax, [savedEsp]
                0x89, 0x81, ...u32(0xc4),                        // context.Esp = eax
                0x31, 0xc0,                                      // xor eax, eax: continue
                0xc3,                                            // ret
            ];
            const bytes = new Array(0x180).fill(0xcc);
            bytes.splice(0, main.length, ...main);
            bytes.splice(0x80, block.length, ...block);
            bytes.splice(0x100, handle.length, ...handle);
            return bytes;
        },
    });
}

test(`a handler runs with DF clear and the context gives it back`,
    { timeout: 60000 }, async t=>{
        const { code } = await runExecutable(t, buildDirectionFlagExe());
        assert.equal(code, 0, '1: DF set in the handler; 2: not in the context; 4: the'
            + ' handler\'s fill went down; 8: the block continued without it');
    });

test(`an entry point that returns ends the process with its answer`,
    { timeout: 60000 }, async t=>{
        const exe = buildExe({
            imports: { 'KERNEL32.dll': ['ExitProcess'] },
            data: {},
            codeSize: 0x10,
            code: ()=>[0xb8, ...u32(5), 0xc3, ...new Array(10).fill(0xcc)], // mov eax, 5; ret
        });
        const { code } = await runExecutable(t, exe);
        assert.equal(code, 5);
    });

/**
 * A vectored handler registered first in line, an invalid opcode it fixes by
 * stepping past it in the context, and the handler removed again: the
 * exception reaches the handler with no frame on the chain at all.
 *
 * Exits 0, 1 when the handler ran other than once, 2 when it saw another
 * code, 3 when the removal failed.
 */
function buildVectoredExe(){
    return buildExe({
        imports: { 'KERNEL32.dll': ['AddVectoredExceptionHandler',
            'RemoveVectoredExceptionHandler', 'ExitProcess'] },
        data: { calls: [0, 0, 0, 0], seen: [0, 0, 0, 0], handle: [0, 0, 0, 0] },
        codeSize: 0x100,
        code: ({ iat, at, code })=>{
            const handler = code(0x80);
            const main = [
                0x68, ...u32(handler),                           // push handler
                0x6a, 0x01,                                      // push 1: first
                0xff, 0x15, ...u32(iat('AddVectoredExceptionHandler')),
                0xa3, ...u32(at('handle')),                      // mov [handle], eax
                0x0f, 0x0b,                                      // ud2
                0xff, 0x35, ...u32(at('handle')),                // push dword [handle]
                0xff, 0x15, ...u32(iat('RemoveVectoredExceptionHandler')),
                0x6a, 0x03,                                      // push 3
                0x85, 0xc0, 0x74, 0x1e,                          // test eax, eax; jz exit
                0x58,                                            // pop eax
                0x6a, 0x01,                                      // push 1
                0x83, 0x3d, ...u32(at('calls')), 0x01,           // cmp dword [calls], 1
                0x75, 0x13,                                      // jne exit
                0x58,                                            // pop eax
                0x6a, 0x02,                                      // push 2
                0x81, 0x3d, ...u32(at('seen')), ...u32(0xc000001d), // cmp [seen], ILLEGAL
                0x75, 0x03,                                      // jne exit
                0x58,                                            // pop eax
                0x6a, 0x00,                                      // push 0
                0xff, 0x15, ...u32(iat('ExitProcess')),          // exit: ExitProcess
            ];
            const handle = [
                0x8b, 0x44, 0x24, 0x04,                          // mov eax, [esp+4]: pointers
                0x8b, 0x08,                                      // mov ecx, [eax]: the record
                0x8b, 0x09,                                      // mov ecx, [ecx]: its code
                0x89, 0x0d, ...u32(at('seen')),                  // mov [seen], ecx
                0xff, 0x05, ...u32(at('calls')),                 // inc dword [calls]
                0x8b, 0x40, 0x04,                                // mov eax, [eax+4]: the context
                0x83, 0x80, ...u32(0xb8), 0x02,                  // add context.Eip, 2
                0xb8, ...u32(0xffffffff),                        // EXCEPTION_CONTINUE_EXECUTION
                0xc2, 0x04, 0x00,                                // ret 4
            ];
            const bytes = new Array(0x100).fill(0xcc);
            bytes.splice(0, main.length, ...main);
            bytes.splice(0x80, handle.length, ...handle);
            return bytes;
        },
    });
}

test('a vectored handler takes an exception before any frame and goes on from its context',
    { timeout: 60000 }, async t=>{
        const { code } = await runExecutable(t, buildVectoredExe());
        assert.equal(code, 0, '1: the handler ran other than once; 2: it saw another code;'
            + ' 3: it could not be removed');
    });

/**
 * A store through NULL right after a frame is pushed, as a packer's entry
 * point makes one to reach its own handler: the store faults where it
 * stands, the handler is given that frame and a context whose Esp is the
 * faulting instruction's, and the program goes on where the handler put it,
 * on that stack.
 *
 * Exits 0, or with a bit per property that failed: 1 the context's Esp was
 * another, 2 the frame handed over was another, 4 the program went on on
 * another stack; 0x77 the store went through.
 */
function buildNullStoreExe(){
    return buildExe({
        imports: { 'KERNEL32.dll': ['ExitProcess'] },
        data: { savedEsp: [0, 0, 0, 0], contextEsp: [0, 0, 0, 0], frame: [0, 0, 0, 0],
            resumedEsp: [0, 0, 0, 0] },
        codeSize: 0x180,
        code: ({ iat, at, code })=>{
            const handler = code(0x100);
            const resume = code(0x80);
            const main = [
                0x68, ...u32(handler),                           // push handler
                0x64, 0xff, 0x35, 0, 0, 0, 0,                    // push dword fs:[0]
                0x64, 0x89, 0x25, 0, 0, 0, 0,                    // mov fs:[0], esp
                0x89, 0x25, ...u32(at('savedEsp')),              // mov [savedEsp], esp
                0x33, 0xc0,                                      // xor eax, eax
                0x89, 0x08,                                      // mov [eax], ecx
                0x6a, 0x77, 0xff, 0x15, ...u32(iat('ExitProcess')), // the store went through
            ];
            const block = [
                0x89, 0x25, ...u32(at('resumedEsp')),            // mov [resumedEsp], esp
                0x31, 0xc0,                                      // xor eax, eax
                0x8b, 0x0d, ...u32(at('savedEsp')),              // mov ecx, [savedEsp]
                0x3b, 0x0d, ...u32(at('contextEsp')),            // cmp ecx, [contextEsp]
                0x74, 0x03, 0x83, 0xc8, 0x01,                    // je +3; or eax, 1
                0x3b, 0x0d, ...u32(at('frame')),                 // cmp ecx, [frame]
                0x74, 0x03, 0x83, 0xc8, 0x02,                    // je +3; or eax, 2
                0x3b, 0x0d, ...u32(at('resumedEsp')),            // cmp ecx, [resumedEsp]
                0x74, 0x03, 0x83, 0xc8, 0x04,                    // je +3; or eax, 4
                0x50, 0xff, 0x15, ...u32(iat('ExitProcess')),    // exit eax
            ];
            const handle = [
                0x8b, 0x4c, 0x24, 0x0c,                          // mov ecx, [esp+12]: CONTEXT
                0x8b, 0x81, ...u32(0xc4),                        // mov eax, [ecx+Esp]
                0xa3, ...u32(at('contextEsp')),                  // mov [contextEsp], eax
                0x8b, 0x44, 0x24, 0x08,                          // mov eax, [esp+8]: the frame
                0xa3, ...u32(at('frame')),                       // mov [frame], eax
                0xc7, 0x81, ...u32(0xb8), ...u32(resume),        // context.Eip = block
                0x31, 0xc0,                                      // xor eax, eax: continue
                0xc3,                                            // ret
            ];
            const bytes = new Array(0x180).fill(0xcc);
            bytes.splice(0, main.length, ...main);
            bytes.splice(0x80, block.length, ...block);
            bytes.splice(0x100, handle.length, ...handle);
            return bytes;
        },
    });
}

test('a store through NULL faults where it stands, with the stack and frame of the store',
    { timeout: 60000 },
    async t=>{
        const { code } = await runExecutable(t, buildNullStoreExe());
        assert.equal(code, 0, '1: the context\'s Esp was another; 2: the frame was another;'
            + ' 4: it went on on another stack; 0x77: the store went through');
    });

/**
 * A field read through NULL, over and over in one loop: each read faults with
 * the address it read and goes on past it, as the .NET runtime's JIT counts on
 * (it emits no null test; the read's access violation is its
 * NullReferenceException). The loop runs long enough to be translated, so
 * the interpreter and translated code both meet it.
 *
 * Exits 0 when the handler saw every read as a read of 0x28; 1 otherwise
 * (0 handled: the reads went through and found something there).
 */
const NULL_READS = 2000;
function buildNullReadExe(){
    return buildExe({
        imports: { 'KERNEL32.dll': ['ExitProcess'] },
        data: { count: [0, 0, 0, 0] },
        codeSize: 0x100,
        code: ({ iat, at, code })=>{
            const handler = code(0x80);
            const main = [
                0x68, ...u32(handler),                           // push handler
                0x64, 0xff, 0x35, 0, 0, 0, 0,                    // push dword fs:[0]
                0x64, 0x89, 0x25, 0, 0, 0, 0,                    // mov fs:[0], esp
                0xbe, ...u32(NULL_READS),                        // mov esi, NULL_READS
                0x31, 0xc0,                                      // L: xor eax, eax
                0x8b, 0x48, 0x28,                                // mov ecx, [eax+0x28]
                0x4e,                                            // dec esi
                0x75, 0xf8,                                      // jnz L
                0xa1, ...u32(at('count')),                       // mov eax, [count]
                0x3d, ...u32(NULL_READS),                        // cmp eax, NULL_READS
                0x74, 0x08,                                      // je +8
                0x6a, 0x01, 0xff, 0x15, ...u32(iat('ExitProcess')), // exit 1
                0x6a, 0x00, 0xff, 0x15, ...u32(iat('ExitProcess')), // exit 0
            ];
            const handle = [
                0x8b, 0x44, 0x24, 0x04,                          // mov eax, [esp+4]: the record
                0x81, 0x38, ...u32(0xc0000005),                  // cmp [eax], ACCESS_VIOLATION
                0x75, 0x12,                                      // jne done
                0x83, 0x78, 0x14, 0x00,                          // cmp [eax+0x14], 0: a read
                0x75, 0x0c,                                      // jne done
                0x83, 0x78, 0x18, 0x28,                          // cmp [eax+0x18], 0x28: of 0x28
                0x75, 0x06,                                      // jne done
                0xff, 0x05, ...u32(at('count')),                 // inc [count]
                0x8b, 0x4c, 0x24, 0x0c,                          // done: mov ecx, [esp+12]
                0x83, 0x81, ...u32(0xb8), 0x03,                  // context.Eip += 3: past the read
                0x31, 0xc0,                                      // xor eax, eax: continue
                0xc3,                                            // ret
            ];
            const bytes = new Array(0x100).fill(0xcc);
            bytes.splice(0, main.length, ...main);
            bytes.splice(0x80, handle.length, ...handle);
            return bytes;
        },
    });
}

test('a read through NULL faults with the address it read, interpreted and translated alike',
    { timeout: 120000 },
    async t=>{
        const { code } = await runExecutable(t, buildNullReadExe());
        assert.equal(code, 0, 'every read faulted as a read of 0x28');
    });

/**
 * Two frames on the chain: the inner one's handler at an address no region
 * holds, the outer one's the program's own. A frame is checked by whether its
 * memory is there (seh.js), so the inner frame is passed over and the outer
 * handler ends the process with 0x5a.
 */
function buildUnmappedHandlerExe(){
    return buildExe({
        imports: { 'KERNEL32.dll': ['ExitProcess'] },
        codeSize: 0x100,
        code: ({ iat, code })=>{
            const handler = code(0x80);
            const main = [
                0x68, ...u32(handler),                           // push handler
                0x64, 0xff, 0x35, 0, 0, 0, 0,                    // push dword fs:[0]
                0x64, 0x89, 0x25, 0, 0, 0, 0,                    // mov fs:[0], esp
                0x68, ...u32(0xdead0000),                        // push unmapped handler
                0x64, 0xff, 0x35, 0, 0, 0, 0,                    // push dword fs:[0]
                0x64, 0x89, 0x25, 0, 0, 0, 0,                    // mov fs:[0], esp
                0x0f, 0x0b,                                      // ud2
                0x6a, 0x77, 0xff, 0x15, ...u32(iat('ExitProcess')), // not reached
            ];
            const handle = [
                0x6a, 0x5a, 0xff, 0x15, ...u32(iat('ExitProcess')), // exit 0x5a
            ];
            const bytes = new Array(0x100).fill(0xcc);
            bytes.splice(0, main.length, ...main);
            bytes.splice(0x80, handle.length, ...handle);
            return bytes;
        },
    });
}

test('a frame whose handler no region holds is passed over for the next one',
    { timeout: 60000 },
    async t=>{
        const { code } = await runExecutable(t, buildUnmappedHandlerExe());
        assert.equal(code, 0x5a, 'the outer handler ran');
    });

/**
 * A TIMERPROC that raises, dispatched by DispatchMessage: Windows calls the
 * procedure inside an __except of its own (UOI_TIMERPROC_EXCEPTION_SUPPRESSION
 * is on by default), so the exception ends the call answering zero and the
 * program goes on after DispatchMessage. The procedure raises the way a
 * compiler's tail call does, leaving RaiseException standing on the
 * procedure's own frame. Exits 0x5a once it has, with the
 * procedure run once; 0x66 if it ran another number of times, 0x77 if
 * DispatchMessage answered anything but zero.
 */
function buildTimerProcExceptionExe(){
    return buildExe({
        imports: { 'USER32.dll': ['SetTimer', 'DispatchMessageA'],
            'KERNEL32.dll': ['ExitProcess', 'RaiseException'] },
        data: { msg: new Array(28).fill(0), count: [0, 0, 0, 0] },
        codeSize: 0x100,
        code: ({ iat, at, code })=>{
            const proc = code(0x80);
            const main = [
                0x68, ...u32(proc),                              // push proc
                0x68, ...u32(1000),                              // push 1000
                0x6a, 0x00, 0x6a, 0x00,                          // push 0; push 0
                0xff, 0x15, ...u32(iat('SetTimer')),             // call SetTimer
                0xa3, ...u32(at('msg') + 8),                     // mov [msg.wParam], eax
                0xc7, 0x05, ...u32(at('msg') + 4), ...u32(0x113), // msg.message = WM_TIMER
                0xc7, 0x05, ...u32(at('msg') + 12), ...u32(proc), // msg.lParam = proc
                0x68, ...u32(at('msg')),                         // push &msg
                0xff, 0x15, ...u32(iat('DispatchMessageA')),     // call DispatchMessageA
                0x85, 0xc0,                                      // test eax, eax
                0x75, 0x19,                                      // jnz to the 0x77 exit
                0x83, 0x3d, ...u32(at('count')), 0x01,           // cmp dword [count], 1
                0x75, 0x08,                                      // jne to the 0x66 exit
                0x6a, 0x5a, 0xff, 0x15, ...u32(iat('ExitProcess')), // exit 0x5a
                0x6a, 0x66, 0xff, 0x15, ...u32(iat('ExitProcess')), // ran another number of times
                0x6a, 0x77, 0xff, 0x15, ...u32(iat('ExitProcess')), // DispatchMessage answered
            ];
            // As a compiler ends a void procedure on a call: RaiseException's
            // four arguments written over its own, and a jump, so the raise
            // returns where the procedure would have.
            const timerProc = [
                0xff, 0x05, ...u32(at('count')),                 // inc dword [count]
                0xc7, 0x44, 0x24, 0x04, ...u32(0xe000beef),      // mov [esp+4], code
                0xc7, 0x44, 0x24, 0x08, ...u32(0),               // mov [esp+8], 0
                0xc7, 0x44, 0x24, 0x0c, ...u32(0),               // mov [esp+12], 0
                0xc7, 0x44, 0x24, 0x10, ...u32(0),               // mov [esp+16], 0
                0xff, 0x25, ...u32(iat('RaiseException')),       // jmp [RaiseException]
            ];
            const bytes = new Array(0x100).fill(0xcc);
            bytes.splice(0, main.length, ...main);
            bytes.splice(0x80, timerProc.length, ...timerProc);
            return bytes;
        },
    });
}

test('an exception a TIMERPROC leaves ends DispatchMessage\'s call to it answering zero',
    { timeout: 60000 },
    async t=>{
        const { code } = await runExecutable(t, buildTimerProcExceptionExe());
        assert.equal(code, 0x5a, '0x77: DispatchMessage answered nonzero; 0x66: the procedure'
            + ' ran another number of times; anything else: the exception ended the process');
    });
