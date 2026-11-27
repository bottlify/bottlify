/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * One translation store serves every program of a bottle: the system modules
 * lie at the same addresses in every process of a configuration whatever a
 * program imports and in what order (decisions A280, A281), so a region of a
 * system routine one program made is taken by another without forming it
 * again. A key carries nothing of the process that made it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from './app.js';
import {
    createDirectoryTranslationStore, createMemoryDirectory,
} from './layers/cpu/internal/translation-store.js';
import { buildExe } from '../../../tools/fixtures/make-pe.mjs';

const BUNDLE_ID = 'shared-test';

/** @param {number} value */
const u32 = value=>[value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24 & 0xff];

/**
 * A program that calls lstrlenA("abc") `rounds` times and exits with the sum,
 * its imports in the order given and its code `pad` bytes into its section:
 * two of them differ in everything a program owns.
 *
 * @param {Record<string, string[]>} imports @param {number} rounds @param {number} pad
 */
const program = (imports, rounds, pad)=>buildExe({
    imports,
    data: { text: [0x61, 0x62, 0x63, 0] },
    codeSize: 0x40 + pad,
    code: ({ iat, at })=>[
        ...new Array(pad).fill(0x90),
        0xbe, ...u32(rounds),
        0x31, 0xff,
        0x68, ...u32(at('text')),
        0xff, 0x15, ...u32(iat('lstrlenA')),
        0x01, 0xc7,
        0x4e,
        0x75, 0xf0,
        0x81, 0xe7, ...u32(0xff),
        0x57,
        0xff, 0x15, ...u32(iat('ExitProcess')),
    ],
});

/** @param {any} app @param {string} name @returns {any} */
const layerOf = (app, name)=>app.diagnostics()
    .find((/** @type {any} */ layer)=>layer.name === name);

/** The span a module takes, as the memory layout names it. @param {any} app @param {string} dll */
function spanOf(app, dll){
    for (const line of /** @type {string[]} */ (layerOf(app, 'memory')?.metrics?.layout ?? []))
    {
        const [, name, base, size] = /^(.*) 0x([0-9a-f]+)\+0x([0-9a-f]+) \S+$/.exec(line) ?? [];
        if (name === dll)
        {
            return [parseInt(base, 16), parseInt(base, 16) + parseInt(size, 16)];
        }
    }
    return null;
}

/** The entry a region of the store's trace is for (`entry:hash:...`). @param {string} region */
const entryOf = region=>parseInt(region.split(':')[0], 16);

/**
 * @param {any} store @param {Uint8Array} executable @param {Record<string, any>} [extra]
 */
async function run(store, executable, extra = {}){
    const app = await createApp({
        executable, ...extra,
        cork: { config: { feed: 'slice', timings: true, traceStore: true, store } },
    });
    try
    {
        const code = await app.run({ timeoutMs: 60000 });
        return { code, cork: /** @type {any} */ (layerOf(app, 'cpu').metrics).cork,
            kernel32: spanOf(app, 'KERNEL32.dll') };
    }
    finally
    {
        await app.dispose();
    }
}

test('a system routine one program translated is taken by another from the store, unformed',
    { timeout: 300000 }, async t=>{
        const store = await createDirectoryTranslationStore(createMemoryDirectory(), BUNDLE_ID);
        const first = await run(store, program(
            { 'KERNEL32.dll': ['lstrlenA', 'ExitProcess'] }, 300_000, 0));
        const [from, to] = /** @type {number[]} */ (first.kernel32);
        const ours = first.cork.storeTrace.put
            .filter((/** @type {string} */ one)=>entryOf(one) >= from && entryOf(one) < to);
        assert.ok(ours.length >= 1, 'the first program stored a region of lstrlenA');

        const second = await run(store, program({
            'USER32.dll': ['GetDesktopWindow'], 'MSVCRT.dll': ['strlen'],
            'KERNEL32.dll': ['ExitProcess', 'lstrlenA'] }, 300_000, 0x30));
        t.diagnostic(`first: ${first.cork.storeTrace.put.length} stored, second: `
            + `${second.cork.cacheHits} hits, ${second.cork.storeTrace.missed.length} missed`);
        assert.deepEqual(second.kernel32, first.kernel32, 'KERNEL32 at the same span');
        assert.equal(second.code, first.code, 'both sum the same lengths');
        const keys = new Set(first.cork.storeTrace.put);
        const madeAgain = [...second.cork.storeTrace.missed, ...second.cork.storeTrace.put]
            .filter((/** @type {string} */ key)=>keys.has(key));
        assert.deepEqual(madeAgain, [], 'nothing the first stored is made again');
        assert.ok(second.cork.cacheHits >= ours.length,
            `the second took the first's regions (${second.cork.cacheHits} hits)`);
    });
