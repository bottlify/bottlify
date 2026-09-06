/*
 * Copyright Bottlify Project 2026
 * Licenses and contributions: THIRD-PARTY-NOTICES.md
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBootRom, ROM_BASE, ROM_SIZE, SEL_CODE32, SEL_DATA32 } from './boot-rom.js';

const ENTRY_VECTOR = 0x7000;
const INITIAL_STACK = 0x200000;

const rom = ()=>buildBootRom({ entryVector: ENTRY_VECTOR, initialStack: INITIAL_STACK });

/** @param {Uint8Array} image @param {number} offset @returns {number} */
const readU32 = (image, offset)=>
    (image[offset] | image[offset + 1] << 8 | image[offset + 2] << 16 | image[offset + 3] << 24) >>> 0;

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

    assert.deepEqual([...image.subarray(gdt, gdt + 8)], [0, 0, 0, 0, 0, 0, 0, 0], 'null descriptor');

    for (const [selector, access] of [[SEL_CODE32, 0x9a], [SEL_DATA32, 0x92]]){
        const at = gdt + selector;
        assert.equal(image[at] | image[at + 1] << 8, 0xffff, 'limit low');
        assert.equal(image[at + 2] | image[at + 3] << 8 | image[at + 4] << 16, 0, 'base is 0 (flat)');
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
    const a = buildBootRom({ entryVector: 0x7000, initialStack: INITIAL_STACK });
    const b = buildBootRom({ entryVector: 0x9000, initialStack: INITIAL_STACK });
    const differing = [...a].reduce((count, byte, i)=>byte === b[i] ? count : count + 1, 0);
    assert.equal(differing, 1, 'only the low byte of the vector address changes between these two');
});
