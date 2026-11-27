/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseElf32 } from './elf.js';

/**
 * A 32-bit ELF with two loadable segments, built byte by byte: the code
 * `[0x90, 0xf4]` at 0x80000 and an 8-byte .bss at 0x100000 with two bytes
 * of file content, so the zero fill is visible.
 */
function tinyElf(){
    const image = new Uint8Array(0x34 + 2 * 0x20 + 16);
    const view = new DataView(image.buffer);
    image.set([0x7f, 0x45, 0x4c, 0x46, 1, 1, 1]);
    view.setUint16(0x10, 2, true);          // ET_EXEC
    view.setUint16(0x12, 3, true);          // EM_386
    view.setUint32(0x18, 0x80000, true);    // e_entry
    view.setUint32(0x1c, 0x34, true);       // e_phoff
    view.setUint16(0x2a, 0x20, true);       // e_phentsize
    view.setUint16(0x2c, 2, true);          // e_phnum
    const data = 0x34 + 2 * 0x20;
    image.set([0x90, 0xf4, 0xaa, 0xbb], data);
    /** @param {number} at @param {number[]} fields */
    const header = (at, fields)=>fields.forEach(
        (value, i)=>view.setUint32(at + i * 4, value, true));
    // p_type, p_offset, p_vaddr, p_paddr, p_filesz, p_memsz, p_flags, p_align
    header(0x34, [1, data, 0x80000, 0x80000, 2, 2, 5, 0x1000]);
    header(0x54, [1, data + 2, 0x100000, 0x100000, 2, 8, 6, 0x1000]);
    return image;
}

test('an ELF32 loads its PT_LOAD segments at their addresses, zero-filled to memsz', ()=>{
    const { entry, segments } = parseElf32(tinyElf());
    assert.equal(entry, 0x80000);
    assert.equal(segments.length, 2);
    assert.equal(segments[0].address, 0x80000);
    assert.deepEqual([...segments[0].bytes], [0x90, 0xf4]);
    assert.equal(segments[1].address, 0x100000);
    assert.deepEqual([...segments[1].bytes], [0xaa, 0xbb, 0, 0, 0, 0, 0, 0]);
    assert.throws(()=>parseElf32(new Uint8Array(64)), /not an ELF/);
});
