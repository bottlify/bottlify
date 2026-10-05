/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { createLinkMemory, openLink } from './system/link.js';
import { systemHandlers } from './system-link.js';
import { createRegistryService } from './layers/win32/advapi32/registry-service.js';
import { HKEY_LOCAL_MACHINE, createHive } from './layers/win32/advapi32/registry.js';
import { createWindowDirectory } from './layers/win32/user32/directory.js';

test('a process across a link writes the run\'s registry, takes the run\'s ids, and finds the'
    + ' windows of a process here', { timeout: 30000 }, async()=>{
    const windows = createWindowDirectory();
    const game = windows.open(0x2000);
    windows.attach(0x2000, {
        find: (parent, after, className)=>(parent === 0 && after === 0
            && className?.toLowerCase() === 'game' ? game : 0),
        describe: hwnd=>(hwnd === game ? { threadId: 0x2001, className: 'Game', title: 'Game' }
            : null),
        post: ()=>true,
        send: ()=>null,
        answer: ()=>null,
        withdraw: ()=>{},
    });
    const system = {
        registry: createRegistryService(createHive()),
        ids: { thread: 1, process: 0x2008 },
        volume: { drives: new Map(), volumes: new Map(), writables: new Map(),
            watchers: new Set() },
        windows,
    };
    const { a, b } = createLinkMemory();
    const link = openLink(a, systemHandlers(system));
    const serving = link.serve();
    const answer = await new Promise((resolve, reject)=>{
        const worker = new Worker(`
            const { workerData, parentPort } = require('node:worker_threads');
            (async()=>{
                const [{ openLink }, { remoteSystem }] = await Promise.all([
                    import(workerData.link), import(workerData.system)]);
                const link = openLink(workerData.end, {});
                const system = remoteSystem((target, method, args)=>
                    link.callWaiting(target, method, args));
                const machine = system.registry.root(workerData.machine);
                const made = system.registry.create(machine, 'SOFTWARE\\\\Child');
                system.registry.setValue(made.key, 'Ran', 4, Uint8Array.of(1, 0, 0, 0));
                const ids = [system.ids.take('process', 8), system.ids.take('process', 8)];
                const hello = system.windows.register('Hello');
                const found = system.windows.find(0x2010, 0, 0, 'game', null);
                const described = system.windows.describe(found, 0x2010);
                parentPort.postMessage({ ids, hello, found, described });
            })().catch(e=>parentPort.postMessage({ error: String(e && e.stack || e) }));`,
        { eval: true, workerData: { end: b, machine: HKEY_LOCAL_MACHINE,
            link: new URL('./system/link.js', import.meta.url).href,
            system: new URL('./system-link.js', import.meta.url).href } });
        worker.once('message', message=>{
            worker.terminate();
            if (message.error)
            {
                reject(new Error(message.error));
            }
            else
            {
                resolve(message);
            }
        });
        worker.once('error', reject);
    });
    assert.deepEqual(answer, { ids: [0x2008, 0x2010], hello: system.windows.register('hello'),
        found: game,
        described: { threadId: 0x2001, className: 'Game', title: 'Game', processId: 0x2000 } });
    assert.equal(system.ids.process, 0x2018, 'the run\'s counter moved');
    const machine = /** @type {number} */ (system.registry.root(HKEY_LOCAL_MACHINE));
    const child = /** @type {number} */ (system.registry.open(machine, 'SOFTWARE\\Child'));
    assert.deepEqual([...(system.registry.getValue(child, 'ran')?.data ?? [])], [1, 0, 0, 0],
        'the value the other thread set is in the run\'s registry');
    link.close();
    await serving;
});
