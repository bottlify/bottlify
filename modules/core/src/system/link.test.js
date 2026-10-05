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
