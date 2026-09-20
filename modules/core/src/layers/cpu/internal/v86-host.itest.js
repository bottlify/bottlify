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

async function boot(binary = 'v86.wasm'){
    const wasm = await readFile(new URL(binary, PREBUILT));
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
    // The crossing itself is counted, whoever handles it: a frame that left the
    // guest far more often than its neighbours is a frame spent on us.
    assert.equal(host.trapCrossings(), 1);
});

test('the views follow the memory when the emulator grows it', async()=>{
    // The host reads registers and memory through views taken once, and the
    // emulator grows its memory in place when its compiler needs room --
    // which detaches the buffer those views were on. A read after that has to
    // find the new buffer rather than answer zero off a dead view.
    const host = await boot();
    host.writeReg32('ebx', 0x600d0000);
    host.writePhysical(GUEST_CODE, new Uint8Array(u32(0xcafe1234)));
    assert.equal(host.readReg32('ebx'), 0x600d0000);

    const grown = host.cpu().wasm_memory.grow(1);
    assert.ok(grown > 0, 'the memory grew');

    assert.equal(host.readReg32('ebx'), 0x600d0000, 'a register read after the growth');
    assert.equal(host.readU32(GUEST_CODE), 0xcafe1234, 'a dword read after the growth');
    host.writeReg32('ecx', 0x1234);
    assert.equal(host.cpu().reg32[1], 0x1234, 'a write after the growth reaches the machine');
    host.stop();
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

test('x87 arithmetic, rounding to integers and the widths a program stores in', async()=>{
    // What a program compiled for the x87 relies on, and what the emulator's
    // double-precision shortcut must keep: exact results where the values are
    // exact, the rounding mode the control word names when storing an
    // integer, a double stored from a single, and a single that overflows
    // going to infinity under round-to-nearest rather than to a wrong finite
    // number (towards zero it would be the largest finite, which is why the
    // control word is put back first).
    const host = await boot();
    const f32 = (/** @type {number} */ v)=>[...new Uint8Array(Float32Array.of(v).buffer)];
    host.writePhysical(0x9000, new Uint8Array([
        ...f32(1.5), ...f32(3.25), ...f32(0.75), ...f32(2.5),   // 0x9000..0x900c
        0, 0, 0, 0,                                             // 0x9010: result
        ...f32(2.75), 0, 0, 0, 0,                               // 0x9014, 0x9018: result
        ...f32(-2.5), 0, 0, 0, 0,                               // 0x901c, 0x9020: result
        0, 0, 0, 0,                                             // 0x9024: result
        ...f32(3e38), 0, 0, 0, 0,                               // 0x9028, 0x902c: result
    ]));
    host.writePhysical(GUEST_CODE, new Uint8Array([
        0xd9, 0x05, ...u32(0x9000),         // fld dword [1.5]
        0xd8, 0x0d, ...u32(0x9004),         // fmul dword [3.25]
        0xd8, 0x05, ...u32(0x9008),         // fadd dword [0.75]
        0xd8, 0x35, ...u32(0x900c),         // fdiv dword [2.5]
        0xd9, 0x1d, ...u32(0x9010),         // fstp dword -> 2.25
        0xd9, 0x05, ...u32(0x9014),         // fld dword [2.75]
        0xdb, 0x1d, ...u32(0x9018),         // fistp dword -> 3 (nearest)
        0xd9, 0x05, ...u32(0x901c),         // fld dword [-2.5]
        0xdb, 0x1d, ...u32(0x9020),         // fistp dword -> -2 (nearest, ties to even)
        0xd9, 0x3d, ...u32(0x9030),         // fnstcw [0x9030]
        0x66, 0x81, 0x0d, ...u32(0x9030), 0x00, 0x0c, // or word [0x9030], 0x0c00: towards zero
        0xd9, 0x2d, ...u32(0x9030),         // fldcw [0x9030]
        0xd9, 0x05, ...u32(0x9014),         // fld dword [2.75]
        0xdb, 0x1d, ...u32(0x9024),         // fistp dword -> 2 (truncated)
        0xd9, 0x05, ...u32(0x9000),         // fld dword [1.5]
        0xdd, 0x1d, ...u32(0x9040),         // fstp qword -> 1.5 as a double
        0x66, 0x81, 0x25, ...u32(0x9030), 0xff, 0xf3, // and word [0x9030], 0xf3ff: nearest
        0xd9, 0x2d, ...u32(0x9030),         // fldcw [0x9030]
        0xd9, 0x05, ...u32(0x9028),         // fld dword [3e38]
        0xd8, 0xc8,                         // fmul st0, st0 -> 9e76
        0xd9, 0x1d, ...u32(0x902c),         // fstp dword -> +infinity in a single
        0xf4,                               // hlt
    ]));
    host.writePhysical(ENTRY_VECTOR, new Uint8Array(u32(GUEST_CODE)));
    host.cpu().in_hlt[0] = 0;
    host.cpu().instruction_pointer[0] = GUEST_CODE;
    for (let slice = 0; slice < 50 && !host.cpu().in_hlt[0]; slice++)
    {
        host.cpu().run_slice(1000);
    }
    assert.ok(host.cpu().in_hlt[0], 'the program ran to its end');
    const word = (/** @type {number} */ at)=>{
        const b = host.readPhysical(at, 4);
        return (b[0] | b[1] << 8 | b[2] << 16 | b[3] << 24) >>> 0;
    };
    assert.equal(word(0x9010), new Uint32Array(Float32Array.of(2.25).buffer)[0],
        '(1.5 * 3.25 + 0.75) / 2.5 stored as a single');
    assert.equal(word(0x9018), 3, '2.75 to the nearest integer');
    assert.equal(word(0x9020), 0xfffffffe, '-2.5 to the nearest even integer');
    assert.equal(word(0x9024), 2, '2.75 truncated under the control word');
    assert.equal(word(0x9040), 0, 'the double 1.5, low word');
    assert.equal(word(0x9044), 0x3ff80000, 'the double 1.5, high word');
    assert.equal(word(0x902c), 0x7f800000, 'a single that overflows is infinity');
    host.stop();
});

test('a profiler build counts what it ran, by counter and by opcode', async()=>{
    // The release build answers null; the profiler build beside it keeps the
    // emulator's own event counters and the retired instructions by opcode,
    // and the reader turns the enum order and the opcode tables into names.
    const plain = await boot();
    assert.equal(plain.instructionStats(), null, 'a release build keeps no counts');
    plain.stop();

    const host = await boot('v86-profiler.wasm');
    // Enough iterations for the compiler to take the loop: it is compiled
    // once a page has run a couple of hundred thousand instructions.
    host.writePhysical(GUEST_CODE, new Uint8Array([
        0xb9, ...u32(200000),      // mov ecx, 200000
        0x49,                      // loop: dec ecx
        0x75, 0xfd,                // jnz loop
        0xf4,                      // hlt
    ]));
    host.writePhysical(ENTRY_VECTOR, new Uint8Array(u32(GUEST_CODE)));
    const before = host.instructionStats();
    assert.ok(before, 'the profiler build keeps counts');
    host.cpu().in_hlt[0] = 0;
    host.cpu().instruction_pointer[0] = GUEST_CODE;
    const retiredBefore = host.instructionCount();
    for (let slice = 0; slice < 5000 && !host.cpu().in_hlt[0]; slice++)
    {
        host.cpu().run_slice(1000);
        if (slice % 20 === 0)
        {
            await new Promise(resolve=>setTimeout(resolve, 0));
        }
    }
    assert.ok(host.cpu().in_hlt[0], 'the loop ran to its end');
    const retired = host.instructionCount() - retiredBefore;
    const after = host.instructionStats();
    assert.ok(after && before, 'counts before and after');
    const steps = (after.counters.RUN_FROM_CACHE_STEPS - before.counters.RUN_FROM_CACHE_STEPS)
        + (after.counters.RUN_INTERPRETED_STEPS - before.counters.RUN_INTERPRETED_STEPS);
    assert.equal(steps, retired, 'the counters account for every instruction retired');
    assert.ok(after.counters.RUN_FROM_CACHE_STEPS > before.counters.RUN_FROM_CACHE_STEPS,
        'and the loop was compiled');
    const executed = (/** @type {number} */ opcode)=>after.opcodes
        .filter(o=>o.kind === 'executed' && !o.is0f && o.opcode === opcode)
        .reduce((sum, o)=>sum + o.count, 0)
        - before.opcodes
            .filter(o=>o.kind === 'executed' && !o.is0f && o.opcode === opcode)
            .reduce((sum, o)=>sum + o.count, 0);
    // The opcode tables count what generated code ran; the stretch the
    // interpreter ran before the loop was compiled is not in them.
    assert.ok(executed(0x49) >= 50000, `dec ecx ran ${executed(0x49)} times in generated code`);
    assert.ok(executed(0x75) >= 50000, `jnz ran ${executed(0x75)} times in generated code`);
    host.stop();
});

test('generated code goes on into the next module, and the slice still bounds it', async()=>{
    // A loop whose body calls routines four pages apart: a compiled module
    // spans three pages at most, so every call and every return leaves the
    // module. Chained, those exits go straight into the callee's module and
    // back; the program computes the same, the slice is still honoured, and
    // the counters say the chains were taken.
    const host = await boot();
    // Enough iterations for every callee's page to be compiled: a page is
    // compiled once it has run two hundred thousand instructions, and a
    // callee is two -- the add and the return the interpreter stops at.
    const N = 300000;
    const callees = [0x4000, 0x8000, 0xc000, 0x10000].map(offset=>GUEST_CODE + offset);
    for (const at of callees)
    {
        host.writePhysical(at, new Uint8Array([0x01, 0xc8, 0xc3]));   // add eax, ecx; ret
    }
    const code = [0x31, 0xc0, 0xb9, ...u32(N)];                      // xor eax, eax; mov ecx, N
    const loopAt = GUEST_CODE + code.length;
    for (const at of callees)
    {
        const callAt = GUEST_CODE + code.length;
        code.push(0xe8, ...u32(at - (callAt + 5)));                    // call callee
    }
    code.push(0x49);                                                 // dec ecx
    const jnzAt = GUEST_CODE + code.length;
    code.push(0x0f, 0x85, ...u32(loopAt - (jnzAt + 6)));            // jnz loop
    code.push(0xf4);                                                 // hlt
    host.writePhysical(GUEST_CODE, new Uint8Array(code));
    host.writePhysical(ENTRY_VECTOR, new Uint8Array(u32(GUEST_CODE)));
    const expected = ((4 * N * (N + 1)) / 2) >>> 0;                  // sum over the loop of 4 * ecx

    /** @param {number} chaining */
    const run = async chaining=>{
        host.cpu().wm.exports.set_jit_config(6, chaining);
        host.cpu().wm.exports.jit_clear_cache_js();
        host.cpu().in_hlt[0] = 0;
        host.cpu().instruction_pointer[0] = GUEST_CODE;
        host.writeReg32('esp', INITIAL_STACK);
        /** @returns {{ chained: number, chainMissed: number, chainRefused: number,
         *     finalised: number, refused: string }} */
        const counts = ()=>{
            const state = host.jitState();
            assert.notEqual(state, -1, 'the compiler reports its state');
            return /** @type {any} */ (state);
        };
        const before = counts();
        let worst = 0;
        let slices = 0;
        while (!host.cpu().in_hlt[0] && slices < 60000)
        {
            worst = Math.max(worst, host.cpu().run_slice(1000) >>> 0);
            slices++;
            if (slices % 20 === 0)
            {
                await new Promise(resolve=>setTimeout(resolve, 0));
            }
        }
        assert.ok(host.cpu().in_hlt[0], `the loop ran to its end (${slices} slices)`);
        const after = counts();
        assert.equal(after.refused, '', 'every module the compiler made was accepted');
        return { eax: host.readReg32('eax'), worst, chained: after.chained - before.chained,
            missed: after.chainMissed - before.chainMissed,
            budget: after.chainRefused - before.chainRefused, modules: after.finalised };
    };

    const plain = await run(0);
    assert.equal(plain.eax, expected, 'the sum, without chaining');
    assert.equal(plain.chained, 0, 'nothing chained while it was off');
    const chained = await run(1);
    assert.equal(chained.eax, expected, 'the same sum, chained');
    assert.ok(chained.chained > N,
        `the calls and returns chained (${JSON.stringify(chained)})`);
    assert.ok(chained.worst <= 1000 + 16,
        `a slice of a thousand retired at most ${chained.worst}, chains and all`);
    host.stop();
});

test('a return into the module it left from stays in it, chained or not', async()=>{
    // A loop calling four routines in its own page: every return lands in
    // the module that made the call, and the one lookup an exit makes says
    // so. With chaining on, nothing is chained -- the module goes on through
    // its own dispatcher, as it did before chaining existed -- and the sum
    // and the slice bound hold either way.
    const host = await boot();
    const N = 100000;
    const callees = [0x400, 0x500, 0x600, 0x700].map(offset=>GUEST_CODE + offset);
    for (const at of callees)
    {
        host.writePhysical(at, new Uint8Array([0x01, 0xc8, 0xc3]));   // add eax, ecx; ret
    }
    const code = [0x31, 0xc0, 0xb9, ...u32(N)];                      // xor eax, eax; mov ecx, N
    const loopAt = GUEST_CODE + code.length;
    for (const at of callees)
    {
        const callAt = GUEST_CODE + code.length;
        code.push(0xe8, ...u32(at - (callAt + 5)));                    // call callee
    }
    code.push(0x49);                                                 // dec ecx
    const jnzAt = GUEST_CODE + code.length;
    code.push(0x0f, 0x85, ...u32(loopAt - (jnzAt + 6)));            // jnz loop
    code.push(0xf4);                                                 // hlt
    host.writePhysical(GUEST_CODE, new Uint8Array(code));
    host.writePhysical(ENTRY_VECTOR, new Uint8Array(u32(GUEST_CODE)));
    const expected = ((4 * N * (N + 1)) / 2) >>> 0;

    /** @param {number} chaining */
    const run = async chaining=>{
        host.cpu().wm.exports.set_jit_config(6, chaining);
        host.cpu().wm.exports.jit_clear_cache_js();
        host.cpu().in_hlt[0] = 0;
        host.cpu().instruction_pointer[0] = GUEST_CODE;
        host.writeReg32('esp', INITIAL_STACK);
        const counts = ()=>{
            const state = host.jitState();
            assert.notEqual(state, -1, 'the compiler reports its state');
            return /** @type {{ chained: number, chainMissed: number, compiledSteps: number }} */ (state);
        };
        const before = counts();
        let worst = 0;
        let slices = 0;
        while (!host.cpu().in_hlt[0] && slices < 60000)
        {
            worst = Math.max(worst, host.cpu().run_slice(1000) >>> 0);
            slices++;
            if (slices % 20 === 0)
            {
                await new Promise(resolve=>setTimeout(resolve, 0));
            }
        }
        assert.ok(host.cpu().in_hlt[0], `the loop ran to its end (${slices} slices)`);
        const after = counts();
        return { eax: host.readReg32('eax'), worst,
            compiled: after.compiledSteps - before.compiledSteps,
            chained: after.chained - before.chained,
            missed: after.chainMissed - before.chainMissed };
    };

    for (const chaining of [0, 1])
    {
        const result = await run(chaining);
        assert.equal(result.eax, expected, `the sum, chaining ${chaining}`);
        assert.ok(result.compiled > N, `most of it compiled (${JSON.stringify(result)})`);
        assert.equal(result.chained, 0, `nothing to chain into: the returns stay in the module`);
        assert.ok(result.worst <= 1000 + 16,
            `a slice of a thousand retired at most ${result.worst}`);
    }
    host.stop();
});

test('x87 inline and through the helpers compute the same, compiled', async()=>{
    // The inline path keeps a register as a tagged double and does the
    // arithmetic in place; the helpers do it in the 80-bit format. A program
    // mixing both -- loads, stores, arithmetic against memory and registers,
    // an exchange, a compare, a square root the helpers keep -- is run
    // compiled with the inline path off and on, and every result it stored
    // is compared word for word, with the exact ones checked outright.
    const f32 = (/** @type {number} */ v)=>[...new Uint8Array(Float32Array.of(v).buffer)];
    const f64 = (/** @type {number} */ v)=>[...new Uint8Array(Float64Array.of(v).buffer)];
    const DATA = 0x9000;
    const [A, B, C, D, E, F, G] = [0x9000, 0x9004, 0x9008, 0x900c, 0x9010, 0x9018, 0x9020];
    const RESULTS = 0x9100;
    const [R1, R2, R3, R4, R5] = [0x9100, 0x9104, 0x9110, 0x9114, 0x9118];
    const N = 20000;
    const program = [
        0xb9, ...u32(N),                    //       mov ecx, N
        0xdb, 0xe3,                         // loop: fninit
        0xd9, 0x05, ...u32(A),              //       fld dword [A]      1.5
        0xd9, 0x05, ...u32(B),              //       fld dword [B]      2.25
        0xde, 0xc9,                         //       fmulp              3.375
        0xd8, 0x05, ...u32(C),              //       fadd dword [C]     4.125
        0xd9, 0xc0,                         //       fld st(0)
        0xd8, 0x2d, ...u32(D),              //       fsubr dword [D]    10 - 4.125 = 5.875
        0xd9, 0xc9,                         //       fxch               st0 4.125, st1 5.875
        0xd8, 0x35, ...u32(E),              //       fdiv dword [E]     1.03125
        0xdd, 0x05, ...u32(F),              //       fld qword [F]      1.125
        0xdc, 0x0d, ...u32(G),              //       fmul qword [G]     3.375
        0xde, 0xc1,                         //       faddp              4.40625
        0xd9, 0x15, ...u32(R1),             //       fst dword [R1]
        0xdd, 0x1d, ...u32(R2),             //       fstp qword [R2]    st0 5.875
        0xdb, 0x1d, ...u32(R3),             //       fistp dword [R3]   6
        0xd9, 0x05, ...u32(A),              //       fld dword [A]
        0xd9, 0x05, ...u32(B),              //       fld dword [B]
        0xde, 0xd9,                         //       fcompp             2.25 > 1.5
        0xdf, 0xe0,                         //       fnstsw ax
        0xa3, ...u32(R4),                   //       mov [R4], eax
        0xd9, 0x05, ...u32(A),              //       fld dword [A]
        0xd9, 0xfa,                         //       fsqrt
        0xd9, 0xe0,                         //       fchs
        0xd9, 0x1d, ...u32(R5),             //       fstp dword [R5]
        0x49,                               //       dec ecx
    ];
    const jnzAt = GUEST_CODE + program.length;
    program.push(0x0f, 0x85, ...u32((GUEST_CODE + 5) - (jnzAt + 6)));  // jnz loop
    program.push(0xf4);                                                 // hlt

    /** @param {number} inline @returns {Promise<Uint8Array>} */
    const run = async inline=>{
        const host = await boot();
        host.cpu().wm.exports.set_jit_config(7, inline);
        host.cpu().wm.exports.jit_clear_cache_js();
        host.writePhysical(DATA, new Uint8Array([
            ...f32(1.5), ...f32(2.25), ...f32(0.75), ...f32(10), ...f32(4), 0, 0, 0, 0,
            ...f64(1.125), ...f64(3),
        ]));
        host.writePhysical(GUEST_CODE, new Uint8Array(program));
        host.writePhysical(ENTRY_VECTOR, new Uint8Array(u32(GUEST_CODE)));
        host.cpu().in_hlt[0] = 0;
        host.cpu().instruction_pointer[0] = GUEST_CODE;
        host.writeReg32('esp', INITIAL_STACK);
        for (let slice = 0; slice < 5000 && !host.cpu().in_hlt[0]; slice++)
        {
            host.cpu().run_slice(10000);
            if (slice % 10 === 0)
            {
                await new Promise(resolve=>setTimeout(resolve, 0));
            }
        }
        assert.ok(host.cpu().in_hlt[0], 'the program ran to its end');
        const state = host.jitState();
        assert.ok(state !== -1 && state.compiledSteps > 0, 'and was compiled');
        const results = host.readPhysical(RESULTS, 0x20);
        host.stop();
        return results;
    };

    const helpers = await run(0);
    const inline = await run(1);
    assert.deepEqual([...inline], [...helpers], 'the same results either way');
    const word = (/** @type {Uint8Array} */ r, /** @type {number} */ at)=>{
        const o = at - RESULTS;
        return (r[o] | r[o + 1] << 8 | r[o + 2] << 16 | r[o + 3] << 24) >>> 0;
    };
    assert.equal(word(inline, R1), new Uint32Array(Float32Array.of(4.40625).buffer)[0],
        'the chain of loads, arithmetic and an exchange, as a single');
    assert.deepEqual([...inline.subarray(R2 - RESULTS, R2 - RESULTS + 8)], f64(4.40625),
        'and as a double');
    assert.equal(word(inline, R3), 6, 'the remaining value rounded to an integer');
    assert.equal(word(inline, R4) & 0x4700, 0, 'a compare that found st(0) greater');
    assert.equal(word(inline, R5), new Uint32Array(Float32Array.of(-Math.sqrt(1.5)).buffer)[0],
        'a square root through the helper, negated, stored as a single');
});

test('flags nobody reads are left unrecorded, and every flag somebody reads is right', async()=>{
    // A loop in which some arithmetic has its flags overwritten before any
    // read -- an add followed by a store and a subtract, an increment before
    // an exclusive-or, an and before an or -- and some has them read: through
    // a move by a jump on carry, by a conditional set, by a subtract with
    // borrow, by the loop's own jump. Compiled with the leaving-out off and
    // on, every value it stores is compared, and the ones that depend on a
    // read flag are checked outright; the counter says the leaving-out ran.
    const DATA = 0x9000;
    const [A, B, C] = [0x9000, 0x9004, 0x9008];
    const RESULTS = 0x9100;
    const [R1, R2, R3, R4, R5, R6] = [0x9100, 0x9104, 0x9108, 0x910c, 0x9110, 0x9114];
    const N = 300000;
    const program = [
        0xb9, ...u32(N),                    //       mov ecx, N
        0xba, ...u32(0),                    //       mov edx, 0
    ];
    const loopAt = GUEST_CODE + program.length;
    program.push(
        0xa1, ...u32(A),                    // loop: mov eax, [A]
        0x8b, 0x1d, ...u32(B),              //       mov ebx, [B]
        0x01, 0xd8,                         //       add eax, ebx        dead: a store, then sub
        0xa3, ...u32(R1),                   //       mov [R1], eax
        0x2d, ...u32(0x12345),              //       sub eax, 0x12345    live: inc keeps the carry
        0xa3, ...u32(R2),                   //       mov [R2], eax
        0x42,                               //       inc edx             dead: xor follows
        0x31, 0xf6,                         //       xor esi, esi        dead: cmp follows
        0x39, 0xd8,                         //       cmp eax, ebx        live: jne reads
        0x75, 0x01,                         //       jne skip
        0x46,                               //       inc esi
        0x83, 0xc0, 0x01,                   // skip: add eax, 1          live: jc reads past a move
        0x8b, 0x3d, ...u32(C),              //       mov edi, [C]
        0x72, 0x02,                         //       jc carry
        0xeb, 0x01,                         //       jmp nocarry
        0x47,                               // carry: inc edi
        0x89, 0x3d, ...u32(R3),             // nocarry: mov [R3], edi
        0x84, 0xc0,                         //       test al, al         live: setnz reads
        0x0f, 0x95, 0xc3,                   //       setnz bl
        0x89, 0x1d, ...u32(R4),             //       mov [R4], ebx
        0x83, 0xea, 0x01,                   //       sub edx, 1          live: sbb reads
        0x83, 0xd8, 0x00,                   //       sbb eax, 0
        0xa3, ...u32(R5),                   //       mov [R5], eax
        0x25, ...u32(0xff),                 //       and eax, 0xff       dead: or follows
        0x0d, ...u32(0x100),                //       or eax, 0x100       live: dec keeps the carry
        0xa3, ...u32(R6),                   //       mov [R6], eax
        0x49,                               //       dec ecx             live: jnz reads
    );
    const jnzAt = GUEST_CODE + program.length;
    program.push(0x0f, 0x85, ...u32(loopAt - (jnzAt + 6)));            // jnz loop
    program.push(0xf4);                                                 // hlt

    /** @param {number} leaveOut @returns {Promise<{ results: Uint8Array, left: number }>} */
    const run = async leaveOut=>{
        const host = await boot();
        host.cpu().wm.exports.set_jit_config(8, leaveOut);
        host.cpu().wm.exports.jit_clear_cache_js();
        host.writePhysical(DATA, new Uint8Array([
            ...u32(0x12345678), ...u32(0x11111111), ...u32(7),
        ]));
        host.writePhysical(GUEST_CODE, new Uint8Array(program));
        host.writePhysical(ENTRY_VECTOR, new Uint8Array(u32(GUEST_CODE)));
        host.cpu().in_hlt[0] = 0;
        host.cpu().instruction_pointer[0] = GUEST_CODE;
        host.writeReg32('esp', INITIAL_STACK);
        const before = /** @type {any} */ (host.jitState());
        for (let slice = 0; slice < 20000 && !host.cpu().in_hlt[0]; slice++)
        {
            host.cpu().run_slice(10000);
            if (slice % 10 === 0)
            {
                await new Promise(resolve=>setTimeout(resolve, 0));
            }
        }
        assert.ok(host.cpu().in_hlt[0], 'the program ran to its end');
        const after = /** @type {any} */ (host.jitState());
        assert.ok(after.compiledSteps - before.compiledSteps > N, 'and was compiled');
        const results = host.readPhysical(RESULTS, 0x18);
        host.stop();
        return { results, left: after.flagsDead - before.flagsDead };
    };

    const recorded = await run(0);
    const left = await run(1);
    assert.equal(recorded.left, 0, 'with the leaving-out off, every instruction records its flags');
    assert.ok(left.left >= 4,
        `with it on, the four whose flags are dead were left out (${left.left})`);
    assert.deepEqual([...left.results], [...recorded.results], 'the same results either way');
    const word = (/** @type {number} */ at)=>{
        const o = at - RESULTS;
        const r = left.results;
        return (r[o] | r[o + 1] << 8 | r[o + 2] << 16 | r[o + 3] << 24) >>> 0;
    };
    assert.equal(word(R1), 0x23456789, 'the add whose flags were left out still adds');
    assert.equal(word(R2), 0x23444444);
    assert.equal(word(R3), 7, 'no carry out of the add, read through a move');
    assert.equal(word(R4), 0x11111101, 'the low byte was not zero, by the conditional set');
    assert.equal(word(R5), 0x23444445, 'no borrow out of the subtract, by the one with borrow');
    assert.equal(word(R6), 0x145, 'the and whose flags were left out still masks');
});

test('a repeated string instruction runs to its end without leaving the module', async()=>{
    // A loop that copies three pages and a bit with rep movsd, fills as much
    // with rep stosb, measures a string with repne scasb and compares two
    // buffers with repe cmpsb. The helper does a page at a time and asks to
    // run again; compiled, that repetition stays inside the module, so the
    // loop enters generated code a handful of times rather than once per
    // page per iteration -- and copies, fills, measures and compares right.
    const host = await boot();
    const SRC = 0x20000;
    const DST = 0x24000;
    const FILL = 0x2c000;
    const BYTES = 3 * 4096 + 100;
    const TEXT = 0x28000;
    const TEXT_LENGTH = 4096 + 37;
    const RESULTS = 0x9100;
    const [R1, R2, R3, R4] = [0x9100, 0x9104, 0x9108, 0x910c];
    // Enough iterations for the loop's page to be compiled: a page is
    // compiled once it has run two hundred thousand instructions.
    const N = 40000;
    const program = [
        0xb9, ...u32(N),                    //       mov ecx, N
        0x89, 0x0d, ...u32(0x9200),         // loop: mov [0x9200], ecx
        0xfc,                               //       cld
        0xbe, ...u32(SRC),                  //       mov esi, SRC
        0xbf, ...u32(DST),                  //       mov edi, DST
        0xb9, ...u32(BYTES / 4),            //       mov ecx, BYTES / 4
        0xf3, 0xa5,                         //       rep movsd
        0xbf, ...u32(FILL),                 //       mov edi, FILL
        0xb9, ...u32(BYTES),                //       mov ecx, BYTES
        0xb0, 0x5a,                         //       mov al, 0x5a
        0xf3, 0xaa,                         //       rep stosb
        0xbf, ...u32(TEXT),                 //       mov edi, TEXT
        0xb9, ...u32(0x10000),              //       mov ecx, 0x10000
        0x30, 0xc0,                         //       xor al, al
        0xf2, 0xae,                         //       repne scasb
        0x89, 0x0d, ...u32(R1),             //       mov [R1], ecx       0x10000 - length - 1
        0xbe, ...u32(SRC),                  //       mov esi, SRC
        0xbf, ...u32(DST),                  //       mov edi, DST
        0xb9, ...u32(BYTES),                //       mov ecx, BYTES
        0xf3, 0xa6,                         //       repe cmpsb
        0x89, 0x0d, ...u32(R2),             //       mov [R2], ecx       none left: they are equal
        0xbe, ...u32(FILL),                 //       mov esi, FILL
        0xbf, ...u32(DST),                  //       mov edi, DST
        0xb9, ...u32(BYTES),                //       mov ecx, BYTES
        0xf3, 0xa6,                         //       repe cmpsb
        0x89, 0x0d, ...u32(R4),             //       mov [R4], ecx       all but one: differ at once
        0x8b, 0x0d, ...u32(0x9200),         //       mov ecx, [0x9200]
        0x49,                               //       dec ecx
    ];
    const jnzAt = GUEST_CODE + program.length;
    program.push(0x0f, 0x85, ...u32((GUEST_CODE + 5) - (jnzAt + 6)));  // jnz loop
    program.push(0x8b, 0x05, ...u32(DST + BYTES - 4));                  // mov eax, [last dword]
    program.push(0xa3, ...u32(R3));                                     // mov [R3], eax
    program.push(0xf4);                                                 // hlt

    const source = new Uint8Array(BYTES);
    for (let i = 0; i < BYTES; i++)
    {
        source[i] = (i * 7 + 3) & 0xff;
    }
    host.writePhysical(SRC, source);
    const text = new Uint8Array(TEXT_LENGTH + 1).fill(0x41);
    text[TEXT_LENGTH] = 0;
    host.writePhysical(TEXT, text);
    host.writePhysical(GUEST_CODE, new Uint8Array(program));
    host.writePhysical(ENTRY_VECTOR, new Uint8Array(u32(GUEST_CODE)));
    host.cpu().in_hlt[0] = 0;
    host.cpu().instruction_pointer[0] = GUEST_CODE;
    host.writeReg32('esp', INITIAL_STACK);
    const before = /** @type {any} */ (host.jitState());
    for (let slice = 0; slice < 60000 && !host.cpu().in_hlt[0]; slice++)
    {
        host.cpu().run_slice(10000);
        if (slice % 10 === 0)
        {
            await new Promise(resolve=>setTimeout(resolve, 0));
        }
    }
    assert.ok(host.cpu().in_hlt[0], 'the program ran to its end');
    const after = /** @type {any} */ (host.jitState());
    assert.ok(after.compiledSteps - before.compiledSteps > N * 10, 'and was compiled');
    // Ending the block at each of the five string instructions, the loop
    // entered generated code five times an iteration; staying inside, it
    // enters once a slice.
    const entries = after.entries - before.entries;
    assert.ok(entries < N / 10, `entered generated code ${entries} times for ${N} iterations`);
    const results = host.readPhysical(RESULTS, 16);
    const word = (/** @type {number} */ at)=>{
        const o = at - RESULTS;
        return (results[o] | results[o + 1] << 8 | results[o + 2] << 16
            | results[o + 3] << 24) >>> 0;
    };
    assert.equal(word(R1), 0x10000 - (TEXT_LENGTH + 1), 'the scan found the terminator');
    assert.equal(word(R3), (source[BYTES - 4] | source[BYTES - 3] << 8
        | source[BYTES - 2] << 16 | source[BYTES - 1] << 24) >>> 0, 'the copy reached its end');
    assert.equal(word(R2), 0, 'the compare of the copy with its source ran to the end');
    assert.equal(word(R4), BYTES - 1, 'the compare of the fill with the copy stopped at once');
    const copied = host.readPhysical(DST, BYTES);
    assert.deepEqual([...copied], [...source], 'the copy is the source, byte for byte');
    const filled = host.readPhysical(FILL, BYTES);
    assert.ok(filled.every(b=>b === 0x5a), 'the fill covered every byte');
    host.stop();
});

test('a read compiled without paging checks a range, and reads what the TLB path reads', async()=>{
    // With paging off the linear address is the physical one, and a read in
    // plain RAM is compiled as a range check and a load. A loop reads a
    // byte, a word, a dword, a double and sixteen bytes from plain RAM, the
    // last dword of RAM, a dword straddling its end, a dword in the VGA
    // window and one below it -- the last three go the slow way -- with the
    // range check off and on, and every value stored is compared, the plain
    // ones checked outright.
    const host = await boot();
    const ram = host.cpu().memory_size[0];
    const DATA = 0x100000;
    const RESULTS = 0x9100;
    const [R1, R2, R3, R4, R5, R6, R7, R8, R9] = [
        0x9100, 0x9104, 0x9108, 0x9110, 0x9120, 0x9130, 0x9134, 0x9138, 0x913c,
    ];
    const N = 200000;
    const program = [
        0xb9, ...u32(N),                    //       mov ecx, N
    ];
    const loopAt = GUEST_CODE + program.length;
    program.push(
        0x0f, 0xb6, 0x05, ...u32(DATA + 1), // loop: movzx eax, byte [DATA + 1]
        0xa3, ...u32(R1),                   //       mov [R1], eax
        0x0f, 0xb7, 0x05, ...u32(DATA + 2), //       movzx eax, word [DATA + 2]
        0xa3, ...u32(R2),                   //       mov [R2], eax
        0xa1, ...u32(DATA + 4),             //       mov eax, [DATA + 4]
        0xa3, ...u32(R3),                   //       mov [R3], eax
        0xdd, 0x05, ...u32(DATA + 8),       //       fld qword [DATA + 8]
        0xdd, 0x1d, ...u32(R4),             //       fstp qword [R4]
        0x0f, 0x10, 0x05, ...u32(DATA + 16), //      movups xmm0, [DATA + 16]
        0x0f, 0x11, 0x05, ...u32(R5),       //       movups [R5], xmm0
        0xa1, ...u32(ram - 4),              //       mov eax, [ram - 4]
        0xa3, ...u32(R6),                   //       mov [R6], eax
        0xa1, ...u32(ram - 2),              //       mov eax, [ram - 2]
        0xa3, ...u32(R7),                   //       mov [R7], eax
        0xa1, ...u32(0xa0000),              //       mov eax, [0xa0000]
        0xa3, ...u32(R8),                   //       mov [R8], eax
        0xa1, ...u32(GUEST_CODE),           //       mov eax, [GUEST_CODE]
        0xa3, ...u32(R9),                   //       mov [R9], eax
        0x49,                               //       dec ecx
    );
    const jnzAt = GUEST_CODE + program.length;
    program.push(0x0f, 0x85, ...u32(loopAt - (jnzAt + 6)));            // jnz loop
    program.push(0xf4);                                                 // hlt

    const data = new Uint8Array(32);
    for (let i = 0; i < 32; i++)
    {
        data[i] = 0x10 + i;
    }
    const f64 = [...new Uint8Array(Float64Array.of(-2.5).buffer)];
    data.set(f64, 8);

    /** @param {number} flat @returns {Promise<Uint8Array>} */
    const run = async flat=>{
        host.cpu().wm.exports.set_jit_config(9, flat);
        host.cpu().wm.exports.jit_clear_cache_js();
        host.writePhysical(DATA, data);
        host.writePhysical(ram - 4, new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
        host.writePhysical(GUEST_CODE, new Uint8Array(program));
        host.writePhysical(ENTRY_VECTOR, new Uint8Array(u32(GUEST_CODE)));
        host.writePhysical(RESULTS, new Uint8Array(0x40));
        host.cpu().in_hlt[0] = 0;
        host.cpu().instruction_pointer[0] = GUEST_CODE;
        host.writeReg32('esp', INITIAL_STACK);
        const before = /** @type {any} */ (host.jitState());
        for (let slice = 0; slice < 60000 && !host.cpu().in_hlt[0]; slice++)
        {
            host.cpu().run_slice(10000);
            if (slice % 10 === 0)
            {
                await new Promise(resolve=>setTimeout(resolve, 0));
            }
        }
        assert.ok(host.cpu().in_hlt[0], 'the program ran to its end');
        const after = /** @type {any} */ (host.jitState());
        assert.ok(after.compiledSteps - before.compiledSteps > N * 10, 'and was compiled');
        return host.readPhysical(RESULTS, 0x40);
    };

    const throughTlb = await run(0);
    const flat = await run(1);
    assert.deepEqual([...flat], [...throughTlb], 'the same values either way');
    const word = (/** @type {number} */ at)=>{
        const o = at - RESULTS;
        return (flat[o] | flat[o + 1] << 8 | flat[o + 2] << 16 | flat[o + 3] << 24) >>> 0;
    };
    assert.equal(word(R1), 0x11, 'a byte');
    assert.equal(word(R2), 0x1312, 'a word');
    assert.equal(word(R3), 0x17161514, 'a dword');
    assert.deepEqual([...flat.subarray(R4 - RESULTS, R4 - RESULTS + 8)], f64, 'a double');
    assert.deepEqual([...flat.subarray(R5 - RESULTS, R5 - RESULTS + 16)],
        [...data.subarray(16, 32)], 'sixteen bytes');
    assert.equal(word(R6), 0xefbeadde, 'the last dword of RAM');
    assert.equal(word(R9), (0xb9 | N << 8) >>> 0, 'the code itself, below the range');
    host.stop();
});

test('an instruction left to the interpreter runs inside the block', async()=>{
    // fnstsw m16 and the SSE control-word moves are run by the interpreter's
    // helper rather than compiled. A loop of them, compiled, stores what they
    // produce -- the status word after a compare, the control word round-
    // tripped -- and enters generated code once a slice rather than at each.
    const host = await boot();
    const RESULTS = 0x9100;
    const [R1, R2, R3] = [0x9100, 0x9104, 0x9108];
    const SCRATCH = 0x9200;
    const N = 40000;
    const program = [
        0xb9, ...u32(N),                    //       mov ecx, N
    ];
    const loopAt = GUEST_CODE + program.length;
    program.push(
        0xdb, 0xe3,                         // loop: fninit
        0xd9, 0xe8,                         //       fld1
        0xd9, 0xee,                         //       fldz
        0xde, 0xd9,                         //       fcompp              0 < 1: C0 set
        0xdd, 0x3d, ...u32(R1),             //       fnstsw word [R1]
        0x0f, 0xae, 0x1d, ...u32(SCRATCH),  //       stmxcsr [SCRATCH]
        0x81, 0x0d, ...u32(SCRATCH), ...u32(0x8000), // or dword [SCRATCH], 0x8000 (FTZ)
        0x0f, 0xae, 0x15, ...u32(SCRATCH),  //       ldmxcsr [SCRATCH]
        0x0f, 0xae, 0x1d, ...u32(R2),       //       stmxcsr [R2]
        0x0f, 0xae, 0x15, ...u32(R3),       //       ldmxcsr [R3]        the default, kept there
        0x49,                               //       dec ecx
    );
    const jnzAt = GUEST_CODE + program.length;
    program.push(0x0f, 0x85, ...u32(loopAt - (jnzAt + 6)));            // jnz loop
    program.push(0xf4);                                                 // hlt
    host.writePhysical(R3, new Uint8Array(u32(0x1f80)));
    host.writePhysical(GUEST_CODE, new Uint8Array(program));
    host.writePhysical(ENTRY_VECTOR, new Uint8Array(u32(GUEST_CODE)));
    host.cpu().in_hlt[0] = 0;
    host.cpu().instruction_pointer[0] = GUEST_CODE;
    host.writeReg32('esp', INITIAL_STACK);
    const before = /** @type {any} */ (host.jitState());
    for (let slice = 0; slice < 60000 && !host.cpu().in_hlt[0]; slice++)
    {
        host.cpu().run_slice(10000);
        if (slice % 10 === 0)
        {
            await new Promise(resolve=>setTimeout(resolve, 0));
        }
    }
    assert.ok(host.cpu().in_hlt[0], 'the program ran to its end');
    const after = /** @type {any} */ (host.jitState());
    // Most of the loop, not all: the compile lands a few thousand
    // iterations in, at a moment that varies with the run.
    assert.ok(after.compiledSteps - before.compiledSteps > N * 2,
        `and was compiled (${after.compiledSteps - before.compiledSteps} steps)`);
    const entries = after.entries - before.entries;
    assert.ok(entries < N / 10, `entered generated code ${entries} times for ${N} iterations`);
    const results = host.readPhysical(RESULTS, 12);
    const word = (/** @type {number} */ at)=>{
        const o = at - RESULTS;
        return (results[o] | results[o + 1] << 8 | results[o + 2] << 16
            | results[o + 3] << 24) >>> 0;
    };
    assert.equal(word(R1) & 0x4500, 0x0100, 'the compare set C0 alone: zero is below one');
    assert.equal(word(R2), 0x9f80, 'the control word came back with flush-to-zero set');
});

test('without paging a loop runs across a page boundary inside generated code', async()=>{
    // A loop laid across the end of a page, with one instruction straddling
    // the boundary. Stopping short of the page's end, the compiler left the
    // last bytes to the interpreter and the loop exited generated code twice
    // an iteration; running to the boundary and across it, the loop stays in
    // the module. Both ways compute the same, and the knob says which.
    const host = await boot();
    const PAGE_END = 0x9000;
    const START = PAGE_END - 0x18;
    // Enough iterations for the next page to be compiled even when it is
    // the only one that can be: three instructions of the loop lie on it.
    const N = 300000;
    const program = [
        0xb9, ...u32(N),                    // 8fe8: mov ecx, N
        0x31, 0xc0,                         // 8fed: xor eax, eax
        0x31, 0xd2,                         // 8fef: xor edx, edx
    ];
    const loopAt = START + program.length;  // 8ff1
    program.push(
        0x01, 0xc8,                         // 8ff1: add eax, ecx
        0x81, 0xc2, ...u32(3),              // 8ff3: add edx, 3
        0x89, 0xc3,                         // 8ff9: mov ebx, eax
        0x31, 0xd3,                         // 8ffb: xor ebx, edx
        0x81, 0xf3, ...u32(0x5a5a),         // 8ffd: xor ebx, 0x5a5a     straddles 9000
        0x89, 0xde,                         // 9003: mov esi, ebx
        0x49,                               // 9005: dec ecx
    );
    const jnzAt = START + program.length;
    program.push(0x0f, 0x85, ...u32(loopAt - (jnzAt + 6)));            // jnz loop
    program.push(0xf4);                                                 // hlt
    assert.equal(START + 0x15, PAGE_END - 3, 'the long xor starts three bytes before the end');

    /**
     * @param {number} across
     * @param {boolean} warm  Keep what the last run compiled.
     * @returns {Promise<{ eax: number, esi: number, entries: number, interpreted: number }>}
     */
    const run = async(across, warm)=>{
        host.cpu().wm.exports.set_jit_config(10, across);
        if (!warm)
        {
            host.cpu().wm.exports.jit_clear_cache_js();
            // Written once: writing the code again would throw the module
            // away, which is what a warm run is measuring the absence of.
            host.writePhysical(START, new Uint8Array(program));
            host.writePhysical(ENTRY_VECTOR, new Uint8Array(u32(START)));
        }
        host.cpu().in_hlt[0] = 0;
        host.cpu().instruction_pointer[0] = START;
        host.writeReg32('esp', INITIAL_STACK);
        const before = /** @type {any} */ (host.jitState());
        for (let slice = 0; slice < 60000 && !host.cpu().in_hlt[0]; slice++)
        {
            host.cpu().run_slice(10000);
            if (slice % 10 === 0)
            {
                await new Promise(resolve=>setTimeout(resolve, 0));
            }
        }
        assert.ok(host.cpu().in_hlt[0], 'the program ran to its end');
        const after = /** @type {any} */ (host.jitState());
        assert.ok(after.compiledSteps - before.compiledSteps > N, 'and was compiled');
        return {
            eax: host.readReg32('eax'), esi: host.readReg32('esi'),
            entries: after.entries - before.entries,
            interpreted: after.interpretedSteps - before.interpretedSteps,
        };
    };

    const short = await run(0, false);
    await run(1, false);
    // Measured warm, so the iterations before the module was compiled --
    // interpreted either way -- are not in the count.
    const across = await run(1, true);
    const expected = ((N * (N + 1)) / 2) >>> 0;
    assert.equal(short.eax, expected, 'the sum, stopping short of the page end');
    assert.equal(across.eax, expected, 'the sum, running across it');
    assert.equal(across.esi, short.esi, 'and the straddling instruction computes the same');
    assert.equal(across.esi, ((expected ^ (3 * N)) ^ 0x5a5a) >>> 0);
    assert.ok(short.entries > N / 2,
        `stopping short, generated code was entered ${short.entries} times`);
    assert.ok(across.entries < N / 10,
        `running across, ${across.entries} times for ${N} iterations`);
    assert.ok(across.interpreted < N / 10,
        `and the interpreter ran ${across.interpreted} instructions, not ${short.interpreted}`);
    host.stop();
});

test('a write compiled without paging checks a range and a byte, and matches the TLB', async()=>{
    // With paging off a write in plain RAM is compiled as a range check, a
    // check that it stays in its page, one byte saying whether the page
    // holds code, and the store. A loop stores a byte, a word, a dword, a
    // double and sixteen bytes, pushes, calls and pops, adds into memory at
    // three widths and writes the last dword of RAM; after it, a store into
    // its own page patches an instruction of a second loop, which must then
    // run, and be compiled again, as patched -- a write the fast path may
    // not take. Another program writes only where the slow path is needed:
    // a dword straddling the end of RAM, one in the VGA window, one below
    // the range, one across a page, and one into its own page beside the
    // loop's instructions, which must keep the module. Both run with the
    // fast path off and on, memory and registers are compared, and the
    // counters say which path was taken and what the code pages kept.
    const host = await boot();
    const exports = host.cpu().wm.exports;
    const slowWrites = ()=>exports.bottlify_stat(12);
    assert.notEqual(slowWrites(), -1, 'a build that counts slow-path writes');
    const ram = host.cpu().memory_size[0];
    const DATA = 0x100000;
    const RESULT = 0x9100;
    const BELOW = 0x7f00;
    const ACROSS = 0x101ffe;
    const N = 200000;

    /** @param {number} callee @returns {number[]} */
    const forms = callee=>{
        const program = [0xb9, ...u32(N)];                          // mov ecx, N
        const loopAt = GUEST_CODE + program.length;
        program.push(
            0x89, 0xc8,                                             // mov eax, ecx
            0xa2, ...u32(DATA),                                     // mov [DATA], al
            0x66, 0xa3, ...u32(DATA + 2),                           // mov [DATA + 2], ax
            0xa3, ...u32(DATA + 4),                                 // mov [DATA + 4], eax
            0x51,                                                   // push ecx
            0x50,                                                   // push eax
        );
        const callAt = GUEST_CODE + program.length;
        program.push(
            0xe8, ...u32(callee - (callAt + 5)),                    // call callee
            0x58,                                                   // pop eax
            0x59,                                                   // pop ecx
            0x01, 0x05, ...u32(DATA + 8),                           // add [DATA + 8], eax
            0xfe, 0x05, ...u32(DATA + 12),                          // inc byte [DATA + 12]
            0x66, 0x01, 0x05, ...u32(DATA + 14),                    // add [DATA + 14], ax
            0xdf, 0x05, ...u32(DATA + 4),                           // fild dword [DATA + 4]
            0xdd, 0x1d, ...u32(DATA + 16),                          // fstp qword [DATA + 16]
            0x0f, 0x10, 0x05, ...u32(DATA),                         // movups xmm0, [DATA]
            0x0f, 0x11, 0x05, ...u32(DATA + 32),                    // movups [DATA + 32], xmm0
            0xa3, ...u32(ram - 4),                                  // mov [ram - 4], eax
            0x49,                                                   // dec ecx
        );
        const jnzAt = GUEST_CODE + program.length;
        program.push(0x0f, 0x85, ...u32(loopAt - (jnzAt + 6)));    // jnz loop
        const patchAt = GUEST_CODE + program.length + 15;
        program.push(
            0xc7, 0x05, ...u32(patchAt + 1), ...u32(7),             // mov dword [patch + 1], 7
            0xb9, ...u32(N),                                        // mov ecx, N
            0xb8, ...u32(0),                                        // patch: mov eax, 0
            0x01, 0x05, ...u32(DATA + 0x30),                        // add [DATA + 0x30], eax
            0x49,                                                   // dec ecx
        );
        const againAt = GUEST_CODE + program.length;
        program.push(
            0x0f, 0x85, ...u32(patchAt - (againAt + 6)),            // jnz patch
            0xa3, ...u32(RESULT),                                   // mov [RESULT], eax
            0xf4,                                                   // hlt
            0xc3,                                                   // callee: ret
        );
        return program;
    };
    const formsProgram = forms(GUEST_CODE + forms(0).length - 1);

    const edges = [0xb9, ...u32(N)];                                // mov ecx, N
    const edgesLoopAt = GUEST_CODE + edges.length;
    edges.push(
        0x89, 0xc8,                                                 // mov eax, ecx
        0xa3, ...u32(ram - 2),                                      // mov [ram - 2], eax
        0xa3, ...u32(0xa0000),                                      // mov [0xa0000], eax
        0xa3, ...u32(BELOW),                                        // mov [BELOW], eax
        0xa3, ...u32(ACROSS),                                       // mov [ACROSS], eax
        0xa3, ...u32(GUEST_CODE + 0x800),                           // mov [GUEST_CODE + 0x800], eax
        0x49,                                                       // dec ecx
    );
    const edgesJnzAt = GUEST_CODE + edges.length;
    edges.push(0x0f, 0x85, ...u32(edgesLoopAt - (edgesJnzAt + 6)));    // jnz loop
    edges.push(0xf4);                                               // hlt

    /**
     * @param {number[]} program
     * @param {number} flat
     * @param {boolean} warm  Keep the code, and whatever was compiled of it.
     */
    const run = async(program, flat, warm)=>{
        exports.set_jit_config(11, flat);
        if (!warm)
        {
            exports.jit_clear_cache_js();
            host.writePhysical(GUEST_CODE, new Uint8Array(program));
            host.writePhysical(ENTRY_VECTOR, new Uint8Array(u32(GUEST_CODE)));
        }
        host.writePhysical(DATA, new Uint8Array(0x40));
        host.writePhysical(RESULT, new Uint8Array(4));
        host.writePhysical(BELOW, new Uint8Array(4));
        host.writePhysical(ACROSS - 2, new Uint8Array(8));
        host.writePhysical(ram - 4, new Uint8Array(4));
        host.writePhysical(GUEST_CODE + 0x800, new Uint8Array(4));
        host.cpu().in_hlt[0] = 0;
        host.cpu().instruction_pointer[0] = GUEST_CODE;
        host.writeReg32('esp', INITIAL_STACK);
        const before = /** @type {any} */ (host.jitState());
        const slowBefore = slowWrites();
        const keptBefore = exports.bottlify_stat(13);
        for (let slice = 0; slice < 60000 && !host.cpu().in_hlt[0]; slice++)
        {
            host.cpu().run_slice(10000);
            if (slice % 10 === 0)
            {
                await new Promise(resolve=>setTimeout(resolve, 0));
            }
        }
        assert.ok(host.cpu().in_hlt[0], 'the program ran to its end');
        const after = /** @type {any} */ (host.jitState());
        assert.ok(after.compiledSteps - before.compiledSteps > N * 4, 'and was compiled');
        return {
            data: host.readPhysical(DATA, 0x40),
            result: host.readPhysical(RESULT, 4),
            below: host.readPhysical(BELOW, 4),
            across: host.readPhysical(ACROSS - 2, 8),
            last: host.readPhysical(ram - 4, 4),
            beside: host.readPhysical(GUEST_CODE + 0x800, 4),
            stack: host.readPhysical(INITIAL_STACK - 16, 16),
            eax: host.readReg32('eax'), ecx: host.readReg32('ecx'), esp: host.readReg32('esp'),
            slow: slowWrites() - slowBefore,
            kept: exports.bottlify_stat(13) - keptBefore,
            modules: after.finalised - before.finalised,
            discarded: after.discarded - before.discarded,
        };
    };
    /** @param {Uint8Array} bytes @param {number} at */
    const word = (bytes, at)=>
        (bytes[at] | bytes[at + 1] << 8 | bytes[at + 2] << 16 | bytes[at + 3] << 24) >>> 0;
    /** @param {Uint8Array} bytes @param {number} at */
    const half = (bytes, at)=>bytes[at] | bytes[at + 1] << 8;

    const throughTlb = await run(formsProgram, 0, false);
    const flat = await run(formsProgram, 1, false);
    const again = await run(formsProgram, 1, true);
    /** @param {string} name @param {typeof flat} one */
    const same = (name, one)=>{
        const base = throughTlb;
        assert.deepEqual([...one.data], [...base.data], `${name}: the data written`);
        assert.deepEqual([...one.stack], [...base.stack], `${name}: the stack written`);
        assert.deepEqual(
            [...one.result, ...one.last, one.eax, one.ecx, one.esp],
            [...base.result, ...base.last, base.eax, base.ecx, base.esp],
            `${name}: the rest`);
    };
    same('flat', flat);
    same('again', again);
    const sum = ((N * (N + 1)) / 2) >>> 0;
    assert.equal(flat.data[0], 1, 'a byte');
    assert.equal(half(flat.data, 2), 1, 'a word');
    assert.equal(word(flat.data, 4), 1, 'a dword');
    assert.equal(word(flat.data, 8), sum, 'a dword added into');
    assert.equal(flat.data[12], N & 0xff, 'a byte incremented');
    assert.equal(half(flat.data, 14), sum & 0xffff, 'a word added into');
    assert.deepEqual([...flat.data.subarray(16, 24)],
        [...new Uint8Array(Float64Array.of(1).buffer)], 'a double');
    assert.deepEqual([...flat.data.subarray(32, 48)], [...flat.data.subarray(0, 16)],
        'sixteen bytes');
    assert.equal(word(flat.last, 0), 1, 'the last dword of RAM');
    assert.equal(word(flat.stack, 12), 1, 'ecx pushed');
    assert.equal(word(flat.stack, 8), 1, 'eax pushed');
    const returnAddress = word(flat.stack, 4);
    assert.ok(returnAddress > GUEST_CODE && returnAddress < GUEST_CODE + formsProgram.length,
        'the return address pushed by call');
    assert.equal(word(flat.data, 0x30), (7 * N) >>> 0,
        'the store into the code page took, and the second loop ran as patched');
    assert.equal(word(flat.result, 0), 7);
    assert.equal(flat.eax, 7);
    assert.ok(flat.modules >= 2, `${flat.modules} modules: one before the patch, one after`);
    assert.ok(again.modules >= 2, `${again.modules} modules on the warm run`);
    assert.equal(flat.esp, INITIAL_STACK, 'and the stack is balanced');
    assert.ok(flat.slow < 8, `${flat.slow} writes took the slow path, out of ${N} iterations`);
    assert.ok(again.slow < 8, `${again.slow} on the warm run`);

    const edgesThroughTlb = await run(edges, 0, false);
    const edgesFlat = await run(edges, 1, false);
    assert.deepEqual([...edgesFlat.below], [...edgesThroughTlb.below], 'below the range');
    assert.deepEqual([...edgesFlat.across], [...edgesThroughTlb.across], 'across a page');
    assert.deepEqual([...edgesFlat.last], [...edgesThroughTlb.last], 'straddling the end');
    assert.equal(word(edgesFlat.below, 0), 1);
    assert.equal(word(edgesFlat.across, 2), 1);
    assert.deepEqual([...edgesFlat.last], [0, 0, 1, 0], 'the bytes past the end are dropped');
    /** @param {string} name @param {typeof edgesFlat} one */
    const keptItsCode = (name, one)=>{
        assert.equal(word(one.beside, 0), 1, `${name}: the write beside the instructions`);
        assert.ok(one.discarded <= 2,
            `${name}: ${one.discarded} modules discarded by ${N} writes beside the instructions`);
        assert.ok(one.kept >= N / 2, `${name}: ${one.kept} writes kept the page's code`);
    };
    keptItsCode('through the TLB', edgesThroughTlb);
    keptItsCode('flat', edgesFlat);
    assert.ok(edgesFlat.slow >= N,
        `${edgesFlat.slow} writes took the slow path, out of ${5 * N}`);
    host.stop();
});

test('an x87 value that keeps its tag computes what the helpers compute', async()=>{
    // The forms beyond arithmetic -- an exchange, a constant, a sign change, a
    // compare, a register-to-register store, a square root, an integer load
    // and an integer store -- are emitted inline on a register the generated
    // code tagged as holding a double. With the group off each is the call it
    // was, and the call writes the 80-bit form back, so the registers it
    // touches lose their tag and every later inline operation on them takes
    // its helper arm too. The same program is run compiled both ways and every
    // result compared word for word: a negative zero through the sign
    // changes, halves rounded in each of the four modes the control word
    // names, a chain of exchanges, roots that are exact and roots that are
    // not, an ordinary compare of two tagged operands, and the integers at
    // either end of a word. A compare against a NaN is its own test below: a
    // NaN is never tagged, so it always takes the helper arm and does not
    // belong to this test's "keeps its tag" threshold.
    //
    // A root that is not exact is stored as a single: rounded to a double
    // through the 80-bit format and rounded to a double directly can differ in
    // the last bit, but rounding a double's worth of root to a single cannot.
    const f32 = (/** @type {number} */ v)=>[...new Uint8Array(Float32Array.of(v).buffer)];
    const bits = (/** @type {number} */ v)=>new Uint32Array(Float32Array.of(v).buffer)[0];
    const DATA = 0x9000;
    const [A, B, NEGZERO] = [0x9000, 0x9004, 0x9008];
    const [HALF, NEGHALF, SQUARE, TWO] = [0x9010, 0x9014, 0x9018, 0x901c];
    const [IMAX, IMIN, CW, CWBASE] = [0x9020, 0x9024, 0x9028, 0x902c];
    const RESULTS = 0x9100;
    const N = 20000;

    /** @param {number} at */
    const abs = at=>u32(at);
    const program = [
        0xb9, ...u32(N),                        //       mov ecx, N
        0xdb, 0xe3,                             // loop: fninit
        // a chain of exchanges, then a multiply reading both registers
        0xd9, 0x05, ...abs(A),                  //       fld dword [1.5]
        0xd9, 0x05, ...abs(B),                  //       fld dword [2.25]
        0xd9, 0xc9,                             //       fxch st1
        0xd9, 0xc9,                             //       fxch st1
        0xd9, 0xc9,                             //       fxch st1
        0xde, 0xc9,                             //       fmulp st1, st0   3.375
        0xd9, 0x1d, ...abs(RESULTS + 0x00),
        // a register-to-register store, the copy then used as an operand
        0xd9, 0x05, ...abs(A),                  //       fld dword [1.5]
        0xd9, 0x05, ...abs(B),                  //       fld dword [2.25]
        0xdd, 0xd1,                             //       fst st1
        0xde, 0xc9,                             //       fmulp st1, st0   5.0625
        0xd9, 0x1d, ...abs(RESULTS + 0x04),
        // a negative zero through the sign changes
        0xd9, 0x05, ...abs(NEGZERO),            //       fld dword [-0.0]
        0xd9, 0xe1,                             //       fabs             +0.0
        0xd9, 0x1d, ...abs(RESULTS + 0x08),
        0xd9, 0xee,                             //       fldz
        0xd9, 0xe0,                             //       fchs             -0.0
        0xd9, 0x1d, ...abs(RESULTS + 0x0c),
        // a root that is exact and one that is not
        0xd9, 0x05, ...abs(SQUARE),             //       fld dword [1.5625]
        0xd9, 0xfa,                             //       fsqrt            1.25
        0xd9, 0x1d, ...abs(RESULTS + 0x10),
        0xd9, 0x05, ...abs(TWO),                //       fld dword [2.0]
        0xd9, 0xfa,                             //       fsqrt
        0xd9, 0x1d, ...abs(RESULTS + 0x14),
        // the integers at either end of a word
        0xdb, 0x05, ...abs(IMAX),               //       fild dword [0x7fffffff]
        0xdb, 0x1d, ...abs(RESULTS + 0x18),     //       fistp dword
        0xdb, 0x05, ...abs(IMIN),               //       fild dword [0x80000000]
        0xdb, 0x1d, ...abs(RESULTS + 0x1c),     //       fistp dword
        // an ordinary compare that pops both registers
        0xd9, 0x05, ...abs(A),                  //       fld dword [1.5]
        0xd9, 0x05, ...abs(B),                  //       fld dword [2.25]
        0x31, 0xc0,                             //       xor eax, eax
        0xde, 0xd9,                             //       fcompp
        0xdf, 0xe0,                             //       fnstsw ax
        0xa3, ...abs(RESULTS + 0x28),           //       mov [.], eax
        // the constants
        0xd9, 0xeb,                             //       fldpi
        0xd9, 0xe8,                             //       fld1
        0xde, 0xc9,                             //       fmulp st1, st0
        0xd9, 0x1d, ...abs(RESULTS + 0x2c),     //       fstp dword       pi
        // the control word's rounding field, read once and put back below
        0xc7, 0x05, ...abs(CW), ...u32(0),      //       mov dword [cw], 0
        0xd9, 0x3d, ...abs(CW),                 //       fnstcw [cw]
        0xa1, ...abs(CW),                       //       mov eax, [cw]
        0x25, ...u32(0xfffff3ff),               //       and eax, ~0x0c00
        0xa3, ...abs(CWBASE),                   //       mov [cwbase], eax
    ];
    // A half rounded from 2.5 and from -2.5 under each mode: to nearest with
    // ties to even, down, up, and towards zero.
    [0x0000, 0x0400, 0x0800, 0x0c00].forEach((mode, index)=>{
        program.push(
            0xa1, ...abs(CWBASE),               //       mov eax, [cwbase]
            0x0d, ...u32(mode),                 //       or eax, mode
            0xa3, ...abs(CW),                   //       mov [cw], eax
            0xd9, 0x2d, ...abs(CW),             //       fldcw [cw]
            0xd9, 0x05, ...abs(HALF),           //       fld dword [2.5]
            0xdf, 0x1d, ...abs(RESULTS + 0x30 + 4 * index),      // fistp word
            0xd9, 0x05, ...abs(NEGHALF),        //       fld dword [-2.5]
            0xdf, 0x1d, ...abs(RESULTS + 0x32 + 4 * index),      // fistp word
        );
    });
    program.push(0x49);                                             // dec ecx
    const jnzAt = GUEST_CODE + program.length;
    program.push(0x0f, 0x85, ...u32((GUEST_CODE + 5) - (jnzAt + 6)));  // jnz loop
    program.push(0xf4);                                                 // hlt

    /** @param {number} tagged */
    const run = async tagged=>{
        const host = await boot();
        host.cpu().wm.exports.set_jit_config(12, tagged);
        host.cpu().wm.exports.jit_clear_cache_js();
        host.writePhysical(DATA, new Uint8Array([
            ...f32(1.5), ...f32(2.25), ...f32(-0), ...[0x00, 0x00, 0xc0, 0x7f],
            ...f32(2.5), ...f32(-2.5), ...f32(1.5625), ...f32(2),
            ...u32(0x7fffffff), ...u32(0x80000000), ...u32(0), ...u32(0),
        ]));
        host.writePhysical(RESULTS, new Uint8Array(0x40));
        host.writePhysical(GUEST_CODE, new Uint8Array(program));
        host.writePhysical(ENTRY_VECTOR, new Uint8Array(u32(GUEST_CODE)));
        host.cpu().in_hlt[0] = 0;
        host.cpu().instruction_pointer[0] = GUEST_CODE;
        host.writeReg32('esp', INITIAL_STACK);
        for (let slice = 0; slice < 5000 && !host.cpu().in_hlt[0]; slice++)
        {
            host.cpu().run_slice(10000);
            if (slice % 10 === 0)
            {
                await new Promise(resolve=>setTimeout(resolve, 0));
            }
        }
        assert.ok(host.cpu().in_hlt[0], 'the program ran to its end');
        const state = host.jitState();
        assert.ok(state !== -1 && state.compiledSteps > 0, 'and was compiled');
        const results = host.readPhysical(RESULTS, 0x40);
        const tagLost = state.x87TagLost;
        host.stop();
        return { results, tagLost };
    };

    const helpers = await run(0);
    const inline = await run(1);
    assert.deepEqual([...inline.results], [...helpers.results], 'the same results either way');

    const word = (/** @type {Uint8Array} */ r, /** @type {number} */ at)=>
        (r[at] | r[at + 1] << 8 | r[at + 2] << 16 | r[at + 3] << 24) >>> 0;
    const half = (/** @type {Uint8Array} */ r, /** @type {number} */ at)=>
        r[at] | r[at + 1] << 8;
    const r = inline.results;

    assert.equal(word(r, 0x00), bits(3.375), 'a chain of exchanges, then a multiply');
    assert.equal(word(r, 0x04), bits(5.0625), 'a register copied and used as an operand');
    assert.equal(word(r, 0x08), 0, 'a negative zero made positive');
    assert.equal(word(r, 0x0c), 0x80000000, 'a zero made negative');
    assert.equal(word(r, 0x10), bits(1.25), 'a root that is exact');
    assert.equal(word(r, 0x14), bits(Math.sqrt(2)), 'a root that is not, as a single');
    assert.equal(word(r, 0x18), 0x7fffffff, 'the largest integer a word holds');
    assert.equal(word(r, 0x1c), 0x80000000, 'and the most negative');
    assert.equal(word(r, 0x2c), bits(Math.PI), 'pi times one');

    assert.equal(word(r, 0x28) & 0x4500, 0, 'st(0) above the other register: none of the three');

    assert.deepEqual(
        [half(r, 0x30), half(r, 0x32)], [2, 0xfffe], 'to nearest, ties to even');
    assert.deepEqual(
        [half(r, 0x34), half(r, 0x36)], [2, 0xfffd], 'down');
    assert.deepEqual(
        [half(r, 0x38), half(r, 0x3a)], [3, 0xfffe], 'up');
    assert.deepEqual(
        [half(r, 0x3c), half(r, 0x3e)], [2, 0xfffe], 'towards zero');

    // With the group on, nothing in this program takes a helper arm for want
    // of a tag; with it off, the exchange, the constants, the sign changes and
    // the register store strip the tag off registers the arithmetic and the
    // stores then read, so those fall to their helpers on every iteration.
    assert.ok(inline.tagLost < 100,
        `${inline.tagLost} helper arms taken for want of a tag over ${N} iterations`);
    assert.ok(helpers.tagLost > 10000,
        `${helpers.tagLost} with the group off, against ${inline.tagLost} with it on`);
});

test('a compare against a NaN takes the helper arm by contract', async()=>{
    // A NaN is neither a normal nor a zero, so it is never tagged and a
    // compare against it is the library's: the compiled arm cannot assume a
    // tag it will never see, so it takes its helper every time, on both the
    // signalling and the quiet form. This is the outcome the tag-keeping test
    // above deliberately excludes, pinned here on its own so a future change
    // that makes NaN compares inline again is as visible as one that stops
    // tagging a value that should stay tagged.
    const f32 = (/** @type {number} */ v)=>[...new Uint8Array(Float32Array.of(v).buffer)];
    const DATA = 0x9000;
    const [B, NAN32] = [0x9000, 0x9004];
    const RESULTS = 0x9100;
    // A larger count than the other tests': this program's loop body is only
    // two compares, so it takes far more iterations running interpreted
    // before the JIT compiles it than the mixed-instruction programs above
    // do; N needs to be large enough that the interpreted warm-up is a small
    // fraction of it, or the per-iteration ratio below is too noisy to pin.
    const N = 200000;

    /** @param {number} at */
    const abs = at=>u32(at);
    const program = [
        0xb9, ...u32(N),                        //       mov ecx, N
        0xdb, 0xe3,                             // loop: fninit
        // a NaN on one side of a compare, signalling and quiet
        0xd9, 0x05, ...abs(B),                  //       fld dword [2.25]
        0xd9, 0x05, ...abs(NAN32),              //       fld dword [nan]
        0x31, 0xc0,                             //       xor eax, eax
        0xd8, 0xd1,                             //       fcom st1
        0xdf, 0xe0,                             //       fnstsw ax
        0xa3, ...abs(RESULTS + 0x00),           //       mov [.], eax
        0x31, 0xc0,                             //       xor eax, eax
        0xdd, 0xe9,                             //       fucomp st1
        0xdf, 0xe0,                             //       fnstsw ax
        0xa3, ...abs(RESULTS + 0x04),           //       mov [.], eax
        0xdd, 0xd8,                             //       fstp st0
    ];
    program.push(0x49);                                             // dec ecx
    const jnzAt = GUEST_CODE + program.length;
    program.push(0x0f, 0x85, ...u32((GUEST_CODE + 5) - (jnzAt + 6)));  // jnz loop
    program.push(0xf4);                                                 // hlt

    /** @param {number} tagged */
    const run = async tagged=>{
        const host = await boot();
        host.cpu().wm.exports.set_jit_config(12, tagged);
        host.cpu().wm.exports.jit_clear_cache_js();
        host.writePhysical(DATA, new Uint8Array([...f32(2.25), 0x00, 0x00, 0xc0, 0x7f]));
        host.writePhysical(RESULTS, new Uint8Array(0x08));
        host.writePhysical(GUEST_CODE, new Uint8Array(program));
        host.writePhysical(ENTRY_VECTOR, new Uint8Array(u32(GUEST_CODE)));
        host.cpu().in_hlt[0] = 0;
        host.cpu().instruction_pointer[0] = GUEST_CODE;
        host.writeReg32('esp', INITIAL_STACK);
        for (let slice = 0; slice < 5000 && !host.cpu().in_hlt[0]; slice++)
        {
            host.cpu().run_slice(10000);
            if (slice % 10 === 0)
            {
                await new Promise(resolve=>setTimeout(resolve, 0));
            }
        }
        assert.ok(host.cpu().in_hlt[0], 'the program ran to its end');
        const state = host.jitState();
        assert.ok(state !== -1 && state.compiledSteps > 0, 'and was compiled');
        const results = host.readPhysical(RESULTS, 0x08);
        const sites = state.x87Sites;
        host.stop();
        return { results, sites };
    };

    const helpers = await run(0);
    const inline = await run(1);
    assert.deepEqual([...inline.results], [...helpers.results], 'the same results either way');

    const word = (/** @type {Uint8Array} */ r, /** @type {number} */ at)=>
        (r[at] | r[at + 1] << 8 | r[at + 2] << 16 | r[at + 3] << 24) >>> 0;
    const r = inline.results;

    // A NaN on either side is unordered: C3, C2 and C0 all set. The signalling
    // compare calls it an invalid operation as well; the quiet one does not.
    assert.equal(word(r, 0x00) & 0x4500, 0x4500, 'a signalling compare of a NaN is unordered');
    assert.equal(word(r, 0x00) & 1, 1, 'and an invalid operation');
    assert.equal(word(r, 0x04) & 0x4500, 0x4500, 'the quiet compare is unordered too');

    /** @param {string} name */
    const siteCount = name=>{
        const match = inline.sites.match(new RegExp(`(?:^| )${name.replace(/\./g, '\\.')}:(\\d+)`));
        return match ? Number(match[1]) : 0;
    };
    const compares = siteCount('arm.fcom.sti');
    // Two NaN compares run every iteration once the block is compiled; a few
    // of the first iterations still run interpreted, before the JIT compiles
    // it, so the count falls short of 2 * N rather than landing on it.
    assert.ok(compares >= N,
        `${compares} arm.fcom.sti events over ${N} iterations, ${inline.sites}`);
    assert.ok(compares <= 2 * N,
        `${compares} arm.fcom.sti events, more than the two NaN compares per iteration allow`);
});

test('an x87 value a double holds keeps its tag through the helpers', async()=>{
    // The forms that have no inline arm write a register through one helper,
    // and that helper now leaves the register in the tagged form whenever the
    // double format holds the value with nothing lost -- so the arithmetic
    // that follows an 80-bit load, a word integer load, a round to an integer,
    // a scale, a remainder or a restored stack is inline, without a codegen arm
    // for any of them. The same program is run compiled both ways and every
    // result compared word for word; with the group on, no operation in it
    // takes a helper arm for want of a tag, and the per-site counters name the
    // one value that is deliberately refused: an 80-bit value with a bit set
    // below a double's mantissa, whose arithmetic must stay the library's.
    const f32 = (/** @type {number} */ v)=>[...new Uint8Array(Float32Array.of(v).buffer)];
    const bits = (/** @type {number} */ v)=>new Uint32Array(Float32Array.of(v).buffer)[0];
    const DATA = 0x9000;
    const [ONEPOINTFIVE, TWOANDAQUARTER, SEVENPOINTFIVE] = [0x9000, 0x9004, 0x9008];
    const [M80, M80INEXACT, I16, I16NEG] = [0x9010, 0x9020, 0x9030, 0x9032];
    const RESULTS = 0x9100;
    const SAVED = 0x9200;
    const N = 20000;

    /** @param {number} at */
    const abs = at=>u32(at);
    const program = [
        0xb9, ...u32(N),                        //       mov ecx, N
        0xdb, 0xe3,                             // loop: fninit
        // an 80-bit load a double holds, then arithmetic on what it loaded
        0xdb, 0x2d, ...abs(M80),                //       fld tword [1.5]
        0xd8, 0x0d, ...abs(TWOANDAQUARTER),     //       fmul dword [2.25]
        0xd9, 0x1d, ...abs(RESULTS + 0x00),     //       fstp dword       3.375
        // a word integer load, then arithmetic on what it loaded
        0xdf, 0x05, ...abs(I16),                //       fild word [1234]
        0xd8, 0x0d, ...abs(ONEPOINTFIVE),       //       fmul dword [1.5]
        0xd9, 0x1d, ...abs(RESULTS + 0x04),     //       fstp dword       1851
        0xdf, 0x05, ...abs(I16NEG),             //       fild word [-3]
        0xd8, 0x05, ...abs(TWOANDAQUARTER),     //       fadd dword [2.25]
        0xd9, 0x1d, ...abs(RESULTS + 0x08),     //       fstp dword       -0.75
        // a round to an integer, then arithmetic on the rounded value
        0xd9, 0x05, ...abs(SEVENPOINTFIVE),     //       fld dword [7.5]
        0xd9, 0xfc,                             //       frndint          8
        0xd8, 0x0d, ...abs(ONEPOINTFIVE),       //       fmul dword [1.5]
        0xd9, 0x1d, ...abs(RESULTS + 0x0c),     //       fstp dword       12
        // a scale, then arithmetic on the scaled value
        0xd9, 0x05, ...abs(TWOANDAQUARTER),     //       fld dword [2.25]
        0xd9, 0xe8,                             //       fld1
        0xd9, 0xc9,                             //       fxch st1
        0xd9, 0xfd,                             //       fscale           4.5
        0xd8, 0x0d, ...abs(ONEPOINTFIVE),       //       fmul dword [1.5]
        0xd9, 0x1d, ...abs(RESULTS + 0x10),     //       fstp dword       6.75
        0xdd, 0xd8,                             //       fstp st0
        // a remainder, then arithmetic on the remainder
        0xd9, 0x05, ...abs(TWOANDAQUARTER),     //       fld dword [2.25]
        0xd9, 0x05, ...abs(SEVENPOINTFIVE),     //       fld dword [7.5]
        0xd9, 0xf8,                             //       fprem            0.75
        0xd8, 0x0d, ...abs(ONEPOINTFIVE),       //       fmul dword [1.5]
        0xd9, 0x1d, ...abs(RESULTS + 0x14),     //       fstp dword       1.125
        0xdd, 0xd8,                             //       fstp st0
        // the whole stack through a save and a restore
        0xd9, 0x05, ...abs(ONEPOINTFIVE),       //       fld dword [1.5]
        0xd9, 0x05, ...abs(TWOANDAQUARTER),     //       fld dword [2.25]
        0xdd, 0x35, ...abs(SAVED),              //       fsave [.]
        0xdd, 0x25, ...abs(SAVED),              //       frstor [.]
        0xde, 0xc9,                             //       fmulp st1, st0   3.375
        0xd9, 0x1d, ...abs(RESULTS + 0x18),     //       fstp dword
        // a value no double holds: refused, so the arithmetic stays the
        // library's, and the result narrowed to a single is the same either way
        0xdb, 0x2d, ...abs(M80INEXACT),         //       fld tword
        0xd8, 0x0d, ...abs(TWOANDAQUARTER),     //       fmul dword [2.25]
        0xd9, 0x1d, ...abs(RESULTS + 0x1c),     //       fstp dword       3.375
    ];
    program.push(0x49);                                             // dec ecx
    const jnzAt = GUEST_CODE + program.length;
    program.push(0x0f, 0x85, ...u32((GUEST_CODE + 5) - (jnzAt + 6)));  // jnz loop
    program.push(0xf4);                                                 // hlt

    /** @param {number} tagged */
    const run = async tagged=>{
        const host = await boot();
        host.cpu().wm.exports.set_jit_config(12, tagged);
        host.cpu().wm.exports.jit_clear_cache_js();
        host.writePhysical(DATA, new Uint8Array([
            ...f32(1.5), ...f32(2.25), ...f32(7.5), ...u32(0),
            // 1.5 in the 80-bit format, and the same with the lowest mantissa
            // bit set -- a bit below anything a double can hold.
            ...u32(0), ...u32(0xc0000000), 0xff, 0x3f, 0, 0, 0, 0, 0, 0,
            ...u32(1), ...u32(0xc0000000), 0xff, 0x3f, 0, 0, 0, 0, 0, 0,
            1234 & 0xff, 1234 >>> 8, 0xfd, 0xff,
        ]));
        host.writePhysical(RESULTS, new Uint8Array(0x20));
        host.writePhysical(GUEST_CODE, new Uint8Array(program));
        host.writePhysical(ENTRY_VECTOR, new Uint8Array(u32(GUEST_CODE)));
        host.cpu().in_hlt[0] = 0;
        host.cpu().instruction_pointer[0] = GUEST_CODE;
        host.writeReg32('esp', INITIAL_STACK);
        for (let slice = 0; slice < 8000 && !host.cpu().in_hlt[0]; slice++)
        {
            host.cpu().run_slice(10000);
            if (slice % 10 === 0)
            {
                await new Promise(resolve=>setTimeout(resolve, 0));
            }
        }
        assert.ok(host.cpu().in_hlt[0], 'the program ran to its end');
        const state = host.jitState();
        assert.ok(state !== -1 && state.compiledSteps > 0, 'and was compiled');
        const results = host.readPhysical(RESULTS, 0x20);
        const { x87TagLost, x87Sites } = state;
        host.stop();
        return { results, x87TagLost, x87Sites };
    };

    const helpers = await run(0);
    const inline = await run(1);
    assert.deepEqual([...inline.results], [...helpers.results], 'the same results either way');

    const word = (/** @type {Uint8Array} */ r, /** @type {number} */ at)=>
        (r[at] | r[at + 1] << 8 | r[at + 2] << 16 | r[at + 3] << 24) >>> 0;
    const r = inline.results;
    assert.equal(word(r, 0x00), bits(3.375), 'an 80-bit load then a multiply');
    assert.equal(word(r, 0x04), bits(1851), 'a word integer load then a multiply');
    assert.equal(word(r, 0x08), bits(-0.75), 'a negative word integer load then an add');
    assert.equal(word(r, 0x0c), bits(12), 'a round to an integer then a multiply');
    assert.equal(word(r, 0x10), bits(6.75), 'a scale then a multiply');
    assert.equal(word(r, 0x14), bits(1.125), 'a remainder then a multiply');
    assert.equal(word(r, 0x18), bits(3.375), 'a saved and restored stack then a multiply');
    assert.equal(word(r, 0x1c), bits(3.375), 'a value no double holds, narrowed to a single');

    // The per-site account. Every form here writes a register through a helper
    // and leaves it in the form the arithmetic after it can use, so each of
    // their sites reads zero and so does every inline arm -- with one exception,
    // which is the point of the account: the 80-bit value no double holds is
    // refused, once per iteration, and the multiply that reads it is the only
    // inline arm in the program that calls its helper.
    /** @param {string} sites */
    const byName = sites=>Object.fromEntries(sites.split(' ').filter(Boolean)
        .map(pair=>[pair.slice(0, pair.lastIndexOf(':')),
            Number(pair.slice(pair.lastIndexOf(':') + 1))]));
    const on = byName(inline.x87Sites);
    for (const site of ['fild.m16', 'frndint', 'fscale', 'fprem', 'frstor', 'fxch',
        'arith', 'fst.sti', 'transcendental', 'mmx',
        'arm.binop.m64', 'arm.binop.sti', 'arm.fld.sti', 'arm.fst.m32',
        'arm.fst.m64', 'arm.fxch', 'arm.fst.sti', 'arm.fcom.sti', 'arm.fcom.mem', 'arm.fist'])
    {
        assert.equal(on[site] ?? 0, 0, `${site} took no helper arm: ${inline.x87Sites}`);
    }
    assert.equal(on.wide, N, `the refused load, once per iteration: ${inline.x87Sites}`);
    assert.equal(on['fld.m80'], on.wide, 'and it is the whole of what was refused');
    assert.ok((on.kept ?? 0) > 5 * N,
        `${on.kept} registers kept their tag through a helper over ${N} iterations`);
    assert.equal(inline.x87TagLost, on['arm.binop.m32'],
        `every arm taken was the multiply on the refused value: ${inline.x87Sites}`);

    // With the group off nothing is tagged at all, so the inline arms of the
    // arithmetic that follows each of these forms fall to their helpers.
    assert.ok(helpers.x87TagLost > 5 * N,
        `${helpers.x87TagLost} with the group off, against ${inline.x87TagLost} with it on`);
});

test('the emulator says why the interpreter ran, and on which page', async()=>{
    // Interpreted steps and dispatches were all a build that runs could report,
    // so a stall spent outside generated code named no cause. The reasons are a
    // partition: every dispatch is charged to exactly one, which makes the sum
    // checkable rather than a hope -- `account` checks it on every run below,
    // and each reason is then provoked on purpose.
    /** @param {any} host @returns {Record<string, number|string>} */
    const state = host=>{
        const read = host.jitState();
        assert.notEqual(read, -1, 'the emulator reports its state');
        return read;
    };
    const REASONS = ['interpNoCode', 'interpNoEntry', 'interpNearPageEnd',
        'interpDifferentState'];
    /**
     * What the interpreter did between two readings, by reason.
     *
     * @param {Record<string, number|string>} before
     * @param {Record<string, number|string>} after
     */
    const account = (before, after)=>{
        /** @param {string} field */
        const of = field=>Number(after[field]) - Number(before[field]);
        const counts = REASONS.map(of);
        const steps = REASONS.map(reason=>of(`${reason}Steps`));
        const dispatches = of('interpretedDispatches');
        assert.equal(counts.reduce((sum, count)=>sum + count, 0), dispatches,
            `the reasons account for every dispatch (${counts} against ${dispatches})`);
        assert.equal(steps.reduce((sum, count)=>sum + count, 0), of('interpretedSteps'),
            `and their steps for every instruction interpreted (${steps})`);
        return { dispatches, steps, nocode: counts[0], noentry: counts[1],
            pageend: counts[2], mismatch: counts[3], below: of('interpBelowThreshold') };
    };

    // A page nothing has compiled: the program retires six hundred instructions
    // and the compiler wants two hundred thousand on a page before it looks.
    const cold = await boot();
    cold.writePhysical(GUEST_CODE, new Uint8Array([
        0xb9, ...u32(200),         // mov ecx, 200
        0x49,                      // loop: dec ecx
        0x75, 0xfd,                //       jnz loop
        0xf4,                      // hlt
    ]));
    cold.writePhysical(ENTRY_VECTOR, new Uint8Array(u32(GUEST_CODE)));
    cold.cpu().in_hlt[0] = 0;
    cold.cpu().instruction_pointer[0] = GUEST_CODE;
    const coldBefore = state(cold);
    for (let slice = 0; slice < 100 && !cold.cpu().in_hlt[0]; slice++)
    {
        cold.cpu().run_slice(1000);
    }
    assert.ok(cold.cpu().in_hlt[0], 'the loop ran to its end');
    const coldAfter = state(cold);
    const cool = account(coldBefore, coldAfter);
    assert.ok(cool.dispatches > 0, 'the interpreter ran');
    assert.equal(cool.nocode, cool.dispatches, 'and every dispatch of it found no code');
    assert.equal(cool.below, cool.dispatches, 'each leaving its page under the threshold');
    assert.equal(Number(coldAfter.compiledSteps) - Number(coldBefore.compiledSteps), 0,
        'nothing was compiled, so nothing ran compiled');
    assert.match(String(coldAfter.interpPages), /(^| )0x8000:\d+:nocode( |$)/,
        `the page is named, and by that reason: ${coldAfter.interpPages}`);
    cold.stop();

    // A page a module was compiled for, entered where the module cannot be: at
    // an address it holds no entry point for, at one within an instruction's
    // reach of the page's end, and in a state it was not compiled for.
    const host = await boot();
    host.cpu().wm.exports.set_jit_config(4, 1000);   // a page compiles sooner
    const pageEnd = (GUEST_CODE & ~0xfff) + 0xffc;
    host.writePhysical(GUEST_CODE, new Uint8Array([
        0xb9, ...u32(200000),      // mov ecx, 200000
        0x49,                      // loop: dec ecx
        0x75, 0xfd,                //       jnz loop
        0xf4,                      // hlt
    ]));
    host.writePhysical(GUEST_CODE + 0x800, new Uint8Array([0xf4]));   // hlt
    host.writePhysical(pageEnd, new Uint8Array([0xf4]));              // hlt
    host.writePhysical(ENTRY_VECTOR, new Uint8Array(u32(GUEST_CODE)));
    const opened = state(host);
    host.cpu().in_hlt[0] = 0;
    host.cpu().instruction_pointer[0] = GUEST_CODE;
    for (let slice = 0; slice < 2000 && !host.cpu().in_hlt[0]; slice++)
    {
        host.cpu().run_slice(1000);
        if (slice % 10 === 0)
        {
            // The module is finalised off a promise, so the loop has to yield
            // for the page to end up compiled at all.
            await new Promise(resolve=>setTimeout(resolve, 0));
        }
    }
    assert.ok(host.cpu().in_hlt[0], 'the loop ran to its end');
    assert.ok(Number(state(host).compiledSteps) > 0, 'and was compiled while it ran');

    /** One dispatch, taken where the caller says. @param {number} at */
    const dispatch = at=>{
        const before = state(host);
        host.cpu().in_hlt[0] = 0;
        host.cpu().instruction_pointer[0] = at;
        host.cpu().run_slice(1);
        const one = account(before, state(host));
        assert.equal(one.dispatches, 1, `exactly one dispatch at 0x${at.toString(16)}`);
        assert.equal(one.steps.reduce((sum, count)=>sum + count, 0), 1, 'of one instruction');
        return one;
    };

    assert.equal(dispatch(GUEST_CODE + 0x800).noentry, 1,
        'a page with a module, entered where the module has no entry point');
    // The end of a page is only a reason while a block may not cross one: with
    // paging off the compiler goes on into the next page and the case cannot
    // arise, so the same address is charged to the plain missing entry.
    assert.equal(dispatch(pageEnd).noentry, 1,
        'the page end, while a block may cross it, is nothing of its own');
    host.cpu().wm.exports.set_jit_config(10, 0);
    assert.equal(dispatch(pageEnd).pageend, 1,
        'and once a block may not cross it, the end of the page is the reason');
    host.cpu().wm.exports.set_jit_config(10, 1);
    // The module was compiled for a 32-bit stack; with a 16-bit one no address
    // in the page may be entered, entry point or not.
    host.cpu().stack_size_32[0] = 0;
    host.cpu().update_state_flags();
    assert.equal(dispatch(GUEST_CODE + 0x800).mismatch, 1,
        'a state the module was not compiled for');
    host.cpu().stack_size_32[0] = 1;
    host.cpu().update_state_flags();

    const closed = state(host);
    // Over the whole run, reasons and dispatches still agree -- which is the
    // relationship that makes the account worth reading, and which the page
    // walk's own counter is deliberately outside of: it counts the dispatches
    // that did not happen, the entry having turned up on the second look.
    const whole = account(opened, closed);
    // `noentry` is more than the two provoked deliberately: a compiled page is
    // re-entered where it holds no entry point while the loop runs, which is
    // what this account exists to make visible.
    assert.ok(whole.nocode > 0 && whole.noentry >= 2 && whole.pageend === 1
        && whole.mismatch === 1, `every reason was provoked: ${JSON.stringify(whole)}`);
    assert.match(String(closed.interpPages), /(^| )0x8000:\d+:nocode,noentry,pageend,state( |$)/,
        `the page carries every reason seen at it: ${closed.interpPages}`);
    host.stop();
});

test('the SSE and x87 state read as a record and go back as one, for the harness', async()=>{
    const host = await boot();
    // movaps xmm3, [0x9000]; fld1; fldz; then trap: what the record must show.
    host.writePhysical(0x9000, new Uint8Array([
        ...u32(0x3f800000), ...u32(0x40000000), ...u32(0x7fc00001), ...u32(0xdeadbeef),
    ]));
    host.writePhysical(GUEST_CODE, new Uint8Array([
        0x0f, 0x28, 0x1d, ...u32(0x9000),                     // movaps xmm3, [0x9000]
        0xd9, 0xe8,                                           // fld1
        0xd9, 0xee,                                           // fldz
        0x66, 0xba, TRAP_PORT & 0xff, TRAP_PORT >>> 8 & 0xff, // mov dx, TRAP_PORT
        0xb8, ...u32(1),                                      // mov eax, 1
        0xef,                                                 // out dx, eax
        0xf4,                                                 // hlt
    ]));
    host.writePhysical(ENTRY_VECTOR, new Uint8Array(u32(GUEST_CODE)));
    assert.equal(await runUntilTrap(host), 1);

    assert.deepEqual([...host.readXmm(3)], [0x3f800000, 0x40000000, 0x7fc00001, 0xdeadbeef],
        'lanes as bit patterns, a NaN payload included');
    assert.deepEqual([...host.readXmm(0)], [0, 0, 0, 0]);
    host.writeXmm(0, new Uint32Array([1, 2, 3, 0x80000000]));
    assert.deepEqual([...host.readXmm(0)], [1, 2, 3, 0x80000000]);
    assert.equal(host.readMxcsr(), 0x1f80, 'the reset value');
    host.writeMxcsr(0x9f80);
    assert.equal(host.readMxcsr(), 0x9f80);

    const before = host.x87State();
    assert.equal(before.top, 6, 'two pushes from an empty stack');
    assert.equal(before.empty & 0xc0, 0, 'physical 6 and 7 are held');
    assert.equal(before.registers[7], 1, 'fld1 landed in physical 7');
    assert.equal(before.registers[6], 0, 'fldz in physical 6');
    assert.equal(before.raw.length, 128);

    // Wreck it, put it back, read the same record.
    host.restoreX87State({
        top: 0, empty: 0xff, control: 0x37f, status: 0, raw: new Uint8Array(128),
    });
    assert.equal(host.x87State().top, 0);
    assert.equal(host.readReg32('eax'), 1);
    host.restoreX87State(before);
    const after = host.x87State();
    assert.deepEqual(
        { top: after.top, empty: after.empty, control: after.control, status: after.status },
        { top: before.top, empty: before.empty, control: before.control, status: before.status });
    assert.deepEqual([...after.registers], [...before.registers]);
    assert.deepEqual([...after.raw], [...before.raw]);
    host.stop();
});
