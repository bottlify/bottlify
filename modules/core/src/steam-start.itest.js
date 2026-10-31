/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The Steam client's SteamStart objects, through `createApp`: a 64-bit
 * program does what a DRM wrapper (SteamStub) does when it cannot start its
 * game -- opens the lock and the section by name, waits for the lock, finds
 * the client ready, posts its request (its process, an event of its own, the
 * app, its failure) and waits on its event. The client answers for an app
 * the account owns; for one it does not own the wait runs out. The program
 * exits with the step that failed, or 0x100 plus its last wait's answer.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from './app.js';
import { buildExe } from '../../../tools/make-pe.mjs';

/** @param {number} value @returns {number[]} */
const u32 = value=>[value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24 & 0xff];
/** @param {string} text */
const ascii = text=>[...text].map(character=>character.charCodeAt(0)).concat(0);

const APP = 361420;
const EXIT = 0x1c0;
const WAIT_TIMEOUT = 0x102;

const program = buildExe({
    bits: 64, codeSize: 0x200,
    imports: { 'KERNEL32.dll': ['OpenEventA', 'OpenFileMappingA', 'WaitForSingleObject',
        'MapViewOfFile', 'CreateEventA', 'GetCurrentProcessId', 'ExitProcess'] },
    data: { lock: ascii('Local\\SteamStart_SharedMemLock'),
        file: ascii('Local\\SteamStart_SharedMemFile') },
    code: ({ iat, at, code })=>{
        /** @type {number[]} */
        const bytes = [];
        /** @param {number[]} op @param {number} to */
        const rip = (op, to)=>bytes.push(...op, ...u32(to - (code(bytes.length) + op.length + 4)));
        const call = (/** @type {string} */ name)=>rip([0xff, 0x15], iat(name));
        /** mov ecx, step; jne exit (or je with `when`) */
        const fail = (/** @type {number} */ step, when = 0x85)=>{
            bytes.push(0xb9, ...u32(step));
            rip([0x0f, when], code(EXIT));
        };
        const testRax = ()=>bytes.push(0x48, 0x85, 0xc0); // test rax, rax
        bytes.push(0x48, 0x83, 0xec, 0x38); // sub rsp, 56
        // lock = OpenEventA(SYNCHRONIZE, FALSE, name) -> r12
        bytes.push(0xb9, ...u32(0x100000), 0x31, 0xd2);
        rip([0x4c, 0x8d, 0x05], at('lock'));
        call('OpenEventA');
        testRax(); fail(1, 0x84);
        bytes.push(0x49, 0x89, 0xc4); // mov r12, rax
        // section = OpenFileMappingA(FILE_MAP_WRITE, FALSE, name) -> r13
        bytes.push(0xb9, ...u32(2), 0x31, 0xd2);
        rip([0x4c, 0x8d, 0x05], at('file'));
        call('OpenFileMappingA');
        testRax(); fail(2, 0x84);
        bytes.push(0x49, 0x89, 0xc5); // mov r13, rax
        // WaitForSingleObject(lock, 5000) == 0
        bytes.push(0x4c, 0x89, 0xe1, 0xba, ...u32(5000)); // mov rcx, r12; mov edx, 5000
        call('WaitForSingleObject');
        bytes.push(0x85, 0xc0); fail(3);
        // view = MapViewOfFile(section, FILE_MAP_WRITE, 0, 0, 0) -> rbx
        bytes.push(0x4c, 0x89, 0xe9, 0xba, ...u32(2), 0x45, 0x31, 0xc0, 0x45, 0x31, 0xc9);
        bytes.push(0x48, 0xc7, 0x44, 0x24, 0x20, 0, 0, 0, 0);
        call('MapViewOfFile');
        testRax(); fail(4, 0x84);
        bytes.push(0x48, 0x89, 0xc3); // mov rbx, rax
        bytes.push(0x83, 0xbb, ...u32(0x90), 2); fail(5); // cmp dword [rbx+0x90], 2
        bytes.push(0x83, 0xbb, ...u32(0x94), 0); fail(6); // cmp dword [rbx+0x94], 0
        // event = CreateEventA(NULL, FALSE, FALSE, NULL) -> rsi
        bytes.push(0x31, 0xc9, 0x31, 0xd2, 0x45, 0x31, 0xc0, 0x45, 0x31, 0xc9);
        call('CreateEventA');
        bytes.push(0x48, 0x89, 0xc6); // mov rsi, rax
        call('GetCurrentProcessId');
        bytes.push(0x89, 0x83, ...u32(0x98)); // mov [rbx+0x98], eax
        bytes.push(0x48, 0x89, 0xb3, ...u32(0xa0)); // mov [rbx+0xa0], rsi
        bytes.push(0xc7, 0x83, ...u32(0xa8), ...u32(APP)); // mov dword [rbx+0xa8], APP
        bytes.push(0xc6, 0x83, ...u32(0xb0), 0x36); // mov byte [rbx+0xb0], '6'
        bytes.push(0xc7, 0x83, ...u32(0x94), ...u32(2)); // mov dword [rbx+0x94], 2
        // WaitForSingleObject(event, 5000), and the step after: 0x100 + its answer
        bytes.push(0x48, 0x89, 0xf1, 0xba, ...u32(5000));
        call('WaitForSingleObject');
        bytes.push(0x8d, 0x88, ...u32(0x100)); // lea ecx, [rax+0x100]
        assert.ok(bytes.length <= EXIT);
        bytes.push(...new Array(EXIT - bytes.length).fill(0x90));
        call('ExitProcess');
        return bytes;
    },
});

/** @param {number[]} apps */
async function run(apps){
    const app = await createApp({ executable: program,
        win32: { steam: { steamId: '76561197960287930', accountName: 'test', apps,
            appId: APP } } });
    try
    {
        return await app.run({ timeoutMs: 50000 });
    }
    finally
    {
        app.dispose();
    }
}

test('the client answers a SteamStart request for an owned app', { timeout: 60000 }, async()=>{
    assert.equal(await run([APP]), 0x100, 'its event set: WAIT_OBJECT_0');
});

test('a SteamStart request for an app the account does not own runs out', { timeout: 60000 },
    async()=>{
        assert.equal(await run([480]), 0x100 + WAIT_TIMEOUT, 'WAIT_TIMEOUT');
    });
