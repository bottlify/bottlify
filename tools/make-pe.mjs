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
 * Usage: node tools/make-pe.mjs <output.exe> [hello|threads|qsort|window]
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
 * @param {Record<string, string[]>} options.imports  Functions called, by DLL.
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

    // One descriptor per DLL, each with its own lookup and address tables --
    // which is how a real program imports, and the only way to say that two
    // functions come from different libraries.
    const modules = Object.entries(imports).map(([dll, names])=>({ dll, names }));

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
    for (const module of modules)
    {
        for (const name of module.names)
        {
            cursor = (cursor + 1) & ~1;
            nameOffsets[name] = cursor;
            cursor += 2 + name.length + 1;
        }
        cursor = (cursor + 1) & ~1;
        module.dllNameOffset = cursor;
        cursor += module.dll.length + 1;
    }

    // Import lookup table and import address table: parallel arrays of RVAs.
    for (const module of modules)
    {
        cursor = (cursor + 3) & ~3;
        module.iltOffset = cursor;
        cursor += (module.names.length + 1) * 4;
        module.iatOffset = cursor;
        cursor += (module.names.length + 1) * 4;
    }
    cursor = (cursor + 3) & ~3;
    const descriptorOffset = cursor;
    cursor += (modules.length + 1) * 20; // one per DLL plus the null terminator
    const sectionSize = cursor;

    /** @param {string} name */
    const iatEntryVa = name=>{
        for (const module of modules)
        {
            const index = module.names.indexOf(name);
            if (index !== -1)
            {
                return va(module.iatOffset + index * 4);
            }
        }
        throw new Error(`${name} is called but not imported`);
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
    for (const module of modules)
    {
        for (const name of module.names)
        {
            text.pad(nameOffsets[name]).u16(0).ascii(name).u8(0);
        }
        text.pad(module.dllNameOffset).ascii(module.dll).u8(0);
    }

    for (const module of modules)
    {
        // The two tables are identical on disk; the loader overwrites the
        // address table in place while the lookup table keeps the names.
        for (const offset of [module.iltOffset, module.iatOffset])
        {
            text.pad(offset);
            for (const name of module.names)
            {
                text.u32(rva(nameOffsets[name]));
            }
            text.u32(0);
        }
    }

    text.pad(descriptorOffset);
    for (const module of modules)
    {
        text.u32(rva(module.iltOffset)).u32(0).u32(0)
            .u32(rva(module.dllNameOffset)).u32(rva(module.iatOffset));
    }
    text.u32(0).u32(0).u32(0).u32(0).u32(0);
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
    directories[1] = [rva(descriptorOffset), (modules.length + 1) * 20]; // import table
    // The IAT directory spans every module's address table; they were laid out
    // consecutively, so the first one's start and the last one's end bound it.
    const last = modules[modules.length - 1];
    directories[12] = [
        rva(modules[0].iatOffset),
        last.iatOffset + (last.names.length + 1) * 4 - modules[0].iatOffset,
    ];
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
        imports: { 'KERNEL32.dll': ['GetStdHandle', 'WriteFile', 'ExitProcess'] },
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

/** The message the windowed fixture answers, and what it reports having seen. */
export const WINDOW_PROBE = 0x0401; // WM_APP + 1

/**
 * A windowed program: it registers a class, makes a window, and runs a message
 * loop until it is told to quit.
 *
 * The interesting part is that its window procedure is its own code. Every
 * message it handles is a call from us into the guest and back, so this
 * exercises the whole path -- a host function that waits, a callback into guest
 * code, and a result that decides what the program does next.
 *
 * It answers the probe message by remembering wParam, and quits when told.
 *
 * @returns {Uint8Array}
 */
export function buildWindowExe(){
    // The window procedure sits at a fixed offset inside the code budget, so its
    // address is known before the body that registers it is emitted.
    const WNDPROC_OFFSET = 0x100;

    const WM_DESTROY = 0x0002;
    const WM_CLOSE = 0x0010;

    return buildExe({
        imports: {
            'USER32.dll': [
                'RegisterClassA', 'CreateWindowExA', 'GetMessageA',
                'TranslateMessage', 'DispatchMessageA', 'DefWindowProcA',
                'PostQuitMessage', 'DestroyWindow',
            ],
            'KERNEL32.dll': ['GetStdHandle', 'WriteFile', 'ExitProcess'],
        },
        codeSize: 0x200,
        data: {
            className: [...'BottlifyWindow'].map(c=>c.charCodeAt(0)).concat(0),
            title: [...'Probe'].map(c=>c.charCodeAt(0)).concat(0),
            wndclass: new Array(40).fill(0), //  WNDCLASSA
            msg: new Array(28).fill(0), //       MSG
            seen: [0, 0, 0, 0], //               what the procedure was told
            written: [0, 0, 0, 0],
        },
        code: ({ iat, at, code })=>{
            // Every forward branch is measured from the block it skips rather
            // than written down: a hand-counted displacement is right until the
            // block changes, and then it lands in the middle of an instruction.
            const setup = [
                // wndclass.lpfnWndProc = WndProc; wndclass.lpszClassName = className
                0xc7, 0x05, ...u32(at('wndclass') + 4), ...u32(code(WNDPROC_OFFSET)),
                0xc7, 0x05, ...u32(at('wndclass') + 36), ...u32(at('className')),

                // RegisterClassA(&wndclass)
                0x68, ...u32(at('wndclass')),
                0xff, 0x15, ...u32(iat('RegisterClassA')),

                // CreateWindowExA(0, className, title, 0, 0, 0, 320, 240, 0, 0, 0, 0)
                0x6a, 0x00, 0x6a, 0x00, 0x6a, 0x00, 0x6a, 0x00,
                0x68, ...u32(240), 0x68, ...u32(320),
                0x6a, 0x00, 0x6a, 0x00,
                0x6a, 0x00,
                0x68, ...u32(at('title')),
                0x68, ...u32(at('className')),
                0x6a, 0x00,
                0xff, 0x15, ...u32(iat('CreateWindowExA')),
            ];

            // The body of the message loop, after the test that leaves it.
            const pump = [
                0x68, ...u32(at('msg')),
                0xff, 0x15, ...u32(iat('TranslateMessage')),
                0x68, ...u32(at('msg')),
                0xff, 0x15, ...u32(iat('DispatchMessageA')),
            ];
            const fetch = [
                0x6a, 0x00, 0x6a, 0x00, 0x6a, 0x00,
                0x68, ...u32(at('msg')),
                0xff, 0x15, ...u32(iat('GetMessageA')),
                0x85, 0xc0, //                       test eax, eax
            ];
            // while (GetMessageA(&msg, 0, 0, 0)) { translate; dispatch; }
            const loop = [
                ...fetch,
                0x74, pump.length + 2, //            jz past the pump and its jump
                ...pump,
                0xeb, (256 - (fetch.length + 2 + pump.length + 2)) & 0xff, // jmp back
            ];

            const main = [
                ...setup,
                ...loop,

                // WriteFile(GetStdHandle(-11), &seen, 4, &written, NULL)
                0x6a, 0xf5,
                0xff, 0x15, ...u32(iat('GetStdHandle')),
                0x6a, 0x00,
                0x68, ...u32(at('written')),
                0x6a, 0x04,
                0x68, ...u32(at('seen')),
                0x50,
                0xff, 0x15, ...u32(iat('WriteFile')),

                0x6a, 0x00,
                0xff, 0x15, ...u32(iat('ExitProcess')),
            ];

            // LRESULT CALLBACK WndProc(HWND, UINT, WPARAM, LPARAM) -- stdcall,
            // so it pops its own sixteen bytes of arguments. Each arm is built
            // first and the branch over it measured from what it is skipping.
            const remember = [
                0x8b, 0x44, 0x24, 0x0c, //           mov eax, [esp+12]  (wParam)
                0xa3, ...u32(at('seen')), //         mov [seen], eax
                0x31, 0xc0, //                       xor eax, eax
                0xc2, 0x10, 0x00, //                 ret 16
            ];
            const close = [
                0xff, 0x74, 0x24, 0x04, //           push [esp+4]       (hWnd)
                0xff, 0x15, ...u32(iat('DestroyWindow')),
                0x31, 0xc0, //                       xor eax, eax
                0xc2, 0x10, 0x00, //                 ret 16
            ];
            const quit = [
                0x6a, 0x00, //                       push 0
                0xff, 0x15, ...u32(iat('PostQuitMessage')),
                0x31, 0xc0, //                       xor eax, eax
                0xc2, 0x10, 0x00, //                 ret 16
            ];
            const wndProc = [
                0x8b, 0x44, 0x24, 0x08, //           mov eax, [esp+8]   (uMsg)

                0x3d, ...u32(WINDOW_PROBE),
                0x75, remember.length, //            jne past this arm
                ...remember,

                0x3d, ...u32(WM_CLOSE),
                0x75, close.length,
                ...close,

                0x3d, ...u32(WM_DESTROY),
                0x75, quit.length,
                ...quit,

                // Anything else is the system's to answer: the same four
                // arguments, forwarded in place. Each push moves ESP down by
                // four, so the offset to the next one stays the same.
                0xff, 0x74, 0x24, 0x10, //           push [esp+16] (lParam)
                0xff, 0x74, 0x24, 0x10, //           push [esp+16] (wParam)
                0xff, 0x74, 0x24, 0x10, //           push [esp+16] (uMsg)
                0xff, 0x74, 0x24, 0x10, //           push [esp+16] (hWnd)
                0xff, 0x15, ...u32(iat('DefWindowProcA')),
                0xc2, 0x10, 0x00, //                 ret 16
            ];

            if (main.length > WNDPROC_OFFSET)
            {
                throw new Error('the body runs into the window procedure');
            }
            return [
                ...main,
                ...new Array(WNDPROC_OFFSET - main.length).fill(0xcc),
                ...wndProc,
            ];
        },
    });
}

/** The array the callback fixture sorts, and what it must become. */
export const QSORT_INPUT = [7, 3, 9, 1, 8, 2];

/**
 * A program that hands the C runtime a comparator of its own and lets it be
 * called back.
 *
 * `qsort` is the smallest honest test of a call in the other direction: the
 * ordering is decided by guest code, the host cannot proceed without it, and
 * it happens many times for one host call. The comparator is compiled as cdecl
 * -- it subtracts the two integers it is pointed at -- so a bridge that gets
 * the convention or the frame wrong sorts by nonsense rather than failing.
 *
 * @returns {Uint8Array}
 */
export function buildQsortExe(){
    // The comparator sits at a fixed offset inside the code budget, so its
    // address is known before the body that passes it is emitted.
    const COMPARE_OFFSET = 0x80;

    return buildExe({
        imports: {
            'msvcrt.dll': ['qsort'],
            'KERNEL32.dll': ['GetStdHandle', 'WriteFile', 'ExitProcess'],
        },
        codeSize: 0x100,
        data: {
            values: QSORT_INPUT.flatMap(value=>[value, 0, 0, 0]),
            written: [0, 0, 0, 0],
        },
        code: ({ iat, at, code })=>{
            const main = [
                // qsort(values, 6, 4, compare) -- cdecl, so the caller cleans up
                0x68, ...u32(code(COMPARE_OFFSET)), //   push compare
                0x6a, 0x04, //                           push 4  (element width)
                0x6a, QSORT_INPUT.length, //             push 6  (element count)
                0x68, ...u32(at('values')), //           push values
                0xff, 0x15, ...u32(iat('qsort')),
                0x83, 0xc4, 0x10, //                     add esp, 16

                // WriteFile(GetStdHandle(-11), values, 24, &written, NULL)
                0x6a, 0xf5,
                0xff, 0x15, ...u32(iat('GetStdHandle')),
                0x6a, 0x00,
                0x68, ...u32(at('written')),
                0x6a, QSORT_INPUT.length * 4,
                0x68, ...u32(at('values')),
                0x50,
                0xff, 0x15, ...u32(iat('WriteFile')),

                0x6a, 0x00,
                0xff, 0x15, ...u32(iat('ExitProcess')),
            ];

            const compare = [
                0x8b, 0x44, 0x24, 0x04, //               mov eax, [esp+4]   (a)
                0x8b, 0x4c, 0x24, 0x08, //               mov ecx, [esp+8]   (b)
                0x8b, 0x00, //                           mov eax, [eax]
                0x2b, 0x01, //                           sub eax, [ecx]
                0xc3, //                                 ret
            ];

            if (main.length > COMPARE_OFFSET)
            {
                throw new Error('the body runs into the comparator');
            }
            return [
                ...main,
                ...new Array(COMPARE_OFFSET - main.length).fill(0xcc),
                ...compare,
            ];
        },
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
    const imports = {
        'KERNEL32.dll': [
            'CreateMutexA', 'CreateEventA', 'CreateThread', 'WaitForSingleObject',
            'ReleaseMutex', 'SetEvent', 'ExitThread', 'GetStdHandle', 'WriteFile', 'ExitProcess',
        ],
    };

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
    /** @type {Record<string, () => Uint8Array>} */
    const kinds = {
        hello: buildHelloExe,
        threads: buildThreadsExe,
        qsort: buildQsortExe,
        window: buildWindowExe,
    };
    if (!(kind in kinds))
    {
        throw new Error(`unknown fixture "${kind}"; know ${Object.keys(kinds).join(', ')}`);
    }
    const image = kinds[kind]();
    await writeFile(output, image);
    console.log(`${output}: ${image.length} bytes (${kind})`);
}
