/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Parsed against the checked-in fixture, which real Windows executes — so these
 * assertions describe a genuine executable rather than our own idea of one.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parsePe, readImports, readExports, rvaToFileOffset, applyRelocations, DIR_EXPORT,
    parseExportDirectory }
    from './pe.js';
import { synthesiseModule } from './synth.js';
import { buildImage, mapImage } from './image.js';

const FIXTURE = new URL('../../../../test/fixtures/hello.exe', import.meta.url);
const file = new Uint8Array(readFileSync(FIXTURE));

test('headers of a real 32-bit console executable', ()=>{
    const image = parsePe(file);
    assert.equal(image.imageBase, 0x400000);
    assert.equal(image.subsystem, 3, 'console subsystem');
    assert.equal(image.sectionAlignment, 0x1000);
    assert.ok(image.entryPointRva > 0);
    assert.ok(image.sizeOfImage >= 0x2000);
    // The COFF header's own build timestamp, read alongside the fields
    // already fetched from it (machine, section count) rather than assumed:
    // a hook's sidecar checks this against the image it hopes to patch. This
    // fixture's is zero -- a reproducible build zeroing it is legitimate, not
    // a parsing failure -- so only that it was actually read is pinned here.
    assert.equal(typeof image.timeDateStamp, 'number');
    // The stack the linker reserved. Read rather than assumed, because a
    // program given less than it was built for fails as a read below its own
    // stack, at whichever call was crossing the boundary.
    assert.equal(image.stackReserve, 0x100000);
    assert.equal(image.stackCommit, 0x1000);
    assert.equal(image.sections.length, 1);
    assert.equal(image.sections[0].name, '.text');
    assert.ok(image.sections[0].executable, 'code section is executable');
});

test('a program is not a library until its COFF header says IMAGE_FILE_DLL', ()=>{
    assert.equal(parsePe(file).library, false);
    const library = file.slice();
    const view = new DataView(library.buffer);
    const characteristics = view.getUint32(0x3c, true) + 4 + 18;
    view.setUint16(characteristics, view.getUint16(characteristics, true) | 0x2000, true);
    assert.equal(parsePe(library).library, true);
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

test('a section whose PointerToRawData is zero maps as zeros, whatever its SizeOfRawData', ()=>{
    const patched = file.slice();
    const view = new DataView(patched.buffer);
    const header = view.getUint32(0x3c, true);
    const sectionTable = header + 24 + view.getUint16(header + 20, true);
    view.setUint32(sectionTable + 20, 0, true);

    const { bytes } = mapImage(patched, 0x400000);

    const section = parsePe(patched).sections[0];
    assert.equal(section.rawSize, 512, 'the size still claims file bytes');
    assert.deepEqual([...bytes.subarray(section.virtualAddress, section.virtualAddress + 512)],
        new Array(512).fill(0), 'and not the headers at offset zero');
});

test('a section maps its virtual size to the section boundary, not raw data past it', ()=>{
    // A self-extractor keeps its archive in the raw data of a resource
    // section a few pages long and reads it from the file; the raw size runs
    // far past the image's end, and none of that is mapped.
    const header = new DataView(file.buffer, file.byteOffset).getUint32(0x3c, true);
    const sectionTable = header + 24
        + new DataView(file.buffer, file.byteOffset).getUint16(header + 20, true);
    const original = parsePe(file).sections[0];
    const patched = new Uint8Array(original.rawOffset + 0x5000);
    patched.set(file);
    for (let at = file.length; at < patched.length; at++)
    {
        patched[at] = at & 0xff;
    }
    const view = new DataView(patched.buffer);
    view.setUint32(sectionTable + 16, 0x5000, true);

    const { bytes, image } = mapImage(patched, 0x400000);
    assert.equal(bytes.length, image.sizeOfImage, 'the image keeps its own size');
    const end = original.virtualAddress + 0x1000;
    assert.deepEqual([...bytes.subarray(end - 4, end)],
        [...patched.subarray(original.rawOffset + 0x1000 - 4, original.rawOffset + 0x1000)],
        'the raw data is mapped to the page its virtual size ends in');

    // A virtual size of zero is the raw size, as older linkers wrote it.
    view.setUint32(sectionTable + 8, 0, true);
    view.setUint32(sectionTable + 16, 0x200, true);
    const zero = mapImage(patched, 0x400000).bytes;
    assert.deepEqual([...zero.subarray(original.virtualAddress, original.virtualAddress + 0x200)],
        [...patched.subarray(original.rawOffset, original.rawOffset + 0x200)]);
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

test('the export directory reads back what the synthesiser wrote', ()=>{
    // Read against our own writer rather than a hand-built fixture: the writer
    // is already proved correct by a guest resolving through it, so agreement
    // here means the reader is right about a real export directory rather than
    // about one shaped to suit it.
    const module = synthesiseModule({
        name: 'sample.dll',
        base: 0x02000000,
        exports: [
            { name: 'Alpha', target: 0x11110000 },
            { name: 'Beta', target: 0x22220000 },
        ],
    });

    const image = parsePe(module.bytes);
    const { name, exports } = readExports(module.bytes, image);

    assert.equal(name, 'sample.dll', 'a module names itself in its export directory');
    assert.deepEqual(exports.map(entry=>entry.name), ['Alpha', 'Beta']);
    assert.equal(exports.every(entry=>entry.forwards === null), true,
        'a trampoline is code, not a forwarder');

    // The addresses have to be the ones the module hands out, or a program that
    // walks the directory itself lands somewhere else than one that imported.
    for (const entry of exports)
    {
        assert.equal(0x02000000 + entry.rva, module.addressOf(/** @type {string} */ (entry.name)));
        assert.equal(entry.ordinal, module.ordinalOf(/** @type {string} */ (entry.name)));
    }
});

test('an export pointing inside the directory is a forwarder, not code', ()=>{
    // The case that is silent when missed: the address is a string, and running
    // it puts the guest on ASCII a long way from the cause.
    const module = synthesiseModule({
        name: 'sample.dll',
        base: 0x02000000,
        exports: [{ name: 'Alpha', target: 0x11110000 }],
    });

    const image = parsePe(module.bytes);
    const directory = image.directories[DIR_EXPORT];
    const bytes = module.bytes.slice();
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    // Point the one export at a string planted inside the directory's range.
    const stringRva = directory.address + directory.size - 16;
    const at = rvaToFileOffset(image, stringRva);
    for (const [index, code] of [...'OTHER.Beta'].entries())
    {
        bytes[at + index] = code.charCodeAt(0);
    }
    bytes[at + 10] = 0;
    const functionsRva = view.getUint32(rvaToFileOffset(image, directory.address) + 28, true);
    view.setUint32(rvaToFileOffset(image, functionsRva), stringRva, true);

    const { exports } = readExports(bytes, image);
    assert.equal(exports.length, 1);
    assert.equal(exports[0].forwards, 'OTHER.Beta');
});

test('an export directory pointing outside the file reads what it can, not a throw', ()=>{
    // A packed executable keeps its export directory encrypted on disk and
    // rebuilds it in memory; the loader never walks it while mapping, so the
    // image must load whatever the directory's fields hold.
    const module = synthesiseModule({
        name: 'sample.dll',
        base: 0x02000000,
        exports: [{ name: 'Alpha', target: 0x11110000 }],
    });
    const image = parsePe(module.bytes);
    const at = rvaToFileOffset(image, image.directories[DIR_EXPORT].address);

    const badName = module.bytes.slice();
    new DataView(badName.buffer).setUint32(at + 12, 0xb8f4a879, true);
    const named = readExports(badName, image);
    assert.equal(named.name, null, 'a name RVA outside every section names nothing');
    assert.deepEqual(named.exports.map(entry=>entry.name), ['Alpha']);

    const badTables = module.bytes.slice();
    const view = new DataView(badTables.buffer);
    view.setUint32(at + 28, 0xdeadbeef, true);
    view.setUint32(at + 32, 0xdeadbeef, true);
    assert.deepEqual(readExports(badTables, image).exports, [],
        'an address table outside the file exports nothing');

    const badNames = module.bytes.slice();
    new DataView(badNames.buffer).setUint32(at + 32, 0xdeadbeef, true);
    assert.deepEqual(readExports(badNames, image).exports.map(entry=>entry.name), [null],
        'a name table outside the file leaves the export by ordinal');
});

test('an export directory the image cannot hold is refused with its reason, not thrown', ()=>{
    // An executable may carry its table encoded and write it out in place
    // before it asks for its own exports: what the file holds there is noise,
    // counts in the hundreds of millions and tables far past the image.
    const module = synthesiseModule({
        name: 'sample.dll',
        base: 0x02000000,
        exports: [{ name: 'Alpha', target: 0x11110000 }],
    });
    const image = parsePe(module.bytes);
    const directory = image.directories[DIR_EXPORT];
    const bytes = module.bytes.slice();
    const head = rvaToFileOffset(image, directory.address);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    view.setUint32(head + 20, 342396563, true);
    view.setUint32(head + 28, 0x5ec159bc, true);

    const garbled = readExports(bytes, image);
    assert.deepEqual(garbled.exports, []);
    assert.match(String(garbled.refused), /outside the image/);

    // The same directory read through the mapping once the program wrote it
    // out: the reader decides where the bytes come from.
    const fixed = parseExportDirectory((rva, length)=>{
        const at = rvaToFileOffset(image, rva);
        return module.bytes.subarray(at, at + length);
    }, directory);
    assert.equal(fixed.refused, null);
    assert.deepEqual(fixed.exports.map(entry=>entry.name), ['Alpha']);
});
