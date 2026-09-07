/*
 * Copyright © 2026 Bottlify Project
 * Licensed under BSD-2-Clause License
 * See LICENSE for details
 */

/**
 * Every assertion reads the synthesised bytes back through `pe.js` -- the same
 * parser the loader runs over a real executable. A field these two disagree
 * about is a field one of them has wrong, and the failing assertion names it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { synthesiseModule } from './synth.js';
import { parsePe, readImports, rvaToFileOffset } from './pe.js';

const BASE = 0x70000000;

/** Trap stubs the exports jump to, deliberately on both sides of BASE. */
const STUBS = {
    GetStdHandle: 0x00401000,
    WriteFile: 0x7f000000,
    ExitProcess: 0x00402000,
    CreateFileA: 0x7f000100,
};

/**
 * @typedef {Object} DecodedExports
 * @property {import('./pe.js').PeImage} image
 * @property {Uint8Array} bytes
 * @property {number} directoryRva
 * @property {number} directorySize
 * @property {string} moduleName
 * @property {number} ordinalBase
 * @property {number} functionCount
 * @property {number} nameCount
 * @property {number[]} functionRvas          Indexed by ordinal - ordinalBase.
 * @property {string[]} names                 In name-table order.
 * @property {number[]} nameOrdinals          Parallel to names, biased by ordinalBase.
 */

/**
 * Walks the export directory the way a loader does: data directory 0, then the
 * three parallel arrays it points at.
 *
 * @param {Uint8Array} bytes
 * @returns {DecodedExports}
 */
function decodeExports(bytes){
    const image = parsePe(bytes);
    const directory = image.directories[0];
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const at = (/** @type {number} */ rva)=>rvaToFileOffset(image, rva);
    const u32 = (/** @type {number} */ rva)=>view.getUint32(at(rva), true);
    const u16 = (/** @type {number} */ rva)=>view.getUint16(at(rva), true);

    const dir = directory.address;
    const ordinalBase = u32(dir + 16);
    const functionCount = u32(dir + 20);
    const nameCount = u32(dir + 24);
    const functionsRva = u32(dir + 28);
    const namesRva = u32(dir + 32);
    const nameOrdinalsRva = u32(dir + 36);

    /** @type {number[]} */
    const functionRvas = [];
    for (let i = 0; i < functionCount; i++){
        functionRvas.push(u32(functionsRva + i * 4));
    }

    /** @type {string[]} */
    const names = [];
    /** @type {number[]} */
    const nameOrdinals = [];
    for (let i = 0; i < nameCount; i++){
        names.push(readCString(bytes, at(u32(namesRva + i * 4))));
        nameOrdinals.push(u16(nameOrdinalsRva + i * 2));
    }

    return {
        image,
        bytes,
        directoryRva: dir,
        directorySize: directory.size,
        moduleName: readCString(bytes, at(u32(dir + 12))),
        ordinalBase,
        functionCount,
        nameCount,
        functionRvas,
        names,
        nameOrdinals,
    };
}

/**
 * Decodes the JMP at an export RVA and reports where it lands.
 *
 * @param {DecodedExports} decoded
 * @param {number} rva
 * @returns {{ target: number, displacement: number }}
 */
function jumpFrom(decoded, rva){
    const offset = rvaToFileOffset(decoded.image, rva);
    const view = new DataView(decoded.bytes.buffer, decoded.bytes.byteOffset,
        decoded.bytes.byteLength);
    assert.equal(decoded.bytes[offset], 0xe9, 'export RVA points at a JMP rel32');
    const displacement = view.getInt32(offset + 1, true);
    return { target: (BASE + rva + 5 + displacement) >>> 0, displacement };
}

/**
 * @param {Uint8Array} bytes
 * @param {number} offset
 * @returns {string}
 */
function readCString(bytes, offset){
    let end = offset;
    while (end < bytes.length && bytes[end] !== 0){
        end++;
    }
    return new TextDecoder().decode(bytes.subarray(offset, end));
}

/**
 * Declaration order is deliberately not sorted: the name table has to be sorted
 * by the emitter, not by the caller.
 *
 * @returns {import('./synth.js').SynthesisedModule}
 */
function kernel32(){
    return synthesiseModule({
        name: 'KERNEL32.dll',
        base: BASE,
        exports: [
            { name: 'WriteFile', target: STUBS.WriteFile },
            { name: 'ExitProcess', target: STUBS.ExitProcess },
            { name: 'GetStdHandle', target: STUBS.GetStdHandle },
            { name: 'CreateFileA', target: STUBS.CreateFileA },
        ],
    });
}

test('the image parses as a PE32 module mapped at its base', ()=>{
    const module = kernel32();
    const image = parsePe(module.bytes);

    assert.equal(image.imageBase, BASE);
    assert.equal(image.sizeOfImage, module.size);
    assert.equal(module.bytes.length, module.size);
    assert.equal(image.sections.length, 1);
    assert.ok(image.sections[0].executable, 'the trampolines are code');
    assert.ok(image.sections[0].readable);
    assert.equal(image.sections[0].writable, false);
    assert.deepEqual(readImports(module.bytes, image), [], 'a synthesised module imports nothing');

    // Raw offsets equal RVAs, so the same bytes serve as file and as mapping.
    const section = image.sections[0];
    assert.equal(rvaToFileOffset(image, section.virtualAddress), section.virtualAddress);
});

test('data directory 0 leads to the export directory', ()=>{
    const module = kernel32();
    const decoded = decodeExports(module.bytes);

    assert.equal(decoded.directoryRva, module.exportDirectoryRva);
    assert.equal(decoded.moduleName, 'KERNEL32.dll');
    assert.equal(decoded.ordinalBase, 1);
    assert.equal(decoded.functionCount, 4);
    assert.equal(decoded.nameCount, 4);

    // The directory's size must span the arrays and strings it owns: a loader
    // treats a function RVA inside that span as a forwarder string, so the
    // trampolines have to sit outside it.
    const end = decoded.directoryRva + decoded.directorySize;
    for (const rva of decoded.functionRvas)
    {
        assert.ok(rva < decoded.directoryRva || rva >= end, 'no export looks like a forwarder');
    }
    assert.ok(decoded.directorySize > 40, 'size covers more than the header struct');
});

test('every name resolves to a trampoline that jumps to its stub', ()=>{
    const module = kernel32();
    const decoded = decodeExports(module.bytes);

    for (const [name, stub] of Object.entries(STUBS))
    {
        const index = decoded.names.indexOf(name);
        assert.notEqual(index, -1, `${name} is in the name table`);

        const rva = decoded.functionRvas[decoded.nameOrdinals[index]];
        assert.equal(jumpFrom(decoded, rva).target, stub, `${name} jumps to its stub`);
        assert.equal(module.addressOf(name), BASE + rva, `${name} reports the trampoline address`);
        assert.equal(module.ordinalOf(name), decoded.ordinalBase + decoded.nameOrdinals[index]);
    }

    assert.equal(module.addressOf('NoSuchFunction'), null);
    assert.equal(module.ordinalOf('NoSuchFunction'), null);
});

test('the name table is sorted, whatever order the exports were given in', ()=>{
    const decoded = decodeExports(kernel32().bytes);
    assert.deepEqual(decoded.names, ['CreateFileA', 'ExitProcess', 'GetStdHandle', 'WriteFile']);
    assert.deepEqual([...decoded.names].sort(), decoded.names);
});

test('ordinals are dense from the base when none are given', ()=>{
    const decoded = decodeExports(kernel32().bytes);
    assert.deepEqual([...decoded.nameOrdinals].sort((a, b)=>a - b), [0, 1, 2, 3]);
    assert.ok(decoded.functionRvas.every(rva=>rva !== 0), 'a dense table has no holes');
});

test('a displacement is signed: stubs above and below the image both resolve', ()=>{
    const module = kernel32();
    const decoded = decodeExports(module.bytes);
    const at = (/** @type {string} */ name)=>
        jumpFrom(decoded, /** @type {number} */ (module.addressOf(name)) - BASE);

    assert.ok(at('GetStdHandle').displacement < 0, 'a stub below the image jumps backwards');
    assert.ok(at('WriteFile').displacement > 0, 'a stub above the image jumps forwards');
    assert.equal(at('GetStdHandle').target, STUBS.GetStdHandle);
    assert.equal(at('WriteFile').target, STUBS.WriteFile);
});

test('explicit ordinals keep their numbers, and their gaps', ()=>{
    const module = synthesiseModule({
        name: 'WSOCK32.dll',
        base: BASE,
        exports: [
            { name: 'send', ordinal: 19, target: 0x00500000 },
            { name: 'recv', ordinal: 16, target: 0x00500010 },
        ],
    });
    const decoded = decodeExports(module.bytes);

    assert.equal(decoded.ordinalBase, 16);
    assert.equal(decoded.functionCount, 4, 'the table spans ordinals 16..19');
    assert.equal(decoded.nameCount, 2);
    assert.deepEqual(decoded.names, ['recv', 'send']);
    assert.deepEqual(decoded.functionRvas.slice(1, 3), [0, 0], 'unused ordinals are empty slots');

    assert.equal(module.ordinalOf('recv'), 16);
    assert.equal(module.ordinalOf('send'), 19);
    assert.equal(jumpFrom(decoded, decoded.functionRvas[0]).target, 0x00500010);
    assert.equal(jumpFrom(decoded, decoded.functionRvas[3]).target, 0x00500000);
});

test('a module with no exports is still a valid image', ()=>{
    const module = synthesiseModule({ name: 'EMPTY.dll', base: BASE, exports: [] });
    const decoded = decodeExports(module.bytes);

    assert.equal(decoded.moduleName, 'EMPTY.dll');
    assert.equal(decoded.ordinalBase, 1);
    assert.equal(decoded.functionCount, 0);
    assert.equal(decoded.nameCount, 0);
    assert.equal(module.addressOf('anything'), null);
});

test('inputs that cannot produce a correct table are rejected', ()=>{
    const twice = [
        { name: 'Dup', target: 0x1000 },
        { name: 'Dup', target: 0x2000 },
    ];
    assert.throws(()=>synthesiseModule({ name: 'A.dll', base: BASE, exports: twice }), /duplicate/);

    const sameOrdinal = [
        { name: 'A', ordinal: 3, target: 0x1000 },
        { name: 'B', ordinal: 3, target: 0x2000 },
    ];
    assert.throws(
        ()=>synthesiseModule({ name: 'A.dll', base: BASE, exports: sameOrdinal }),
        /ordinal 3/,
    );

    // Byte-wise sorting is what a loader's binary search assumes; a name outside
    // ASCII would sort by UTF-16 code unit instead and silently break it.
    const wide = [{ name: 'GeßtStdHandle', target: 0x1000 }];
    assert.throws(()=>synthesiseModule({ name: 'A.dll', base: BASE, exports: wide }), /ASCII/);
});

test('a library may pin some ordinals and leave the rest to us', ()=>{
    // The ordinary case for a real library: the numbers its callers import by
    // are fixed, and the linker assigns the others. Refusing a mixed set would
    // refuse every library that has ever had a well-known ordinal.
    const module = synthesiseModule({
        name: 'mixed.dll',
        base: 0x02000000,
        exports: [
            { name: 'Pinned', target: 0x1000, ordinal: 7 },
            { name: 'Free', target: 0x2000 },
            { name: 'AlsoPinned', target: 0x3000, ordinal: 151 },
        ],
    });

    assert.equal(module.ordinalOf('Pinned'), 7, 'a declared ordinal is honoured exactly');
    assert.equal(module.ordinalOf('AlsoPinned'), 151);
    assert.equal(module.ordinalOf('Free'), 152,
        'and one we assign sits above everything claimed, so it cannot collide');
});
