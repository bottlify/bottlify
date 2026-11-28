/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The gate of the run's tables (`common/run-tables.js`) under the locale
 * functions: the same seeded calls - GetStringType, the conversions both
 * ways, the lead bytes, CPINFO - through tables made afresh for every read (a
 * space that keeps nothing), through tables read in place from the run's
 * cache, and through a cache too small to keep most of them, each answer, last
 * error and every byte of memory compared after each call. And a second realm of the run (a worker)
 * reading
 * the tables a first one made, without making them again.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guestOver } from '../common/guest.fixture.js';
import { Worker } from 'node:worker_threads';
import { testCache } from '../../cache/testing.fixture.js';
import { runTables } from '../common/run-tables.js';
import { codePages } from './codepages.js';
import { createLocaleFunctions } from './locale.js';
import { stringTypes } from './string-types.js';

const MEMORY = 0x8000;
const SOURCE = 0x1000;
const DESTINATION = 0x3000;
const DEFAULT_CHAR = 0x7000;
const USED_DEFAULT = 0x7010;
const INFO = 0x7100;

const PAGES = [932, 936, 949, 950, 1250, 1251, 1253, 1255, 874, 866, 10000, 28597, 1252, 437,
    65001, 0, 3, 1234];

/** A seeded xorshift32: the same calls in every arm. @param {number} seed */
const seeded = seed=>{
    let state = seed >>> 0 || 1;
    return (/** @type {number} */ below)=>{
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        return (state >>> 0) % below;
    };
};

/** @param {import('../common/run-tables.js').RunTables} tables */
const machine = tables=>{
    const bytes = new Uint8Array(MEMORY);
    /** @type {number[]} */
    const errors = [];
    const fns = createLocaleFunctions({
        tables,
        guest: guestOver(bytes),
        stringLength(address, unit){
            let count = 0;
            while ((unit === 1 ? bytes[address + count]
                : bytes[address + count * 2] | bytes[address + count * 2 + 1]) !== 0)
            {
                count++;
            }
            return count;
        },
        setLastError: code=>errors.push(code),
    });
    return { bytes, errors, fns: /** @type {Record<string, any>} */ (fns) };
};

/**
 * One seeded call: what it plants in memory and its name and arguments.
 *
 * @param {(below: number) => number} next
 * @returns {{ plant: [number, number[]][], name: string, args: number[] }}
 */
const call = next=>{
    const page = PAGES[next(PAGES.length)];
    const units = Array.from({ length: 1 + next(48) }, ()=>{
        switch (next(6))
        {
            case 0: return 0x20 + next(0x5f);
            case 1: return 0x80 + next(0x180);
            case 2: return 0x3000 + next(0x6000);
            case 3: return 0xff00 + next(0xf0);
            case 4: return 0xac00 + next(0x2000);
            default: return 1 + next(0xffff);
        }
    });
    const lead = ()=>0x81 + next(0x7e);
    const ansi = Array.from({ length: 1 + next(48) }, ()=>(next(3) === 0 ? lead()
        : next(2) === 0 ? 0x40 + next(0xc0) : 1 + next(0xff)));
    const wide = units.flatMap(unit=>[unit & 0xff, unit >> 8]);
    const room = [0, 1, 3, 200][next(4)];
    /** Zero is the measuring call, with no buffer. @param {number} size */
    const destination = size=>(size === 0 ? 0 : DESTINATION);
    switch (next(7))
    {
        case 0:
            return { plant: [[SOURCE, wide]], name: 'GetStringTypeW',
                args: [[1, 2, 4, 3][next(4)], SOURCE, units.length, DESTINATION] };
        case 1:
            return { plant: [[SOURCE, ansi]], name: 'GetStringTypeA',
                args: [0x409, [1, 2, 4][next(3)], SOURCE, ansi.length, DESTINATION] };
        case 2:
            return { plant: [[SOURCE, ansi]], name: 'MultiByteToWideChar',
                args: [page, [0, 8][next(2)], SOURCE, ansi.length, destination(room), room] };
        case 3:
            return { plant: [[SOURCE, wide], [DEFAULT_CHAR, [next(2) === 0 ? 0x5f : lead(), 0x40]]],
                name: 'WideCharToMultiByte',
                args: [page, [0, 0x400][next(2)], SOURCE, units.length, destination(room), room,
                    next(2) === 0 ? 0 : DEFAULT_CHAR, next(2) === 0 ? 0 : USED_DEFAULT] };
        case 4:
            return { plant: [], name: 'IsDBCSLeadByteEx', args: [page, next(256)] };
        case 5:
            return { plant: [], name: 'GetCPInfo', args: [page, INFO] };
        default:
            return { plant: [], name: 'GetCPInfoExW', args: [page, 0, INFO] };
    }
};

test('the locale functions answer the same with the run\'s tables and with tables made afresh',
    async()=>{
        const roomy = await testCache();
        // Room for the single-byte pages and not the 128 KiB tables: those are
        // made again at each read.
        const cramped = await testCache({ budget: 64 << 10, segmentBytes: 64 << 10 });
        const own = machine(runTables((await testCache({ budget: 0 })).space('tables')));
        const roomyTables = runTables(roomy.space('tables', { idle: 'stay' }));
        const crampedTables = runTables(cramped.space('tables', { idle: 'stay' }));
        const arms = { kept: machine(roomyTables), cramped: machine(crampedTables) };
        const next = seeded(0x5eed);
        /** @type {Set<string>} */
        const named = new Set();
        for (let n = 0; n < 1500; n++)
        {
            const { plant, name, args } = call(next);
            named.add(name);
            const answers = [own, ...Object.values(arms)].map(arm=>{
                for (const [at, bytes] of plant)
                {
                    arm.bytes.set(bytes, at);
                }
                const answer = arm.fns[name].handler(args);
                return { answer, errors: arm.errors.length, error: arm.errors.at(-1) ?? null };
            });
            for (const [index, [label, arm]] of Object.entries(arms).entries())
            {
                const what = `${label}: call ${n} ${name}(${args})`;
                assert.deepEqual(answers[index + 1], answers[0], what);
                assert.ok(Buffer.from(arm.bytes).equals(Buffer.from(own.bytes)),
                    `memory after ${what}`);
            }
        }
        assert.equal(named.size, 7, 'every call drawn');
        // Each arm took the path it stands for: the roomy one read tables in place,
        // the cramped one was refused room for some and made them again.
        const kept = roomyTables.figures();
        assert.ok(kept.read > 0 && kept.refused === 0, `kept: ${JSON.stringify(kept)}`);
        const cramp = crampedTables.figures();
        assert.ok(cramp.refused > 1 && cramp.read > 0, `cramped: ${JSON.stringify(cramp)}`);
        await roomy.keeper.close?.();
        await cramped.keeper.close?.();
    });

test('a worker of the run reads the tables a first process made, and makes none', async()=>{
    const cache = await testCache();
    const first = runTables(cache.space('tables', { idle: 'stay' }));
    const sjis = [0x93, 0xfa, 0x96, 0x7b, 0x41];
    const here = { words: Array.from(/** @type {Uint16Array} */ (stringTypes(first)(1, 'Aa1 '))),
        text: codePages(first)(932)?.decode(Uint8Array.from(sjis), false) };
    assert.deepEqual(first.figures(), { made: 2, read: 0, refused: 0 });
    const joined = /** @type {NonNullable<ReturnType<typeof cache.join>>} */ (cache.join(()=>{}));
    const url = (/** @type {string} */ path)=>JSON.stringify(new URL(path, import.meta.url).href);
    const worker = new Worker(`
        const { workerData, parentPort } = require('node:worker_threads');
        (async()=>{
            const { joinedSpace } = await import(${url('../../cache/module.js')});
            const { runTables } = await import(${url('../common/run-tables.js')});
            const { stringTypes } = await import(${url('./string-types.js')});
            const { codePages } = await import(${url('./codepages.js')});
            const tables = runTables(joinedSpace(workerData.joined, 'tables').space);
            const words = Array.from(stringTypes(tables)(1, 'Aa1 '));
            const text = codePages(tables)(932).decode(Uint8Array.from(workerData.sjis), false);
            parentPort.postMessage({ words, text, figures: tables.figures() });
        })();
    `, { eval: true,
        workerData: { joined: { shared: joined.shared, segments: joined.segments }, sjis } });
    const answer = await new Promise((resolve, reject)=>{
        worker.once('message', resolve);
        worker.once('error', reject);
    });
    await worker.terminate();
    joined.leave();
    assert.deepEqual({ words: answer.words, text: answer.text }, here);
    assert.deepEqual(answer.figures, { made: 0, read: 2, refused: 0 },
        'read in place, made nowhere');
});
