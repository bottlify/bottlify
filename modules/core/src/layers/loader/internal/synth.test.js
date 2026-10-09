/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Every assertion reads the synthesised bytes back through `pe.js` -- the same
 * parser the loader runs over a real executable. A field these two disagree
 * about is a field one of them has wrong, and the failing assertion names it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { synthesiseModule, synthesiseProgram } from './synth.js';
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
    // Opened by `mov edi, edi`, as a Windows API is: a jump as the first
    // instruction is what a hook looks like to a program that checks.
    assert.deepEqual([...decoded.bytes.subarray(offset, offset + 2)], [0x8b, 0xff],
        'export RVA opens with mov edi, edi');
    assert.equal(decoded.bytes[offset + 2], 0xe9, 'and then a JMP rel32');
    const displacement = view.getInt32(offset + 3, true);
    return { target: (BASE + rva + 7 + displacement) >>> 0, displacement };
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

test('an export may be the entry point, and the header names it', ()=>{
    // A library loaded at run time is initialised through its header's entry
    // point, so a synthesised one that has to announce itself needs the field
    // filled in -- and one that does not must keep it zero, or the loader
    // would run a trampoline that was never meant to be called that way.
    const exports = [{ name: 'DllMain', target: 0x1000 }, { name: 'Other', target: 0x2000 }];
    const plain = synthesiseModule({ name: 'A.dll', base: BASE, exports });
    assert.equal(plain.entryPointRva, 0);
    assert.equal(parsePe(plain.bytes).entryPointRva, 0);

    const withEntry = synthesiseModule({
        name: 'A.dll', base: BASE, exports, entryPoint: 'DllMain',
    });
    assert.equal(BASE + withEntry.entryPointRva, withEntry.addressOf('DllMain'));
    assert.equal(parsePe(withEntry.bytes).entryPointRva, withEntry.entryPointRva);
    assert.throws(
        ()=>synthesiseModule({ name: 'A.dll', base: BASE, exports, entryPoint: 'Nope' }),
        /entry point "Nope"/,
    );
});

test('a data export holds its bytes at the exported address, not a jump', ()=>{
    // A runtime's `_acmdln` is a variable: a program reads a pointer through
    // the address it imported, and a jump there is read as a pointer to
    // nowhere.
    const value = new Uint8Array([0x78, 0x56, 0x34, 0x12]);
    const module = synthesiseModule({
        name: 'MSVCRT.dll',
        base: BASE,
        exports: [{ name: '_acmdln', data: value }, { name: 'exit', target: 0x2000 }],
    });
    const decoded = decodeExports(module.bytes);
    const rva = decoded.functionRvas[decoded.nameOrdinals[decoded.names.indexOf('_acmdln')]];
    assert.equal(module.addressOf('_acmdln'), BASE + rva);
    assert.deepEqual([...module.bytes.subarray(rva, rva + 4)], [0x78, 0x56, 0x34, 0x12]);
});

test('variables live in a writable data section of their own, apart from the code', ()=>{
    // As a real runtime's do: a program and the runtime itself write a
    // variable -- a stream's flags, the file mode -- where the code beside it
    // stays read-only and executable.
    const module = synthesiseModule({
        name: 'MSVCRT.dll',
        base: BASE,
        exports: [{ name: 'exit', target: 0x2000 }, { name: '_fmode', data: new Uint8Array(4) },
            { name: '_iob', data: new Uint8Array(20 * 32) }],
    });
    const image = parsePe(module.bytes);
    assert.equal(image.sections.length, 2);
    const [text, data] = image.sections;
    assert.equal(text.name, '.text');
    assert.ok(text.executable && !text.writable);
    assert.equal(data.name, '.data');
    assert.ok(data.readable && data.writable && !data.executable);
    assert.equal(data.virtualAddress % 0x1000, 0, 'on pages of its own');
    assert.equal(module.dataRva, data.virtualAddress);
    for (const name of ['_fmode', '_iob'])
    {
        const rva = /** @type {number} */ (module.addressOf(name)) - BASE;
        assert.ok(rva >= data.virtualAddress && rva < data.virtualAddress + data.virtualSize,
            `${name} is in .data`);
    }
    const exit = /** @type {number} */ (module.addressOf('exit')) - BASE;
    assert.ok(exit >= text.virtualAddress && exit < text.virtualAddress + text.virtualSize);
    assert.equal(synthesiseModule({ name: 'K.dll', base: BASE, exports: [
        { name: 'f', target: 0x2000 }] }).dataRva, 0, 'no variables, no data section');
});

test('a variable larger than a slot gets room of its own, outside the export directory', ()=>{
    // The runtime's standard streams are an array of twenty records: the
    // export's address is the first, and the other nineteen follow it.
    const streams = new Uint8Array(20 * 32).map((_, index)=>index & 0xff);
    const module = synthesiseModule({
        name: 'MSVCRT.dll',
        base: BASE,
        exports: [{ name: 'exit', target: 0x2000 }, { name: '_iob', data: streams },
            { name: '_small', data: new Uint8Array([1, 2, 3, 4]) }],
    });
    const decoded = decodeExports(module.bytes);
    const rva = decoded.functionRvas[decoded.nameOrdinals[decoded.names.indexOf('_iob')]];

    assert.equal(module.addressOf('_iob'), BASE + rva);
    assert.deepEqual(module.bytes.subarray(rva, rva + streams.length), streams);
    assert.equal(rva % 16, 0);
    assert.ok(rva >= decoded.directoryRva + decoded.directorySize,
        'past the directory, so it is not read as a forwarder');
    assert.ok(rva + streams.length <= module.size, 'and inside the image');
    const small = decoded.functionRvas[decoded.nameOrdinals[decoded.names.indexOf('_small')]];
    assert.deepEqual([...module.bytes.subarray(small, small + 4)], [1, 2, 3, 4],
        'a small one has room of its own too');
});

test('a function that is code of its own lies in the code section, on no variable\'s page', ()=>{
    // A write to a variable -- a stream's record, written from the host --
    // must not land on a page with code: a translator drops what it made of it.
    const body = Uint8Array.of(0x8b, 0x44, 0x24, 0x04, 0xc3);
    const long = new Uint8Array(0x1400).fill(0x90);
    const module = synthesiseModule({
        name: 'MSVCRT.dll',
        base: BASE,
        exports: [{ name: '_iob', data: new Uint8Array(20 * 32) }, { name: 'floor', code: body },
            { name: 'exit', target: 0x2000 }, { name: 'long', code: long },
            { name: '_fmode', data: new Uint8Array(4) }],
    });
    const image = parsePe(module.bytes);
    const [text, data] = image.sections;
    const decoded = decodeExports(module.bytes);
    for (const [name, bytes] of /** @type {[string, Uint8Array][]} */ ([['floor', body],
        ['long', long]]))
    {
        const rva = decoded.functionRvas[decoded.nameOrdinals[decoded.names.indexOf(name)]];
        assert.equal(module.addressOf(name), BASE + rva);
        assert.deepEqual(module.bytes.subarray(rva, rva + bytes.length), bytes, `${name}'s body`);
        assert.equal(rva % 16, 0);
        assert.ok(rva >= decoded.directoryRva + decoded.directorySize,
            `${name} past the directory, so it is not read as a forwarder`);
        assert.ok(rva + bytes.length <= text.virtualAddress + text.virtualSize,
            `${name} in .text, read-only and executable`);
        assert.ok(rva + bytes.length <= data.virtualAddress, 'below every variable\'s page');
    }
    assert.ok(text.executable && !text.writable);
    assert.ok(module.dataRva % 0x1000 === 0 && module.dataRva === data.virtualAddress);
    assert.throws(()=>synthesiseModule({ name: 'K.dll', base: BASE, exports: [
        { name: 'f', code: body, data: body }] }), /both code and a variable/);
});

test('a jump out of a function that is code of its own lands where it was aimed', ()=>{
    // cmp eax, 1; jne +5 (to ret); jmp <a stub>; ret -- the displacement left
    // for the loader, which alone knows where the code is placed.
    const body = Uint8Array.of(0x83, 0xf8, 0x01, 0x75, 0x05, 0xe9, 0, 0, 0, 0, 0xc3);
    for (const target of [0x2000, BASE + 0x10000, 0xfffff000])
    {
        const module = synthesiseModule({
            name: 'MSVCRT.dll',
            base: BASE,
            exports: [{ name: 'exit', target: 0x3000 },
                { name: 'strtol', code: body, jumps: [{ at: 6, target }] }],
        });
        const address = /** @type {number} */ (module.addressOf('strtol'));
        const rva = address - BASE;
        const view = new DataView(module.bytes.buffer);
        assert.equal(address + 10 + view.getInt32(rva + 6, true) >>> 0, target,
            `the jump lands at 0x${target.toString(16)}`);
        assert.deepEqual([...module.bytes.subarray(rva, rva + 6)], [...body.subarray(0, 6)]);
        assert.equal(module.bytes[rva + 10], 0xc3, 'the rest of the body as it was');
    }
});

test('a variable may hold other exports\' addresses, and be exported part way in', ()=>{
    // A vtable: the class's locator in the word before it, the export's
    // address at its first slot, the slots the addresses of the functions.
    const module = synthesiseModule({
        name: 'MSVCRT.dll',
        base: BASE,
        exports: [
            { name: 'what', target: 0x2000 },
            { name: 'locator', data: new Uint8Array(20) },
            { name: 'vtable', data: new Uint8Array(12), entry: 4,
                pointers: [{ at: 0, to: 'locator' }, { at: 4, to: 'what' },
                    { at: 8, to: 'vtable' }] },
        ],
    });
    const decoded = decodeExports(module.bytes);
    const vtable = /** @type {number} */ (module.addressOf('vtable'));
    const rva = decoded.functionRvas[decoded.nameOrdinals[decoded.names.indexOf('vtable')]];
    assert.equal(vtable, BASE + rva, 'the directory and addressOf agree on the entry');
    const view = new DataView(module.bytes.buffer);
    assert.equal(view.getUint32(rva - 4, true), module.addressOf('locator'));
    assert.equal(view.getUint32(rva, true), module.addressOf('what'));
    assert.equal(view.getUint32(rva + 4, true), vtable, 'a pointer to an entry is to the entry');
    const table = synthesiseModule({
        name: 'MSVCRT.dll',
        base: BASE,
        exports: [{ name: 'table', data: new Uint8Array(12),
            pointers: [{ at: 0, to: 'table', offset: 8 }] }],
    });
    assert.equal(new DataView(table.bytes.buffer).getUint32(
        /** @type {number} */ (table.addressOf('table')) - BASE, true),
    /** @type {number} */ (table.addressOf('table')) + 8, 'a pointer into an export');
    assert.throws(()=>synthesiseModule({
        name: 'MSVCRT.dll',
        base: BASE,
        exports: [{ name: 'vtable', data: new Uint8Array(4), pointers: [{ at: 0, to: 'none' }] }],
    }), /points at "none"/);
});

test('a program is an executable whose entry calls one routine and exits with its answer', ()=>{
    const program = synthesiseProgram({ library: 'bottlify.dll', routine: 'msiexec' });
    const image = parsePe(program.bytes);
    assert.equal(image.library, false, 'an executable, not a library');
    assert.equal(image.imageBase, 0x400000);
    assert.equal(image.subsystem, 2, 'a windowed program, as the system\'s own are');
    assert.ok(image.stackReserve >= 0x10000);
    assert.equal(image.sizeOfImage, program.bytes.length, 'the file is its own mapping');
    assert.deepEqual(readImports(program.bytes, image).map(dll=>[dll.dll,
        dll.entries.map(entry=>entry.name)]),
    [['bottlify.dll', ['msiexec']], ['KERNEL32.dll', ['ExitProcess']]]);
    const [routine, exit] = readImports(program.bytes, image).map(dll=>dll.entries[0].iatRva);
    const iat = image.directories[12];
    assert.ok(routine >= iat.address && exit + 4 <= iat.address + iat.size,
        'both address tables lie in the range the IAT directory names');
    const text = image.sections.find(section=>section.name === '.text');
    const data = image.sections.find(section=>section.name === '.data');
    assert.ok(text?.executable && !text.writable, 'the code is read-only');
    assert.ok(data?.writable && !data.executable, 'and what the loader binds is not code');

    // call [routine]; push eax; call [ExitProcess]
    const entry = rvaToFileOffset(image, image.entryPointRva);
    const view = new DataView(program.bytes.buffer);
    assert.deepEqual([...program.bytes.subarray(entry, entry + 2)], [0xff, 0x15]);
    assert.equal(view.getUint32(entry + 2, true), image.imageBase + routine);
    assert.equal(program.bytes[entry + 6], 0x50);
    assert.deepEqual([...program.bytes.subarray(entry + 7, entry + 9)], [0xff, 0x15]);
    assert.equal(view.getUint32(entry + 9, true), image.imageBase + exit);
    assert.throws(()=>synthesiseProgram({ library: '', routine: 'x' }), /ASCII/);
});
