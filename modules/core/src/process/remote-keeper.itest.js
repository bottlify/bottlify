/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The gate of the run's cache reached from a process in a worker of its own
 * (`remoteCache`, Cellar's remote keeper across its link): seeded random
 * sequences of what a process asks of the cache - bodies put, read, looked
 * at, dropped, room reserved and abandoned, an owner's names given, filled
 * and let go of - run from a worker, and the same sequence run on the
 * keeper's own thread through its reader (the fixed reference). Every
 * answer, the keeper's figures and every body after must be the same.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { createLinkMemory, openLink } from '@bottlify/cellar';
import { CACHE_CALLS, openRunCache } from './run-cache.js';

const NAMES = 48;

/**
 * The ops of one seed: each `[op, name, length, byte]`.
 *
 * @param {number} seed @param {number} count
 */
function sequenceOf(seed, count){
    let state = seed >>> 0;
    const next = ()=>{
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ t >>> 15, t | 1);
        t ^= t + Math.imul(t ^ t >>> 7, t | 61);
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
    const ops = ['put', 'put', 'put', 'read', 'read', 'look', 'drop', 'reserve', 'own', 'ownPut',
        'ownPut', 'ownPut', 'release'];
    return Array.from({ length: count }, ()=>[ops[Math.floor(next() * ops.length)],
        `m/${Math.floor(next() * NAMES)}`, 1 + Math.floor(next() * 2_000_000),
        Math.floor(next() * 256)]);
}

/**
 * Runs `ops` over `reader` and `own` (a process's, wherever it is): what each
 * answered. One body of its own a name, its bytes from the op's byte.
 *
 * Written as a function's source, so the worker runs this same code.
 */
const RUN = `(reader, own, ops)=>{
    const sum = body=>{
        let total = body.length;
        for (let i = 0; i < body.length; i += 997)
        {
            total = (total * 31 + body[i]) % 0x7fffffff;
        }
        return total;
    };
    const bodyOf = (length, byte)=>{
        const bytes = new Uint8Array(length);
        for (let i = 0; i < length; i++)
        {
            bytes[i] = (byte + i * 7) & 255;
        }
        return bytes;
    };
    const owners = [];
    return ops.map(([op, name, length, byte])=>{
        if (op === 'put')
        {
            return reader.put(name, bodyOf(length, byte));
        }
        if (op === 'read')
        {
            return reader.with(name, sum) ?? null;
        }
        if (op === 'look')
        {
            return reader.look(name);
        }
        if (op === 'drop')
        {
            reader.drop(name);
            return null;
        }
        if (op === 'reserve')
        {
            const room = reader.reserve(name, length);
            if (room !== null)
            {
                reader.abandon(name);
            }
            return room?.length ?? null;
        }
        if (op === 'own')
        {
            const owned = own('texels');
            owners.push({ owned, held: 0 });
            return owned.prefix;
        }
        const owner = owners.at(-1);
        if (!owner)
        {
            return null;
        }
        if (op === 'ownPut')
        {
            const kept = reader.put(owner.owned.prefix + name, bodyOf(length, byte),
                { onlyCopy: true, disk: 'run' });
            owner.held += kept ? 1 : 0;
            return kept;
        }
        owners.pop();
        return owner.owned.release(owner.held);
    });
}`;

/** The worker: a process's cache across its link, running the ops it is handed. */
const PROCESS = `
    const { workerData, parentPort } = require('node:worker_threads');
    Promise.all([import(workerData.cellar), import(workerData.runCache)])
        .then(([{ openLink }, { remoteCache }])=>{
            const link = openLink(workerData.end, {});
            const cache = remoteCache(workerData.joined, link, null);
            parentPort.postMessage({ answers: (${RUN})(cache.reader, cache.own, workerData.ops) });
        }).catch(error=>parentPort.postMessage({ error: String(error && error.stack || error) }));`;

/** What a run's cache holds once the ops ran: its figures, as far as the ops decide them, and every body. @param {any} run */
const standing = run=>{
    const { budget, records, hot, cold, segments, segmentBytes, placedBytes, roundingBytes, spaces,
        owners, ownerTails, ownersOut } = run.figures();
    /** @type {Record<string, number | null>} */
    const bodies = {};
    for (let n = 0; n < NAMES; n++)
    {
        bodies[`m/${n}`] = run.reader.with(`m/${n}`, (/** @type {Uint8Array} */ body)=>body.reduce(
            (/** @type {number} */ total, /** @type {number} */ byte, /** @type {number} */ i)=>
                (total + byte * (i + 1)) % 0x7fffffff, 0)) ?? null;
    }
    return { figures: { budget, records, hot, cold, segments, segmentBytes, placedBytes,
        roundingBytes, spaces, owners, ownerTails, ownersOut }, bodies };
};

for (const seed of [1, 2, 3, 0x5eed])
{
    test(`seed ${seed}: a process in a worker of its own is answered as the keeper's own thread is`,
        { timeout: 120_000 }, async()=>{
            const ops = sequenceOf(seed, 400);
            // One segment: bodies leave for room, and the owners' only copies fill it.
            const budget = 16 << 20;

            const reference = await openRunCache({ budget });
            let expected;
            try
            {
                const run = /** @type {(reader: any, own: any, ops: any[]) => any[]} */ (
                    new Function(`return ${RUN}`)());
                const answers = run(reference.reader, reference.own, ops);
                expected = { answers, ...standing(reference) };
            }
            finally
            {
                reference.close();
            }

            const remote = await openRunCache({ budget });
            const across = remote.across();
            const { a, b } = createLinkMemory(CACHE_CALLS);
            const system = openLink(a, {}, { words: across.words });
            const serving = system.serve();
            const joined = remote.join(()=>{});
            const worker = new Worker(PROCESS, { eval: true, workerData: {
                cellar: import.meta.resolve('@bottlify/cellar'),
                runCache: new URL('./run-cache.js', import.meta.url).href,
                end: b, ops, joined: { shared: joined.shared, segments: joined.segments } } });
            try
            {
                const said = await new Promise((resolve, reject)=>{
                    worker.once('message', resolve);
                    worker.once('error', reject);
                });
                assert.equal(/** @type {any} */ (said).error, undefined);
                const answers = /** @type {any} */ (said).answers;
                // Drops are not waited on: the last ones may still be crossing.
                await new Promise(resolve=>setTimeout(resolve, 50));
                const got = { answers, ...standing(remote) };
                for (const [n, answer] of answers.entries())
                {
                    assert.deepEqual(answer, expected.answers[n],
                        `op ${n}: ${JSON.stringify(ops[n])}`);
                }
                assert.deepEqual(got.figures, expected.figures);
                assert.deepEqual(got.bodies, expected.bodies);
                // Not a sequence that passes on nothing: bodies were read, and room refused.
                const answered = (/** @type {string} */ op, /** @type {(answer: any) => boolean} */ is)=>
                    answers.some((/** @type {any} */ answer, /** @type {number} */ n)=>ops[n][0] === op && is(answer));
                assert.ok(answered('read', answer=>typeof answer === 'number'), 'a body read');
                assert.ok(answered('ownPut', answer=>answer === false), 'room refused');
            }
            finally
            {
                await worker.terminate();
                system.close();
                await serving;
                joined.leave();
                remote.close();
            }
        });
}
