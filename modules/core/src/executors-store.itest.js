/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The executors' store gate: a program whose threads run on three executors,
 * twice on one translation store. The second run's other executors take the
 * batch modules the first stored from the run's cache, where the process put
 * each once, and read them there: none crosses to an executor as a copy.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from './app.js';
import { buildExe } from '../../../tools/fixtures/make-pe.mjs';
import {
    createDirectoryTranslationStore, createMemoryDirectory,
} from './layers/cpu/internal/translation-store.js';

/** @param {number} value */
const u32 = value=>[
    value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff,
];

const N = 20_000;
const WORKER_OFFSET = 0x100;

/**
 * @param {boolean} [crossing]  every thread, the main one between starting the workers and
 *     waiting for them, also calls into the host each time round: the others' calls are
 *     then answered inside the calls of the thread on the process's own executor
 */
function buildRaceExe(crossing = false){
    return buildExe({
        imports: { 'KERNEL32.dll': ['CreateThread', 'WaitForSingleObject', 'ExitProcess',
            'GetACP'] },
        codeSize: 0x200,
        data: {
            counter: [0, 0, 0, 0], guarded: [0, 0, 0, 0], lock: [0, 0, 0, 0],
            swapped: [0, 0, 0, 0], first: [0, 0, 0, 0], second: [0, 0, 0, 0],
        },
        code: ({ iat, at, code })=>{
            /** CreateThread(NULL, 0, worker, NULL, 0, NULL), the handle to `slot`. @param {string} slot */
            const start = slot=>[
                0x6a, 0x00, 0x6a, 0x00, 0x6a, 0x00,
                0x68, ...u32(code(WORKER_OFFSET)),
                0x6a, 0x00, 0x6a, 0x00,
                0xff, 0x15, ...u32(iat('CreateThread')),
                0xa3, ...u32(at(slot)),
            ];
            /** WaitForSingleObject([slot], INFINITE) @param {string} slot */
            const wait = slot=>[
                0x6a, 0xff, 0xff, 0x35, ...u32(at(slot)),
                0xff, 0x15, ...u32(iat('WaitForSingleObject')),
            ];
            /** cmp dword [name], 2N; jne +3; or ebx, bit @param {string} name @param {number} bit */
            const check = (name, bit)=>[
                0x81, 0x3d, ...u32(at(name)), ...u32(2 * N), 0x75, 0x03, 0x83, 0xcb, bit,
            ];
            // push ecx; call [GetACP]; pop ecx -- what a crossing may clobber, kept
            const cross = crossing ? [0x51, 0xff, 0x15, ...u32(iat('GetACP')), 0x59] : [];
            // mov ecx, N; L: the crossing; dec ecx; jnz L
            const busy = crossing
                ? [0xb9, ...u32(N), ...cross, 0x49, 0x75, -(cross.length + 3) & 0xff]
                : [];
            const main = [
                ...start('first'), ...start('second'), ...busy, ...wait('first'), ...wait('second'),
                0x31, 0xdb, //                                  xor ebx, ebx
                ...check('counter', 1), ...check('guarded', 2), ...check('swapped', 4),
                0x53, 0xff, 0x15, ...u32(iat('ExitProcess')), // ExitProcess(ebx)
            ];
            const body = [
                ...cross,
                0xf0, 0xff, 0x05, ...u32(at('counter')), //        L: lock inc [counter]
                0xb8, ...u32(1), //                                S: mov eax, 1
                0x87, 0x05, ...u32(at('lock')), //                    xchg [lock], eax
                0x85, 0xc0, 0x75, 0xf1, //                            test eax, eax; jnz S
                0xff, 0x05, ...u32(at('guarded')), //                 inc [guarded]
                0xc7, 0x05, ...u32(at('lock')), ...u32(0), //        mov [lock], 0
                0xa1, ...u32(at('swapped')), //                       mov eax, [swapped]
                0x8d, 0x50, 0x01, //                               C: lea edx, [eax+1]
                0xf0, 0x0f, 0xb1, 0x15, ...u32(at('swapped')), //    lock cmpxchg [swapped], edx
                0x75, 0xf3, //                                        jnz C
            ];
            const worker = [
                0xb9, ...u32(N), //                                   mov ecx, N
                ...body,
                0x49, 0x0f, 0x85, ...u32(-(body.length + 1 + 6)), //  dec ecx; jnz L
                0x31, 0xc0, 0xc2, 0x04, 0x00, //                      xor eax, eax; ret 4
            ];
            return [...main, ...new Array(WORKER_OFFSET - main.length).fill(0x90), ...worker];
        },
    });
}

/** The other executors' accounts of a run on three executors over `store`. @param {any} store */
async function run(store){
    const app = await createApp({ executable: buildRaceExe(),
        cpu: { cores: 3 }, cork: { config: { store } } });
    try
    {
        const code = await app.run({ timeoutMs: 120_000 });
        // An executor answers its account between its slices, the one asked
        // before: asked until what it read is all the process put for it.
        /** @type {any[]} */
        let executors = [];
        for (let asked = 0; asked < 50; asked++)
        {
            const tables = /** @type {any[]} */ (await app.diagnostics());
            executors = tables.find(table=>table.name === 'cpu')?.metrics?.executors ?? [];
            if (executors.every(one=>one.storeRecords
                && one.storeRecords.cachePut >= (one.storeSent?.cached ?? 0)))
            {
                break;
            }
            await new Promise(resolve=>setTimeout(resolve, 100));
        }
        return { code, executors };
    }
    finally
    {
        await app.dispose();
    }
}

test('a second run\'s other executors read the stored batch modules in the run\'s cache, '
    + 'not sent a copy of them', { timeout: 600_000 }, async t=>{
    const store = await createDirectoryTranslationStore(createMemoryDirectory(), 'executors-store');
    const first = await run(store);
    assert.equal(first.code, 7);
    const second = await run(store);
    assert.equal(second.code, 7);
    t.diagnostic(JSON.stringify(second.executors.map(one=>({ index: one.index,
        records: one.storeRecords, sent: one.storeSent, hits: one.cacheHits }))));
    const put = second.executors.reduce((sum, one)=>sum + (one.storeSent?.cached ?? 0), 0);
    const read = second.executors.reduce((sum, one)=>sum + (one.storeRecords?.cachePut ?? 0)
        + (one.storeRecords?.cacheHits ?? 0), 0);
    assert.ok(put > 0, 'the process put a stored batch module in the run\'s cache');
    assert.ok(read >= put, `the executors read each one there (${read} of ${put})`);
    // A batch module's bytes are what crossed before: a region's record, whose
    // bytes may change under its key, still does.
    const copied = second.executors.reduce((sum, one)=>sum + (one.storeSent?.copiedBytes ?? 0), 0);
    const cached = second.executors.reduce((sum, one)=>sum + (one.storeSent?.cachedBytes ?? 0), 0);
    assert.ok(cached > copied, `the modules were the larger part (${cached} kept, ${copied} sent)`);
});
