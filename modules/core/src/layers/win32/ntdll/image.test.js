/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guestOver } from '../common/guest.fixture.js';
import { createImageFunctions } from './image.js';

const BASE = 0x1000;
const SIZE_OUT = 0x10;
const RESOURCE = 2;

/**
 * A PE32 header with one section at RVA 0x1000 whose bytes sit at file
 * offset 0x400, and the resource directory at RVA 0x1010, 0x20 bytes.
 */
function fakeImage(){
    const bytes = new Uint8Array(0x4000);
    const view = new DataView(bytes.buffer);
    const nt = 0x80;
    view.setUint16(BASE, 0x5a4d, true);
    view.setUint32(BASE + 0x3c, nt, true);
    view.setUint32(BASE + nt, 0x4550, true);
    view.setUint16(BASE + nt + 6, 1, true);
    view.setUint16(BASE + nt + 20, 0xe0, true);
    const optional = BASE + nt + 24;
    view.setUint16(optional, 0x10b, true);
    view.setUint32(optional + 60, 0x400, true);
    view.setUint32(optional + 92, 16, true);
    view.setUint32(optional + 96 + RESOURCE * 8, 0x1010, true);
    view.setUint32(optional + 96 + RESOURCE * 8 + 4, 0x20, true);
    const section = optional + 0xe0;
    view.setUint32(section + 8, 0x100, true);
    view.setUint32(section + 12, 0x1000, true);
    view.setUint32(section + 16, 0x200, true);
    view.setUint32(section + 20, 0x400, true);
    // Past the buffer is not there: a read of it faults.
    return { view, guest: guestOver(bytes) };
}

test('LdrProcessRelocationBlock moves a dword, a word\'s high and low halves; the next block', ()=>{
    const memory = new Uint8Array(0x100);
    const view = new DataView(memory.buffer);
    const fns = createImageFunctions({
        guest: guestOver(memory),
    });
    view.setUint32(0x10, 0x50005, true);
    view.setUint16(0x20, 0x505, true);
    view.setUint16(0x30, 0x505, true);
    // HIGHLOW at +0x10, HIGH at +0x20, LOW at +0x30, then ABSOLUTE padding.
    [0x3010, 0x1020, 0x2030, 0x0000].forEach((entry, i)=>view.setUint16(0x80 + i * 2, entry, true));
    assert.equal(fns.LdrProcessRelocationBlock.handler([0, 3, 0x80, 0x500050]), 0x86);
    assert.equal(view.getUint32(0x10, true), 0x550055);
    assert.equal(view.getUint16(0x20, true), 0x555);
    assert.equal(view.getUint16(0x30, true), 0x555, 'the low half of 0x500050 added');
    view.setUint16(0x80, 0x7010, true);
    assert.equal(fns.LdrProcessRelocationBlock.handler([0, 1, 0x80, 1]), 0, 'an unknown type');
});

test('RtlImageDirectoryEntryToData finds a directory in a mapped image and in a file', ()=>{
    const host = fakeImage();
    const { RtlImageDirectoryEntryToData: entry } = createImageFunctions(host);
    assert.equal(entry.argBytes, 16);

    assert.equal(entry.handler([BASE, 1, RESOURCE, SIZE_OUT]), BASE + 0x1010,
        'mapped, the RVA is an offset from the base');
    assert.equal(host.view.getUint32(SIZE_OUT, true), 0x20);

    assert.equal(entry.handler([BASE, 0, RESOURCE, SIZE_OUT]), BASE + 0x410,
        'as a file, the section says where the bytes sit');
    assert.equal(entry.handler([BASE | 1, 1, RESOURCE, 0]), BASE + 0x410,
        'a data-file base is laid out as on disk whatever the flag says');
});

test('RtlImageDirectoryEntryToData answers NULL for what is not there', ()=>{
    const host = fakeImage();
    const { RtlImageDirectoryEntryToData: entry } = createImageFunctions(host);
    assert.equal(entry.handler([BASE, 1, 0, SIZE_OUT]), 0, 'an empty directory');
    assert.equal(entry.handler([BASE, 1, 16, SIZE_OUT]), 0, 'past NumberOfRvaAndSizes');
    assert.equal(entry.handler([0, 1, RESOURCE, SIZE_OUT]), 0);
    assert.equal(entry.handler([BASE + 2, 1, RESOURCE, SIZE_OUT]), 0, 'no MZ');
    assert.equal(entry.handler([0x3ffe, 1, RESOURCE, SIZE_OUT]), 0, 'headers past the end');
    host.view.setUint32(BASE + 0x80 + 24 + 96 + RESOURCE * 8, 0x3000, true);
    assert.equal(entry.handler([BASE, 0, RESOURCE, SIZE_OUT]), 0, 'an RVA no section holds');
});
