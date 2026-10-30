/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The gate of an image's TLS callbacks at the process's end and at
 * FreeLibrary, and of the thread-local storage of a library loaded at run
 * time.
 *
 * A TLS callback is called for every reason its image's entry point is, and
 * before it: DLL_PROCESS_DETACH too, with lpvReserved non-NULL when the
 * process ends (ExitProcess, or its last thread's end) and NULL at FreeLibrary,
 * as Wine's loader test expects of FreeLibrary (test_import_resolution). The
 * images are told of the process's end the last attached first, the program's
 * own callbacks last (decisions A50).
 *
 * A library loaded at run time is given what one the program imports is: a
 * slot written into its index dword, a copy of its block in every thread --
 * the one loading it, one made before the load and one made after -- and its
 * callbacks for every reason. FreeLibrary gives the slot back: the next
 * library loaded is given it.
 *
 * Every entry point and callback reports to log.dll, which appends the
 * thread, who reported, the reason and lpvReserved to a list the test reads
 * once the program has ended.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from './app.js';
import { assemble, buildExe } from '../../../tools/make-pe.mjs';

/** @param {number} value @returns {number[]} */
const u32 = value=>[
    value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff,
];

/** @param {string} text */
const cString = text=>[...text].map(c=>c.charCodeAt(0)).concat(0);

/** @typedef {import('../../../tools/make-pe.mjs').AsmPart} Part */

/** Who reported. */
const TAG = Object.freeze({
    EXE_TLS: 1, STATIC_TLS: 2, STATIC: 3, RUNTIME_TLS: 4, RUNTIME: 5, SECOND_TLS: 6, SECOND: 7,
});
const DLL_PROCESS_DETACH = 0;
const DLL_PROCESS_ATTACH = 1;
const DLL_THREAD_ATTACH = 2;
const DLL_THREAD_DETACH = 3;
/** Room in the list: every call either program makes, with some to spare. */
const ENTRIES = 32;

/** Where log.dll's list is, set when it is built. */
const where = { count: 0, entries: 0 };

/**
 * note(tag, reason, reserved), stdcall: appends { thread id, tag, reason,
 * reserved } to the list with a locked add, so that two threads reporting at
 * once each have an entry.
 */
function logLibrary(){
    return buildExe({
        dll: true,
        imageBase: 0x14000000,
        imports: { 'KERNEL32.dll': ['GetCurrentThreadId'] },
        codeSize: 0x60,
        data: { count: u32(0), entries: new Array(ENTRIES * 16).fill(0) },
        exports: [{ name: 'note', offset: 0x10 }],
        code: ({ iat, at })=>{
            where.count = at('count');
            where.entries = at('entries');
            const main = [0xb8, ...u32(1), 0xc2, 0x0c, 0x00]; // DllMain: TRUE
            const note = [
                0xff, 0x15, ...u32(iat('GetCurrentThreadId')),
                0xb9, ...u32(1), //                              mov ecx, 1
                0xf0, 0x0f, 0xc1, 0x0d, ...u32(at('count')), // lock xadd [count], ecx
                0x83, 0xf9, ENTRIES, //                          cmp ecx, ENTRIES
                0x73, 0x27, //                                   jae done
                0xc1, 0xe1, 0x04, //                             shl ecx, 4
                0x89, 0x81, ...u32(at('entries')), //            mov [entries+ecx], eax
                0x8b, 0x54, 0x24, 0x04, 0x89, 0x91, ...u32(at('entries') + 4), //  the tag
                0x8b, 0x54, 0x24, 0x08, 0x89, 0x91, ...u32(at('entries') + 8), //  the reason
                0x8b, 0x54, 0x24, 0x0c, 0x89, 0x91, ...u32(at('entries') + 12), // lpvReserved
                0xc2, 0x0c, 0x00, //                             done: ret 12
            ];
            return [...main, ...new Array(0x10 - main.length).fill(0xcc), ...note];
        },
    });
}

/**
 * Reports a call as `tag`: an entry point's or a TLS callback's three
 * arguments are on the stack above the return address.
 *
 * @param {(name: string) => number} iat @param {number} tag
 */
const report = (iat, tag)=>[
    0xff, 0x74, 0x24, 0x0c, //                 push dword [esp+12]  lpvReserved
    0xff, 0x74, 0x24, 0x0c, //                 push dword [esp+12]  fdwReason
    0x6a, tag,
    0xff, 0x15, ...u32(iat('note')),
];

/** @param {number[]} bytes @param {number} to */
const padTo = (bytes, to)=>{
    if (bytes.length > to)
    {
        throw new Error(`${bytes.length} bytes past ${to}`);
    }
    return [...bytes, ...new Array(to - bytes.length).fill(0xcc)];
};

/** The first dword of the run-time library's template. */
const MARK = 0x7e57d0d0;
/** What its index holds before a loader writes a slot there, as in Wine's test. */
const UNWRITTEN = 9999;
const CALLBACK_AT = 0x40;
const BLOCK_AT = 0x60;
const SLOT_AT = 0x70;

/**
 * A library whose DllMain and TLS callback report each call. With
 * `accessors` it exports block(), this thread's copy of its thread-local
 * block (the compiler's own fs:[0x2c] sequence), and slot(), its index.
 *
 * @param {{ imageBase: number, tag: number, tlsTag: number, marker: string,
 *     accessors?: boolean }} options
 */
function library({ imageBase, tag, tlsTag, marker, accessors }){
    return buildExe({
        dll: true,
        imageBase,
        imports: { 'log.dll': ['note'] },
        codeSize: 0x80,
        data: { template: [...u32(MARK), ...new Array(12).fill(0)], index: u32(UNWRITTEN) },
        exports: [
            { name: marker, offset: 0x80 },
            ...accessors ? [{ name: 'block', offset: BLOCK_AT }, { name: 'slot', offset: SLOT_AT }]
                : [],
        ],
        tls: { template: 'template', index: 'index', callbacks: [CALLBACK_AT] },
        code: ({ iat, at })=>{
            const main = [...report(iat, tag), 0xb8, ...u32(1), 0xc2, 0x0c, 0x00];
            const callback = [...report(iat, tlsTag), 0xc2, 0x0c, 0x00];
            const block = [
                0x8b, 0x0d, ...u32(at('index')), //            mov ecx, [_tls_index]
                0x64, 0xa1, ...u32(0x2c), //                    mov eax, fs:[0x2c]
                0x8b, 0x04, 0x88, //                            mov eax, [eax+ecx*4]
                0xc3,
            ];
            const slot = [0xa1, ...u32(at('index')), 0xc3]; // mov eax, [_tls_index]
            return [
                ...padTo(main, CALLBACK_AT),
                ...padTo(callback, BLOCK_AT - CALLBACK_AT),
                ...padTo(block, SLOT_AT - BLOCK_AT),
                ...slot,
            ];
        },
    });
}

/**
 * Runs `executable` with `libraries` beside it, on `cores` executors: its
 * exit code and log.dll's list.
 *
 * @param {Uint8Array} executable @param {Record<string, Uint8Array>} libraries
 * @param {number} cores
 */
async function run(executable, libraries, cores){
    const app = await createApp({
        executable,
        imagePath: 'C:\\App\\tls.exe',
        cpu: { cores, eager: true },
        files: Object.entries({ 'log.dll': logLibrary(), ...libraries })
            .map(([name, bytes])=>({ path: `C:\\App\\${name}`, bytes })),
    });
    try
    {
        const code = (await app.run({ timeoutMs: 60_000 })) >>> 0;
        const words = (/** @type {number} */ address, /** @type {number} */ count)=>{
            const bytes = app.debug.read(address, count * 4);
            const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
            return Array.from({ length: count }, (_, index)=>view.getUint32(index * 4, true));
        };
        const [count] = words(where.count, 1);
        assert.ok(count <= ENTRIES, `${count} calls, more than the list holds`);
        const flat = words(where.entries, count * 4);
        const entries = Array.from({ length: count }, (_, index)=>({
            index, thread: flat[index * 4], tag: flat[index * 4 + 1],
            reason: flat[index * 4 + 2], reserved: flat[index * 4 + 3],
        }));
        return { code, entries };
    }
    finally
    {
        await app.dispose();
    }
}

/** @param {{ tag: number, reason: number, reserved: number }} each */
const call = each=>`${each.tag}/${each.reason}/${each.reserved}`;

const EXE_CALLBACK_AT = 0x40;

/**
 * A program with a TLS callback that imports a library with one; it ends by
 * ExitProcess(3), or by returning 3 from its entry point, which ends its last
 * thread.
 *
 * @param {'ExitProcess' | 'return'} ending
 */
function staticProgram(ending){
    return buildExe({
        imports: {
            'KERNEL32.dll': ['ExitProcess'],
            'log.dll': ['note'],
            'static.dll': ['static'],
        },
        codeSize: 0x80,
        data: { template: u32(0), index: u32(0) },
        tls: { template: 'template', index: 'index', callbacks: [EXE_CALLBACK_AT] },
        code: ({ iat })=>[
            ...padTo(ending === 'ExitProcess'
                ? [0x6a, 0x03, 0xff, 0x15, ...u32(iat('ExitProcess'))]
                : [0xb8, ...u32(3), 0xc3], EXE_CALLBACK_AT),
            ...report(iat, TAG.EXE_TLS), 0xc2, 0x0c, 0x00,
        ],
    });
}

for (const ending of /** @type {const} */ (['ExitProcess', 'return']))
{
    test(`the TLS callbacks hear DLL_PROCESS_DETACH as the process ends by ${
        ending === 'return' ? 'its last thread returning' : 'ExitProcess'
    }, each image's before its entry point and the program's last`, { timeout: 120_000 }, async()=>{
        const { code, entries } = await run(staticProgram(ending), {
            'static.dll': library({ imageBase: 0x10000000, tag: TAG.STATIC,
                tlsTag: TAG.STATIC_TLS, marker: 'static' }),
        }, 1);
        const text = entries.map(each=>`${each.thread}:${call(each)}`).join(' ');
        assert.equal(code, 3, text);
        assert.equal(new Set(entries.map(each=>each.thread)).size, 1, `all on one thread: ${text}`);
        assert.deepEqual(entries.map(call), [
            `${TAG.EXE_TLS}/${DLL_PROCESS_ATTACH}/1`,
            `${TAG.STATIC_TLS}/${DLL_PROCESS_ATTACH}/1`,
            `${TAG.STATIC}/${DLL_PROCESS_ATTACH}/1`,
            `${TAG.STATIC_TLS}/${DLL_PROCESS_DETACH}/1`,
            `${TAG.STATIC}/${DLL_PROCESS_DETACH}/1`,
            `${TAG.EXE_TLS}/${DLL_PROCESS_DETACH}/1`,
        ], text);
    });
}

const EARLY_AT = 0x300;
const LATE_AT = 0x340;
const MAIN_MARK = 0x11110001;
const EARLY_MARK = 0x22220002;
const LATE_MARK = 0x33330003;

/**
 * What the program finds wrong, as bits of its exit code.
 */
const FAILED = Object.freeze({
    LOAD: 1, SLOT: 2, MAIN: 4, EARLY: 8, LATE: 16, SHARED: 32, OVERWRITTEN: 64,
    NOT_FREED: 128, NOT_GIVEN_BACK: 256,
});

/**
 * Starts a thread and waits until it is running; loads runtime.dll, reads its
 * slot and its own copy of the block, which it marks; lets the early thread
 * read and mark its copy and starts a late one that does the same; waits for
 * both, frees the library, checks the slot reads zero in its array, loads
 * second.dll and checks it was given the same slot, and ends by ExitProcess
 * with what failed.
 */
function runtimeProgram(){
    return buildExe({
        imports: {
            'KERNEL32.dll': ['CreateThread', 'CreateEventA', 'SetEvent', 'WaitForSingleObject',
                'LoadLibraryA', 'GetProcAddress', 'FreeLibrary', 'ExitProcess'],
            'log.dll': ['note'],
        },
        codeSize: 0x380,
        data: {
            library: cString('runtime.dll'), second: cString('second.dll'),
            blockName: cString('block'),
            slotName: cString('slot'),
            started: u32(0), go: u32(0), early: u32(0), late: u32(0), handle: u32(0),
            block: u32(0), slot: u32(0),
            mainBlock: u32(0), earlyBlock: u32(0), lateBlock: u32(0),
            mainSaw: u32(0), earlySaw: u32(0), lateSaw: u32(0),
        },
        code: ({ iat, at, code })=>{
            /** @param {string} name */
            const callApi = name=>[0xff, 0x15, ...u32(iat(name))];
            /** @param {string} name */
            const pushOf = name=>[0xff, 0x35, ...u32(at(name))];
            /** @param {string} name */
            const store = name=>[0xa3, ...u32(at(name))];
            /** @param {number} bit */
            const fail = bit=>[0x81, 0xcb, ...u32(bit)]; //  or ebx, bit
            // CreateEventA(NULL, TRUE, FALSE, NULL): manual reset, not signalled
            const event = [0x6a, 0x00, 0x6a, 0x00, 0x6a, 0x01, 0x6a, 0x00,
                ...callApi('CreateEventA')];
            /** @param {number} start */
            const begin = start=>[0x6a, 0x00, 0x6a, 0x00, 0x6a, 0x00,
                0x68, ...u32(code(start)), 0x6a, 0x00, 0x6a, 0x00, ...callApi('CreateThread')];
            /** @param {string} handle */
            const wait = handle=>[0x6a, 0xff, ...pushOf(handle), ...callApi('WaitForSingleObject')];
            /**
             * This thread's copy, kept at `kept`; what it held at `saw`, then `mark` in it.
             *
             * @param {string} kept @param {string} saw @param {number} mark
             */
            const readAndMark = (kept, saw, mark)=>[
                0xa1, ...u32(at('block')), 0xff, 0xd0, //    call [block]
                ...store(kept),
                0x85, 0xc0, 0x74, 0x0e, //                   test eax, eax; jz past
                0x8b, 0x08, 0x89, 0x0d, ...u32(at(saw)), //  mov ecx, [eax]; mov [saw], ecx
                0xc7, 0x00, ...u32(mark), //                 mov dword [eax], mark
            ];
            /**
             * A thread's copy was missing, or did not start as the template.
             *
             * @param {string} kept @param {string} saw @param {number} bit @param {string} label
             * @returns {Part[]}
             */
            const checkCopy = (kept, saw, bit, label)=>[
                0x83, 0x3d, ...u32(at(kept)), 0x00, //       cmp dword [kept], 0
                { jump: 'jz', to: `${label}-bad` },
                0x81, 0x3d, ...u32(at(saw)), ...u32(MARK), // cmp dword [saw], MARK
                { jump: 'jz', to: `${label}-good` },
                { label: `${label}-bad` }, ...fail(bit),
                { label: `${label}-good` },
            ];
            /**
             * @param {string} one @param {string} other @param {string} label
             * @returns {Part[]}
             */
            const distinct = (one, other, label)=>[
                0xa1, ...u32(at(one)), //                    mov eax, [one]
                0x3b, 0x05, ...u32(at(other)), //            cmp eax, [other]
                { jump: 'jnz', to: label }, ...fail(FAILED.SHARED), { label },
            ];
            const main = assemble([
                0x31, 0xdb, //                                          xor ebx, ebx
                ...event, ...store('started'), ...event, ...store('go'),
                ...begin(EARLY_AT), ...store('early'),
                ...wait('started'), //                                  it is running
                0x68, ...u32(at('library')), ...callApi('LoadLibraryA'), ...store('handle'),
                0x85, 0xc0, { jump: 'jnz', to: 'loaded' },
                ...fail(FAILED.LOAD), { jump: 'jmp', to: 'end' },
                { label: 'loaded' },
                0x68, ...u32(at('blockName')), 0x50, ...callApi('GetProcAddress'),
                ...store('block'),
                0x68, ...u32(at('slotName')), ...pushOf('handle'), ...callApi('GetProcAddress'),
                0xff, 0xd0, ...store('slot'), //                       call eax
                0x83, 0xf8, 0x40, { jump: 'jb', to: 'slot-good' }, //  cmp eax, 64
                ...fail(FAILED.SLOT), { jump: 'jmp', to: 'end' },
                { label: 'slot-good' },
                ...readAndMark('mainBlock', 'mainSaw', MAIN_MARK),
                ...pushOf('go'), ...callApi('SetEvent'),
                ...begin(LATE_AT), ...store('late'),
                ...wait('early'), ...wait('late'),
                ...checkCopy('mainBlock', 'mainSaw', FAILED.MAIN, 'main'),
                ...checkCopy('earlyBlock', 'earlySaw', FAILED.EARLY, 'early'),
                ...checkCopy('lateBlock', 'lateSaw', FAILED.LATE, 'late'),
                ...distinct('mainBlock', 'earlyBlock', 'main-early'),
                ...distinct('mainBlock', 'lateBlock', 'main-late'),
                ...distinct('earlyBlock', 'lateBlock', 'early-late'),
                0x8b, 0x0d, ...u32(at('mainBlock')), //                 mov ecx, [mainBlock]
                0x85, 0xc9, { jump: 'jz', to: 'kept' }, //              none: said already
                0x81, 0x39, ...u32(MAIN_MARK), //                       cmp dword [ecx], MAIN_MARK
                { jump: 'jz', to: 'kept' }, ...fail(FAILED.OVERWRITTEN), { label: 'kept' },
                ...pushOf('handle'), ...callApi('FreeLibrary'),
                0x8b, 0x0d, ...u32(at('slot')), //                      mov ecx, [slot]
                0x64, 0xa1, ...u32(0x2c), //                            mov eax, fs:[0x2c]
                0x83, 0x3c, 0x88, 0x00, //                              cmp dword [eax+ecx*4], 0
                { jump: 'jz', to: 'freed' }, ...fail(FAILED.NOT_FREED), { label: 'freed' },
                0x68, ...u32(at('second')), ...callApi('LoadLibraryA'),
                0x85, 0xc0, { jump: 'jz', to: 'again-bad' },
                0x68, ...u32(at('slotName')), 0x50, ...callApi('GetProcAddress'),
                0xff, 0xd0, 0x3b, 0x05, ...u32(at('slot')), //          call eax; cmp eax, [slot]
                { jump: 'jz', to: 'end' },
                { label: 'again-bad' }, ...fail(FAILED.NOT_GIVEN_BACK),
                { label: 'end' },
                0x53, ...callApi('ExitProcess'), //                     push ebx
            ]);
            const early = [
                ...pushOf('started'), ...callApi('SetEvent'),
                ...wait('go'),
                ...readAndMark('earlyBlock', 'earlySaw', EARLY_MARK),
                0x31, 0xc0, 0xc2, 0x04, 0x00, //                        return 0
            ];
            const late = [
                ...readAndMark('lateBlock', 'lateSaw', LATE_MARK),
                0x31, 0xc0, 0xc2, 0x04, 0x00,
            ];
            return [...padTo(main, EARLY_AT), ...padTo(early, LATE_AT - EARLY_AT), ...late];
        },
    });
}

for (const cores of [1, 2])
{
    test(`a library loaded at run time has a slot, every thread's copy of its block and its TLS`
        + ` callbacks, and FreeLibrary tells them and gives the slot back, on ${cores} executor${
            cores > 1 ? 's' : ''}`, { timeout: 120_000 }, async()=>{
        const { code, entries } = await run(runtimeProgram(), {
            'runtime.dll': library({ imageBase: 0x13000000, tag: TAG.RUNTIME,
                tlsTag: TAG.RUNTIME_TLS, marker: 'runtime', accessors: true }),
            'second.dll': library({ imageBase: 0x15000000, tag: TAG.SECOND,
                tlsTag: TAG.SECOND_TLS, marker: 'second', accessors: true }),
        }, cores);
        const text = entries.map(each=>`${each.thread}:${call(each)}`).join(' ');
        assert.equal(code, 0, `${Object.entries(FAILED).filter(([, bit])=>code & bit)
            .map(([what])=>what).join(', ')} (${code}): ${text}`);

        const main = entries[0].thread;
        const own = (/** @type {number} */ thread)=>entries.filter(each=>each.thread === thread);
        /**
         * @param {number} reason @param {number} reserved
         * @param {number[]} [tags]  The image's callback's and entry point's.
         */
        const told = (reason, reserved, tags = [TAG.RUNTIME_TLS, TAG.RUNTIME])=>
            tags.map(tag=>`${tag}/${reason}/${reserved}`);
        // Loaded and freed, then the second loaded and the process's end:
        // the callback before the entry point every time, lpvReserved NULL
        // but at the end.
        const second = [TAG.SECOND_TLS, TAG.SECOND];
        assert.deepEqual(own(main).map(call), [
            ...told(DLL_PROCESS_ATTACH, 0), ...told(DLL_PROCESS_DETACH, 0),
            ...told(DLL_PROCESS_ATTACH, 0, second), ...told(DLL_PROCESS_DETACH, 1, second),
        ], text);
        const workers = [...new Set(entries.map(each=>each.thread))]
            .filter(thread=>thread !== main);
        assert.equal(workers.length, 2, text);
        // The early thread started before the load: it is told of its end
        // only, as DllMain's documentation allows. The late one of both.
        const late = workers.find(thread=>own(thread)
            .some(each=>each.reason === DLL_THREAD_ATTACH)) ?? 0;
        const early = workers.find(thread=>thread !== late) ?? 0;
        assert.deepEqual(own(early).map(call), told(DLL_THREAD_DETACH, 0), `early: ${text}`);
        assert.deepEqual(own(late).map(call),
            [...told(DLL_THREAD_ATTACH, 0), ...told(DLL_THREAD_DETACH, 0)], `late: ${text}`);
        const freed = entries.findIndex(each=>each.thread === main
            && each.reason === DLL_PROCESS_DETACH);
        assert.ok(entries.every(each=>each.thread === main || each.index < freed),
            `both threads ended before FreeLibrary: ${text}`);
    });
}

/** What the crowded program finds wrong, as bits of its exit code. */
const CROWDED = Object.freeze({ LOAD: 1, INDEX: 2, BLOCK: 4, TEMPLATE: 8 });

/**
 * Takes TlsAlloc slots until one past the first 64 comes back, as a program
 * with many threads of its own does, then loads runtime.dll: it must load,
 * at the loader's own index -- 0, no other image holding thread-local
 * storage, whatever TlsAlloc has handed out -- and this thread's copy of its
 * block must be there through the compiler's fs:[0x2c] sequence, starting as
 * the template.
 */
function crowdedProgram(){
    return buildExe({
        imports: {
            'KERNEL32.dll': ['TlsAlloc', 'LoadLibraryA', 'GetProcAddress', 'ExitProcess'],
            'log.dll': ['note'],
        },
        codeSize: 0x100,
        data: { library: cString('runtime.dll'), blockName: cString('block'),
            slotName: cString('slot'), handle: u32(0) },
        code: ({ iat, at })=>{
            /** @param {string} name */
            const callApi = name=>[0xff, 0x15, ...u32(iat(name))];
            /** @param {number} bit */
            const fail = bit=>[0x81, 0xcb, ...u32(bit)]; //  or ebx, bit
            return assemble([
                0x31, 0xdb, //                                          xor ebx, ebx
                { label: 'take' },
                ...callApi('TlsAlloc'),
                0x83, 0xf8, 0x40, { jump: 'jb', to: 'take' }, //        cmp eax, 64; jb take
                0x68, ...u32(at('library')), ...callApi('LoadLibraryA'),
                0xa3, ...u32(at('handle')), //                          mov [handle], eax
                0x85, 0xc0, { jump: 'jnz', to: 'loaded' },
                ...fail(CROWDED.LOAD), { jump: 'jmp', to: 'end' },
                { label: 'loaded' },
                0x68, ...u32(at('slotName')), 0x50, ...callApi('GetProcAddress'),
                0xff, 0xd0, //                                          call eax
                0x85, 0xc0, { jump: 'jz', to: 'first' }, ...fail(CROWDED.INDEX),
                { label: 'first' },
                0x68, ...u32(at('blockName')), 0xff, 0x35, ...u32(at('handle')),
                ...callApi('GetProcAddress'),
                0xff, 0xd0, //                                          call eax
                0x85, 0xc0, { jump: 'jnz', to: 'block' },
                ...fail(CROWDED.BLOCK), { jump: 'jmp', to: 'end' },
                { label: 'block' },
                0x81, 0x38, ...u32(MARK), //                            cmp dword [eax], MARK
                { jump: 'jz', to: 'end' }, ...fail(CROWDED.TEMPLATE),
                { label: 'end' },
                0x53, ...callApi('ExitProcess'), //                     push ebx
            ]);
        },
    });
}

test('a library loaded at run time when the program holds the first 64 TlsAlloc slots loads'
    + ' at the loader\'s own index, reached through fs:[0x2c]', { timeout: 120_000 }, async()=>{
    // The Steam client's own libraries take more than 64 slots before it
    // loads one with thread-local storage of its own. The image's index is
    // the loader's numbering, not one of TlsAlloc's slots, so how many of
    // those are held does not move it.
    const { code, entries } = await run(crowdedProgram(), {
        'runtime.dll': library({ imageBase: 0x13000000, tag: TAG.RUNTIME,
            tlsTag: TAG.RUNTIME_TLS, marker: 'runtime', accessors: true }),
    }, 1);
    assert.equal(code, 0, Object.entries(CROWDED).filter(([, bit])=>code & bit)
        .map(([what])=>what).join(', '));
    assert.deepEqual(entries.slice(0, 2).map(call),
        [`${TAG.RUNTIME_TLS}/${DLL_PROCESS_ATTACH}/0`, `${TAG.RUNTIME}/${DLL_PROCESS_ATTACH}/0`]);
});
