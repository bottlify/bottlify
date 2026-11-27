/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { createLinkMemory, openLink } from '@bottlify/cellar';
import { REGISTRY, remoteSystem, systemHandlers } from './system-link.js';
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
        fileSecurity: new Map(),
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
                    link.ask(target, method, args));
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
            link: import.meta.resolve('@bottlify/cellar'),
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

test('every registry call a process makes reaches the run\'s registry from a worker', ()=>{
    // RegQueryInfoKey asks the key's class: a process in a worker (ngen under
    // concurrency) that could not ask it ended in a TypeError.
    // `asMachine` is the remote's own: its function cannot cross, its writes do
    // (`machineWrite`).
    const systemOnly = new Set(['onChanged', 'toJSON', 'fromJSON', 'fillFromJSON', 'asMachine']);
    const service = createRegistryService(createHive());
    assert.deepEqual(Object.keys(service).filter(name=>!systemOnly.has(name)).sort(),
        [...REGISTRY].sort());
});

test('what a process across a link lays as the machine\'s is furnished and announces nothing',
    async()=>{
        const system = {
            registry: createRegistryService(createHive()),
            ids: { thread: 1, process: 0x2008 },
            volume: { drives: new Map(), volumes: new Map(), writables: new Map(),
                watchers: new Set() },
            windows: createWindowDirectory(),
            fileSecurity: new Map(),
        };
        let announced = 0;
        system.registry.onChanged(()=>announced++);
        const engine = /** @type {Record<string, any>} */ (systemHandlers(system));
        const remote = /** @type {any} */ (remoteSystem((target, method, args)=>
            engine[target][method](...args), {}));
        const HKEY_CURRENT_USER = 0x80000001;
        const REG_SZ = 1;
        const root = remote.registry.root(HKEY_CURRENT_USER);
        const key = remote.registry.asMachine(()=>{
            const made = remote.registry.create(root, 'Control Panel\\Desktop').key;
            remote.registry.setValue(made, 'Wallpaper', REG_SZ, Uint8Array.of(0));
            return made;
        });
        await Promise.resolve();
        assert.equal(announced, 0, 'the machine\'s own keys, laid from a worker, are no change');
        assert.equal(system.registry.getValue(key, 'Wallpaper')?.furnished, true);
        remote.registry.setValue(key, 'Wallpaper', REG_SZ, Uint8Array.of(65, 0));
        await Promise.resolve();
        assert.equal(announced, 1, 'the program\'s write from a worker is');
    });

test('the descriptors a process across a link sets on a file are the run\'s, read by any process',
    ()=>{
        // A setup writes a file's DACL in one process and a service reads it in
        // another: each in a worker of its own keeps nothing of it there.
        const system = {
            registry: createRegistryService(createHive()),
            ids: { thread: 1, process: 0x2008 },
            volume: { drives: new Map(), volumes: new Map(), writables: new Map(),
                watchers: new Set() },
            windows: createWindowDirectory(),
            fileSecurity: new Map(),
        };
        const engine = /** @type {Record<string, any>} */ (systemHandlers(system));
        const across = ()=>/** @type {any} */ (remoteSystem((target, method, args)=>
            engine[target][method](...args), {}));
        const setup = across();
        const service = across();
        const dacl = Uint8Array.of(2, 0, 8, 0);
        setup.fileSecurity.set('c:\\app\\data', { dacl });
        assert.deepEqual(system.fileSecurity.get('c:\\app\\data'), { dacl });
        assert.deepEqual(service.fileSecurity.get('c:\\app\\data'), { dacl });
        assert.equal(service.fileSecurity.get('c:\\other'), undefined);
    });

test('two processes on one link (a child beside its parent in a worker) each answer for their'
    + ' own windows', ()=>{
    const windows = createWindowDirectory();
    const system = {
        registry: createRegistryService(createHive()),
        ids: { thread: 1, process: 0x2008 },
        volume: { drives: new Map(), volumes: new Map(), writables: new Map(),
            watchers: new Set() },
        windows,
        fileSecurity: new Map(),
    };
    /** @type {Record<string, any>} */
    const across = {};
    const engine = /** @type {Record<string, any>} */ (systemHandlers(system,
        (target, method, args)=>across[target][method](...args)));
    const remote = /** @type {any} */ (remoteSystem((target, method, args)=>
        engine[target][method](...args), across));
    /** @param {number} hwnd @param {string} title */
    const endpoint = (hwnd, title)=>({
        find: ()=>0,
        describe: (/** @type {number} */ asked)=>(asked === hwnd
            ? { threadId: 1, className: 'OleMainThreadWndClass', title } : null),
        post: ()=>true, send: ()=>null, answer: ()=>null, withdraw: ()=>{},
        lostForeground: ()=>{}, activate: ()=>false,
    });
    // ngen, then the worker process it started beside it: each makes a
    // window, and attaches after the other.
    const parentWindow = remote.windows.open(0x2000);
    remote.windows.attach(0x2000, endpoint(parentWindow, 'ngen'));
    const childWindow = remote.windows.open(0x2010);
    remote.windows.attach(0x2010, endpoint(childWindow, 'worker'));
    assert.equal(windows.describe(parentWindow, 0x3000)?.title, 'ngen',
        'the parent answers for its window though the child attached after it');
    assert.equal(windows.describe(childWindow, 0x3000)?.title, 'worker');
    remote.windows.detach(0x2010);
    assert.equal(windows.describe(parentWindow, 0x3000)?.title, 'ngen',
        'and still does once the child is gone');
});

test('the run keeps which processes answer for their windows across a link, to detach those a'
    + ' gone link never did', ()=>{
    const windows = createWindowDirectory();
    const system = {
        registry: createRegistryService(createHive()),
        ids: { thread: 1, process: 0x2008 },
        volume: { drives: new Map(), volumes: new Map(), writables: new Map(),
            watchers: new Set() },
        windows,
        fileSecurity: new Map(),
    };
    /** @type {Set<number>} */
    const attached = new Set();
    let asked = 0;
    const engine = /** @type {Record<string, any>} */ (systemHandlers(system, ()=>{
        asked++;
        return { threadId: 1, className: 'X', title: 'gone' };
    }, attached));
    const hwnd = engine.windows.open(0x2000);
    engine.windows.attach(0x2000);
    engine.windows.attach(0x2010);
    engine.windows.detach(0x2010);
    assert.deepEqual([...attached], [0x2000], 'one said it ended; the other died');
    // What the run does as the link ends: nothing asks the gone process again.
    for (const id of attached)
    {
        windows.detach(id);
    }
    assert.equal(windows.describe(hwnd, 0x3000), null);
    assert.equal(asked, 0);
});

test('a system joined across a link says so, and the run\'s session is not its to save', ()=>{
    // `openSession` makes no saver for a process whose system is remote: its
    // writes land on the volume the run's own thread saves, and a saver there
    // rewrote the whole volume in every process ngen started.
    // No drives to join: the volume's first question answers an empty list.
    const system = remoteSystem((target, method)=>(method === 'drives' ? [] : null));
    assert.equal(system.remote, true);
    // Its hive's changes are the system's to save: nothing here listens.
    assert.equal(typeof system.registry.onChanged(), 'function');
});
