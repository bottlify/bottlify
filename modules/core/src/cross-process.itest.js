/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The gate of the calls a parent makes in its child: one mechanism -- the
 * call sent to the child and made there -- over three ways a child runs, on
 * its parent's thread, in a worker of its own, and beside a parent that runs
 * in a worker, reached through the run. Seeded programs make the same calls
 * down each; everything the parent can observe -- each result, the last
 * error after it, every byte the calls wrote back, the child's exit code --
 * is written out and compared.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from './app.js';
import { buildExe } from '../../../tools/make-pe.mjs';

/** @param {number} value */
const u32 = value=>[value & 255, value >>> 8 & 255, value >>> 16 & 255, value >>> 24 & 255];
/** @param {string} text */
const ascii = text=>[...text].map(character=>character.charCodeAt(0)).concat(0);

/** @param {number} seed */
function random(seed){
    let state = seed >>> 0;
    return ()=>{
        state = (state + 0x6d2b79f5) >>> 0;
        let mixed = Math.imul(state ^ state >>> 15, 1 | state);
        mixed ^= mixed + Math.imul(mixed ^ mixed >>> 7, 61 | mixed);
        return ((mixed ^ mixed >>> 14) >>> 0) / 2 ** 32;
    };
}

const CREATE_SUSPENDED = 4;
const CONTEXT_BYTES = 0x2cc;
const OPS = 28;

/**
 * A parent that starts the child suspended, makes a seeded run of calls in
 * it, resumes it, waits for it and writes, in hex on its standard output,
 * every result, last error and byte that came back.
 *
 * @param {number} seed
 */
function seededParent(seed){
    const next = random(seed);
    /** @param {number} below */
    const pick = below=>Math.floor(next() * below);
    /** @type {{ name: string, args: (number | 'process' | 'thread' | [string, number])[],
     *     extra: number, before?: [number, number], store?: string }[]} */
    const ops = [];
    let suspended = 1;
    /** Where each op's answer goes in `out`: result, last error, then its bytes. */
    let size = 0;
    const slot = (/** @type {number} */ extra)=>{
        const at = size;
        size += 8 + ((extra + 3) & ~3);
        return at;
    };
    /** An address in the child: a region it was given, at an offset, or none. */
    const where = ()=>(next() < 0.85
        ? /** @type {[string, number]} */ ([`base${pick(4)}`, pick(3) * 0x1000 + pick(64) * 4])
        : 0x10 + pick(0x100) * 4);
    for (let index = 0; index < OPS; index++)
    {
        const kind = pick(10);
        if (kind <= 1)
        {
            const protect = [4, 2, 0x40, 1][pick(4)];
            ops.push({ name: 'VirtualAllocEx', args: ['process', 0,
                (1 + pick(3)) * 0x1000 - pick(2) * 0x80, 0x3000, protect], extra: 0,
            store: `base${pick(4)}` });
            continue;
        }
        if (kind === 2)
        {
            const count = 1 + pick(48);
            ops.push({ name: 'WriteProcessMemory', args: ['process', where(),
                ['payload', pick(64)], count, ['out', 8]], extra: 4 });
            continue;
        }
        if (kind === 3)
        {
            const count = 1 + pick(48);
            ops.push({ name: 'ReadProcessMemory', args: ['process', where(), ['out', 12], count,
                ['out', 8]], extra: 4 + count });
            continue;
        }
        if (kind === 4)
        {
            ops.push({ name: 'VirtualQueryEx', args: ['process', where(), ['out', 8], 28],
                extra: 28 });
            continue;
        }
        if (kind === 5)
        {
            ops.push({ name: 'VirtualProtectEx', args: ['process', where(),
                1 + pick(0x2000), [4, 2, 0x40, 0x20][pick(4)], ['out', 8]], extra: 4 });
            continue;
        }
        if (kind === 6)
        {
            const release = next() < 0.6;
            ops.push({ name: 'VirtualFreeEx', args: ['process', where(),
                release ? 0 : 0x1000, release ? 0x8000 : 0x4000], extra: 0 });
            continue;
        }
        if (kind === 7)
        {
            ops.push({ name: 'SuspendThread', args: ['thread'], extra: 0 });
            suspended++;
            continue;
        }
        if (kind === 8 && suspended > 1)
        {
            ops.push({ name: 'ResumeThread', args: ['thread'], extra: 0 });
            suspended--;
            continue;
        }
        // CONTEXT_CONTROL | CONTEXT_INTEGER, set in the record before the call.
        ops.push({ name: 'GetThreadContext', args: ['thread', ['out', 8]], extra: CONTEXT_BYTES,
            before: [8, 0x10003] });
    }
    // The child may run now: resumed to zero, it exits, and its code is seen.
    while (suspended > 0)
    {
        ops.push({ name: 'ResumeThread', args: ['thread'], extra: 0 });
        suspended--;
    }
    const places = ops.map(op=>slot(op.extra));
    const exitAt = slot(0);
    const payload = Array.from({ length: 128 }, ()=>pick(256));
    const exe = buildExe({
        imports: { 'KERNEL32.dll': ['CreateProcessA', 'WaitForSingleObject', 'GetExitCodeProcess',
            'GetLastError', 'SetLastError', 'GetStdHandle', 'WriteFile', 'ExitProcess',
            ...new Set(ops.map(op=>op.name))] },
        data: {
            command: ascii('C:\\App\\child.exe'),
            startup: [...u32(68), ...new Array(64).fill(0)],
            info: new Array(16).fill(0),
            base0: u32(0), base1: u32(0), base2: u32(0), base3: u32(0),
            payload,
            out: new Array(size).fill(0),
            hex: new Array(size * 2).fill(0),
            digits: ascii('0123456789abcdef'),
            written: u32(0),
        },
        codeSize: 0x2000,
        code: ({ iat, at })=>{
            /** @param {string} name */
            const call = name=>[0xff, 0x15, ...u32(iat(name))];
            /** @param {number | 'process' | 'thread' | [string, number]} arg @param {number} place */
            const push = (arg, place)=>{
                if (typeof arg === 'number')
                {
                    return [0x68, ...u32(arg)];
                }
                if (arg === 'process' || arg === 'thread')
                {
                    return [0xff, 0x35, ...u32(at('info') + (arg === 'process' ? 0 : 4))];
                }
                const [name, offset] = arg;
                if (name === 'out')
                {
                    return [0x68, ...u32(at('out') + place + offset)];
                }
                if (name === 'payload')
                {
                    return [0x68, ...u32(at('payload') + offset)];
                }
                // mov eax, [base]; add eax, offset; push eax
                return [0xa1, ...u32(at(name)), 0x05, ...u32(offset), 0x50];
            };
            const code = [
                0x68, ...u32(at('info')), 0x68, ...u32(at('startup')),
                0x6a, 0, 0x6a, 0, 0x6a, CREATE_SUSPENDED, 0x6a, 0, 0x6a, 0, 0x6a, 0,
                0x68, ...u32(at('command')), 0x6a, 0,
                ...call('CreateProcessA'),
            ];
            ops.forEach((op, index)=>{
                const place = places[index];
                if (op.before)
                {
                    code.push(0xc7, 0x05, ...u32(at('out') + place + op.before[0]),
                        ...u32(op.before[1]));
                }
                // A last error of its own before each call: one the call set
                // is told from one it left.
                code.push(0x68, ...u32(0xe0000000 + index), ...call('SetLastError'));
                for (const arg of [...op.args].reverse())
                {
                    code.push(...push(arg, place));
                }
                code.push(...call(op.name));
                code.push(0xa3, ...u32(at('out') + place));
                if (op.store)
                {
                    code.push(0xa3, ...u32(at(op.store)));
                }
                code.push(...call('GetLastError'), 0xa3, ...u32(at('out') + place + 4));
            });
            code.push(
                0x6a, 0xff, 0xff, 0x35, ...u32(at('info')), ...call('WaitForSingleObject'),
                0x68, ...u32(at('out') + exitAt), 0xff, 0x35, ...u32(at('info')),
                ...call('GetExitCodeProcess'),
                // Each byte of `out` as two hex digits in `hex`.
                0xbe, ...u32(at('out')), 0xbf, ...u32(at('hex')), 0xb9, ...u32(size),
                0x0f, 0xb6, 0x06, 0x89, 0xc2, 0xc1, 0xe8, 0x04,
                0x8a, 0x80, ...u32(at('digits')), 0x88, 0x07,
                0x83, 0xe2, 0x0f, 0x8a, 0x92, ...u32(at('digits')), 0x88, 0x57, 0x01,
                0x46, 0x83, 0xc7, 0x02, 0x49, 0x75, 0xdb,
                // WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), hex, size * 2, &written, 0)
                0x6a, 0, 0x68, ...u32(at('written')), 0x68, ...u32(size * 2),
                0x68, ...u32(at('hex')), 0x6a, 0xf5, ...call('GetStdHandle'), 0x50,
                ...call('WriteFile'),
                0x6a, 0, ...call('ExitProcess'),
            );
            return code;
        },
    });
    /**
     * The calls, each with what it answered, as the parent wrote them.
     *
     * @param {string} text
     */
    const calls = text=>ops.map((op, index)=>{
        const at = places[index] * 2;
        const word = (/** @type {number} */ from)=>text.slice(at + from * 2, at + from * 2 + 8);
        return `${index} ${op.name} ${word(0)} ${word(4)} ${text.slice(at + 16,
            at + 16 + Math.min(op.extra, 32) * 2)}`;
    });
    return { exe, calls };
}

/** A parent that starts `command` and exits with its child's code. */
function launcher(){
    return buildExe({
        imports: { 'KERNEL32.dll': ['CreateProcessA', 'WaitForSingleObject',
            'GetExitCodeProcess', 'ExitProcess'] },
        data: {
            command: ascii('C:\\App\\parent.exe'),
            startup: [...u32(68), ...new Array(64).fill(0)],
            info: new Array(16).fill(0),
            code: u32(0),
        },
        codeSize: 0x60,
        code: ({ iat, at })=>[
            0x68, ...u32(at('info')), 0x68, ...u32(at('startup')),
            0x6a, 0, 0x6a, 0, 0x6a, 0, 0x6a, 0, 0x6a, 0, 0x6a, 0,
            0x68, ...u32(at('command')), 0x6a, 0,
            0xff, 0x15, ...u32(iat('CreateProcessA')),
            0x6a, 0xff, 0xff, 0x35, ...u32(at('info')),
            0xff, 0x15, ...u32(iat('WaitForSingleObject')),
            0x68, ...u32(at('code')), 0xff, 0x35, ...u32(at('info')),
            0xff, 0x15, ...u32(iat('GetExitCodeProcess')),
            0xff, 0x35, ...u32(at('code')),
            0xff, 0x15, ...u32(iat('ExitProcess')),
        ],
    });
}

const child = buildExe({
    imports: { 'KERNEL32.dll': ['ExitProcess'] },
    code: ({ iat })=>[0x6a, 0x2a, 0xff, 0x15, ...u32(iat('ExitProcess'))],
});

/**
 * What a seeded parent wrote, run one way.
 *
 * @param {Uint8Array} parent @param {import('./mode.js').Concurrency} concurrency
 * @param {boolean} through
 * @param {import('node:test').TestContext} t
 * @param {Uint8Array} [childImage]  C:\App\child.exe
 */
async function observed(parent, concurrency, through, t, childImage = child){
    const app = await createApp({
        executable: through ? launcher() : parent,
        imagePath: through ? 'C:\\App\\launcher.exe' : 'C:\\App\\parent.exe',
        concurrency,
        storage: { load: async()=>({ files: [
            { path: 'C:\\App\\child.exe', bytes: childImage },
            { path: 'C:\\App\\parent.exe', bytes: parent },
        ] }) },
    });
    t.after(()=>app.dispose());
    /** @type {string[]} */
    const output = [];
    app.attachLog((/** @type {number} */ _handle, /** @type {string} */ text)=>
        output.push(text));
    const code = await app.run({ timeoutMs: 120_000 });
    const tables = await app.diagnostics();
    const kernel = (Array.isArray(tables) ? tables : []).find(table=>table.name === 'kernel');
    return { code, text: output.join(''),
        scheduler: kernel?.metrics?.scheduler ?? kernel?.metrics ?? null };
}

for (const seed of [1, 2, 3, 4, 5, 6])
{
    test(`a parent's calls in its child answer alike however the child runs (seed ${seed})`,
        { timeout: 180000 }, async t=>{
            const { exe: parent, calls } = seededParent(seed);
            const same = await observed(parent, 1, false, t);
            assert.equal(same.code, 0);
            const text = same.text.match(/[0-9a-f]+/)?.[0] ?? '';
            assert.ok(text.length > OPS * 16, `the parent wrote what it saw: ${same.text}`);
            assert.equal(text.slice(-16, -8), '2a000000', 'and saw its child exit with its code');
            for (const [name, concurrency, through] of /** @type {const} */ ([
                ['in a worker of its own', 2, false],
                ['beside a parent in a worker, through the run', 2, true],
            ]))
            {
                const other = await observed(parent, concurrency, through, t);
                assert.deepEqual(calls(other.text.match(/[0-9a-f]+/)?.[0] ?? ''), calls(text),
                    name);
                assert.equal(other.text.match(/[0-9a-f]+/)?.[0], text, name);
            }
        });
}

test('a thread a parent makes in its child runs there, and is waited on and read from here',
    { timeout: 180000 }, async t=>{
        // Wine's kernel32 test_CreateRemoteThread: code written into the
        // child, a thread started at it with a parameter, the parent waiting
        // on the thread and reading its exit code -- the parameter plus five.
        const parent = buildExe({
            imports: { 'KERNEL32.dll': ['CreateProcessA', 'VirtualAllocEx', 'WriteProcessMemory',
                'CreateRemoteThread', 'WaitForSingleObject', 'GetExitCodeThread',
                'TerminateProcess', 'ExitProcess'] },
            data: {
                command: ascii('C:\\App\\child.exe'),
                startup: [...u32(68), ...new Array(64).fill(0)],
                info: new Array(16).fill(0),
                // mov eax, [esp + 4]; add eax, 5; ret 4
                routine: [0x8b, 0x44, 0x24, 0x04, 0x83, 0xc0, 0x05, 0xc2, 0x04, 0x00],
                remote: u32(0),
                id: u32(0),
                code: u32(0),
                waited: u32(0xffffffff),
            },
            codeSize: 0x100,
            code: ({ iat, at })=>[
                0x68, ...u32(at('info')), 0x68, ...u32(at('startup')),
                0x6a, 0, 0x6a, 0, 0x6a, CREATE_SUSPENDED, 0x6a, 0, 0x6a, 0, 0x6a, 0,
                0x68, ...u32(at('command')), 0x6a, 0,
                0xff, 0x15, ...u32(iat('CreateProcessA')),
                // remote = VirtualAllocEx(hProcess, 0, 0x1000, MEM_COMMIT | MEM_RESERVE,
                //     PAGE_EXECUTE_READWRITE)
                0x6a, 0x40, 0x68, ...u32(0x3000), 0x68, ...u32(0x1000), 0x6a, 0,
                0xff, 0x35, ...u32(at('info')), 0xff, 0x15, ...u32(iat('VirtualAllocEx')),
                0xa3, ...u32(at('remote')),
                // WriteProcessMemory(hProcess, remote, routine, 10, 0)
                0x6a, 0, 0x6a, 10, 0x68, ...u32(at('routine')), 0x50,
                0xff, 0x35, ...u32(at('info')), 0xff, 0x15, ...u32(iat('WriteProcessMemory')),
                // CreateRemoteThread(hProcess, 0, 0, remote, 37, 0, &id)
                0x68, ...u32(at('id')), 0x6a, 0, 0x6a, 37, 0xff, 0x35, ...u32(at('remote')),
                0x6a, 0, 0x6a, 0, 0xff, 0x35, ...u32(at('info')),
                0xff, 0x15, ...u32(iat('CreateRemoteThread')),
                0x89, 0xc6, // mov esi, eax
                // waited = WaitForSingleObject(thread, INFINITE)
                0x6a, 0xff, 0x56, 0xff, 0x15, ...u32(iat('WaitForSingleObject')),
                0xa3, ...u32(at('waited')),
                // GetExitCodeThread(thread, &code)
                0x68, ...u32(at('code')), 0x56, 0xff, 0x15, ...u32(iat('GetExitCodeThread')),
                // TerminateProcess(hProcess, 0): its first thread never ran
                0x6a, 0, 0xff, 0x35, ...u32(at('info')),
                0xff, 0x15, ...u32(iat('TerminateProcess')),
                0x6a, 0xff, 0xff, 0x35, ...u32(at('info')),
                0xff, 0x15, ...u32(iat('WaitForSingleObject')),
                // ExitProcess(code + (waited << 8) + (id != 0) << 16)
                0x31, 0xc0, 0x83, 0x3d, ...u32(at('id')), 0x00, 0x0f, 0x95, 0xc0,
                0xc1, 0xe0, 0x10, 0x8b, 0x0d, ...u32(at('waited')), 0xc1, 0xe1, 0x08, 0x01, 0xc8,
                0x03, 0x05, ...u32(at('code')), 0x50,
                0xff, 0x15, ...u32(iat('ExitProcess')),
            ],
        });
        for (const [name, concurrency, through] of /** @type {const} */ ([
            ['on its parent\'s thread', 1, false],
            ['in a worker of its own', 2, false],
            ['beside a parent in a worker, through the run', 2, true],
        ]))
        {
            const run = await observed(parent, concurrency, through, t);
            assert.equal(run.code >>> 0, (1 << 16) + 42, name);
        }
    });

/**
 * Code with labels: bytes pushed as they come, a jump's target named and
 * patched once every label is known -- relative, or an absolute address.
 *
 * @param {(offset: number) => number} va  An offset in the code as an address.
 */
function assembler(va){
    /** @type {number[]} */
    const bytes = [];
    /** @type {Record<string, number>} */
    const labels = {};
    /** @type {{ at: number, label: string, absolute: boolean }[]} */
    const patches = [];
    return {
        bytes,
        /** @param {...number} more */
        emit: (...more)=>bytes.push(...more),
        /** @param {string} label */
        mark: label=>{
            labels[label] = bytes.length;
        },
        /** @param {number[]} opcode @param {string} label */
        jump: (opcode, label)=>{
            bytes.push(...opcode);
            patches.push({ at: bytes.length, label, absolute: false });
            bytes.push(0, 0, 0, 0);
        },
        /** push imm32 of a label's address @param {string} label */
        pushAddress: label=>{
            bytes.push(0x68);
            patches.push({ at: bytes.length, label, absolute: true });
            bytes.push(0, 0, 0, 0);
        },
        done(){
            for (const { at, label, absolute } of patches)
            {
                const target = labels[label];
                bytes.splice(at, 4, ...u32(absolute ? va(target) : target - (at + 4)));
            }
            return bytes;
        },
    };
}

test('a thread waiting on its child\'s answers does not hold the processor from a thread it woke',
    { timeout: 120000 }, async t=>{
        // Wine's kernel32 sync.c test_apc_deadlock: one thread allocates and
        // frees in the child and sets an event after each; the main thread,
        // two hundred times, suspends the child's thread, waits for the event
        // and resumes it. The asking thread went on through every answer, so
        // the main thread waited the four-second starvation bound each round.
        const ROUNDS = 200;
        const sleeper = buildExe({
            imports: { 'KERNEL32.dll': ['SleepEx'] },
            // for (;;) SleepEx(INFINITE, TRUE);
            code: ({ iat })=>[0x6a, 1, 0x6a, 0xff, 0xff, 0x15, ...u32(iat('SleepEx')), 0xeb, 0xf5],
        });
        const parent = buildExe({
            imports: { 'KERNEL32.dll': ['CreateProcessA', 'CreateEventA', 'CreateThread',
                'SetEvent', 'WaitForSingleObject', 'SuspendThread', 'ResumeThread', 'Sleep',
                'TerminateProcess', 'ExitProcess'],
            'ntdll.dll': ['NtAllocateVirtualMemory', 'NtFreeVirtualMemory'] },
            data: {
                command: ascii('C:\\App\\child.exe'),
                startup: [...u32(68), ...new Array(64).fill(0)],
                info: new Array(16).fill(0),
                event: u32(0), running: u32(1), base: u32(0), size: u32(0), rounds: u32(0),
            },
            codeSize: 0x200,
            code: ({ iat, at, code: va })=>{
                const a = assembler(va);
                /** @param {string} name */
                const call = name=>a.emit(0xff, 0x15, ...u32(iat(name)));
                /** @param {string} name @param {number} [offset] */
                const pushOf = (name, offset = 0)=>a.emit(0xff, 0x35, ...u32(at(name) + offset));
                /** @param {number} value */
                const push = value=>a.emit(0x68, ...u32(value));
                push(at('info'));
                push(at('startup'));
                a.emit(0x6a, 0, 0x6a, 0, 0x6a, 0, 0x6a, 0, 0x6a, 0, 0x6a, 0);
                push(at('command'));
                a.emit(0x6a, 0);
                call('CreateProcessA');
                a.emit(0x6a, 0, 0x6a, 0, 0x6a, 0, 0x6a, 0);
                call('CreateEventA');
                a.emit(0xa3, ...u32(at('event')));
                a.emit(0x6a, 0, 0x6a, 0, 0x6a, 0);
                a.pushAddress('worker');
                a.emit(0x6a, 0, 0x6a, 0);
                call('CreateThread');
                a.emit(0x89, 0xc7); // mov edi, eax: the worker
                push(1000);
                pushOf('event');
                call('WaitForSingleObject');
                a.emit(0x31, 0xf6); // xor esi, esi: the rounds done
                a.mark('round');
                a.emit(0x81, 0xfe, ...u32(ROUNDS)); // cmp esi, ROUNDS
                a.jump([0x0f, 0x8d], 'done');
                pushOf('info', 4);
                call('SuspendThread');
                a.emit(0x6a, 0);
                pushOf('event');
                call('WaitForSingleObject');
                push(1000);
                pushOf('event');
                call('WaitForSingleObject');
                a.emit(0x85, 0xc0); // test eax, eax: anything but WAIT_OBJECT_0 ends it
                a.jump([0x0f, 0x85], 'done');
                pushOf('info', 4);
                call('ResumeThread');
                a.emit(0x6a, 1);
                call('Sleep');
                a.emit(0x46); // inc esi
                a.jump([0xe9], 'round');
                a.mark('done');
                a.emit(0xc7, 0x05, ...u32(at('running')), ...u32(0));
                push(1000);
                a.emit(0x57);
                call('WaitForSingleObject');
                a.emit(0x6a, 0);
                pushOf('info');
                call('TerminateProcess');
                a.emit(0x6a, 0xff);
                pushOf('info');
                call('WaitForSingleObject');
                a.emit(0x56); // ExitProcess(rounds)
                call('ExitProcess');

                // The worker: while running, allocate and free a page in the child.
                a.mark('worker');
                a.emit(0x83, 0x3d, ...u32(at('running')), 0);
                a.jump([0x0f, 0x84], 'out');
                a.emit(0xc7, 0x05, ...u32(at('base')), ...u32(0));
                a.emit(0xc7, 0x05, ...u32(at('size')), ...u32(0x1000));
                a.emit(0x6a, 4);
                push(0x3000);
                push(at('size'));
                a.emit(0x6a, 0);
                push(at('base'));
                pushOf('info');
                call('NtAllocateVirtualMemory');
                pushOf('event');
                call('SetEvent');
                a.emit(0xc7, 0x05, ...u32(at('size')), ...u32(0));
                push(0x8000);
                push(at('size'));
                push(at('base'));
                pushOf('info');
                call('NtFreeVirtualMemory');
                pushOf('event');
                call('SetEvent');
                a.jump([0xe9], 'worker');
                a.mark('out');
                a.emit(0x31, 0xc0, 0xc2, 4, 0);
                return a.done();
            },
        });
        const run = await observed(parent, 1, false, t, sleeper);
        assert.equal(run.code, ROUNDS, 'every round saw the event');
        // A round each starvation bound was 800 s; now a round is the asking
        // thread's quantum or two. Counted, not timed: no thread is ever
        // passed over for the bound, which a busy machine's clock would blur.
        assert.deepEqual([run.scheduler?.boosts, run.scheduler?.hostTurns?.starved], [0, 0],
            'no turn handed out to a thread starved of one');
    });
