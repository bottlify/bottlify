/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * SetThreadContext moves a suspended thread: what a .NET runtime's collector
 * does to a thread it stopped in managed code, sending it to a stub that waits
 * for the collection. One thread spins; the first suspends it, reads its
 * context, sets its instruction pointer to a landing and a register to a mark,
 * reads the context back, resumes it, and the spinner runs the landing with
 * the mark - at 32 and 64 bits, on one executor and on two. The program checks
 * one property per bit of its exit code.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from './app.js';
import { buildExe } from '../../../tools/fixtures/make-pe.mjs';

/** @param {number} value @returns {number[]} */
const u32 = value=>[value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24 & 0xff];

/**
 * Waits, a millisecond at a time, until the dword at `address` is not zero: a
 * thread is in its loop once it has counted, however long its executor took to
 * open - a fixed sleep was no promise of that on a loaded machine, where the
 * thread was still in its own start when it was suspended.
 *
 * @param {number} address @param {(fn: string) => number[]} call
 */
const untilCounted = (address, call)=>[0x83, 0x3d, ...u32(address), 0x00, 0x75, 10,
    0x6a, 0x01, ...call('Sleep'), 0xeb, 0xed]; // cmp [address], 0; jne out; Sleep(1); jmp back

/**
 * Waits the same way until the dword at `address` is no longer EDI.
 *
 * @param {number} address @param {(fn: string) => number[]} call
 */
const untilMoved = (address, call)=>[0x3b, 0x3d, ...u32(address), 0x75, 10,
    0x6a, 0x01, ...call('Sleep'), 0xeb, 0xee]; // cmp edi, [address]; jne out; Sleep(1); jmp back

/**
 * Exit code bits: SetThreadContext answered TRUE (1), GetThreadContext then
 * read the new instruction pointer (2), and the thread ran there with the
 * register it was given (4).
 */
const ALL = 7;
const MARK = 0x1234;
const IMPORTS = ['CreateThread', 'Sleep', 'SuspendThread', 'ResumeThread', 'GetThreadContext',
    'SetThreadContext', 'WaitForSingleObject', 'ExitThread', 'ExitProcess'];

function program32(){
    return buildExe({
        imports: { 'KERNEL32.dll': IMPORTS },
        data: { ctx: new Array(0x2cc).fill(0), hit: [0, 0, 0, 0] },
        codeSize: 0x200,
        code: ({ iat, at, code })=>{
            /** @param {string} fn */
            const call = fn=>[0xff, 0x15, ...u32(iat(fn))];
            const ctx = at('ctx');
            /** @param {number} offset @param {number} value  mov dword [ctx+offset], value */
            const put = (offset, value)=>[0xc7, 0x05, ...u32(ctx + offset), ...u32(value)];
            const flag = (/** @type {number} */ bit)=>[0x81, 0xcb, ...u32(bit)]; // or ebx, bit
            /** @param {number} spinner @param {number} landing */
            const main = (spinner, landing)=>[
                0x31, 0xdb, //                                   xor ebx, ebx
                0x6a, 0x00, 0x6a, 0x00, 0x6a, 0x00, //           id, flags, parameter
                0x68, ...u32(spinner), 0x6a, 0x00, 0x6a, 0x00, // start, stack, attributes
                ...call('CreateThread'),
                0x89, 0xc6, //                                   mov esi, eax
                0x6a, 30, ...call('Sleep'),
                0x56, ...call('SuspendThread'),
                ...put(0, 0x10007), //                           CONTEXT_FULL
                0x68, ...u32(ctx), 0x56, ...call('GetThreadContext'),
                ...put(0xb8, landing), //                        Eip
                ...put(0xa4, MARK), //                           Ebx
                0x68, ...u32(ctx), 0x56, ...call('SetThreadContext'),
                0x85, 0xc0, 0x74, 6, ...flag(1), //              test eax, eax; jz
                ...put(0xb8, 0),
                0x68, ...u32(ctx), 0x56, ...call('GetThreadContext'),
                0x81, 0x3d, ...u32(ctx + 0xb8), ...u32(landing), 0x75, 6, ...flag(2),
                0x56, ...call('ResumeThread'),
                0x6a, 0xff, 0x56, ...call('WaitForSingleObject'), // INFINITE
                0x81, 0x3d, ...u32(at('hit')), ...u32(MARK), 0x75, 6, ...flag(4),
                0x53, ...call('ExitProcess'),
            ];
            const spin = [0xeb, 0xfe]; //                        jmp $
            const land = [
                0x89, 0x1d, ...u32(at('hit')), //                mov [hit], ebx
                0x6a, 0x00, ...call('ExitThread'),
            ];
            const length = main(0, 0).length;
            return [...main(code(length), code(length + spin.length)), ...spin, ...land];
        },
    });
}

/**
 * @param {boolean} [fresh]  the thread made CREATE_SUSPENDED: never run when its
 *     context is read and set, and resumed twice
 */
function program64(fresh = false){
    return buildExe({
        bits: 64,
        imports: { 'KERNEL32.dll': IMPORTS },
        data: { ctx: new Array(0x4d0).fill(0), hit: [0, 0, 0, 0] },
        codeSize: 0x300,
        code: ({ iat, at, code })=>{
            /** @type {number[]} */
            const bytes = [];
            /** @type {Array<[number, string]>} */
            const fixups = [];
            /** @param {...number} b */
            const emit = (...b)=>{
                bytes.push(...b);
            };
            /** @param {string} fn  a call through its slot */
            const call = fn=>emit(0xff, 0x15, ...u32(iat(fn) - (code(bytes.length) + 6)));
            /** @param {number[]} head  a RIP-relative instruction to a data name @param {string} name */
            const toData = (head, name)=>emit(...head,
                ...u32(at(name) - (code(bytes.length + head.length + 4))));
            /**
             * The same to a label, patched once it is known.
             *
             * @param {number[]} head @param {string} label
             */
            const toLabel = (head, label)=>{
                emit(...head, 0, 0, 0, 0);
                fixups.push([bytes.length, label]);
            };
            const flag = (/** @type {number} */ bit)=>emit(0x83, 0xcb, bit); // or ebx, bit
            emit(0x48, 0x83, 0xec, 0x48); //                     sub rsp, 72
            emit(0x31, 0xdb); //                                 xor ebx, ebx
            emit(0x31, 0xc9, 0x31, 0xd2); //                     xor ecx, ecx; xor edx, edx
            toLabel([0x4c, 0x8d, 0x05], 'spin'); //              lea r8, [spin]
            emit(0x45, 0x31, 0xc9); //                           xor r9d, r9d
            emit(0x48, 0xc7, 0x44, 0x24, 0x20, fresh ? 4 : 0, 0, 0, 0); // flags
            emit(0x48, 0xc7, 0x44, 0x24, 0x28, 0, 0, 0, 0); //   id
            call('CreateThread');
            emit(0x48, 0x89, 0xc6); //                           mov rsi, rax
            emit(0xb9, ...u32(30));
            call('Sleep');
            emit(0x48, 0x89, 0xf1);
            call('SuspendThread');
            toData([0x48, 0x8d, 0x3d], 'ctx'); //                lea rdi, [ctx]
            emit(0xc7, 0x47, 0x30, ...u32(0x100003)); //         ContextFlags: control, integer
            emit(0x48, 0x89, 0xf1, 0x48, 0x89, 0xfa);
            call('GetThreadContext');
            toLabel([0x48, 0x8d, 0x05], 'land'); //              lea rax, [land]
            emit(0x48, 0x89, 0x87, ...u32(0xf8)); //             mov [rdi+Rip], rax
            emit(0x48, 0xc7, 0x87, ...u32(0x90), ...u32(MARK)); // mov qword [rdi+Rbx], MARK
            emit(0x48, 0x89, 0xf1, 0x48, 0x89, 0xfa);
            call('SetThreadContext');
            emit(0x85, 0xc0, 0x74, 3);
            flag(1);
            emit(0x48, 0xc7, 0x87, ...u32(0xf8), ...u32(0));
            emit(0x48, 0x89, 0xf1, 0x48, 0x89, 0xfa);
            call('GetThreadContext');
            toLabel([0x48, 0x8d, 0x05], 'land');
            emit(0x48, 0x39, 0x87, ...u32(0xf8)); //             cmp [rdi+Rip], rax
            emit(0x75, 3);
            flag(2);
            emit(0x48, 0x89, 0xf1);
            call('ResumeThread');
            if (fresh)
            {
                emit(0x48, 0x89, 0xf1);
                call('ResumeThread');
            }
            emit(0x48, 0x89, 0xf1, 0xba, ...u32(0xffffffff)); // INFINITE
            call('WaitForSingleObject');
            toData([0x48, 0x8d, 0x05], 'hit');
            emit(0x81, 0x38, ...u32(MARK), 0x75, 3); //          cmp dword [rax], MARK
            flag(4);
            emit(0x89, 0xd9); //                                 mov ecx, ebx
            call('ExitProcess');
            /** @type {Record<string, number>} */
            const labels = { spin: bytes.length };
            emit(0xeb, 0xfe); //                                 jmp $
            labels.land = bytes.length;
            emit(0x48, 0x83, 0xe4, 0xf0, 0x48, 0x83, 0xec, 0x28); // and rsp, -16; sub rsp, 40
            toData([0x48, 0x8d, 0x05], 'hit');
            emit(0x89, 0x18, 0x31, 0xc9); //                     mov [rax], ebx; xor ecx, ecx
            call('ExitThread');
            for (const [end, label] of fixups)
            {
                const disp = u32(code(labels[label]) - code(end));
                bytes.splice(end - 4, 4, ...disp);
            }
            return bytes;
        },
    });
}

/**
 * A thread stopped in the middle of its own code, by a thread that may run on
 * another executor: its context is the instruction it stands on - EIP inside
 * its loop, ESP the stack it wrote down itself - it does not move while
 * suspended, and ResumeThread lets it go on from there. Exit code bits: EIP in
 * the loop (1), ESP its own (2), no step while suspended (4), steps again once
 * resumed (8).
 */
const STOPPED_ALL = 0xf;

function stoppedProgram(){
    return buildExe({
        imports: { 'KERNEL32.dll': [...IMPORTS, 'TerminateThread'] },
        data: { ctx: new Array(0x2cc).fill(0), count: [0, 0, 0, 0], seen: [0, 0, 0, 0] },
        codeSize: 0x200,
        code: ({ iat, at, code })=>{
            /** @param {string} fn */
            const call = fn=>[0xff, 0x15, ...u32(iat(fn))];
            const ctx = at('ctx');
            const flag = (/** @type {number} */ bit)=>[0x81, 0xcb, ...u32(bit)];
            /** @param {number} spinner @param {number} loop @param {number} end */
            const main = (spinner, loop, end)=>[
                0x31, 0xdb,
                0x6a, 0x00, 0x6a, 0x00, 0x6a, 0x00, 0x68, ...u32(spinner), 0x6a, 0x00, 0x6a, 0x00,
                ...call('CreateThread'),
                0x89, 0xc6,
                ...untilCounted(at('count'), call),
                0x56, ...call('SuspendThread'),
                0xc7, 0x05, ...u32(ctx), ...u32(0x10007),
                0x68, ...u32(ctx), 0x56, ...call('GetThreadContext'),
                0xa1, ...u32(ctx + 0xb8), //                     mov eax, [Eip]
                0x3d, ...u32(loop), 0x72, 13, //                 cmp eax, loop; jb
                0x3d, ...u32(end), 0x73, 6, ...flag(1), //       cmp eax, end; jae
                0xa1, ...u32(ctx + 0xc4), //                     mov eax, [Esp]
                0x3b, 0x05, ...u32(at('seen')), 0x75, 6, ...flag(2),
                0x8b, 0x3d, ...u32(at('count')), //              mov edi, [count]
                0x6a, 30, ...call('Sleep'),
                0x3b, 0x3d, ...u32(at('count')), 0x75, 6, ...flag(4),
                0x56, ...call('ResumeThread'),
                ...untilMoved(at('count'), call), ...flag(8),
                0x6a, 0x00, 0x56, ...call('TerminateThread'),
                0x53, ...call('ExitProcess'),
            ];
            const spin = [0x89, 0x25, ...u32(at('seen'))]; //   mov [seen], esp
            const loop = [0xff, 0x05, ...u32(at('count')), 0xeb, 0xf8]; // inc [count]; jmp loop
            const length = main(0, 0, 0).length;
            const start = code(length);
            const top = code(length + spin.length);
            return [...main(start, top, top + loop.length), ...spin, ...loop];
        },
    });
}

/**
 * The flags a stopped thread's context says are the ones its last instruction
 * left, not a word the translator had not yet brought up to date: a thread
 * adds one to -1 (carry and zero set) and spins; its context says CF and ZF.
 * A collector restores the context it read, so a stale word would be put back.
 */
function flagsProgram(){
    return buildExe({
        imports: { 'KERNEL32.dll': [...IMPORTS, 'TerminateThread'] },
        data: { ctx: new Array(0x2cc).fill(0), count: [0, 0, 0, 0] },
        codeSize: 0x100,
        code: ({ iat, at, code })=>{
            /** @param {string} fn */
            const call = fn=>[0xff, 0x15, ...u32(iat(fn))];
            const ctx = at('ctx');
            /** @param {number} spinner */
            const main = spinner=>[
                0x31, 0xdb,
                0x6a, 0x00, 0x6a, 0x00, 0x6a, 0x00, 0x68, ...u32(spinner), 0x6a, 0x00, 0x6a, 0x00,
                ...call('CreateThread'),
                0x89, 0xc6,
                ...untilCounted(at('count'), call),
                0x56, ...call('SuspendThread'),
                0xc7, 0x05, ...u32(ctx), ...u32(0x10001),
                0x68, ...u32(ctx), 0x56, ...call('GetThreadContext'),
                0x8b, 0x1d, ...u32(ctx + 0xc0), //               mov ebx, [EFlags]
                0x83, 0xe3, 0x41, //                             and ebx, CF | ZF
                0x6a, 0x00, 0x56, ...call('TerminateThread'),
                0x53, ...call('ExitProcess'),
            ];
            // mov eax, -1; add eax, 1; then count the turn touching no flag (mov, lea,
            // mov) and go round: once it has counted, the last flags set are the add's.
            const spin = [0xb8, ...u32(0xffffffff), 0x83, 0xc0, 0x01,
                0x8b, 0x0d, ...u32(at('count')), 0x8d, 0x49, 0x01, 0x89, 0x0d, ...u32(at('count')),
                0xeb, 0xe7];
            return [...main(code(main(0).length)), ...spin];
        },
    });
}

for (const cores of [1, 2])
{
    test(`a stopped thread's context carries the flags its last instruction left, ${cores}`
        + ' executor(s)', { timeout: 60000 }, async t=>{
        const app = await createApp({ executable: flagsProgram(), cpu: { cores } });
        t.after(()=>app.dispose());
        assert.equal(await app.run({ timeoutMs: 40000 }), 0x41, 'CF and ZF');
    });
}

for (const cores of [1, 2])
{
    test(`a thread suspended in its own code is read where it stands and goes on from there, ${
        cores} executor(s)`, { timeout: 60000 }, async t=>{
        const app = await createApp({ executable: stoppedProgram(), cpu: { cores } });
        t.after(()=>app.dispose());
        const code = await app.run({ timeoutMs: 40000 });
        assert.equal(code, STOPPED_ALL, `missing bits 0x${(STOPPED_ALL & ~code).toString(16)}`);
    });
}

for (const [bits, build] of /** @type {const} */ ([[32, program32], [64, program64]]))
{
    for (const cores of [1, 2])
    {
        test(`SetThreadContext sends a suspended thread where it says, ${bits}-bit, ${cores}`
            + ' executor(s)', { timeout: 60000 }, async t=>{
            const app = await createApp({ executable: build(), cpu: { cores } });
            t.after(()=>app.dispose());
            const code = await app.run({ timeoutMs: 40000 });
            assert.equal(code, ALL, `missing bits 0x${(ALL & ~code).toString(16)}`);
        });
    }
}

test('SetThreadContext sends a 64-bit thread made suspended, never run, off on its own stack',
    { timeout: 60000 }, async t=>{
        // Its stack pointer is in its context's dword view alone until it first
        // runs: a context read from the block alone sent it off with RSP 0.
        const app = await createApp({ executable: program64(true) });
        t.after(()=>app.dispose());
        const code = await app.run({ timeoutMs: 40000 });
        assert.equal(code, ALL, `missing bits 0x${(ALL & ~code).toString(16)}`);
    });
