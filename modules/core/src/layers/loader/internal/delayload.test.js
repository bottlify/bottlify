/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePe } from './pe.js';
import { mapImage } from './image.js';
import { bindDelayImports, readDelayImports } from './delayload.js';
import { planDependencies } from './dependencies.js';

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

const DESCRIPTOR = 32;

/**
 * Each descriptor's tables live in a block of their own, clear of the
 * descriptor array at the start of the section, so several can coexist.
 */
const BLOCK = 0x400;
const NAMES = 0x000;
const IAT = 0x040;
const DLL_NAME = 0x080;
const MODULE_HANDLE = 0x0c0;
const IMPORT_NAMES = 0x100;
const IMPORT_STRIDE = 0x20;
const BOUND_TABLE = 0x200;
const UNLOAD_TABLE = 0x240;

/**
 * @typedef {Object} DelayedDll
 * @property {string} [dll]
 * @property {(string | number)[]} [imports]  A name, or an ordinal.
 */

/**
 * An image whose delay-load directory holds one descriptor per entry in `dlls`.
 *
 * `rvaBased` is the whole point of the fixture: the same logical table, stored
 * as RVAs with the bit set or as virtual addresses with it clear, has to read
 * and bind identically.
 *
 * @param {Object} options
 * @param {boolean} options.rvaBased
 * @param {DelayedDll[]} options.dlls
 * @param {boolean} [options.optionalTables]  Emit a bound and an unload table.
 * @returns {{ bytes: Uint8Array, image: import('./pe.js').PeImage }}
 */
function withDelayLoads({ rvaBased, dlls, optionalTables = false }){
    const section = new Uint8Array(0x2000);
    const view = new DataView(section.buffer);
    const encoder = new TextEncoder();
    // How this descriptor spells an address: an RVA, or that plus the base.
    const address = (/** @type {number} */ offset)=>
        (rvaBased ? 0 : IMAGE_BASE) + SECTION_RVA + offset;

    dlls.forEach(({ dll = 'thing.dll', imports = ['Alpha'] }, index)=>{
        const at = index * DESCRIPTOR;
        const block = blockOf(index);

        view.setUint32(at, rvaBased ? 1 : 0, true); //                Attributes
        view.setUint32(at + 4, address(block + DLL_NAME), true); //   DllNameRVA
        view.setUint32(at + 8, address(block + MODULE_HANDLE), true); // ModuleHandleRVA
        view.setUint32(at + 12, address(block + IAT), true); //       ImportAddressTableRVA
        view.setUint32(at + 16, address(block + NAMES), true); //     ImportNameTableRVA
        if (optionalTables)
        {
            // A linker that emits neither leaves these zero, which is what the
            // rest of the fixture does; a descriptor that has them must bind
            // the same way, and reading them as required is how code walks off
            // the end of a section.
            view.setUint32(at + 20, address(block + BOUND_TABLE), true);
            view.setUint32(at + 24, address(block + UNLOAD_TABLE), true);
            view.setUint32(at + 28, 0x3fffffff, true); // TimeStamp
        }

        section.set(encoder.encode(dll), block + DLL_NAME);

        imports.forEach((entry, slot)=>{
            if (typeof entry === 'number')
            {
                view.setUint32(block + NAMES + slot * 4, 0x80000000 | entry, true);
                return;
            }
            const name = block + IMPORT_NAMES + slot * IMPORT_STRIDE;
            view.setUint16(name, 0, true); // hint
            section.set(encoder.encode(entry), name + 2);
            view.setUint32(block + NAMES + slot * 4, address(name), true);
        });
    });

    const size = (dlls.length + 1) * DESCRIPTOR;
    const bytes = fixture(section, { 13: { address: SECTION_RVA, size } });
    return { bytes, image: parsePe(bytes) };
}

/**
 * The single-descriptor case, which most of these tests want.
 *
 * @param {Object} options
 * @param {boolean} options.rvaBased
 * @param {(string | number)[]} [options.imports]
 * @param {string} [options.dll]
 * @param {boolean} [options.optionalTables]
 */
function withDelayImports({ rvaBased, imports, dll, optionalTables }){
    return withDelayLoads({ rvaBased, dlls: [{ dll, imports }], optionalTables });
}

/** Where descriptor `index` keeps its tables, as an offset into the section. */
function blockOf(/** @type {number} */ index){
    return BLOCK * (index + 1);
}

/** The RVA of one address-table slot. */
function slotRva(/** @type {number} */ dll, /** @type {number} */ slot){
    return SECTION_RVA + blockOf(dll) + IAT + slot * 4;
}

/**
 * @param {{ bytes: Uint8Array }} mapped
 * @param {number} rva
 * @returns {number}
 */
function slotAt({ bytes }, rva){
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(rva, true);
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
    assert.deepEqual(entry.entries.map(one=>one.iatRva), [slotRva(0, 0), slotRva(0, 1)],
        'a slot per import, so a caller can write answers into them');
});

test('an address table slot is an offset into the image, never a virtual address', ()=>{
    // A caller writes the resolved address into this, so a base left in it
    // writes over whatever is that far past the end of the image.
    const { bytes, image } = withDelayImports({ rvaBased: false });
    const [entry] = readDelayImports(bytes, image);

    assert.equal(entry.entries[0].iatRva, slotRva(0, 0));
    assert.ok(entry.entries[0].iatRva < IMAGE_BASE);
    assert.equal(entry.moduleHandleRva, SECTION_RVA + blockOf(0) + MODULE_HANDLE);
});

test('an import by ordinal has no name, and keeps its slot', ()=>{
    const { bytes, image } = withDelayImports({ rvaBased: true, imports: [7] });
    const [entry] = readDelayImports(bytes, image);

    assert.deepEqual(entry.entries, [
        { name: null, ordinal: 7, iatRva: slotRva(0, 0) },
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

/** The address `stamp` answers a name with: derived from it, so a slot names its own import. */
const stamped = (/** @type {string} */ name)=>0xaa000000 + name.charCodeAt(0);

/** Claims every name in thing.dll and nothing else, so both outcomes appear in one image. */
const stamp = (/** @type {string} */ dll, /** @type {string | null} */ name)=>
    dll === 'thing.dll' && name !== null ? stamped(name) : null;

test('binding writes the same addresses whether the descriptor stored RVAs or VAs', ()=>{
    // Read the wrong way the address table lands at a plausible offset inside
    // the image, and binding writes over whatever is really there.
    const asRvas = mapImage(withDelayImports({ rvaBased: true, imports: ['Alpha', 'Beta'] }).bytes);
    const asVas = mapImage(withDelayImports({ rvaBased: false, imports: ['Alpha', 'Beta'] }).bytes);

    assert.deepEqual(bindDelayImports(asRvas, stamp), []);
    assert.deepEqual(bindDelayImports(asVas, stamp), []);

    const slots = (/** @type {{ bytes: Uint8Array }} */ mapped)=>
        [slotRva(0, 0), slotRva(0, 1)].map(rva=>slotAt(mapped, rva));

    assert.deepEqual(slots(asRvas), [stamped('Alpha'), stamped('Beta')]);
    assert.deepEqual(slots(asVas), slots(asRvas),
        'the same table, spelled two ways, binds the same');
});

test('an unclaimed delay import is reported and its slot left as the file wrote it', ()=>{
    const { bytes } = withDelayImports({ rvaBased: true, imports: ['Alpha', 'Beta', 7] });
    const mapped = mapImage(bytes);
    const before = slotAt(mapped, slotRva(0, 1));

    const unresolved = bindDelayImports(mapped, (dll, name)=>name === 'Alpha' ? 0x11110000 : null);

    assert.deepEqual(unresolved, ['thing.dll!Beta', 'thing.dll!#7']);
    assert.equal(slotAt(mapped, slotRva(0, 0)), 0x11110000);
    assert.equal(slotAt(mapped, slotRva(0, 1)), before,
        'nothing claimed it, so nothing pretends to have');
});

test('the missing hook decides where a call to an unclaimed delay import lands', ()=>{
    const mapped = mapImage(withDelayImports({ rvaBased: false, imports: ['Alpha'] }).bytes);

    const unresolved = bindDelayImports(mapped, ()=>null, ()=>0xdead0000);

    assert.deepEqual(unresolved, ['thing.dll!Alpha']);
    assert.equal(slotAt(mapped, slotRva(0, 0)), 0xdead0000);
});

test('a descriptor carrying a bound and an unload table binds like one without', ()=>{
    // Both are optional, and both are absent from most images; code that reads
    // them as required walks off the end of a section on the ordinary case.
    const plain = mapImage(withDelayImports({ rvaBased: true, imports: ['Alpha'] }).bytes);
    const full = mapImage(
        withDelayImports({ rvaBased: true, imports: ['Alpha'], optionalTables: true }).bytes);

    assert.deepEqual(bindDelayImports(plain, stamp), []);
    assert.deepEqual(bindDelayImports(full, stamp), []);

    assert.equal(slotAt(full, slotRva(0, 0)), slotAt(plain, slotRva(0, 0)));
});

test('every descriptor in an image is bound, not just the first', ()=>{
    const { bytes } = withDelayLoads({
        rvaBased: false,
        dlls: [
            { dll: 'thing.dll', imports: ['Alpha'] },
            { dll: 'other.dll', imports: ['Beta'] },
            { dll: 'thing.dll', imports: ['Gamma', 4] },
        ],
    });
    const mapped = mapImage(bytes);

    const unresolved = bindDelayImports(mapped, stamp);

    assert.deepEqual(unresolved, ['other.dll!Beta', 'thing.dll!#4']);
    assert.equal(slotAt(mapped, slotRva(0, 0)), stamped('Alpha'));
    assert.equal(slotAt(mapped, slotRva(2, 0)), stamped('Gamma'));
});

test('the module handle slot is left alone', ()=>{
    // Its only reader is the program's own helper, and binding the address
    // table is exactly what stops that helper from ever running. There is no
    // honest value to put here: a resolver answers with an address per import,
    // never a base per library.
    const mapped = mapImage(withDelayImports({ rvaBased: true }).bytes);

    bindDelayImports(mapped, stamp);

    assert.equal(slotAt(mapped, SECTION_RVA + blockOf(0) + MODULE_HANDLE), 0);
});

test('a library the program delay-loads and brought is planned, as an import is', async()=>{
    // An update package delay-loads its own copy of the setup API, which sits
    // beside it; the tables are bound before it runs, so it has to be mapped.
    const { bytes } = withDelayLoads({ rvaBased: true,
        dlls: [{ dll: 'updspapi.dll' }, { dll: 'USER32.dll' }, { dll: 'nowhere.dll' }] });
    const library = withDelayImports({ rvaBased: true, dll: 'USER32.dll' }).bytes;
    /** @type {string[]} */
    const asked = [];
    const { order, missing } = await planDependencies({
        entry: bytes,
        isSystem: name=>name.toLowerCase() === 'user32.dll',
        isKnownDll: name=>name.toLowerCase() === 'user32.dll',
        readLibrary: async name=>{
            asked.push(name);
            return name === 'updspapi.dll' ? library : null;
        },
    });
    assert.deepEqual(order.map(entry=>entry.name), ['updspapi.dll']);
    assert.deepEqual(asked, ['updspapi.dll', 'nowhere.dll'], 'a KnownDLL is not looked for');
    assert.deepEqual(missing, ['nowhere.dll']);
});
