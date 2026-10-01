/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
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
    return {
        view,
        /** @param {number} address @param {number} length */
        readMemory(address, length){
            if (address + length > bytes.length)
            {
                throw new Error(`unmapped ${address}`);
            }
            return bytes.slice(address, address + length);
        },
        /** @param {number} address @param {Uint8Array} data */
        writeMemory: (address, data)=>bytes.set(data, address),
    };
}

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
