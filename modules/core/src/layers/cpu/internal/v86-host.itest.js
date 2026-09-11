/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
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
import { GUEST_JUMP } from './boot-rom.js';

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

test('protected mode is on before anyone is handed the machine', async()=>{
    // Not on the first `run()`: a scheduler never calls it. It moves the CPU by
    // restoring a thread context and running a slice, and that context is a
    // copy of the machine taken when the thread was created. Taken before the
    // mode switch it is a processor at reset, so every thread starts in real
    // mode at a 32-bit address, decodes whatever the bytes happen to mean, and
    // runs memory at random -- with no fault and no halt to say so.
    const host = await boot();

    assert.ok(host.inProtectedMode(), 'the ROM has already switched modes');
    assert.equal(host.eip(), GUEST_JUMP, 'parked on the jump into guest code');
    assert.equal(host.readReg32('esp'), INITIAL_STACK, 'and the ROM has set the stack');

    // Segments are flat 32-bit, which is what makes a captured context usable:
    // a guest address is a linear address.
    host.writePhysical(GUEST_CODE, new Uint8Array([
        0x66, 0xba, TRAP_PORT & 0xff, TRAP_PORT >>> 8 & 0xff, // mov dx, TRAP_PORT
        0xa1, ...u32(0x9000),                                 // mov eax, [0x9000]
        0xef,                                                 // out dx, eax
        0xf4,                                                 // hlt
    ]));
    host.writePhysical(0x9000, new Uint8Array(u32(0xfeedface)));
    host.writePhysical(ENTRY_VECTOR, new Uint8Array(u32(GUEST_CODE)));

    assert.equal(await runUntilTrap(host), 0xfeedface,
        'a flat DS, so an absolute address means itself');
});

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

test('the instruction count carries on past the emulator\'s own word', async()=>{
    const host = await boot();
    // The emulator's word is about to wrap: a count read from it alone would
    // fall back to almost nothing, and a run's instructions per second with it.
    host.cpu().instruction_counter[0] = 0xffffff00;
    const before = host.instructionCount();
    host.cpu().in_hlt[0] = 0;
    host.cpu().run_slice(1000);
    const after = host.instructionCount();
    assert.ok(after > before, `the count went on (${before} then ${after})`);
    assert.ok(after - before < 0x1000, 'by what ran, not by the wrapped word');
    host.stop();
});

test('the emulator\'s account of where the guest ran adds up to what it retired', async()=>{
    const host = await boot();
    assert.ok(host.profile.available(), 'the build carries the account');

    // A loop, so that the same addresses are entered many times: a long
    // stretch run once and a short stretch run often read apart in it.
    const LOOP = GUEST_CODE + 5;
    host.writePhysical(GUEST_CODE, new Uint8Array([
        0xb9, ...u32(2000),        // mov ecx, 2000
        0x49,                      // loop: dec ecx
        0x75, 0xfd,                // jnz loop
        0xf4,                      // hlt
    ]));
    host.writePhysical(ENTRY_VECTOR, new Uint8Array(u32(GUEST_CODE)));

    assert.ok(host.profile.start());
    const before = host.instructionCount();
    host.cpu().in_hlt[0] = 0;
    host.cpu().instruction_pointer[0] = GUEST_CODE;
    // The compiler gets its chance: the loop is hot after the first slice, and
    // the block it compiles counts itself the same way the interpreter did.
    for (let slice = 0; slice < 20 && !host.cpu().in_hlt[0]; slice++)
    {
        host.cpu().run_slice(500);
        await new Promise(resolve=>setTimeout(resolve, 0));
    }
    const retired = host.instructionCount() - before;
    const account = host.profile.read();
    host.profile.stop();

    assert.ok(account, 'an account was kept');
    const counted = account.entries.reduce((sum, entry)=>sum + entry.instructions, 0);
    assert.ok(retired >= 4000, `the loop ran (${retired} retired)`);
    assert.equal(counted + account.dropped, retired,
        `every instruction is accounted to an address (${counted} of ${retired})`);
    const inLoop = account.entries.filter(entry=>
        entry.address >= LOOP && entry.address < LOOP + 3);
    const loopShare = inLoop.reduce((sum, entry)=>sum + entry.instructions, 0) / retired;
    assert.ok(loopShare > 0.99, `the loop is where the time went (${loopShare})`);
    assert.ok(inLoop.some(entry=>entry.hits >= 100), 'and it was entered many times');
    assert.ok(account.entries.every(entry=>
        entry.address >= GUEST_CODE && entry.address < GUEST_CODE + 9),
    'nothing is accounted to an address that never ran');
    host.stop();
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

test('eip and eflags are readable by name, as a CONTEXT record needs', async()=>{
    // Neither lives in the general-purpose file, and both are asked for by
    // name: describing an exception to the code that will handle it means
    // building a CONTEXT, and a register missing from it throws instead.
    const host = await boot();

    host.writePhysical(GUEST_CODE, new Uint8Array([
        0x66, 0xba, TRAP_PORT & 0xff, TRAP_PORT >>> 8 & 0xff, // mov dx, TRAP_PORT
        0x31, 0xc0,                                     // xor eax, eax
        0xef,                                           // out dx, eax
        0xf4,                                           // hlt
    ]));
    host.writePhysical(ENTRY_VECTOR, new Uint8Array(u32(GUEST_CODE)));
    await runUntilTrap(host);

    assert.equal(host.readReg32('eip'), host.eip(), 'the name and the accessor agree');
    // xor cleared eax, so the zero flag is set. Any plausible flags word has
    // bit 1 set as well, which is what tells a stale zero from a real read.
    const flags = host.readReg32('eflags');
    assert.equal(flags & 0x40, 0x40, 'ZF, after an instruction that sets it');
    assert.equal(flags & 0x02, 0x02, 'the reserved bit x86 always keeps set');

    host.writeReg32('eip', 0x1234);
    assert.equal(host.eip(), 0x1234, 'and writing by name moves the guest');

    // A written word is literal: the lazy flags must not recompute over it.
    host.writeReg32('eflags', 0x2);
    assert.equal(host.readReg32('eflags'), 0x2, 'ZF is gone because we said so');
});

test('a loop with two entries is held to the slice like any other', async()=>{
    // Two blocks that jump back to each other, so the loop has two heads: the
    // compiler dispatches such a loop by index and once emitted no bound check
    // on its way round, so a slice of a thousand ran the whole loop. A game
    // spinning on a flag in a loop of this shape held the machine for as long
    // as the spin lasted, with no frame and no sound in between.
    const host = await boot();
    const N = 100000;
    host.writePhysical(GUEST_CODE, new Uint8Array([
        0x31, 0xc9,                 //     xor ecx, ecx
        0x31, 0xd2,                 //     xor edx, edx
        0xeb, 0x01,                 //     jmp B
        0x41,                       // A:  inc ecx
        0x42,                       // B:  inc edx
        0xf7, 0xc2, ...u32(1),      //     test edx, 1
        0x75, 0xf6,                 //     jnz A
        0x81, 0xf9, ...u32(N),      //     cmp ecx, N
        0x75, 0xef,                 //     jne B
        0xf4,                       //     hlt
    ]));
    host.writePhysical(ENTRY_VECTOR, new Uint8Array(u32(GUEST_CODE)));
    host.cpu().in_hlt[0] = 0;
    host.cpu().instruction_pointer[0] = GUEST_CODE;

    const SLICE = 1000;
    let worst = 0;
    let slices = 0;
    while (!host.cpu().in_hlt[0] && slices < 20000)
    {
        const retired = host.cpu().run_slice(SLICE) >>> 0;
        worst = Math.max(worst, retired);
        slices++;
        if (slices % 20 === 0)
        {
            // The compiler finishes a module off the thread; give it the chance.
            await new Promise(resolve=>setTimeout(resolve, 0));
        }
    }
    assert.ok(host.cpu().in_hlt[0], `the loop ran to its end (${slices} slices)`);
    const state = host.jitState();
    if (state !== -1 && state.compiledSteps >= 0)
    {
        assert.ok(state.compiledSteps > 0, 'the loop was compiled, not only interpreted');
    }
    // What is left to overrun by is one basic block.
    assert.ok(worst <= SLICE + 16, `the worst slice retired ${worst} of ${SLICE} asked`);
    host.stop();
});
