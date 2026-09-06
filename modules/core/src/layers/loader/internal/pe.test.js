/*
 * Copyright © 2026 Bottlify Project
 * Licensed under BSD-2-Clause License
 * See LICENSE for details
 */

/**
 * Parsed against the checked-in fixture, which real Windows executes — so these
 * assertions describe a genuine executable rather than our own idea of one.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parsePe, readImports, rvaToFileOffset, applyRelocations } from './pe.js';
import { buildImage } from './image.js';

const FIXTURE = new URL('../../../../test/fixtures/hello.exe', import.meta.url);
const file = new Uint8Array(readFileSync(FIXTURE));

test('headers of a real 32-bit console executable', ()=>{
    const image = parsePe(file);
    assert.equal(image.imageBase, 0x400000);
    assert.equal(image.subsystem, 3, 'console subsystem');
    assert.equal(image.sectionAlignment, 0x1000);
    assert.ok(image.entryPointRva > 0);
    assert.ok(image.sizeOfImage >= 0x2000);
    assert.equal(image.sections.length, 1);
    assert.equal(image.sections[0].name, '.text');
    assert.ok(image.sections[0].executable, 'code section is executable');
});

test('rejects images it cannot honestly load', ()=>{
    assert.throws(()=>parsePe(new Uint8Array(64)), /missing MZ/);

    const truncated = file.slice(0, 0x40);
    assert.throws(()=>parsePe(truncated), /missing PE signature/);

    const wrongMachine = file.slice();
    const peOffset = new DataView(wrongMachine.buffer).getUint32(0x3c, true);
    new DataView(wrongMachine.buffer).setUint16(peOffset + 4, 0x8664, true); // x86-64
    assert.throws(()=>parsePe(wrongMachine), /only i386/);
});

test('imports name the functions the program actually calls', ()=>{
    const image = parsePe(file);
    const imports = readImports(file, image);

    assert.equal(imports.length, 1);
    assert.equal(imports[0].dll.toLowerCase(), 'kernel32.dll');
    assert.deepEqual(
        imports[0].entries.map(entry=>entry.name),
        ['GetStdHandle', 'WriteFile', 'ExitProcess'],
    );
    for (const entry of imports[0].entries)
    {
        assert.equal(entry.ordinal, null, 'imported by name, not ordinal');
        assert.ok(entry.iatRva > 0, 'each import has a slot to write into');
    }
});

test('RVA translation accounts for the zero-filled tail past raw data', ()=>{
    const image = parsePe(file);
    const section = image.sections[0];
    assert.equal(rvaToFileOffset(image, section.virtualAddress), section.rawOffset);
    assert.throws(()=>rvaToFileOffset(image, 0x7fffffff), /outside every section/);
});

test('an image without relocations refuses to move', ()=>{
    const image = parsePe(file);
    assert.equal(image.relocatable, false,
        'the fixture has no .reloc, like many pre-2000 binaries');
    assert.throws(()=>applyRelocations(new Uint8Array(image.sizeOfImage), image, 0x1000), /no relocation directory/);
    assert.throws(()=>buildImage(file, { resolveImport: ()=>0, base: 0x800000 }), /carries no relocations/);
});

test('building the image binds every import into the IAT', ()=>{
    /** @type {string[]} */
    const asked = [];
    const stubs = { GetStdHandle: 0x00200000, WriteFile: 0x0020000c, ExitProcess: 0x00200018 };

    const loaded = buildImage(file, {
        resolveImport: (dll, name)=>{
            asked.push(`${dll}!${name}`);
            return stubs[/** @type {keyof typeof stubs} */ (name)] ?? null;
        },
    });

    assert.equal(loaded.base, 0x400000);
    assert.equal(loaded.entryPoint, 0x401000);
    assert.deepEqual(loaded.unresolved, []);
    assert.deepEqual(asked, [
        'KERNEL32.dll!GetStdHandle',
        'KERNEL32.dll!WriteFile',
        'KERNEL32.dll!ExitProcess',
    ]);

    // The entry point's first instruction is `push -11` (STD_OUTPUT_HANDLE), and
    // the call that follows must now point at the address we handed back.
    const entryOffset = loaded.entryPoint - loaded.base;
    assert.equal(loaded.bytes[entryOffset], 0x6a);
    assert.equal(loaded.bytes[entryOffset + 1], 0xf5);

    const view = new DataView(loaded.bytes.buffer);
    const iatSlot = view.getUint32(entryOffset + 4, true) - loaded.base; // operand of call [abs]
    assert.equal(view.getUint32(iatSlot, true), stubs.GetStdHandle,
        'IAT slot holds the bound address');
});

test('an import nobody claims is reported, not fatal', ()=>{
    const loaded = buildImage(file, {
        resolveImport: (_dll, name)=>name === 'WriteFile' ? null : 0x00200000,
    });
    assert.deepEqual(loaded.unresolved, ['KERNEL32.dll!WriteFile']);
});
