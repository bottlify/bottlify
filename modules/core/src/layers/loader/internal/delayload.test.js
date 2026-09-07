/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePe } from './pe.js';
import { readDelayImports } from './delayload.js';

const IMAGE_BASE = 0x400000;
const SECTION_RVA = 0x1000;
const HEADERS = 0x200;

/**
 * The smallest PE `parsePe` will accept: one section, and whichever data
 * directories a test wants pointed at it.
 *
 * Built here rather than with the fixture builder in tools, which knows about
 * imports and data and nothing about the directory these tests are for.
 *
 * @param {Uint8Array} section
 * @param {Record<number, { address: number, size: number }>} directories
 * @returns {Uint8Array}
 */
function fixture(section, directories){
    const file = new Uint8Array(HEADERS + section.length);
    const view = new DataView(file.buffer);
    const pe = 0x80;
    const optional = pe + 24;

    view.setUint16(0, 0x5a4d, true); //             "MZ"
    view.setUint32(0x3c, pe, true); //              e_lfanew
    view.setUint32(pe, 0x00004550, true); //        "PE\0\0"
    view.setUint16(pe + 4, 0x014c, true); //        i386
    view.setUint16(pe + 6, 1, true); //             one section
    view.setUint16(pe + 20, 0xe0, true); //         optional header size
    view.setUint16(optional, 0x010b, true); //      PE32
    view.setUint32(optional + 16, SECTION_RVA, true); // entry point
    view.setUint32(optional + 28, IMAGE_BASE, true);
    view.setUint32(optional + 32, 0x1000, true); // section alignment
    view.setUint32(optional + 56, SECTION_RVA + section.length, true); // sizeOfImage
    view.setUint32(optional + 60, HEADERS, true); // sizeOfHeaders
    view.setUint32(optional + 92, 16, true); //     directory count

    for (const [index, { address, size }] of Object.entries(directories))
    {
        const at = optional + 96 + Number(index) * 8;
        view.setUint32(at, address, true);
        view.setUint32(at + 4, size, true);
    }

    const header = optional + 0xe0;
    file.set(new TextEncoder().encode('.data'), header);
    view.setUint32(header + 8, section.length, true); //  virtualSize
    view.setUint32(header + 12, SECTION_RVA, true); //    virtualAddress
    view.setUint32(header + 16, section.length, true); // rawSize
    view.setUint32(header + 20, HEADERS, true); //        rawOffset
    view.setUint32(header + 36, 0xc0000040, true); //     initialised data, r/w

    file.set(section, HEADERS);
    return file;
}

const NAMES = 0x100;
const IAT = 0x200;
const DLL_NAME = 0x300;
const FIRST_IMPORT = 0x400;
const SECOND_IMPORT = 0x420;

/**
 * One delay-load descriptor, written either way round.
 *
 * `rvaBased` is the whole point of the fixture: the same logical table, stored
 * as RVAs with the bit set or as virtual addresses with it clear, has to read
 * back identically.
 *
 * @param {Object} options
 * @param {boolean} options.rvaBased
 * @param {(string | number)[]} [options.imports]  A name, or an ordinal.
 * @param {string} [options.dll]
 */
function withDelayImports({ rvaBased, imports = ['Alpha'], dll = 'thing.dll' }){
    const section = new Uint8Array(0x1000);
    const view = new DataView(section.buffer);
    const encoder = new TextEncoder();
    // How this descriptor spells an address: an RVA, or that plus the base.
    const address = (/** @type {number} */ offset)=>
        (rvaBased ? 0 : IMAGE_BASE) + SECTION_RVA + offset;

    view.setUint32(0, rvaBased ? 1 : 0, true); //          Attributes
    view.setUint32(4, address(DLL_NAME), true); //         DllNameRVA
    view.setUint32(8, address(0x500), true); //            ModuleHandleRVA
    view.setUint32(12, address(IAT), true); //             ImportAddressTableRVA
    view.setUint32(16, address(NAMES), true); //           ImportNameTableRVA
    // Bytes 20 through 31 are the bound table, unload table and timestamp; a
    // linker leaves them zero and nothing here reads them.

    section.set(encoder.encode(dll), DLL_NAME);

    imports.forEach((entry, index)=>{
        if (typeof entry === 'number')
        {
            view.setUint32(NAMES + index * 4, 0x80000000 | entry, true);
            return;
        }
        const at = index === 0 ? FIRST_IMPORT : SECOND_IMPORT;
        view.setUint16(at, 0, true); // hint
        section.set(encoder.encode(entry), at + 2);
        view.setUint32(NAMES + index * 4, address(at), true);
    });

    const bytes = fixture(section, { 13: { address: SECTION_RVA, size: 64 } });
    return { bytes, image: parsePe(bytes) };
}

test('a descriptor reads the same whether it stored RVAs or virtual addresses', ()=>{
    // The one bit this file exists for. Read the wrong way the table lands at a
    // plausible offset inside the image and binds nonsense, and the program
    // finds out much later in a function that resolved to whatever was there.
    const asRvas = withDelayImports({ rvaBased: true, imports: ['Alpha', 'Beta'] });
    const asVas = withDelayImports({ rvaBased: false, imports: ['Alpha', 'Beta'] });

    const fromRvas = readDelayImports(asRvas.bytes, asRvas.image);
    const fromVas = readDelayImports(asVas.bytes, asVas.image);

    assert.equal(fromRvas[0].rvaBased, true);
    assert.equal(fromVas[0].rvaBased, false);
    assert.deepEqual(fromRvas[0].entries, fromVas[0].entries,
        'the same table, spelled two ways, is the same table');
    assert.equal(fromRvas[0].dll, fromVas[0].dll);
});

test('what is imported is reported the way an ordinary import is', ()=>{
    const { bytes, image } = withDelayImports({ rvaBased: true, imports: ['Alpha', 'Beta'] });
    const [entry] = readDelayImports(bytes, image);

    assert.equal(entry.dll, 'thing.dll');
    assert.deepEqual(entry.entries.map(one=>one.name), ['Alpha', 'Beta']);
    assert.deepEqual(entry.entries.map(one=>one.iatRva),
        [SECTION_RVA + IAT, SECTION_RVA + IAT + 4],
        'a slot per import, so a caller can write answers into them');
});

test('an address table slot is an offset into the image, never a virtual address', ()=>{
    // A caller writes the resolved address into this, so a base left in it
    // writes over whatever is that far past the end of the image.
    const { bytes, image } = withDelayImports({ rvaBased: false });
    const [entry] = readDelayImports(bytes, image);

    assert.equal(entry.entries[0].iatRva, SECTION_RVA + IAT);
    assert.ok(entry.entries[0].iatRva < IMAGE_BASE);
    assert.equal(entry.moduleHandleRva, SECTION_RVA + 0x500);
});

test('an import by ordinal has no name, and keeps its slot', ()=>{
    const { bytes, image } = withDelayImports({ rvaBased: true, imports: [7] });
    const [entry] = readDelayImports(bytes, image);

    assert.deepEqual(entry.entries, [
        { name: null, ordinal: 7, iatRva: SECTION_RVA + IAT },
    ]);
});

test('the walk stops at the all-zero descriptor', ()=>{
    // The directory's size is not the terminator -- it is generous, and reading
    // past the zero entry would produce a library named by whatever follows.
    const { bytes, image } = withDelayImports({ rvaBased: true });
    assert.equal(readDelayImports(bytes, image).length, 1);
});

test('an image that delay-loads nothing answers with nothing', ()=>{
    const none = fixture(new Uint8Array(0x1000), {});
    assert.deepEqual(readDelayImports(none, parsePe(none)), []);

    const empty = fixture(new Uint8Array(0x1000), { 13: { address: 0, size: 0 } });
    assert.deepEqual(readDelayImports(empty, parsePe(empty)), []);
});
