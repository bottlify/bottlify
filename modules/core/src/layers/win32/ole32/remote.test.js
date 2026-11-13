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
 * @param {{ exporter: string, worker?: boolean, window?: boolean,
 *     modalPump?: (thread: unknown) => Promise<number> }} options
 *     `window`: each apartment's hidden window, its message handled at the next turn
 */
function channel({ exporter, worker = true, window = false, modalPump }){
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
        ...(window ? { apartmentWindow: (()=>{
            /** @type {(message: number) => unknown} */
            let handle = ()=>0;
            return {
                create: (/** @type {(message: number) => unknown} */ handler)=>{
                    handle = handler;
                    return 7;
                },
                post: (/** @type {number} */ _window, /** @type {number} */ message)=>{
                    setTimeout(()=>handle(message), 0);
                },
            };
        })() } : {}),
        ...(modalPump ? { modalPump } : {}),
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

test('a type description another apartment of the process asks for is handed over as itself',
    async()=>{
        // An InstallScript engine's IDispatch, served from its own apartment:
        // its caller asks GetTypeInfo on another thread and is given the
        // ITypeInfo, which holds no apartment's state, where it was refused.
        const IID_ITYPEINFO = '{00020401-0000-0000-C000-000000000046}';
        const { remoting, OBJECT } = channel({ exporter: 'sta' });
        const reference = await remoting.exportReference(OBJECT, IID_ITYPEINFO, 'sta');
        assert.equal(await remoting.importReference(reference, IID_ITYPEINFO, 'main'), OBJECT,
            'the object itself, not a proxy');
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

test('the manager starts a service once: a second start finds it running, a class it serves is'
    + ' waited for in that process, and once the process ends the service is stopped', async()=>{
    /** @type {any[]} */
    const launched = [];
    /** @type {(code: number) => void} */
    let end = ()=>{};
    const table = createClassTable({ launch: request=>{
        launched.push(request);
        return { exited: new Promise(resolve=>{
            end = resolve;
        }) };
    } });
    assert.equal(table.serviceRunning('Svc'), false);
    assert.equal(table.startService({ command: 'C:\\svc.exe', service: 'Svc' }, null), 'started');
    assert.equal(table.serviceRunning('svc'), true, 'by its name in any case');
    assert.equal(table.startService({ command: 'C:\\svc.exe', service: 'SVC' }, null), 'running');
    const asked = table.serviceProcess({ command: 'C:\\svc.exe', service: 'Svc', clsid: '{C}' },
        null);
    assert.equal(asked?.fresh, false, 'COM asking for the class finds the process standing');
    assert.equal(launched.length, 1, 'one process');
    assert.deepEqual(launched[0], { command: 'C:\\svc.exe', service: 'Svc', clsid: '' });
    end(0);
    await new Promise(resolve=>setTimeout(resolve, 0));
    assert.equal(table.serviceRunning('Svc'), false, 'its process is gone');
    assert.equal(createClassTable().startService({ command: 'C:\\svc.exe', service: 'Svc' }, null),
        null, 'nothing here starts a process');
});

test('a call that comes in as the apartment\'s own outgoing call is answered is still run: the'
    + ' modal loop ends, and the idle apartment takes it', async()=>{
    // ngen.exe waited for good on BindToRuntimeWorker into mscorsvw.exe: the
    // call was queued while mscorsvw's thread waited on a call of its own,
    // that answer won the modal loop's race, and nothing ran the queue after.
    /** @type {(value: any) => void} */
    let answer = ()=>{};
    /** @type {Promise<any> | null} */
    let incoming = null;
    /** @type {any} */
    let endpoint = null;
    /** @type {any} */
    let reference = null;
    const { remoting, table, calls, OBJECT } = channel({ exporter: 'sta', worker: false,
        window: true, modalPump: async()=>{
            if (incoming === null)
            {
                // Between the loop's looks: the call is queued, then the answer comes.
                incoming = endpoint.deliver({ kind: 'release', object: reference.object,
                    count: 1 });
                answer({ hr: 0 });
            }
            return 0;
        } });
    reference = await remoting.exportReference(OBJECT, IID_IUNKNOWN, 'sta');
    endpoint = table.endpoint(reference.endpoint);
    const other = table.attach({ process: {}, alive: true, rundown: async()=>{},
        deliver: ()=>new Promise(resolve=>{
            answer = resolve;
        }) });
    calls.length = 0;
    await remoting.releaseReference({ endpoint: other, object: 1 }, 'sta');
    // Lost, it is never answered: the test's own timeout is the bound.
    assert.deepEqual(await incoming, { hr: 0 }, 'the queued call ran once the loop had ended');
    assert.ok(calls.length > 0 && calls.every(([, thread])=>thread === 'sta'),
        'on the apartment\'s own thread');
});
