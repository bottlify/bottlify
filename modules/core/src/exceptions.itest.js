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
import { buildExe } from '../../../tools/make-pe.mjs';

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
    { timeout: 60000, todo: 'the first 64 KiB stay open until a store alone can fault there' },
    async t=>{
        const { code } = await runExecutable(t, buildNullStoreExe());
        assert.equal(code, 0, '1: the context\'s Esp was another; 2: the frame was another;'
            + ' 4: it went on on another stack; 0x77: the store went through');
    });
