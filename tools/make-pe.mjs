/*
 * Copyright © 2026 Bottlify Project
 * Licensed under BSD-2-Clause License
 * See LICENSE for details
 */

/**
 * Generates 32-bit console PE executables used as loader and scheduler fixtures.
 *
 * Written by hand rather than produced by a compiler for two reasons: no
 * toolchain is required to reproduce them, and the files stay small enough that
 * every byte is accounted for by this script. They are real PEs -- real Windows
 * runs them -- so they serve as contract tests rather than mocks: the same
 * binary must behave the same way under Windows and under Bottlify.
 *
 * Usage: node tools/make-pe.mjs <output.exe> [hello|threads]
 */

import { writeFile } from 'node:fs/promises';

const IMAGE_BASE = 0x400000;
const SECTION_RVA = 0x1000;
const FILE_ALIGNMENT = 0x200;
const SECTION_ALIGNMENT = 0x1000;
const HEADERS_SIZE = 0x200;

class Buf {
    constructor(){
        /** @type {number[]} */
        this.bytes = [];
    }
    get length(){
        return this.bytes.length;
    }
    /** @param {number[]} values */
    push(...values){
        this.bytes.push(...values);
        return this;
    }
    /** @param {number} value */
    u8(value){
        return this.push(value & 0xff);
    }
    /** @param {number} value */
    u16(value){
        return this.push(value & 0xff, (value >>> 8) & 0xff);
    }
    /** @param {number} value */
    u32(value){
        return this.push(
            value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
    }
    /** @param {string} text */
    ascii(text){
        return this.push(...[...text].map(c=>c.charCodeAt(0)));
    }
    /** @param {number} size */
    pad(size){
        while (this.bytes.length < size){
            this.bytes.push(0);
        }
        return this;
    }
}

/** @param {number} value @returns {number[]} */
const u32 = value=>[
    value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff,
];

/**
 * Builds an executable.
 *
 * Layout happens in two passes, because the code needs addresses that only
 * exist once the data is placed: reserve the code's budget, lay out data and
 * import tables after it, then ask the caller to emit the code with every
 * address resolved.
 *
 * @param {Object} options
 * @param {string[]} options.imports  KERNEL32 functions the program calls.
 * @param {Record<string, number[]>} [options.data]  Named blobs placed after the code.
 * @param {number} [options.codeSize]  Bytes reserved for the code.
 * @param {(ctx: {
 *   iat: (name: string) => number,
 *   at: (name: string) => number,
 *   code: (offset: number) => number,
 * }) => number[]} options.code
 * @returns {Uint8Array}
 */
export function buildExe({ imports, data = {}, codeSize = 0x40, code }){
    const text = new Buf();
    const rva = (/** @type {number} */ offset)=>SECTION_RVA + offset;
    const va = (/** @type {number} */ offset)=>IMAGE_BASE + rva(offset);

    let cursor = codeSize;

    /** @type {Record<string, number>} */
    const dataOffsets = {};
    for (const [name, bytes] of Object.entries(data))
    {
        cursor = (cursor + 3) & ~3; // dword-aligned: several of these are counters
        dataOffsets[name] = cursor;
        cursor += bytes.length;
    }

    // Import name blocks: WORD hint + zero-terminated name, WORD-aligned.
    /** @type {Record<string, number>} */
    const nameOffsets = {};
    for (const name of imports)
    {
        cursor = (cursor + 1) & ~1;
        nameOffsets[name] = cursor;
        cursor += 2 + name.length + 1;
    }
    cursor = (cursor + 1) & ~1;
    const dllNameOffset = cursor;
    cursor += 'KERNEL32.dll'.length + 1;

    // Import lookup table and import address table: parallel arrays of RVAs.
    cursor = (cursor + 3) & ~3;
    const iltOffset = cursor;
    cursor += (imports.length + 1) * 4;
    const iatOffset = cursor;
    cursor += (imports.length + 1) * 4;
    const descriptorOffset = cursor;
    cursor += 2 * 20; // one descriptor plus the null terminator
    const sectionSize = cursor;

    /** @param {string} name */
    const iatEntryVa = name=>{
        const index = imports.indexOf(name);
        if (index === -1)
        {
            throw new Error(`${name} is called but not imported`);
        }
        return va(iatOffset + index * 4);
    };

    // --- code ---
    text.push(...code({
        iat: iatEntryVa,
        at: name=>{
            if (!(name in dataOffsets))
            {
                throw new Error(`no data named "${name}"`);
            }
            return va(dataOffsets[name]);
        },
        code: offset=>va(offset),
    }));
    if (text.length > codeSize)
    {
        throw new Error(`code is ${text.length} bytes, past its ${codeSize}-byte budget`);
    }
    text.pad(codeSize);

    // --- data ---
    for (const [name, bytes] of Object.entries(data))
    {
        text.pad(dataOffsets[name]).push(...bytes);
    }
    for (const name of imports)
    {
        text.pad(nameOffsets[name]).u16(0).ascii(name).u8(0);
    }
    text.pad(dllNameOffset).ascii('KERNEL32.dll').u8(0);

    text.pad(iltOffset);
    for (const name of imports)
    {
        text.u32(rva(nameOffsets[name]));
    }
    text.u32(0);
    for (const name of imports)
    {
        text.u32(rva(nameOffsets[name]));
    }
    text.u32(0);

    text.pad(descriptorOffset);
    text.u32(rva(iltOffset)).u32(0).u32(0).u32(rva(dllNameOffset)).u32(rva(iatOffset));
    text.pad(sectionSize);

    const rawSize = Math.ceil(sectionSize / FILE_ALIGNMENT) * FILE_ALIGNMENT;
    const sizeOfImage =
        SECTION_RVA + Math.ceil(sectionSize / SECTION_ALIGNMENT) * SECTION_ALIGNMENT;

    // --- headers ---
    const head = new Buf();
    head.ascii('MZ').pad(0x3c).u32(0x40); // DOS header; e_lfanew -> PE header at 0x40
    head.pad(0x40).ascii('PE').u8(0).u8(0);

    // COFF header
    head.u16(0x014c); // i386
    head.u16(1); // one section
    head.u32(0); // timestamp
    head.u32(0).u32(0); // no symbol table
    head.u16(0xe0); // size of optional header
    head.u16(0x0102); // EXECUTABLE_IMAGE | 32BIT_MACHINE

    // Optional header (PE32)
    head.u16(0x010b);
    head.u8(0).u8(0); // linker version
    head.u32(rawSize).u32(0).u32(0); // sizes of code / initialized / uninitialized data
    head.u32(SECTION_RVA); // AddressOfEntryPoint
    head.u32(SECTION_RVA).u32(0); // BaseOfCode / BaseOfData
    head.u32(IMAGE_BASE);
    head.u32(SECTION_ALIGNMENT).u32(FILE_ALIGNMENT);
    head.u16(4).u16(0); // OS version
    head.u16(0).u16(0); // image version
    head.u16(4).u16(0); // subsystem version
    head.u32(0); // win32 version
    head.u32(sizeOfImage).u32(HEADERS_SIZE);
    head.u32(0); // checksum
    head.u16(3); // subsystem: console
    head.u16(0); // dll characteristics
    head.u32(0x100000).u32(0x1000); // stack reserve / commit
    head.u32(0x100000).u32(0x1000); // heap reserve / commit
    head.u32(0).u32(16); // loader flags, number of data directories

    const directories = new Array(16).fill(null).map(()=>[0, 0]);
    directories[1] = [rva(descriptorOffset), 40]; // import table
    directories[12] = [rva(iatOffset), (imports.length + 1) * 4]; // IAT
    for (const [address, size] of directories)
    {
        head.u32(address).u32(size);
    }

    // Section header: one section holding code, data and the import tables.
    head.ascii('.text').pad(head.length + 3); // name padded to 8 bytes
    head.u32(sectionSize).u32(SECTION_RVA).u32(rawSize).u32(HEADERS_SIZE);
    head.u32(0).u32(0).u16(0).u16(0);
    head.u32(0xe0000020); // CODE | EXECUTE | READ | WRITE
    head.pad(HEADERS_SIZE);

    return new Uint8Array([
        ...head.bytes, ...text.bytes, ...new Array(rawSize - sectionSize).fill(0),
    ]);
}

/**
 * Writes a line to stdout and exits. The loader fixture.
 *
 * @param {string} [message]
 * @returns {Uint8Array}
 */
export function buildHelloExe(message = 'Hello from Bottlify\r\n'){
    return buildExe({
        imports: ['GetStdHandle', 'WriteFile', 'ExitProcess'],
        data: {
            message: [...message].map(c=>c.charCodeAt(0)),
            written: [0, 0, 0, 0], // WriteFile's out-parameter
        },
        code: ({ iat, at })=>[
            0x6a, 0xf5, //                       push -11 (STD_OUTPUT_HANDLE)
            0xff, 0x15, ...u32(iat('GetStdHandle')),
            0x6a, 0x00, //                       push 0            (lpOverlapped)
            0x68, ...u32(at('written')), //      push &written
            0x6a, message.length & 0xff, //      push len
            0x68, ...u32(at('message')), //      push message
            0x50, //                             push eax          (the handle)
            0xff, 0x15, ...u32(iat('WriteFile')),
            0x6a, 0x00, //                       push 0            (uExitCode)
            0xff, 0x15, ...u32(iat('ExitProcess')),
        ],
    });
}

/** How many times each worker increments the shared counter. */
export const THREAD_ITERATIONS = 100;

/** How many workers the threaded fixture starts. */
export const THREAD_WORKERS = 2;

/**
 * Two worker threads incrementing one counter under a mutex, while the main
 * thread waits for both and reports the total.
 *
 * The result is deterministic by construction: whatever order the workers run
 * in, and wherever they are preempted, the counter must end at exactly
 * workers x iterations. A scheduler that loses an increment, resumes a thread
 * onto the wrong state, or lets both into the critical section produces a
 * different number -- and the number says how badly.
 *
 * @returns {Uint8Array}
 */
export function buildThreadsExe(){
    const imports = [
        'CreateMutexA', 'CreateEventA', 'CreateThread', 'WaitForSingleObject',
        'ReleaseMutex', 'SetEvent', 'ExitThread', 'GetStdHandle', 'WriteFile', 'ExitProcess',
    ];

    // The worker body sits at a fixed offset inside the code budget, so its
    // address is known before the main body that starts it is emitted.
    const WORKER_OFFSET = 0x100;

    return buildExe({
        imports,
        codeSize: 0x200,
        data: {
            counter: [0, 0, 0, 0],
            mutex: [0, 0, 0, 0],
            doneA: [0, 0, 0, 0],
            doneB: [0, 0, 0, 0],
            written: [0, 0, 0, 0],
        },
        code: ({ iat, at, code })=>{
            const main = [
                // mutex = CreateMutexA(NULL, FALSE, NULL)
                0x6a, 0x00, 0x6a, 0x00, 0x6a, 0x00,
                0xff, 0x15, ...u32(iat('CreateMutexA')),
                0xa3, ...u32(at('mutex')), //            mov [mutex], eax

                // doneA = CreateEventA(NULL, TRUE, FALSE, NULL) -- manual reset
                0x6a, 0x00, 0x6a, 0x00, 0x6a, 0x01, 0x6a, 0x00,
                0xff, 0x15, ...u32(iat('CreateEventA')),
                0xa3, ...u32(at('doneA')),

                // doneB = CreateEventA(NULL, TRUE, FALSE, NULL)
                0x6a, 0x00, 0x6a, 0x00, 0x6a, 0x01, 0x6a, 0x00,
                0xff, 0x15, ...u32(iat('CreateEventA')),
                0xa3, ...u32(at('doneB')),

                // CreateThread(NULL, 0, worker, doneA, 0, NULL)
                0x6a, 0x00, 0x6a, 0x00,
                0x68, ...u32(at('doneA')), //            push &doneA (the worker's event)
                0x68, ...u32(code(WORKER_OFFSET)), //    push worker
                0x6a, 0x00, 0x6a, 0x00,
                0xff, 0x15, ...u32(iat('CreateThread')),

                // CreateThread(NULL, 0, worker, doneB, 0, NULL)
                0x6a, 0x00, 0x6a, 0x00,
                0x68, ...u32(at('doneB')),
                0x68, ...u32(code(WORKER_OFFSET)),
                0x6a, 0x00, 0x6a, 0x00,
                0xff, 0x15, ...u32(iat('CreateThread')),

                // WaitForSingleObject(doneA, INFINITE)
                0x6a, 0xff, //                           push -1 (INFINITE)
                0xff, 0x35, ...u32(at('doneA')), //      push [doneA]
                0xff, 0x15, ...u32(iat('WaitForSingleObject')),

                // WaitForSingleObject(doneB, INFINITE)
                0x6a, 0xff,
                0xff, 0x35, ...u32(at('doneB')),
                0xff, 0x15, ...u32(iat('WaitForSingleObject')),

                // WriteFile(GetStdHandle(-11), &counter, 4, &written, NULL)
                0x6a, 0xf5,
                0xff, 0x15, ...u32(iat('GetStdHandle')),
                0x6a, 0x00,
                0x68, ...u32(at('written')),
                0x6a, 0x04,
                0x68, ...u32(at('counter')),
                0x50,
                0xff, 0x15, ...u32(iat('WriteFile')),

                0x6a, 0x00,
                0xff, 0x15, ...u32(iat('ExitProcess')),
            ];

            if (main.length > WORKER_OFFSET)

            {
                throw new Error(`main body is ${main.length} bytes, past the worker at 0x100`);
            }

            // worker(event): loop { lock; counter++; unlock } then signal and exit.
            // ESI holds the event pointer, EDI the remaining iterations, so
            // neither is disturbed by the calls in between.
            // One pass through the critical section, without the branch that
            // closes the loop -- so the branch displacement is computed from the
            // real length instead of being a constant that quietly rots.
            const loopBody = [
                0x6a, 0xff, //                           push -1 (INFINITE)
                0xff, 0x35, ...u32(at('mutex')), //      push [mutex]
                0xff, 0x15, ...u32(iat('WaitForSingleObject')),
                0xff, 0x05, ...u32(at('counter')), //    inc dword [counter]
                0xff, 0x35, ...u32(at('mutex')),
                0xff, 0x15, ...u32(iat('ReleaseMutex')),
                0x4f, //                                 dec edi
            ];
            const back = -(loopBody.length + 2); // the jnz itself is two bytes
            if (back < -128)
            {
                throw new Error(`loop body is ${loopBody.length} bytes, too far for a short jump`);
            }

            const worker = [
                0x8b, 0x74, 0x24, 0x04, //               mov esi, [esp+4]   (the event slot)
                0xbf, ...u32(THREAD_ITERATIONS), //      mov edi, iterations
                ...loopBody,
                0x75, back & 0xff, //                    jnz loop
            ];

            worker.push(
                0xff, 0x36, //                           push [esi]        (the event handle)
                0xff, 0x15, ...u32(iat('SetEvent')),
                0x6a, 0x00, //                           push 0
                0xff, 0x15, ...u32(iat('ExitThread')),
            );

            const image = [...main];
            while (image.length < WORKER_OFFSET){
                image.push(0xcc); // int3: nothing should ever run in the gap
            }
            image.push(...worker);
            return image;
        },
    });
}

const [, , output, kind = 'hello'] = process.argv;
if (output)
{
    const image = kind === 'threads' ? buildThreadsExe() : buildHelloExe();
    await writeFile(output, image);
    console.log(`${output}: ${image.length} bytes (${kind})`);
}
