/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    REGCLS_MULTIPLEUSE, REGCLS_SUSPENDED, createClassTable, createRemoting,
} from './remote.js';

const IID_IUNKNOWN = '{00000000-0000-0000-C000-000000000046}';

const CLSID = '{91814EC0-B5F0-11D2-80B9-00104B1F6CEA}';

/** @param {Partial<import('./remote.js').Registration>} fields */
const entry = fields=>({ clsid: CLSID, endpoint: 1, object: 1, flags: REGCLS_MULTIPLEUSE,
    cookie: 1, suspended: false, used: false, ...fields });

test('a single-use class object serves one client; a multiple-use one serves every client', ()=>{
    const table = createClassTable();
    table.register(entry({ flags: 0 }));
    assert.ok(table.take(CLSID));
    assert.equal(table.take(CLSID), null, 'the next client starts a server of its own');

    table.register(entry({ cookie: 2 }));
    assert.ok(table.take(CLSID));
    assert.ok(table.take(CLSID));
});

test('a suspended registration is found only once the server resumes', ()=>{
    const table = createClassTable();
    table.register(entry({ flags: REGCLS_MULTIPLEUSE | REGCLS_SUSPENDED, suspended: true }));
    assert.equal(table.take(CLSID), null);
    table.resume(1);
    assert.ok(table.take(CLSID));
});

test('a client waits for the server it started, and stops waiting when that server ends',
    async()=>{
        const table = createClassTable();
        const waiting = table.whenRegistered(CLSID, new Promise(()=>{}));
        table.register(entry({}));
        assert.equal(await waiting, true);

        const other = createClassTable();
        /** @type {(value?: unknown) => void} */
        let end = ()=>{};
        const gaveUp = other.whenRegistered(CLSID, new Promise(resolve=>{
            end = resolve;
        }));
        end();
        assert.equal(await gaveUp, false, 'a server that exits without registering fails it');
    });

test('an ended process takes its registrations with it and runs its proxies down', async()=>{
    const table = createClassTable();
    const process = {};
    let rundowns = 0;
    const id = table.attach({ process, alive: true, deliver: async()=>({}),
        rundown: async()=>{
            rundowns++;
        } });
    table.register(entry({ endpoint: id }));
    await table.ended(process);
    assert.equal(table.take(CLSID), null);
    assert.equal(table.endpoint(id), null);
    assert.equal(rundowns, 1);
});

test('a suspended registration is handed to no new client until resumed again', ()=>{
    const table = createClassTable();
    table.register({ clsid: 'A', endpoint: 1, object: 1, flags: REGCLS_MULTIPLEUSE, cookie: 1,
        suspended: false, used: false });
    table.register({ clsid: 'B', endpoint: 2, object: 1, flags: REGCLS_MULTIPLEUSE, cookie: 1,
        suspended: false, used: false });
    table.suspend(1);
    assert.equal(table.take('A'), null);
    assert.equal(table.take('B')?.endpoint, 2, 'another process\'s registration is its own');
    table.resume(1);
    assert.equal(table.take('A')?.endpoint, 1);
});

test('an RPC endpoint is one process\'s: a second to claim it is refused, and it goes with its'
    + ' process', async()=>{
    const table = createClassTable();
    const first = {};
    const id = table.attach({ process: first, alive: true, deliver: async()=>({}),
        rundown: async()=>{} });
    const other = table.attach({ process: {}, alive: true, deliver: async()=>({}),
        rundown: async()=>{} });
    assert.equal(table.rpcServer('ncalrpc:one'), null);
    assert.equal(table.rpcListen('ncalrpc:one', id), true);
    assert.equal(table.rpcListen('ncalrpc:one', id), true, 'the process that has it asks again');
    assert.equal(table.rpcListen('ncalrpc:one', other), false, 'another process cannot have it');
    assert.equal(table.rpcServer('ncalrpc:one'), id);

    table.rpcUnlisten(id, 'ncalrpc:one');
    assert.equal(table.rpcServer('ncalrpc:one'), null);
    assert.equal(table.rpcListen('ncalrpc:one', other), true, 'and it is free again');

    assert.equal(table.rpcListen('ncacn_np:\\pipe\\two', id), true);
    assert.equal(table.rpcListen('ncalrpc:three', id), true);
    await table.ended(first);
    assert.equal(table.rpcServer('ncacn_np:\\pipe\\two'), null, 'what a process listened on goes');
    assert.equal(table.rpcServer('ncalrpc:three'), null);
    assert.equal(table.rpcServer('ncalrpc:one'), other, 'another process\'s stays');
});

/**
 * One process's channel over a memory of its own, whose one object answers
 * IUnknown's three and records the thread each call ran on.
 *
 * @param {{ exporter: string, worker?: boolean }} options
 */
function channel({ exporter, worker = true }){
    const bytes = new Uint8Array(0x10000);
    const view = new DataView(bytes.buffer);
    const OBJECT = 0x1000;
    view.setUint32(OBJECT, 0x2000, true);
    [0x9000, 0x9001, 0x9002].forEach((method, slot)=>view.setUint32(0x2000 + slot * 4, method,
        true));
    let next = 0x4000;
    const MTA = Symbol('MTA');
    /** @type {[number, unknown][]} */
    const calls = [];
    /** @type {string[]} */
    const reported = [];
    let workers = 0;
    const table = createClassTable();
    const remoting = createRemoting({
        table,
        process: 'server',
        readMemory: (address, length)=>bytes.subarray(address, address + length),
        writeMemory: (address, data)=>bytes.set(data, address),
        heap: { allocate: size=>{
            const at = next;
            next += (size + 7) & ~7;
            return at;
        }, free: ()=>true },
        call: async(method, args, thread)=>{
            calls.push([method, thread]);
            if (method === 0x9000)
            {
                view.setUint32(args[2], args[0], true);
            }
            return 0;
        },
        callerThread: ()=>exporter,
        apartmentOf: thread=>(thread === 'sta' ? thread : MTA),
        vtables: { publish: ()=>0 },
        bstr: { allocate: ()=>0, free: ()=>true },
        catalog: /** @type {any} */ ({}),
        divergence: (_api, detail)=>reported.push(detail),
        ...(worker ? { worker: (/** @type {(thread: unknown) => Promise<void>} */ body)=>{
            workers++;
            void body('rpc thread');
            return true;
        } } : {}),
    });
    return { remoting, table, calls, reported, OBJECT, workers: ()=>workers };
}

test('a call for an object of the multithreaded apartment runs on a thread of the server\'s'
    + ' own, however its exporting thread waits', async()=>{
    // ole_server.c: a server that registered from the MTA and sits in
    // WaitForSingleObject(INFINITE) still serves its clients, as COM's RPC
    // threads serve the MTA.
    const { remoting, table, calls, OBJECT, workers } = channel({ exporter: 'main' });
    const reference = await remoting.exportReference(OBJECT, IID_IUNKNOWN,
        'main');
    calls.length = 0;
    const endpoint = table.endpoint(reference.endpoint);
    assert.ok(endpoint);
    await endpoint.deliver({ kind: 'addref', object: reference.object });
    const release = { kind: 'release', object: reference.object, count: 1 };
    assert.deepEqual(await endpoint.deliver(release), { hr: 0 });
    assert.equal(calls.length, 0, 'a count of two leaves the object held');
    assert.deepEqual(await endpoint.deliver(release), { hr: 0 });
    assert.ok(calls.length > 0 && calls.every(([, thread])=>thread === 'rpc thread'),
        'the last release runs on the worker');
    assert.equal(workers(), 1, 'one worker for the process, started with the first call');
});

test('a single-threaded apartment\'s object is called on its own thread, never the worker\'s',
    async()=>{
        const { remoting, table, calls, reported, OBJECT, workers } = channel({ exporter: 'sta' });
        const reference = await remoting.exportReference(OBJECT, IID_IUNKNOWN,
            'sta');
        calls.length = 0;
        const endpoint = table.endpoint(reference.endpoint);
        assert.equal((await endpoint?.deliver({ kind: 'release', object: reference.object,
            count: 1 }))?.hr, 0x80010108 | 0,
        'with no window to deliver through, RPC_E_DISCONNECTED');
        assert.deepEqual(calls, []);
        assert.equal(workers(), 0);
        assert.match(reported.join('\n'), /no window/);
    });

test('a registered class object is held by the registration\'s count alone', async()=>{
    // ole_server.c: once its clients are gone, a server's class object has
    // the one count CoRegisterClassObject took; the channel takes none of
    // its own until an activation hands the object out.
    const { remoting, calls, OBJECT } = channel({ exporter: 'main' });
    await remoting.registerClass(CLSID, OBJECT, REGCLS_MULTIPLEUSE, 7);
    assert.deepEqual(calls, []);
    assert.equal(await remoting.revokeClass(7), true);
    assert.deepEqual(calls, [], 'and revoking it releases nothing the channel did not take');
});
