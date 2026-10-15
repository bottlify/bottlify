/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The kernel32 exports that are code in the guest's own kernel32, called
 * through the import as a program calls them: the interlocked arithmetic,
 * thread-local storage, and critical sections -- whose contended entry is the
 * one place any of them reaches the host.
 *
 * Each program exits 0, or with the number of the first check that failed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from './app.js';
import { buildExe } from '../../../tools/make-pe.mjs';

/** @param {number} value */
const u32 = value=>[value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24 & 0xff];

/**
 * Bytes, labels, and near jumps to labels, laid out with every displacement
 * filled in.
 *
 * @param {(number[] | string | { jump: number[], to: string })[]} pieces
 * @returns {number[]}
 */
function assemble(pieces){
    /** @type {Map<string, number>} */
    const labels = new Map();
    let at = 0;
    for (const piece of pieces)
    {
        if (typeof piece === 'string')
        {
            labels.set(piece, at);
        }
        else
        {
            at += Array.isArray(piece) ? piece.length : piece.jump.length + 4;
        }
    }
    /** @type {number[]} */
    const out = [];
    for (const piece of pieces)
    {
        if (typeof piece === 'string')
        {
            continue;
        }
        if (Array.isArray(piece))
        {
            out.push(...piece);
            continue;
        }
        const target = labels.get(piece.to);
        assert.ok(target !== undefined, `no label ${piece.to}`);
        out.push(...piece.jump);
        out.push(...u32(target - (out.length + 4)));
    }
    return out;
}

const JNE = [0x0f, 0x85];
const JNZ = JNE;
const JE = [0x0f, 0x84];
const JAE = [0x0f, 0x83];
const JMP = [0xe9];

/**
 * The context `buildExe` hands a program's code, and the few instructions
 * every program here is written in.
 *
 * @param {{ iat: (name: string) => number, at: (name: string) => number }} context
 */
const toolkit = ({ iat, at })=>({
    /** @param {string} name */
    call: name=>[0xff, 0x15, ...u32(iat(name))],
    /** @param {string} name @param {number} [offset] */
    push: (name, offset = 0)=>[0x68, ...u32(at(name) + offset)],
    /** push dword [name] @param {string} name */
    pushFrom: (name, offset = 0)=>[0xff, 0x35, ...u32(at(name) + offset)],
    /** @param {number} value */
    pushValue: value=>[0x68, ...u32(value)],
    /** mov dword [name], value @param {string} name @param {number} value */
    store: (name, value, offset = 0)=>[0xc7, 0x05, ...u32(at(name) + offset), ...u32(value)],
    /** mov [name], eax @param {string} name */
    keep: (name, offset = 0)=>[0xa3, ...u32(at(name) + offset)],
    /** cmp dword [name], value @param {string} name @param {number} value */
    compare: (name, value, offset = 0)=>[0x81, 0x3d, ...u32(at(name) + offset), ...u32(value)],
    /** mov ebx, n: the check that is running, which a failure exits with */
    check: (/** @type {number} */ number)=>[0xbb, ...u32(number)],
    exit: ()=>[0x6a, 0x00, 0xff, 0x15, ...u32(iat('ExitProcess'))],
    /** The shared ending: `fail` exits with the number of the check. */
    fail: ()=>['fail', [0x53, 0xff, 0x15, ...u32(iat('ExitProcess'))]],
    /**
     * CreateThread(NULL, 0, start, NULL, 0, NULL), the handle kept.
     * @param {number} start @param {string} handles @param {number} index
     */
    spawn: (start, handles, index)=>[
        0x6a, 0x00, 0x6a, 0x00, 0x6a, 0x00, 0x68, ...u32(start), 0x6a, 0x00, 0x6a, 0x00,
        0xff, 0x15, ...u32(iat('CreateThread')),
        0xa3, ...u32(at(handles) + index * 4),
    ],
});

/** What the callee-saved registers hold across every call, to be found there after. */
const KEPT = { esi: 0x51515151, edi: 0x7e7e7e7e, ebp: 0x3c3c3c3c };

/**
 * Each interlocked export once or twice through the import: what it answered,
 * what it left in the dword, that it popped exactly its arguments, and that
 * it kept the registers a stdcall callee keeps.
 */
function buildInterlockedExe(){
    const names = ['InterlockedIncrement', 'InterlockedDecrement', 'InterlockedExchange',
        'InterlockedExchangeAdd', 'InterlockedCompareExchange'];
    return buildExe({
        imports: { 'KERNEL32.dll': [...names, 'ExitProcess'] },
        data: { counter: [0, 0, 0, 0], stack: [0, 0, 0, 0] },
        codeSize: 0x600,
        code: context=>{
            const { call, push, pushValue, store, compare, check, exit, fail } = toolkit(context);
            let number = 0;
            /**
             * @param {number[]} pushes  the arguments after the pointer, last first
             * @param {string} name @param {number} answer @param {number} left
             */
            const step = (pushes, name, answer, left)=>[
                check(++number),
                [0x89, 0x25, ...u32(context.at('stack'))],            // mov [stack], esp
                pushes, push('counter'), call(name),
                [0x3b, 0x25, ...u32(context.at('stack'))],            // cmp esp, [stack]
                { jump: JNE, to: 'fail' },
                [0x3d, ...u32(answer)], { jump: JNE, to: 'fail' },     // cmp eax, answer
                compare('counter', left), { jump: JNE, to: 'fail' },
                [0x81, 0xfe, ...u32(KEPT.esi)], { jump: JNE, to: 'fail' },
                [0x81, 0xff, ...u32(KEPT.edi)], { jump: JNE, to: 'fail' },
                [0x81, 0xfd, ...u32(KEPT.ebp)], { jump: JNE, to: 'fail' },
            ];
            return assemble([
                [0xbe, ...u32(KEPT.esi), 0xbf, ...u32(KEPT.edi), 0xbd, ...u32(KEPT.ebp)],
                store('counter', 5),
                ...step([], 'InterlockedIncrement', 6, 6),
                ...step([], 'InterlockedDecrement', 5, 5),
                store('counter', 0),
                ...step([], 'InterlockedDecrement', 0xffffffff, 0xffffffff),
                store('counter', 0x7fffffff),
                ...step([], 'InterlockedIncrement', 0x80000000, 0x80000000),
                store('counter', 5),
                ...step(pushValue(42), 'InterlockedExchange', 5, 42),
                // Comparand first, then the exchange: pushed right to left.
                ...step([...pushValue(42), ...pushValue(7)], 'InterlockedCompareExchange', 42, 7),
                ...step([...pushValue(42), ...pushValue(9)], 'InterlockedCompareExchange', 7, 7),
                ...step(pushValue(10), 'InterlockedExchangeAdd', 7, 17),
                ...step(pushValue(-20 >>> 0), 'InterlockedExchangeAdd', 17, -3 >>> 0),
                exit(),
                ...fail(),
            ]);
        },
    });
}

const WORKERS = 3;
const TURNS = 3000;

/**
 * Three threads counting into two shared dwords through the import, preempted
 * wherever the quantum ends: every increment has to land.
 */
function buildInterlockedRaceExe(){
    return buildExe({
        imports: { 'KERNEL32.dll': ['InterlockedIncrement', 'InterlockedExchangeAdd',
            'CreateThread', 'ExitThread', 'WaitForMultipleObjects', 'ExitProcess'] },
        data: { counter: [0, 0, 0, 0], total: [0, 0, 0, 0], handles: new Array(16).fill(0) },
        codeSize: 0x200,
        code: context=>{
            const { call, push, compare, check, exit, fail, spawn } = toolkit(context);
            const worker = context.code(0x100);
            const main = assemble([
                ...[0, 1, 2].map(index=>spawn(worker, 'handles', index)),
                [0x6a, 0xff, 0x6a, 0x01], push('handles'), [0x6a, WORKERS],
                call('WaitForMultipleObjects'),
                check(1), compare('counter', WORKERS * TURNS), { jump: JNE, to: 'fail' },
                check(2), compare('total', 3 * WORKERS * TURNS), { jump: JNE, to: 'fail' },
                exit(),
                ...fail(),
            ]);
            const body = assemble([
                [0xbe, ...u32(TURNS)],                                   // mov esi, TURNS
                'turn',
                push('counter'), call('InterlockedIncrement'),
                [0x6a, 0x03], push('total'), call('InterlockedExchangeAdd'),
                [0x4e], { jump: JNZ, to: 'turn' },                       // dec esi; jnz
                [0x6a, 0x00], call('ExitThread'),
            ]);
            return [...main, ...new Array(0x100 - main.length).fill(0x90), ...body];
        },
    });
}

/**
 * TlsAlloc, TlsSetValue and TlsGetValue through the import: a value set is
 * the value read, by the API and by the compiler's own `fs:[0x2c]` sequence;
 * a get clears the last error and a set leaves it; another thread has its
 * own; a slot past the thread's array goes through the host and works the
 * same; an index past every slot fails with ERROR_INVALID_PARAMETER; a freed
 * slot reads as zero, and a value set in it while it was free is gone once
 * TlsAlloc hands it out again.
 */
function buildTlsExe(){
    const ERROR_INVALID_PARAMETER = 87;
    return buildExe({
        imports: { 'KERNEL32.dll': ['TlsAlloc', 'TlsFree', 'TlsGetValue', 'TlsSetValue',
            'GetLastError', 'SetLastError', 'CreateThread', 'ExitThread',
            'WaitForSingleObject', 'ExitProcess'] },
        data: { index: [0, 0, 0, 0], high: [0, 0, 0, 0], handles: [0, 0, 0, 0],
            seen: [0xff, 0xff, 0xff, 0xff, 0, 0, 0, 0] },
        codeSize: 0x400,
        code: context=>{
            const { call, pushFrom, pushValue, compare, keep, check, exit, fail, spawn } =
                toolkit(context);
            const worker = context.code(0x300);
            /** cmp eax, value; jne fail @param {number} value */
            const expect = value=>[[0x3d, ...u32(value)], { jump: JNE, to: 'fail' }];
            /** @param {number} code */
            const errorIs = code=>[call('GetLastError'), ...expect(code)];
            const main = assemble([
                check(1), call('TlsAlloc'), keep('index'),
                [0x3d, ...u32(0xffffffff)], { jump: JE, to: 'fail' },     // TLS_OUT_OF_INDEXES
                check(2), pushValue(5), call('SetLastError'),
                pushValue(0x1234), pushFrom('index'), call('TlsSetValue'), ...expect(1),
                check(3), ...errorIs(5),
                check(4), pushFrom('index'), call('TlsGetValue'), ...expect(0x1234),
                check(5), ...errorIs(0),
                // __declspec(thread) as the compiler reads it.
                check(6), [0x64, 0x8b, 0x0d, 0x2c, 0, 0, 0],             // mov ecx, fs:[0x2c]
                [0xa1, ...u32(context.at('index'))],                     // mov eax, [index]
                [0x8b, 0x04, 0x81], ...expect(0x1234),                   // mov eax, [ecx+eax*4]
                spawn(worker, 'handles', 0),
                [0x6a, 0xff], pushFrom('handles'), call('WaitForSingleObject'),
                check(7), compare('seen', 0), { jump: JNE, to: 'fail' },
                check(8), compare('seen', 0x5678, 4), { jump: JNE, to: 'fail' },
                check(9), pushFrom('index'), call('TlsGetValue'), ...expect(0x1234),
                // Past the array: allocate until an index of 64 or more.
                check(10), [0xbe, ...u32(100)],                          // mov esi, 100
                'more',
                call('TlsAlloc'), [0x83, 0xf8, 64], { jump: JAE, to: 'found' }, // cmp eax, 64
                [0x4e], { jump: JNZ, to: 'more' },                       // dec esi
                { jump: JMP, to: 'fail' },
                'found',
                keep('high'),
                check(11), pushValue(0x9abc), pushFrom('high'), call('TlsSetValue'), ...expect(1),
                pushValue(5), call('SetLastError'),
                check(12), pushFrom('high'), call('TlsGetValue'), ...expect(0x9abc),
                check(13), ...errorIs(0),
                check(14), pushValue(1), pushValue(5000), call('TlsSetValue'), ...expect(0),
                check(15), ...errorIs(ERROR_INVALID_PARAMETER),
                check(16), pushFrom('index'), call('TlsFree'), ...expect(1),
                check(17), [0x64, 0x8b, 0x0d, 0x2c, 0, 0, 0],
                [0xa1, ...u32(context.at('index'))], [0x8b, 0x04, 0x81], ...expect(0),
                // A freed slot is still written, as on Windows, and its next
                // owner reads zero all the same.
                check(18), pushValue(0x4321), pushFrom('index'), call('TlsSetValue'), ...expect(1),
                check(19), call('TlsAlloc'),
                [0x3b, 0x05, ...u32(context.at('index'))],               // cmp eax, [index]
                { jump: JNE, to: 'fail' },
                check(20), pushFrom('index'), call('TlsGetValue'), ...expect(0),
                check(21), [0x64, 0x8b, 0x0d, 0x2c, 0, 0, 0],
                [0xa1, ...u32(context.at('index'))], [0x8b, 0x04, 0x81], ...expect(0),
                exit(),
                ...fail(),
            ]);
            const body = assemble([
                pushFrom('index'), call('TlsGetValue'), keep('seen'),
                pushValue(0x5678), pushFrom('index'), call('TlsSetValue'),
                pushFrom('index'), call('TlsGetValue'), keep('seen', 4),
                [0x6a, 0x00], call('ExitThread'),
            ]);
            assert.ok(main.length <= 0x300, `main is ${main.length} bytes`);
            return [...main, ...new Array(0x300 - main.length).fill(0x90), ...body];
        },
    });
}

/** RTL_CRITICAL_SECTION's fields. */
const CS = { LOCK_COUNT: 4, RECURSION_COUNT: 8, OWNING_THREAD: 12 };
const SECTION_TURNS = 64;

/**
 * Three threads through one section, each entering it twice a turn, reading
 * the shared count, sometimes sleeping while they hold it -- which is when the
 * others arrive and wait in the host -- and writing it back one higher. Inside,
 * the owner is always the thread itself at recursion two. Afterwards the
 * count is exact and the section is free.
 */
function buildSectionRaceExe(){
    return buildExe({
        imports: { 'KERNEL32.dll': ['InitializeCriticalSection', 'EnterCriticalSection',
            'LeaveCriticalSection', 'Sleep', 'CreateThread', 'ExitThread',
            'WaitForMultipleObjects', 'ExitProcess'] },
        data: { section: new Array(24).fill(0), counter: [0, 0, 0, 0], bad: [0, 0, 0, 0],
            handles: new Array(16).fill(0) },
        codeSize: 0x300,
        code: context=>{
            const { call, push, store, compare, check, exit, fail, spawn } = toolkit(context);
            const worker = context.code(0x180);
            const main = assemble([
                push('section'), call('InitializeCriticalSection'),
                ...[0, 1, 2].map(index=>spawn(worker, 'handles', index)),
                [0x6a, 0xff, 0x6a, 0x01], push('handles'), [0x6a, WORKERS],
                call('WaitForMultipleObjects'),
                check(1), compare('bad', 0), { jump: JNE, to: 'fail' },
                check(2), compare('counter', WORKERS * SECTION_TURNS), { jump: JNE, to: 'fail' },
                check(3), compare('section', 0xffffffff, CS.LOCK_COUNT), { jump: JNE, to: 'fail' },
                check(4), compare('section', 0, CS.RECURSION_COUNT), { jump: JNE, to: 'fail' },
                check(5), compare('section', 0, CS.OWNING_THREAD), { jump: JNE, to: 'fail' },
                exit(),
                ...fail(),
            ]);
            const body = assemble([
                [0xbe, ...u32(SECTION_TURNS)],                              // mov esi, turns
                'turn',
                push('section'), call('EnterCriticalSection'),
                push('section'), call('EnterCriticalSection'),
                [0x64, 0xa1, 0x24, 0, 0, 0],                                // mov eax, fs:[0x24]
                [0x39, 0x05, ...u32(context.at('section') + CS.OWNING_THREAD)], // cmp [owner], eax
                { jump: JNE, to: 'bad' },
                compare('section', 2, CS.RECURSION_COUNT), { jump: JNE, to: 'bad' },
                [0x8b, 0x3d, ...u32(context.at('counter'))],                // mov edi, [counter]
                [0xf7, 0xc6, ...u32(15)], { jump: JNZ, to: 'held' },        // test esi, 15
                [0x6a, 0x01], call('Sleep'),                                // Sleep(1), holding it
                'held',
                [0x47, 0x89, 0x3d, ...u32(context.at('counter'))],          // inc edi; store it
                push('section'), call('LeaveCriticalSection'),
                compare('section', 1, CS.RECURSION_COUNT), { jump: JNE, to: 'bad' },
                push('section'), call('LeaveCriticalSection'),
                [0x4e], { jump: JNZ, to: 'turn' },
                [0x6a, 0x00], call('ExitThread'),
                'bad',
                store('bad', 1), [0x6a, 0x00], call('ExitThread'),
            ]);
            assert.ok(main.length <= 0x180, `main is ${main.length} bytes`);
            return [...main, ...new Array(0x180 - main.length).fill(0x90), ...body];
        },
    });
}

/**
 * The main thread holds the section while a second thread tries it (and is
 * refused) and then enters it: the second waits in the host, the count says
 * one thread is queued, and nothing past its entry runs until the main
 * thread -- which meanwhile takes it once more by trying -- leaves it for the
 * last time, which hands the section over, with the structure naming the new
 * owner before it runs.
 */
function buildSectionHandoffExe(){
    return buildExe({
        imports: { 'KERNEL32.dll': ['InitializeCriticalSection', 'EnterCriticalSection',
            'LeaveCriticalSection', 'TryEnterCriticalSection', 'GetCurrentThreadId', 'Sleep',
            'CreateThread', 'ExitThread', 'WaitForSingleObject', 'ExitProcess'] },
        data: { section: new Array(24).fill(0), handles: [0, 0, 0, 0],
            tried: [0xff, 0xff, 0xff, 0xff], reached: [0, 0, 0, 0], inside: [0, 0, 0, 0],
            owner: [0, 0, 0, 0], recursion: [0, 0, 0, 0], id: [0, 0, 0, 0] },
        codeSize: 0x300,
        code: context=>{
            const { call, push, pushFrom, store, compare, keep, check, exit, fail, spawn } =
                toolkit(context);
            const worker = context.code(0x200);
            const main = assemble([
                push('section'), call('InitializeCriticalSection'),
                push('section'), call('EnterCriticalSection'),
                spawn(worker, 'handles', 0),
                // Until the worker waits: at once on one processor, whenever its
                // own gets to it on several.
                'waiting', [0x6a, 0x01], call('Sleep'),
                compare('section', 1, CS.LOCK_COUNT), { jump: JNE, to: 'waiting' },
                check(1), compare('tried', 0), { jump: JNE, to: 'fail' },
                check(2), compare('reached', 1), { jump: JNE, to: 'fail' },
                check(3), compare('inside', 0), { jump: JNE, to: 'fail' },
                check(4), compare('section', 1, CS.LOCK_COUNT), { jump: JNE, to: 'fail' },
                // The owner's own try is a recursion, counted as the entry would be.
                check(5), push('section'), call('TryEnterCriticalSection'),
                [0x3d, ...u32(1)], { jump: JNE, to: 'fail' },
                check(6), compare('section', 2, CS.LOCK_COUNT), { jump: JNE, to: 'fail' },
                compare('section', 2, CS.RECURSION_COUNT), { jump: JNE, to: 'fail' },
                push('section'), call('LeaveCriticalSection'),
                push('section'), call('LeaveCriticalSection'),
                [0x6a, 0xff], pushFrom('handles'), call('WaitForSingleObject'),
                check(7), compare('inside', 1), { jump: JNE, to: 'fail' },
                check(8), [0xa1, ...u32(context.at('owner'))],           // mov eax, [owner]
                [0x3b, 0x05, ...u32(context.at('id'))], { jump: JNE, to: 'fail' },
                check(9), compare('recursion', 1), { jump: JNE, to: 'fail' },
                check(10), compare('section', 0xffffffff, CS.LOCK_COUNT), { jump: JNE, to: 'fail' },
                check(11), compare('section', 0, CS.OWNING_THREAD), { jump: JNE, to: 'fail' },
                exit(),
                ...fail(),
            ]);
            const body = assemble([
                call('GetCurrentThreadId'), keep('id'),
                push('section'), call('TryEnterCriticalSection'), keep('tried'),
                store('reached', 1),
                push('section'), call('EnterCriticalSection'),
                [0xa1, ...u32(context.at('section') + CS.OWNING_THREAD)], keep('owner'),
                [0xa1, ...u32(context.at('section') + CS.RECURSION_COUNT)], keep('recursion'),
                store('inside', 1),
                push('section'), call('LeaveCriticalSection'),
                [0x6a, 0x00], call('ExitThread'),
            ]);
            assert.ok(main.length <= 0x200, `main is ${main.length} bytes`);
            return [...main, ...new Array(0x200 - main.length).fill(0x90), ...body];
        },
    });
}

/**
 * The calls that are a few instructions in the guest, each against what the
 * process block or the host says: GetProcessHeap is PEB->ProcessHeap and a
 * heap to allocate from, GetVersion the version the block holds, the two
 * pseudo-handles, and the host's GetCurrentThreadId the block's id and, in a
 * second thread, the id CreateThread answered; lstrlen and lstrcpy in both
 * widths, a null pointer 0 in the guest and one the guest cannot read (0x100)
 * 0 from the host, and a copy compared by the host's lstrcmpA.
 */
function buildSimpleCallsExe(){
    return buildExe({
        imports: { 'KERNEL32.dll': ['GetProcessHeap', 'HeapAlloc', 'GetVersion',
            'GetCurrentProcess', 'GetCurrentThread', 'GetCurrentThreadId', 'lstrlenA',
            'lstrlenW', 'lstrcpyA', 'lstrcpyW', 'lstrcmpA', 'CreateThread', 'ExitThread',
            'WaitForSingleObject', 'ExitProcess'] },
        data: { text: [...'hello', '\0'].map(c=>c.charCodeAt(0)),
            wide: [...'h\u00e9llo', '\0']
                .flatMap(c=>[c.charCodeAt(0) & 0xff, c.charCodeAt(0) >>> 8]),
            buffer: new Array(16).fill(0xcc), wideBuffer: new Array(16).fill(0xcc),
            handles: [0, 0, 0, 0], id: [0, 0, 0, 0], seen: [0, 0, 0, 0], main: [0, 0, 0, 0] },
        codeSize: 0x400,
        code: context=>{
            const { call, push, pushFrom, pushValue, keep, compare, check, exit, fail } =
                toolkit(context);
            const worker = context.code(0x300);
            /** cmp eax, value; jne fail @param {number} value */
            const expect = value=>[[0x3d, ...u32(value)], { jump: JNE, to: 'fail' }];
            const main = assemble([
                check(1), call('GetProcessHeap'), [0x85, 0xc0], { jump: JE, to: 'fail' },
                [0x64, 0x8b, 0x0d, 0x30, 0, 0, 0, 0x3b, 0x41, 0x18],    // cmp eax, [peb + 0x18]
                { jump: JNE, to: 'fail' },
                pushValue(8), pushValue(0), [0x50], call('HeapAlloc'),  // HeapAlloc(it, 0, 8)
                [0x85, 0xc0], { jump: JE, to: 'fail' },
                // (build & 0x7fff) << 16 | minor << 8 | major, from the process block
                check(2), [0x64, 0x8b, 0x0d, 0x30, 0, 0, 0],             // mov ecx, fs:[0x30]
                [0x0f, 0xb7, 0x91, 0xac, 0, 0, 0],                      // movzx edx, word [+0xac]
                [0x81, 0xe2, ...u32(0x7fff), 0xc1, 0xe2, 0x10],          // and edx; shl edx, 16
                [0x8b, 0x81, 0xa8, 0, 0, 0, 0xc1, 0xe0, 0x08],          // eax = minor << 8
                [0x0b, 0x81, 0xa4, 0, 0, 0, 0x09, 0xc2],                // | major; edx |= eax
                [0x52], call('GetVersion'), [0x5a, 0x39, 0xd0], { jump: JNE, to: 'fail' },
                check(3), call('GetCurrentProcess'), ...expect(0xffffffff),
                check(4), call('GetCurrentThread'), ...expect(0xfffffffe),
                check(5), call('GetCurrentThreadId'), keep('main'),
                [0x64, 0x3b, 0x05, 0x24, 0, 0, 0], { jump: JNE, to: 'fail' },  // cmp eax, fs:[0x24]
                [0x85, 0xc0], { jump: JE, to: 'fail' },
                check(6), push('text'), call('lstrlenA'), ...expect(5),
                pushValue(0), call('lstrlenA'), ...expect(0),
                pushValue(0x100), call('lstrlenA'), ...expect(0),
                check(7), push('wide'), call('lstrlenW'), ...expect(5),
                check(8), push('text'), push('buffer'), call('lstrcpyA'),
                [0x3d, ...u32(context.at('buffer'))], { jump: JNE, to: 'fail' },
                push('text'), push('buffer'), call('lstrcmpA'), ...expect(0),
                compare('buffer', 0xcccc006f, 4), { jump: JNE, to: 'fail' },    // "o\0" and after
                check(9), push('wide'), push('wideBuffer'), call('lstrcpyW'),
                [0x3d, ...u32(context.at('wideBuffer'))], { jump: JNE, to: 'fail' },
                push('wideBuffer'), call('lstrlenW'), ...expect(5),
                // CreateThread(NULL, 0, worker, NULL, 0, &id)
                check(10), push('id'), [0x6a, 0x00, 0x6a, 0x00, 0x68, ...u32(worker), 0x6a, 0x00,
                    0x6a, 0x00], call('CreateThread'), keep('handles'),
                [0x6a, 0xff], pushFrom('handles'), call('WaitForSingleObject'),
                [0xa1, ...u32(context.at('seen'))], [0x3b, 0x05, ...u32(context.at('id'))],
                { jump: JNE, to: 'fail' },
                [0x3b, 0x05, ...u32(context.at('main'))], { jump: JE, to: 'fail' },
                exit(),
                ...fail(),
            ]);
            const body = assemble([
                call('GetCurrentThreadId'), keep('seen'),
                [0x6a, 0x00], call('ExitThread'),
            ]);
            assert.ok(main.length <= 0x300, `main is ${main.length} bytes`);
            return [...main, ...new Array(0x300 - main.length).fill(0x90), ...body];
        },
    });
}

/**
 * Runs a program to its exit, and reads before the machine goes what crossed
 * into the host: the bridge's most frequent calls, and what the host's half
 * of the critical sections counted.
 *
 * @param {Uint8Array} executable @param {number} [quantum]
 */
async function run(executable, quantum){
    const app = await createApp({ executable, quantum });
    try
    {
        const code = await app.run({ timeoutMs: 30000 });
        const win32 = app.diagnostics().find((/** @type {any} */ layer)=>layer.name === 'win32');
        const bridge = app.diagnostics().find((/** @type {any} */ layer)=>layer.name === 'bridge');
        return {
            code,
            sections: win32?.metrics?.criticalSections,
            /** @type {[string, number][]} */
            hot: bridge?.metrics?.hot ?? [],
        };
    }
    finally
    {
        await app.dispose();
    }
}

test(`the interlocked exports answer as Windows does, in the guest`,
    { timeout: 60000 }, async()=>{
        const { code, hot } = await run(buildInterlockedExe());
        assert.equal(code, 0, 'the number of the first check that failed');
        assert.deepEqual(hot.filter(([name])=>name.includes('Interlocked')), [],
            'and none of them crossed into the host');
    });

test(`interlocked increments from three preempted threads all land`,
    { timeout: 60000 }, async()=>{
        const { code } = await run(buildInterlockedRaceExe(), 97);
        assert.equal(code, 0, '1: an increment was lost; 2: an addition was');
    });

test(`a thread-local slot set in the guest is the slot every reader sees`,
    { timeout: 60000 }, async()=>{
        const { code, hot } = await run(buildTlsExe());
        assert.equal(code, 0, 'the number of the first check that failed');
        const crossed = Object.fromEntries(hot);
        assert.equal(crossed['<tls-set>'], 2, 'only the two sets past the array crossed');
        assert.equal(crossed['<tls-get>'], 1, 'and the one get');
    });

test('three threads share a section with recursion and the count comes out exact',
    { timeout: 60000 }, async()=>{
        const { code, sections } = await run(buildSectionRaceExe(), 97);
        assert.equal(code, 0, '1: a thread found the section wrong inside it; 2: an update'
            + ' was lost; 3-5: the section was not left free');
        const passes = WORKERS * SECTION_TURNS * 2;
        assert.equal(sections.entered, passes, 'every entry ran the guest\'s fast path');
        assert.equal(sections.left, passes);
        assert.ok(sections.waits > 0, 'some entries found it held and waited in the host');
        assert.equal(sections.handoffs, sections.waits, 'and each waiter was handed it');
        assert.equal(sections.queued, 0);
        assert.equal(sections.owed, 0);
    });

test(`the calls a few instructions long answer in the guest as the host does`,
    { timeout: 60000 }, async()=>{
        const { code, hot } = await run(buildSimpleCallsExe());
        assert.equal(code, 0, 'the number of the first check that failed');
        const crossed = Object.fromEntries(hot);
        for (const name of ['GetProcessHeap', 'GetVersion', 'GetCurrentProcess',
            'GetCurrentThread', 'lstrlenW', 'lstrcpyA', 'lstrcpyW'])
        {
            assert.equal(crossed[`KERNEL32.dll!${name}`], undefined, `${name} crossed`);
        }
        assert.equal(crossed['KERNEL32.dll!lstrlenA'], 1, 'only the pointer at 0x100');
        assert.equal(crossed['KERNEL32.dll!lstrcmpA'], 1, 'lstrcmpA stays the host\'s');
    });

test(`a thread waiting for a section waits in the host and is handed it`,
    { timeout: 60000 }, async()=>{
        const { code, sections } = await run(buildSectionHandoffExe());
        assert.equal(code, 0, 'the number of the first check that failed');
        assert.equal(sections.waits, 1, 'the second thread waited once');
        assert.equal(sections.wakes, 1, 'the main thread\'s leave woke it');
        assert.equal(sections.handoffs, 1);
        assert.equal(sections.queued, 0);
        assert.equal(sections.entered, 3,
            'two entries and the owner\'s try, and not the refused one');
        assert.equal(sections.left, 3);
    });
