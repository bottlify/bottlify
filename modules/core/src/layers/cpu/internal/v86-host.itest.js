/*
 * Copyright © 2026 Bottlify Project
 * Licensed under BSD-2-Clause License
 * See LICENSE for details
 */

/**
 * Integration test: drives a real v86 build.
 *
 * Kept out of `npm test` (which stays hermetic and dependency-free) because it
 * needs the prebuilt vendor artifacts — run `npm run fetch:v86` first, then
 * `npm run test:integration`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createV86Host } from './v86-host.js';

const PREBUILT = new URL('../../../../vendor/prebuilt/', import.meta.url);
const TRAP_PORT = 0xb077;
const ENTRY_VECTOR = 0x7000;
const GUEST_CODE = 0x8000;
const INITIAL_STACK = 0x200000;

async function boot(){
    const wasm = await readFile(new URL('v86.wasm', PREBUILT));
    return createV86Host({
        moduleUrl: new URL('libv86.mjs', PREBUILT).href,
        wasmBytes: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength),
        memorySize: 64 * 1024 * 1024,
        trapPort: TRAP_PORT,
        entryVector: ENTRY_VECTOR,
        initialStack: INITIAL_STACK,
    });
}

/** @param {number} value @returns {number[]} */
const u32 = value=>[value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24 & 0xff];

/** Runs until the guest traps, or the deadline passes. @param {any} host */
function runUntilTrap(host, timeoutMs = 4000){
    return new Promise((resolve, reject)=>{
        const timer = setTimeout(()=>{
            host.stop();
            reject(new Error('guest never trapped'));
        }, timeoutMs);
        host.onTrap((/** @type {number} */ value)=>{
            clearTimeout(timer);
            host.stop();
            resolve(value);
        });
        host.run();
    });
}

test('boots without a BIOS and reaches guest code in protected mode', async()=>{
    const host = await boot();

    // Guest program: write a marker, then trap back to the host with a value.
    host.writePhysical(GUEST_CODE, new Uint8Array([
        0xc7, 0x05, ...u32(0x9000), ...u32(0xcafebabe), // mov dword [0x9000], 0xCAFEBABE
        0x66, 0xba, TRAP_PORT & 0xff, TRAP_PORT >>> 8 & 0xff, // mov dx, TRAP_PORT
        0xb8, ...u32(0x12345678),                       // mov eax, 0x12345678
        0xef,                                           // out dx, eax
        0xf4,                                           // hlt
    ]));
    host.writePhysical(ENTRY_VECTOR, new Uint8Array(u32(GUEST_CODE)));

    const trapped = await runUntilTrap(host);

    assert.equal(trapped, 0x12345678, 'trap value arrives intact');
    assert.ok(host.inProtectedMode(), 'ROM switched the CPU into protected mode');

    const marker = host.readPhysical(0x9000, 4);
    assert.equal(
        (marker[0] | marker[1] << 8 | marker[2] << 16 | marker[3] << 24) >>> 0,
        0xcafebabe,
        'guest code ran and wrote to memory',
    );

    // The whole point of shipping our own ROM: nothing but our stub runs first.
    assert.ok(host.instructionCount() < 40,
        `only the ROM stub ran first (${host.instructionCount()} instructions)`);
});

test('the guest stack is the one the ROM set up', async()=>{
    const host = await boot();

    // push a value, then trap with ESP so the host can see where the stack is
    host.writePhysical(GUEST_CODE, new Uint8Array([
        0x68, ...u32(0xdeadbeef),                       // push 0xDEADBEEF
        0x66, 0xba, TRAP_PORT & 0xff, TRAP_PORT >>> 8 & 0xff, // mov dx, TRAP_PORT
        0x89, 0xe0,                                     // mov eax, esp
        0xef,                                           // out dx, eax
        0xf4,                                           // hlt
    ]));
    host.writePhysical(ENTRY_VECTOR, new Uint8Array(u32(GUEST_CODE)));

    const esp = await runUntilTrap(host);
    assert.equal(esp, INITIAL_STACK - 4, 'one dword pushed below the configured stack top');

    const pushed = host.readPhysical(esp, 4);
    assert.equal(
        (pushed[0] | pushed[1] << 8 | pushed[2] << 16 | pushed[3] << 24) >>> 0,
        0xdeadbeef,
        'the pushed value is where the stack says it is',
    );
});

test('registers are readable and writable from the host', async()=>{
    const host = await boot();

    host.writePhysical(GUEST_CODE, new Uint8Array([
        0x66, 0xba, TRAP_PORT & 0xff, TRAP_PORT >>> 8 & 0xff, // mov dx, TRAP_PORT
        0x89, 0xd8,                                     // mov eax, ebx
        0xef,                                           // out dx, eax
        0xf4,                                           // hlt
    ]));
    host.writePhysical(ENTRY_VECTOR, new Uint8Array(u32(GUEST_CODE)));

    // Seed a register before the guest starts; the guest hands it back through the trap.
    host.writeReg32('ebx', 0x5150f00d);
    const seen = await runUntilTrap(host);

    assert.equal(seen, 0x5150f00d, 'guest observed the value the host wrote');
    assert.equal(host.readReg32('eax'), 0x5150f00d, "host reads the guest's register back");
});
