/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Named pipes between processes wherever each runs: both on the engine's
 * thread (concurrency 1), each in a worker of its own, or a child beside its
 * parent in the parent's worker (the root a waiting parent, so the pipe's
 * server is a child past the run's room). The same programs, the same exit
 * codes: what each side read and wrote, and every error it was answered.
 *
 * The shapes are a crash reporter's: a server that listens overlapped and a
 * client that waits for an instance, opens it and talks synchronously; and a
 * program that makes the first instance inheritable, hands it to the handler
 * it starts, closes its own copy and transacts with it as a client while the
 * handler makes a second instance and listens on the one it inherited.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../../../app.js';
import { assemble, buildExe } from '../../../../../../tools/fixtures/make-pe.mjs';
import { waitingParent } from '../../../../../../tools/fixtures/spawn-program.mjs';

/** @param {number} value @returns {number[]} */
const u32 = value=>[
    value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff,
];
/** @param {string} text */
const cString = text=>[...text].map(c=>c.charCodeAt(0)).concat(0);
/** @param {number} size */
const zeros = size=>new Array(size).fill(0);

const NAME = '\\\\.\\pipe\\bottlify_across';
const CRASH = '\\\\.\\pipe\\bottlify_crash';

/**
 * The instructions the programs are written in.
 *
 * @param {{ iat: (name: string) => number, at: (name: string) => number }} pe
 */
const x86 = ({ iat, at })=>({
    /** @param {number} value */
    push: value=>((value | 0) >= -128 && (value | 0) <= 127 ? [0x6a, value & 0xff]
        : [0x68, ...u32(value >>> 0)]),
    /** @param {string} name */
    pushAt: name=>[0x68, ...u32(at(name))],
    /** push dword [name] @param {string} name */
    pushFrom: name=>[0xff, 0x35, ...u32(at(name))],
    /** @param {string} name */
    call: name=>[0xff, 0x15, ...u32(iat(name))],
    /** mov eax, [name] @param {string} name */
    load: name=>[0xa1, ...u32(at(name))],
    /** The program ends with `code` when the last call answered FALSE. @param {string} label */
    unlessTrue: label=>[0x85, 0xc0, { jump: /** @type {const} */ ('jz'), to: label }],
    /** An exit with a code, under a label. @param {string} label @param {number} code */
    exitWith: (label, code)=>[{ label }, 0x68, ...u32(code),
        0xff, 0x15, ...u32(iat('ExitProcess'))],
});

/**
 * The server: a message pipe, overlapped, one instance; it starts the client,
 * connects, reads its message and answers "pong!" through the OVERLAPPED's
 * event, then exits with (the client's code << 16) | (bytes read << 8) | the
 * first byte. An 0xEx code says which step failed.
 */
const server = ()=>buildExe({
    imports: { 'KERNEL32.dll': ['CreateNamedPipeA', 'CreateEventA', 'CreateProcessA',
        'ConnectNamedPipe', 'GetLastError', 'GetOverlappedResult', 'ReadFile', 'WriteFile',
        'WaitForSingleObject', 'GetExitCodeProcess', 'ExitProcess'] },
    data: {
        name: cString(NAME), child: cString('C:\\App\\client.exe'), pong: cString('pong!'),
        si: [...u32(68), ...zeros(64)], pi: zeros(16), ov: zeros(20), buf: zeros(16),
        n: zeros(4), code: zeros(4),
    },
    codeSize: 0x200,
    code: pe=>{
        const { push, pushAt, pushFrom, call, load, unlessTrue, exitWith } = x86(pe);
        /** Waits on the OVERLAPPED unless the call finished: FALSE but ERROR_IO_PENDING. @param {string} done @param {number} failed */
        const settle = (done, failed)=>[
            0x85, 0xc0, { jump: /** @type {const} */ ('jnz'), to: done },
            ...call('GetLastError'), 0x3d, ...u32(997), { jump: /** @type {const} */ ('jnz'), to: `e${failed}` },
            { label: done },
            ...push(1), ...pushAt('n'), ...pushAt('ov'), 0x56, ...call('GetOverlappedResult'),
            ...unlessTrue(`e${failed + 1}`),
        ];
        return assemble([
            ...push(0), ...push(0), ...push(512), ...push(512), ...push(1), ...push(6),
            ...push(0x40000003), ...pushAt('name'), ...call('CreateNamedPipeA'),
            0x83, 0xf8, 0xff, { jump: 'jz', to: 'e1' }, //  cmp eax, -1
            0x89, 0xc6, //                                   mov esi, eax
            ...push(0), ...push(0), ...push(1), ...push(0), ...call('CreateEventA'),
            0xa3, ...u32(pe.at('ov') + 16),
            ...pushAt('pi'), ...pushAt('si'), ...push(0), ...push(0), ...push(0), ...push(0),
            ...push(0), ...push(0), ...pushAt('child'), ...push(0), ...call('CreateProcessA'),
            ...unlessTrue('e2'),
            // ConnectNamedPipe: at once, ERROR_PIPE_CONNECTED, or pending.
            ...pushAt('ov'), 0x56, ...call('ConnectNamedPipe'),
            0x85, 0xc0, { jump: 'jnz', to: 'connected' },
            ...call('GetLastError'), 0x3d, ...u32(535), { jump: 'jz', to: 'connected' },
            0x3d, ...u32(997), { jump: 'jnz', to: 'e3' },
            ...push(1), ...pushAt('n'), ...pushAt('ov'), 0x56, ...call('GetOverlappedResult'),
            ...unlessTrue('e4'),
            { label: 'connected' },
            ...pushAt('ov'), ...pushAt('n'), ...push(16), ...pushAt('buf'), 0x56,
            ...call('ReadFile'),
            ...settle('read', 5),
            ...load('n'), 0xc1, 0xe0, 0x08, 0x0f, 0xb6, 0x0d, ...u32(pe.at('buf')), 0x09, 0xc8,
            0x89, 0xc3, //                                   mov ebx, eax
            ...pushAt('ov'), ...pushAt('n'), ...push(5), ...pushAt('pong'), 0x56,
            ...call('WriteFile'),
            ...settle('written', 7),
            ...push(-1), ...pushFrom('pi'), ...call('WaitForSingleObject'),
            ...pushAt('code'), ...pushFrom('pi'), ...call('GetExitCodeProcess'),
            ...load('code'), 0xc1, 0xe0, 0x10, 0x09, 0xd8, //  shl eax, 16; or eax, ebx
            0x50, ...call('ExitProcess'),
            ...exitWith('e1', 0xe1), ...exitWith('e2', 0xe2), ...exitWith('e3', 0xe3),
            ...exitWith('e4', 0xe4), ...exitWith('e5', 0xe5), ...exitWith('e6', 0xe6),
            ...exitWith('e7', 0xe7), ...exitWith('e8', 0xe8),
        ]);
    },
});

/**
 * The client: waits for an instance, opens it, writes "ping" and reads the
 * answer, synchronously; exits with (bytes read << 8) | the first byte, or
 * 0xCx for the step that failed.
 */
const client = ()=>buildExe({
    imports: { 'KERNEL32.dll': ['WaitNamedPipeA', 'CreateFileA', 'WriteFile', 'ReadFile',
        'ExitProcess'] },
    data: { name: cString(NAME), ping: cString('ping'), buf: zeros(16), n: zeros(4) },
    codeSize: 0x100,
    code: pe=>{
        const { push, pushAt, call, load, unlessTrue, exitWith } = x86(pe);
        return assemble([
            ...push(5000), ...pushAt('name'), ...call('WaitNamedPipeA'), ...unlessTrue('c1'),
            ...push(0), ...push(0), ...push(3), ...push(0), ...push(0), ...push(0xc0000000),
            ...pushAt('name'), ...call('CreateFileA'),
            0x83, 0xf8, 0xff, { jump: 'jz', to: 'c2' },
            0x89, 0xc6,
            ...push(0), ...pushAt('n'), ...push(4), ...pushAt('ping'), 0x56, ...call('WriteFile'),
            ...unlessTrue('c3'),
            ...push(0), ...pushAt('n'), ...push(16), ...pushAt('buf'), 0x56, ...call('ReadFile'),
            ...unlessTrue('c4'),
            ...load('n'), 0xc1, 0xe0, 0x08, 0x0f, 0xb6, 0x0d, ...u32(pe.at('buf')), 0x09, 0xc8,
            0x50, ...call('ExitProcess'),
            ...exitWith('c1', 0xc1), ...exitWith('c2', 0xc2), ...exitWith('c3', 0xc3),
            ...exitWith('c4', 0xc4),
        ]);
    },
});

/**
 * A crash reporter's start: the first instance made inheritable and handed to
 * the handler it starts as its standard input; its own copy closed, it opens
 * the pipe as a client, writes "ping" and reads the answer. It exits with
 * (the handler's code << 16) | (bytes read << 8) | the first byte, or 0xAx
 * for the step that failed.
 */
const reporter = ()=>buildExe({
    imports: { 'KERNEL32.dll': ['CreateNamedPipeA', 'CreateProcessA', 'CloseHandle',
        'WaitNamedPipeA', 'CreateFileA', 'WriteFile', 'ReadFile', 'WaitForSingleObject',
        'GetExitCodeProcess', 'ExitProcess'] },
    data: {
        name: cString(CRASH), child: cString('C:\\App\\handler.exe'), ping: cString('ping'),
        // STARTUPINFO: cb, STARTF_USESTDHANDLES at 44, hStdInput at 56.
        si: [...u32(68), ...zeros(40), ...u32(0x100), ...zeros(20)],
        // SECURITY_ATTRIBUTES with bInheritHandle.
        sa: [...u32(12), ...u32(0), ...u32(1)],
        pi: zeros(16), buf: zeros(16), n: zeros(4), code: zeros(4),
    },
    codeSize: 0x200,
    code: pe=>{
        const { push, pushAt, pushFrom, call, load, unlessTrue, exitWith } = x86(pe);
        return assemble([
            ...pushAt('sa'), ...push(0), ...push(512), ...push(512), ...push(255), ...push(6),
            ...push(3), ...pushAt('name'), ...call('CreateNamedPipeA'),
            0x83, 0xf8, 0xff, { jump: 'jz', to: 'a1' }, //  cmp eax, -1
            0xa3, ...u32(pe.at('si') + 56), //               mov [si.hStdInput], eax
            ...pushAt('pi'), ...pushAt('si'), ...push(0), ...push(0), ...push(0), ...push(1),
            ...push(0), ...push(0), ...pushAt('child'), ...push(0), ...call('CreateProcessA'),
            ...unlessTrue('a2'),
            0xff, 0x35, ...u32(pe.at('si') + 56), ...call('CloseHandle'),
            ...unlessTrue('a3'),
            ...push(5000), ...pushAt('name'), ...call('WaitNamedPipeA'), ...unlessTrue('a4'),
            ...push(0), ...push(0), ...push(3), ...push(0), ...push(0), ...push(0xc0000000),
            ...pushAt('name'), ...call('CreateFileA'),
            0x83, 0xf8, 0xff, { jump: 'jz', to: 'a5' },
            0x89, 0xc6, //                                   mov esi, eax
            ...push(0), ...pushAt('n'), ...push(4), ...pushAt('ping'), 0x56, ...call('WriteFile'),
            ...unlessTrue('a6'),
            ...push(0), ...pushAt('n'), ...push(16), ...pushAt('buf'), 0x56, ...call('ReadFile'),
            ...unlessTrue('a7'),
            ...load('n'), 0xc1, 0xe0, 0x08, 0x0f, 0xb6, 0x0d, ...u32(pe.at('buf')), 0x09, 0xc8,
            0x89, 0xc3, //                                   mov ebx, eax
            ...push(-1), ...pushFrom('pi'), ...call('WaitForSingleObject'),
            ...pushAt('code'), ...pushFrom('pi'), ...call('GetExitCodeProcess'),
            ...load('code'), 0xc1, 0xe0, 0x10, 0x09, 0xd8, //  shl eax, 16; or eax, ebx
            0x50, ...call('ExitProcess'),
            ...exitWith('a1', 0xa1), ...exitWith('a2', 0xa2), ...exitWith('a3', 0xa3),
            ...exitWith('a4', 0xa4), ...exitWith('a5', 0xa5), ...exitWith('a6', 0xa6),
            ...exitWith('a7', 0xa7),
        ]);
    },
});

/**
 * The handler: the instance it inherited is its standard input; it connects
 * (its client may be there already), reads the message and answers "pong!",
 * synchronously; exits with (bytes read << 8) | the first byte, or 0xBx.
 */
const handler = ()=>buildExe({
    imports: { 'KERNEL32.dll': ['GetStdHandle', 'ConnectNamedPipe', 'GetLastError',
        'ReadFile', 'WriteFile', 'ExitProcess'] },
    data: { pong: cString('pong!'), buf: zeros(16), n: zeros(4) },
    codeSize: 0x100,
    code: pe=>{
        const { push, pushAt, call, load, unlessTrue, exitWith } = x86(pe);
        return assemble([
            ...push(-10), ...call('GetStdHandle'),
            0x83, 0xf8, 0xff, { jump: 'jz', to: 'b1' },
            0x89, 0xc6, //                                   mov esi, eax
            ...push(0), 0x56, ...call('ConnectNamedPipe'),
            0x85, 0xc0, { jump: 'jnz', to: 'connected' },
            ...call('GetLastError'), 0x3d, ...u32(535), { jump: 'jnz', to: 'b2' },
            { label: 'connected' },
            ...push(0), ...pushAt('n'), ...push(16), ...pushAt('buf'), 0x56, ...call('ReadFile'),
            ...unlessTrue('b3'),
            ...load('n'), 0xc1, 0xe0, 0x08, 0x0f, 0xb6, 0x0d, ...u32(pe.at('buf')), 0x09, 0xc8,
            0x89, 0xc3, //                                   mov ebx, eax
            ...push(0), ...pushAt('n'), ...push(5), ...pushAt('pong'), 0x56, ...call('WriteFile'),
            ...unlessTrue('b4'),
            0x53, ...call('ExitProcess'), //                 push ebx
            ...exitWith('b1', 0xb1), ...exitWith('b2', 0xb2), ...exitWith('b3', 0xb3),
            ...exitWith('b4', 0xb4),
        ]);
    },
});

/**
 * Where the two run: the program the run starts, and whether each process
 * started in a worker of its own.
 *
 * @type {{ where: string, concurrency: 1 | 2, waiting: boolean, workers: boolean[] }[]}
 */
const PLACEMENTS = [
    { where: 'both on the engine\'s thread', concurrency: 1, waiting: false,
        workers: [false] },
    { where: 'each in a worker of its own', concurrency: 2, waiting: false,
        workers: [true, true] },
    { where: 'the child beside its parent, in the parent\'s worker', concurrency: 2,
        waiting: true, workers: [true, true, false] },
];

/**
 * Runs a pair: the parent at C:\\App\\server.exe, or a waiting parent that
 * starts it, its child beside it.
 *
 * @param {any} t @param {typeof PLACEMENTS[number]} placement
 * @param {Uint8Array} parent @param {string} childPath @param {Uint8Array} child
 */
async function runPair(t, placement, parent, childPath, child){
    const app = await createApp({
        executable: placement.waiting ? waitingParent('C:\\App\\server.exe') : parent,
        imagePath: placement.waiting ? 'C:\\App\\root.exe' : 'C:\\App\\server.exe',
        concurrency: placement.concurrency,
        storage: { load: async()=>({ files: [{ path: childPath, bytes: child },
            ...placement.waiting ? [{ path: 'C:\\App\\server.exe', bytes: parent }] : []] }) },
    });
    t.after(()=>app.dispose());
    /** @type {boolean[]} */
    const workers = [];
    app.on('process-started', (/** @type {any} */ event)=>workers.push(event.worker === true));
    const code = await app.run({ timeoutMs: 60_000 });
    return { code, workers };
}

for (const placement of PLACEMENTS)
{
    test(`a named pipe between a server and its client, ${placement.where}: an overlapped `
        + 'connect, read and write on one side, a wait, open, write and read on the other',
    { timeout: 90000 }, async t=>{
        const { code, workers } = await runPair(t, placement, server(), 'C:\\App\\client.exe',
            client());
        assert.equal(code.toString(16), (((5 << 8 | 0x70) << 16) | (4 << 8 | 0x70)).toString(16),
            'the client read "pong!" and the server "ping"');
        assert.deepEqual(workers, placement.workers, 'where each process ran');
    });
}

for (const placement of PLACEMENTS)
{
    test(`an inheritable instance handed to the handler a program starts, ${placement.where}: `
        + 'the handler listens on what it inherited, the program closes its copy and talks to '
        + 'it as a client', { timeout: 90000 }, async t=>{
        const { code, workers } = await runPair(t, placement, reporter(), 'C:\\App\\handler.exe',
            handler());
        assert.equal(code.toString(16), (((4 << 8 | 0x70) << 16) | (5 << 8 | 0x70)).toString(16),
            'the handler read "ping" and the program "pong!"');
        assert.deepEqual(workers, placement.workers, 'where each process ran');
    });
}
