/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { createLinkMemory, openLink } from './link.js';

const LINK = new URL('./link.js', import.meta.url).href;

/**
 * A thread that runs `body` with its side of a link open, and posts what it
 * returns: the side of a process, which blocks while it waits.
 *
 * @param {import('./link.js').LinkEnd} end
 * @param {string} body  the function's body; `link` and `openLink` are in scope
 * @param {string} [handlers]  an expression for the handlers it answers with
 */
const processThread = (end, body, handlers = '{}')=>new Promise((resolve, reject)=>{
    const worker = new Worker(`
        const { workerData, parentPort } = require('node:worker_threads');
        import(workerData.module).then(({ openLink })=>{
            let link;
            const handlers = ${handlers};
            link = openLink(workerData.end, handlers);
            const run = ()=>{ ${body} };
            try { parentPort.postMessage({ value: run() }); }
            catch (e) { parentPort.postMessage({ error: String(e.message) }); }
        });`, { eval: true, workerData: { module: LINK, end } });
    worker.once('message', message=>{
        worker.terminate();
        if ('error' in message)
        {
            reject(new Error(message.error));
        }
        else
        {
            resolve(message.value);
        }
    });
    worker.once('error', reject);
});

test('a blocked process is answered by the system, in order, errors and all', { timeout: 20000 },
    async()=>{
        const { a, b } = createLinkMemory();
        /** @type {Map<string, Uint8Array>} */
        const values = new Map();
        const system = openLink(a, { registry: {
            set: (/** @type {string} */ name, /** @type {Uint8Array} */ data)=>{
                values.set(name, data);
                return values.size;
            },
            // Answered later, on the event loop.
            get: async(/** @type {string} */ name)=>{
                await new Promise(resolve=>setTimeout(resolve, 5));
                return values.get(name) ?? null;
            },
            fail: ()=>{
                throw new Error('no such key');
            },
        } });
        const serving = system.serve();
        const answers = await processThread(b, `
            const set = [link.callWaiting('registry', 'set', ['a', Uint8Array.of(1, 2)]),
                link.callWaiting('registry', 'set', ['b', Uint8Array.of(3)])];
            const got = link.callWaiting('registry', 'get', ['a']);
            let failed = null;
            try { link.callWaiting('registry', 'fail'); } catch (e) { failed = e.message; }
            const unknown = (()=>{ try { link.callWaiting('nobody', 'home'); } catch (e) {
                return e.message; } })();
            return { set, got: [...got], failed, unknown };`);
        assert.deepEqual(answers, { set: [1, 2], got: [1, 2], failed: 'no such key',
            unknown: 'link: nothing answers nobody.home' });
        system.close();
        await serving;
    });

test('the system asks a process back while it waits, and is answered', { timeout: 20000 },
    async()=>{
        const { a, b } = createLinkMemory();
        /** @type {ReturnType<typeof openLink>} */
        let system;
        system = openLink(a, { windows: {
            // To answer, the system needs the process that asked.
            find: async(/** @type {string} */ title)=>
                [await system.call('endpoint', 'describe', [title]), 'found'],
        } });
        const serving = system.serve();
        const answer = await processThread(b,
            'return link.callWaiting(\'windows\', \'find\', [\'Game\']);',
            '{ endpoint: { describe: title => "window " + title } }');
        assert.deepEqual(answer, ['window Game', 'found']);
        system.close();
        await serving;
    });

test('two blocked processes: one\'s call needs the other, which is itself waiting on the system',
    { timeout: 20000 }, async()=>{
        const one = createLinkMemory();
        const two = createLinkMemory();
        /** @type {() => void} */
        let release = ()=>{};
        const held = new Promise(resolve=>{
            release = ()=>resolve('released');
        });
        const toTwo = openLink(two.a, { system: {
            // Process two waits here until process one's call is done.
            hold: ()=>held,
        } });
        const toOne = openLink(one.a, { windows: {
            post: async(/** @type {number} */ value)=>{
                const echoed = await toTwo.call('endpoint', 'take', [value]);
                release();
                return echoed;
            },
        } });
        const serving = [toOne.serve(), toTwo.serve()];
        const second = processThread(two.b, 'return link.callWaiting(\'system\', \'hold\');',
            '{ endpoint: { take: value => value * 2 } }');
        // Process two is blocked in its call before process one asks.
        await new Promise(resolve=>setTimeout(resolve, 50));
        const first = processThread(one.b, 'return link.callWaiting(\'windows\', \'post\', [21]);');
        assert.deepEqual(await Promise.all([first, second]), [42, 'released']);
        toOne.close();
        toTwo.close();
        await Promise.all(serving);
    });

test('calls that together overflow the ring all cross, the writer waiting for room',
    { timeout: 20000 }, async()=>{
        const { a, b } = createLinkMemory({ capacity: 4096 });
        let total = 0;
        const system = openLink(a, { sink: {
            take: (/** @type {Uint8Array} */ bytes)=>{
                total += bytes.length;
                return total;
            },
        } });
        const serving = system.serve();
        const answer = await processThread(b, `
            let last = 0;
            for (let i = 0; i < 64; i++)
                last = link.callWaiting('sink', 'take', [new Uint8Array(1500)]);
            return last;`);
        assert.equal(answer, 64 * 1500);
        system.close();
        await serving;
    });

test('a side counts what it asked of the other and how long it waited, by target and method',
    { timeout: 20000 }, async()=>{
        const { a, b } = createLinkMemory();
        const system = openLink(a, { registry: { get: ()=>1 }, ids: { take: ()=>2 } });
        const serving = system.serve();
        const counted = await processThread(b, `
            for (let i = 0; i < 3; i++) link.callWaiting('registry', 'get', []);
            link.callWaiting('ids', 'take', []);
            return link.diagnostics();`);
        system.close();
        await serving;
        assert.equal(counted.calls, 4);
        assert.deepEqual(counted.asked.map((/** @type {any} */ row)=>[row.name, row.count])
            .sort(), [['ids.take', 1], ['registry.get', 3]]);
        assert.ok(counted.waitedMs > 0 && counted.asked.every((/** @type {any} */ row)=>
            row.waitedMs > 0), 'each blocked for its answer');
    });

test('what a process told the system before the link closed is heard, nothing waited on',
    { timeout: 20000 }, async()=>{
        const { a, b } = createLinkMemory();
        /** @type {number[]} */
        const heard = [];
        const system = openLink(a, { events: {
            emit: (/** @type {number} */ n)=>void heard.push(n),
        } });
        const serving = system.serve();
        await new Promise(resolve=>setImmediate(resolve));
        // The process tells and ends while this thread is held, and the link
        // is closed before the serving side had a turn to look.
        const done = new Int32Array(new SharedArrayBuffer(4));
        const worker = new Worker(`
            const { workerData } = require('node:worker_threads');
            import(workerData.module).then(({ openLink })=>{
                const link = openLink(workerData.end, {});
                for (let i = 0; i < 20; i++) link.call('events', 'emit', [i]);
                Atomics.store(workerData.done, 0, 1);
                Atomics.notify(workerData.done, 0);
            });`, { eval: true, workerData: { module: LINK, end: b, done } });
        Atomics.wait(done, 0, 0, 10000);
        system.close();
        await serving;
        await worker.terminate();
        assert.deepEqual(heard, [...Array(20).keys()]);
    });

test('a call answered by waiting on a call of its own is handled once, and the calls after it'
    + ' in their order', { timeout: 20000 }, async()=>{
    const { a, b } = createLinkMemory();
    /** @type {any[]} */
    const read = [];
    const system = openLink(a, {
        processes: { start: ()=>{
            read.push(system.call('parent', 'read', [1]), system.call('parent', 'read', [2]));
            return true;
        } },
        volume: { get: (/** @type {number} */ n)=>n * 10 },
    });
    const serving = system.serve();
    const order = await processThread(b, `
        link.callWaiting('processes', 'start', []);
        return globalThis.order;`, `{ parent: { read: n=>{
            (globalThis.order ??= []).push('in ' + n);
            const got = link.callWaiting('volume', 'get', [n]);
            globalThis.order.push('out ' + n);
            return got;
        } } }`);
    assert.deepEqual(await Promise.all(read), [10, 20]);
    assert.deepEqual(order, ['in 1', 'in 2', 'out 2', 'out 1'],
        'each once; the second, come while the first waited, handled inside that wait');
    system.close();
    await serving;
});

test('a failure crosses with what it says of itself, not only its message', { timeout: 20000 },
    async()=>{
        const { a, b } = createLinkMemory();
        const system = openLink(a, { volume: {
            read: ()=>{
                throw Object.assign(new Error('blocks are missing'),
                    { code: 'BLOCK_MISS', blocks: [{ index: 3, offset: 0, packed: 7 }] });
            },
        } });
        const serving = system.serve();
        const answer = await processThread(b, `
            try { link.callWaiting('volume', 'read'); return null; }
            catch (e) { return { message: e.message, code: e.code, blocks: e.blocks }; }`);
        assert.deepEqual(answer, { message: 'blocks are missing', code: 'BLOCK_MISS',
            blocks: [{ index: 3, offset: 0, packed: 7 }] });
        // And the other way, to a promise.
        const back = openLink(b, { endpoint: { fail: ()=>{
            throw Object.assign(new Error('no window'), { code: 1400 });
        } } });
        const asked = system.call('endpoint', 'fail');
        back.pump();
        await assert.rejects(asked, (/** @type {any} */ e)=>e.code === 1400
            && e.message === 'no window');
        system.close();
        await serving;
    });

test('a call and an answer larger than a ring holds cross in parts, whole and in order',
    { timeout: 20000 }, async()=>{
        // A small ring, so a few hundred KiB are many records of it.
        const { a, b } = createLinkMemory({ capacity: 64 * 1024 });
        const big = (/** @type {number} */ size, /** @type {number} */ seed)=>
            Uint8Array.from({ length: size }, (_, at)=>(at * 31 + seed) & 0xff);
        const system = openLink(a, { volume: {
            read: (/** @type {number} */ size)=>big(size, 7),
            sum: (/** @type {Uint8Array} */ bytes)=>bytes.reduce((sum, byte)=>(sum + byte) >>> 0, 0),
        } });
        const serving = system.serve();
        const answer = await processThread(b, `
            const read = link.callWaiting('volume', 'read', [300000]);
            const small = link.callWaiting('volume', 'read', [16]);
            const sent = Uint8Array.from({ length: 200000 }, (_, at)=>(at * 31 + 3) & 0xff);
            const sum = link.callWaiting('volume', 'sum', [sent]);
            return { length: read.length, head: [...read.subarray(0, 4)],
                tail: [...read.subarray(-4)], small: small.length, sum };`);
        system.close();
        await serving;
        const expected = big(300000, 7);
        assert.deepEqual(answer, {
            length: 300000, head: [...expected.subarray(0, 4)], tail: [...expected.subarray(-4)],
            small: 16,
            sum: big(200000, 3).reduce((sum, byte)=>(sum + byte) >>> 0, 0),
        });
    });

test('an answer that cannot cross reaches the caller as a failure, and the link goes on',
    { timeout: 20000 }, async()=>{
        const { a, b } = createLinkMemory();
        const system = openLink(a, { odd: {
            handler: ()=>()=>0,
            plain: ()=>42,
        } });
        const serving = system.serve();
        const answer = await processThread(b, `
            let failed = null;
            try { link.callWaiting('odd', 'handler', []); }
            catch (e) { failed = e.message; }
            return { failed, after: link.callWaiting('odd', 'plain', []) };`);
        system.close();
        await serving;
        assert.match(answer.failed, /cannot|codec|encode/i);
        assert.equal(answer.after, 42);
    });
