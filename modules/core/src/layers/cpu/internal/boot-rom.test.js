/*
 * Copyright © 2026 Bottlify Project
 * Licensed under BSD-2-Clause License
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBootRom, ROM_BASE, ROM_SIZE, SEL_CODE32, SEL_DATA32 } from './boot-rom.js';

const ENTRY_VECTOR = 0x7000;
const INITIAL_STACK = 0x200000;

const rom = ()=>buildBootRom(
    { entryVector: ENTRY_VECTOR, initialStack: INITIAL_STACK, trapPort: 0xb077 });

/** @param {Uint8Array} image @param {number} offset @returns {number} */
const readU32 = (image, offset)=>
    (image[offset] | image[offset + 1] << 8
        | image[offset + 2] << 16 | image[offset + 3] << 24) >>> 0;

test('image is exactly the size v86 maps at 0xF0000', ()=>{
    assert.equal(rom().length, ROM_SIZE);
    assert.equal(ROM_BASE, 0xf0000);
});

test('reset vector is a far jump to the 16-bit init stub', ()=>{
    const image = rom();
    // F000:FFF0 is where the CPU starts; EA is `jmp far ptr16:16`.
    assert.equal(image[0xfff0], 0xea);
    assert.equal(image[0xfff1] | image[0xfff2] << 8, 0x0000, 'offset = init stub at ROM offset 0');
    assert.equal(image[0xfff3] | image[0xfff4] << 8, 0xf000, 'segment = the ROM itself');
});

test('GDT holds a null descriptor plus flat 4 GiB code and data segments', ()=>{
    const image = rom();
    const gdt = 0x100;

    assert.deepEqual([...image.subarray(gdt, gdt + 8)],
        [0, 0, 0, 0, 0, 0, 0, 0], 'null descriptor');

    for (const [selector, access] of [[SEL_CODE32, 0x9a], [SEL_DATA32, 0x92]])
    {
        const at = gdt + selector;
        assert.equal(image[at] | image[at + 1] << 8, 0xffff, 'limit low');
        assert.equal(image[at + 2] | image[at + 3] << 8 | image[at + 4] << 16, 0,
            'base is 0 (flat)');
        assert.equal(image[at + 5], access, 'access byte');
        assert.equal(image[at + 6], 0xcf, 'granularity 4 KiB, 32-bit, limit high nibble');
        assert.equal(image[at + 7], 0, 'base high');
    }
});

test("GDT pointer covers three descriptors and points at the GDT's linear address", ()=>{
    const image = rom();
    const ptr = 0x120;
    assert.equal(image[ptr] | image[ptr + 1] << 8, 3 * 8 - 1, 'limit is size-1');
    assert.equal(readU32(image, ptr + 2), ROM_BASE + 0x100, 'base is the GDT, as a linear address');
});

test('protected-mode entry sets a stack and jumps indirectly through the entry vector', ()=>{
    const image = rom();
    const pm = 0x200;
    const bytes = [...image.subarray(pm, pm + 0x30)];

    const movEsp = bytes.indexOf(0xbc);
    assert.notEqual(movEsp, -1, 'mov esp, imm32 present');
    assert.equal(readU32(image, pm + movEsp + 1), INITIAL_STACK);

    // FF 25 <disp32> is `jmp dword [disp32]` — the indirection that lets the ROM
    // be built before the guest entry point is known.
    const jmp = bytes.findIndex((b, i)=>b === 0xff && bytes[i + 1] === 0x25);
    assert.notEqual(jmp, -1, 'indirect jmp present');
    assert.equal(readU32(image, pm + jmp + 2), ENTRY_VECTOR);
    assert.ok(movEsp < jmp, 'stack is set before control leaves the ROM');
});

test('the entry vector is data, so two ROMs differ only where the vector does', ()=>{
    const a = buildBootRom({ entryVector: 0x7000, initialStack: INITIAL_STACK, trapPort: 0xb077 });
    const b = buildBootRom({ entryVector: 0x9000, initialStack: INITIAL_STACK, trapPort: 0xb077 });
    const differing = [...a].reduce((count, byte, i)=>byte === b[i] ? count : count + 1, 0);
    assert.equal(differing, 1, 'only the low byte of the vector address changes between these two');
});

test('every processor exception has a gate, and each gate has its own stub', ()=>{
    // Without these the emulator has nowhere to send a fault and stops the
    // machine, so a divide by zero and a bad pointer arrive as the same
    // message at an address that is wherever the CPU happened to be.
    const image = buildBootRom({ entryVector: 0x7000, initialStack: 0x300000, trapPort: 0xb077 });
    const idt = 0x400;

    for (const vector of [0, 6, 13, 14, 31])
    {
        const gate = idt + vector * 8;
        const offset = image[gate] | image[gate + 1] << 8
            | image[gate + 6] << 16 | image[gate + 7] << 24;
        assert.equal(image[gate + 2] | image[gate + 3] << 8, 0x08, 'the flat 32-bit code selector');
        assert.equal(image[gate + 5], 0x8e,
            'present, ring 0, 32-bit interrupt gate — a trap gate would leave interrupts on');
        assert.equal(offset, ROM_BASE + 0x700 + vector * 16,
            'and it points at this vector\'s own stub, not a shared one');
    }
});

test('a fault stub reports its own vector and then stops', ()=>{
    const image = buildBootRom({ entryVector: 0x7000, initialStack: 0x300000, trapPort: 0xb077 });
    const stub = 0x700 + 13 * 16;

    assert.deepEqual([...image.subarray(stub, stub + 4)], [0x66, 0xba, 0x77, 0xb0],
        'mov dx, trapPort');
    assert.equal(image[stub + 4], 0xb8, 'mov eax, imm32');
    const trap = image[stub + 5] | image[stub + 6] << 8
        | image[stub + 7] << 16 | image[stub + 8] << 24;
    assert.equal(trap, 0xf000 + 13, 'the trap carries which exception this was');
    assert.equal(image[stub + 9], 0xef, 'out dx, eax');
    // It must not return: iret would resume at the faulting instruction and
    // take the same fault again, for ever.
    assert.deepEqual([...image.subarray(stub + 10, stub + 13)], [0xf4, 0xeb, 0xfd]);
});

test('the interrupt table is loaded before the guest can fault', ()=>{
    const image = buildBootRom({ entryVector: 0x7000, initialStack: 0x300000, trapPort: 0xb077 });
    const init = [...image.subarray(0, 0x40)];
    const lidt = init.findIndex((byte, at)=>byte === 0x66 && init[at + 1] === 0x0f
        && init[at + 2] === 0x01 && init[at + 3] === 0x1e);
    const lgdt = init.findIndex((byte, at)=>byte === 0x66 && init[at + 1] === 0x0f
        && init[at + 2] === 0x01 && init[at + 3] === 0x16);

    assert.ok(lgdt >= 0 && lidt > lgdt, 'lidt follows lgdt, both before protected mode');
    assert.equal(image[0x600] | image[0x601] << 8, 32 * 8 - 1, 'thirty-two gates, less one');
});
