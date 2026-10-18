/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The gate of what the libraries are told of a thread: every thread made by
 * CreateThread calls each image's TLS callbacks and each library's DllMain
 * with DLL_THREAD_ATTACH, in load order, on itself and before its start
 * routine, and with DLL_THREAD_DETACH the other way round when it returns or
 * calls ExitThread; a library that called DisableThreadLibraryCalls hears of
 * no thread, unless it has static thread-local storage; a library loaded at
 * run time is told of the threads made after it. One thread's calls are made
 * together, under the loader lock, with others starting beside it.
 *
 * Every entry point and callback reports to log.dll, which appends the
 * thread, who reported, the reason and lpvReserved to a list the test reads
 * once the program has ended.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from './app.js';
import { writeBundle } from './bundle-node.js';
import { buildExe } from '../../../tools/make-pe.mjs';

/** @param {number} value @returns {number[]} */
const u32 = value=>[
    value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff,
];

/** @param {string} text */
const cString = text=>[...text].map(c=>c.charCodeAt(0)).concat(0);

/** Who reported: each image's entry point or TLS callback, and a start routine. */
const TAG = Object.freeze({
    EXE_TLS: 1, TOLD: 2, QUIET: 3, TLS_QUIET_TLS: 4, TLS_QUIET: 5, LATE: 6, ROUTINE: 7,
});
/** What a start routine reports as its reason, to place itself among the calls. */
const RAN = 0x100;
const DLL_PROCESS_ATTACH = 1;
const DLL_THREAD_ATTACH = 2;
const DLL_THREAD_DETACH = 3;
/** Threads that return from their routine, all started before any is waited for. */
const RETURNERS = 4;
/** Room in the list: every call this program makes, with some to spare. */
const ENTRIES = 96;

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

/** Where an image's TLS callback is in its code. */
const CALLBACK_AT = 0x40;

/**
 * A library whose DllMain -- and TLS callback, with `tlsTag` -- reports each
 * call; with `quiet` it calls DisableThreadLibraryCalls on its process attach.
 *
 * @param {{ imageBase: number, tag: number, marker: string, tlsTag?: number,
 *     quiet?: boolean }} options
 */
function library({ imageBase, tag, marker, tlsTag, quiet }){
    return buildExe({
        dll: true,
        imageBase,
        imports: {
            'log.dll': ['note'],
            ...quiet ? { 'KERNEL32.dll': ['DisableThreadLibraryCalls'] } : {},
        },
        codeSize: 0x80,
        data: {
            [marker]: u32(0),
            ...tlsTag ? { template: u32(0x7e57), index: u32(0) } : {},
        },
        exports: [{ name: marker, offset: 0x80 }],
        ...tlsTag
            ? { tls: { template: 'template', index: 'index', callbacks: [CALLBACK_AT] } }
            : {},
        code: ({ iat })=>{
            const main = [
                ...report(iat, tag),
                ...quiet ? [
                    0x83, 0x7c, 0x24, 0x08, DLL_PROCESS_ATTACH, // cmp dword [esp+8], 1
                    0x75, 0x0a, //                                  jne past
                    0xff, 0x74, 0x24, 0x04, //                      push dword [esp+4]  hinstDLL
                    0xff, 0x15, ...u32(iat('DisableThreadLibraryCalls')),
                ] : [],
                0xb8, ...u32(1), 0xc2, 0x0c, 0x00, //               TRUE
            ];
            const callback = tlsTag ? [...report(iat, tlsTag), 0xc2, 0x0c, 0x00] : [];
            return [...main, ...new Array(CALLBACK_AT - main.length).fill(0xcc), ...callback];
        },
    });
}

const RETURNER_AT = 0x100;
const EXITER_AT = 0x140;
const EXE_CALLBACK_AT = 0x180;

/**
 * The program: a TLS callback that reports; RETURNERS threads started at once
 * and waited for together, each reporting and returning; then late.dll
 * loaded, and one more thread that reports and calls ExitThread.
 */
function program(){
    return buildExe({
        imports: {
            'KERNEL32.dll': ['CreateThread', 'WaitForMultipleObjects', 'WaitForSingleObject',
                'ExitThread', 'ExitProcess', 'LoadLibraryA'],
            'log.dll': ['note'],
            'told.dll': ['told'],
            'quiet.dll': ['quiet'],
            'tlsquiet.dll': ['tlsquiet'],
        },
        codeSize: 0x200,
        data: {
            template: u32(0x7e57), index: u32(0),
            handles: new Array(RETURNERS * 4).fill(0), handle: u32(0),
            late: cString('late.dll'),
        },
        tls: { template: 'template', index: 'index', callbacks: [EXE_CALLBACK_AT] },
        code: ({ iat, at, code })=>{
            /** @param {string} name */
            const call = name=>[0xff, 0x15, ...u32(iat(name))];
            /** CreateThread(NULL, 0, start, param, 0, NULL) @param {number} start @param {number} param */
            const begin = (start, param)=>[0x6a, 0x00, 0x6a, 0x00, 0x6a, param,
                0x68, ...u32(code(start)), 0x6a, 0x00, 0x6a, 0x00, ...call('CreateThread')];
            const main = [
                ...Array.from({ length: RETURNERS }, (_, index)=>[
                    ...begin(RETURNER_AT, index), 0xa3, ...u32(at('handles') + index * 4),
                ]).flat(),
                0x6a, 0xff, 0x6a, 0x01, 0x68, ...u32(at('handles')), 0x6a, RETURNERS,
                ...call('WaitForMultipleObjects'), //       all of them, INFINITE
                0x68, ...u32(at('late')), ...call('LoadLibraryA'),
                ...begin(EXITER_AT, 0), 0xa3, ...u32(at('handle')),
                0x6a, 0xff, 0xff, 0x35, ...u32(at('handle')), ...call('WaitForSingleObject'),
                0x6a, 0x00, ...call('ExitProcess'),
            ];
            /** The routine says it is running, as a reason no loader passes. */
            const ran = [0x6a, 0x00, 0x68, ...u32(RAN), 0x6a, TAG.ROUTINE, ...call('note')];
            const returner = [...ran, 0xb8, ...u32(7), 0xc2, 0x04, 0x00];
            const exiter = [...ran, 0x6a, 0x09, ...call('ExitThread')];
            const callback = [
                ...report(iat, TAG.EXE_TLS), 0xc2, 0x0c, 0x00,
            ];
            /** @param {number[]} bytes @param {number} to */
            const padTo = (bytes, to)=>{
                if (bytes.length > to)
                {
                    throw new Error(`${bytes.length} bytes past ${to}`);
                }
                return [...bytes, ...new Array(to - bytes.length).fill(0xcc)];
            };
            return [
                ...padTo(main, RETURNER_AT),
                ...padTo(returner, EXITER_AT - RETURNER_AT),
                ...padTo(exiter, EXE_CALLBACK_AT - EXITER_AT),
                ...callback,
            ];
        },
    });
}

/**
 * Runs `executable` from a bundle holding the libraries, on `cores`
 * executors: its exit code and log.dll's list.
 *
 * @param {Uint8Array} executable @param {number} cores
 */
async function run(executable, cores){
    const libraries = {
        'log.dll': logLibrary(),
        'told.dll': library({ imageBase: 0x10000000, tag: TAG.TOLD, marker: 'told' }),
        'quiet.dll': library({ imageBase: 0x11000000, tag: TAG.QUIET, marker: 'quiet',
            quiet: true }),
        'tlsquiet.dll': library({ imageBase: 0x12000000, tag: TAG.TLS_QUIET, marker: 'tlsquiet',
            tlsTag: TAG.TLS_QUIET_TLS, quiet: true }),
        'late.dll': library({ imageBase: 0x13000000, tag: TAG.LATE, marker: 'late' }),
    };
    const root = await mkdtemp(join(tmpdir(), 'attach-src-'));
    const out = await mkdtemp(join(tmpdir(), 'attach-out-'));
    for (const [name, bytes] of Object.entries(libraries))
    {
        await writeFile(join(root, name), bytes);
    }
    const path = join(out, 'bundle.btl');
    await writeBundle({ root, output: path, blockSize: 4096 });
    const handle = await open(path, 'r');
    const app = await createApp({
        executable,
        imagePath: 'C:\\App\\attach.exe',
        cpu: { cores, eager: true },
        bundle: {
            prefix: 'App',
            fetch: async(/** @type {number} */ offset, /** @type {number} */ length)=>{
                const buffer = Buffer.alloc(length);
                await handle.read(buffer, 0, length, offset);
                return new Uint8Array(buffer);
            },
        },
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
        await handle.close();
        await rm(root, { recursive: true, force: true });
        await rm(out, { recursive: true, force: true });
    }
}

/** The image each tag belongs to: a TLS callback and an entry point are one image's. */
const imageOf = (/** @type {number} */ tag)=>(tag === TAG.TLS_QUIET_TLS ? TAG.TLS_QUIET : tag);

/**
 * The detach order for an attach order: the images the other way round, each
 * one's own calls as they were.
 *
 * @param {number[]} attach
 */
const detachOrder = attach=>{
    /** @type {number[][]} */
    const images = [];
    for (const tag of attach)
    {
        const last = images.at(-1);
        if (last && imageOf(last[0]) === imageOf(tag))
        {
            last.push(tag);
        }
        else
        {
            images.push([tag]);
        }
    }
    return images.reverse().flat();
};

for (const cores of [1, 2])
{
    test(`each library is told of a thread's start and end, on it, in load order, on ${
        cores} executor${cores > 1 ? 's' : ''}`, { timeout: 120_000 }, async()=>{
        const { code, entries } = await run(program(), cores);
        assert.equal(code, 0);
        const text = entries.map(each=>`${each.thread}:${each.tag}/${each.reason}/${each.reserved}`)
            .join(' ');

        // The process's first thread attaches what the program imports, the
        // program's own TLS callback first, statically (lpvReserved non-NULL).
        const main = entries[0].thread;
        const statics = entries.filter(each=>each.reason === DLL_PROCESS_ATTACH
            && each.reserved !== 0);
        assert.ok(statics.every(each=>each.thread === main), text);
        const loadOrder = statics.map(each=>each.tag);
        assert.equal(loadOrder[0], TAG.EXE_TLS, text);
        assert.deepEqual([...loadOrder].sort(), [TAG.EXE_TLS, TAG.TOLD, TAG.QUIET,
            TAG.TLS_QUIET_TLS, TAG.TLS_QUIET].sort(), text);
        assert.equal(loadOrder.indexOf(TAG.TLS_QUIET) - loadOrder.indexOf(TAG.TLS_QUIET_TLS), 1,
            `an image's TLS callback just before its entry point: ${text}`);
        assert.ok(entries.some(each=>each.tag === TAG.LATE && each.reason === DLL_PROCESS_ATTACH
            && each.reserved === 0 && each.thread === main),
        `late.dll loaded at run time: ${text}`);
        assert.ok(!entries.some(each=>each.thread === main
            && (each.reason === DLL_THREAD_ATTACH || each.reason === DLL_THREAD_DETACH)),
        `the first thread is told of no thread: ${text}`);

        // quiet.dll disabled its thread calls; tlsquiet.dll asked the same,
        // but has static thread-local storage and is still told.
        const told = loadOrder.filter(tag=>tag !== TAG.QUIET);
        const threads = [...new Set(entries.map(each=>each.thread))].filter(id=>id !== main);
        // Where each call the loader made falls among the loader's calls
        // alone: a start routine runs outside the loader lock, so another
        // thread's may report in the middle of one thread's attach or detach.
        const lockedAt = new Map(entries.filter(each=>each.reason !== RAN)
            .map((each, position)=>[each.index, position]));
        assert.equal(threads.length, RETURNERS + 1, text);
        threads.forEach((thread, number)=>{
            const own = entries.filter(each=>each.thread === thread);
            // Every thread but the last was made before late.dll was loaded.
            const attach = number < RETURNERS ? told : [...told, TAG.LATE];
            const expected = [
                ...attach.map(tag=>`${tag}/${DLL_THREAD_ATTACH}/0`),
                `${TAG.ROUTINE}/${RAN}/0`,
                ...detachOrder(attach).map(tag=>`${tag}/${DLL_THREAD_DETACH}/0`),
            ];
            assert.deepEqual(own.map(each=>`${each.tag}/${each.reason}/${each.reserved}`), expected,
                `thread ${thread}: ${text}`);
            // Made together, under the loader lock: no other thread's call to
            // a library among one thread's attach or detach.
            for (const reason of [DLL_THREAD_ATTACH, DLL_THREAD_DETACH])
            {
                const at = own.filter(each=>each.reason === reason)
                    .map(each=>/** @type {number} */ (lockedAt.get(each.index)));
                assert.equal((at.at(-1) ?? 0) - at[0], at.length - 1,
                    `thread ${thread}'s ${reason === DLL_THREAD_ATTACH ? 'attach' : 'detach'}`
                    + ` interleaved with another's: ${text}`);
            }
        });
    });
}

/** What each of the two workers of `lastProgram` returns. */
const WORKER_CODES = [11, 12];

/**
 * The first thread starts two workers and calls ExitThread at once; each
 * worker sleeps and returns its parameter.
 */
function lastProgram(){
    return buildExe({
        imports: {
            'KERNEL32.dll': ['CreateThread', 'ExitThread', 'Sleep'],
            'told.dll': ['told'],
        },
        codeSize: 0x100,
        data: {},
        code: ({ iat, code })=>{
            /** @param {string} name */
            const call = name=>[0xff, 0x15, ...u32(iat(name))];
            const main = [
                ...WORKER_CODES.map(param=>[0x6a, 0x00, 0x6a, 0x00, 0x6a, param,
                    0x68, ...u32(code(0x80)), 0x6a, 0x00, 0x6a, 0x00,
                    ...call('CreateThread')]).flat(),
                0x6a, 0x00, ...call('ExitThread'),
            ];
            const worker = [
                0x6a, 0x64, ...call('Sleep'), //                Sleep(100)
                0x8b, 0x44, 0x24, 0x04, //                      mov eax, [esp+4]
                0xc2, 0x04, 0x00,
            ];
            return [...main, ...new Array(0x80 - main.length).fill(0xcc), ...worker];
        },
    });
}

for (const cores of [1, 2])
{
    test(`a thread that is not the last is told its detach, and the last ends the process, on ${
        cores} executor${cores > 1 ? 's' : ''}`, { timeout: 120_000 }, async()=>{
        const { code, entries } = await run(lastProgram(), cores);
        const text = entries.map(each=>`${each.thread}:${each.tag}/${each.reason}/${each.reserved}`)
            .join(' ');
        assert.ok(WORKER_CODES.includes(code), `the last worker's code, not ${code}: ${text}`);
        const main = entries[0].thread;
        // The first thread was never told of its own attach, and is told of
        // its detach: the workers outlive it.
        assert.deepEqual(entries.filter(each=>each.thread === main)
            .map(each=>`${each.tag}/${each.reason}/${each.reserved}`),
        [`${TAG.TOLD}/${DLL_PROCESS_ATTACH}/1`, `${TAG.TOLD}/${DLL_THREAD_DETACH}/0`], text);
        const workers = [...new Set(entries.map(each=>each.thread))].filter(id=>id !== main);
        assert.equal(workers.length, 2, text);
        const ends = workers.map(thread=>entries.filter(each=>each.thread === thread)
            .map(each=>`${each.reason}/${each.reserved}`));
        // The last is told the process's end instead of its own. Two that end
        // at once each find the other standing and are both told their own,
        // and the process ends with no thread left to tell of it.
        const last = ['2/0', '0/1'].join();
        const notLast = ['2/0', '3/0'].join();
        const shapes = ends.map(each=>each.join()).sort().join(' | ');
        assert.ok(shapes === [last, notLast].sort().join(' | ')
            || shapes === [notLast, notLast].join(' | '), `${shapes}: ${text}`);
    });
}
