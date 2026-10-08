/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeValue, encodeValue } from './system/codec.js';
import { createClassTable } from './layers/win32/ole32/remote.js';
import { comHandlers, remoteClassTable } from './com-link.js';

/** @param {any} value */
const across = value=>decodeValue(encodeValue(value));

/**
 * A process across a link, in this thread: what it asks of the run's table
 * crosses through the codec, as a link's calls do, and what the run delivers
 * to it arrives in its handlers.
 *
 * @param {ReturnType<typeof createClassTable>} table
 * @param {Parameters<typeof comHandlers>[1]['launch']} [launch]
 * @param {import('./layers/win32/ole32/remote.js').ClassTableHooks} [hooks]
 */
function processOn(table, launch, hooks){
    /** @type {Record<string, any>} */
    const handlers = {};
    const side = comHandlers(table, {
        call: async(method, args)=>across(await handlers.com[method](...across(args))),
        launch,
    });
    /** @param {string} method @param {any[]} args */
    const ask = (method, args)=>across(/** @type {any} */ (side.handlers)[method](...across(args)));
    /** @param {string} method @param {any[]} args */
    const call = async(method, args)=>across(
        await /** @type {any} */ (side.handlers)[method](...across(args)));
    return { side, table: remoteClassTable({ ask, call, handlers }, hooks) };
}

const CLSID = '{6B2F0C1E-3D4A-4E8B-9A51-2C7D10E348B6}';

/** An endpoint as `ole32/remote.js` makes one, answering what it is sent. @param {unknown} process */
const endpointOf = process=>({
    process,
    alive: true,
    /** @type {any[]} */
    seen: [],
    /** @param {any} message */
    async deliver(message){
        this.seen.push(message);
        return { hr: 0, reply: [message.kind, new Uint8Array([1, 2, 3])] };
    },
    async rundown(){},
});

test('what one process sends another goes through the run\'s table and comes back answered',
    async()=>{
        const table = createClassTable();
        const server = processOn(table);
        const client = processOn(table);
        const served = endpointOf('server');
        const id = server.table.attach(served);
        server.table.register({ clsid: CLSID, endpoint: id, object: 7, flags: 1, cookie: 1,
            suspended: false, used: false });
        const entry = client.table.take(CLSID);
        assert.equal(entry?.endpoint, id);
        const endpoint = client.table.endpoint(id);
        assert.equal(endpoint?.alive, true);
        const reply = await endpoint?.deliver({ kind: 'call', object: 7, slot: 3,
            request: [new Uint8Array([9])] });
        assert.deepEqual(reply, { hr: 0, reply: ['call', new Uint8Array([1, 2, 3])] });
        assert.deepEqual(served.seen, [{ kind: 'call', object: 7, slot: 3,
            request: [new Uint8Array([9])] }]);
        assert.equal(server.table.endpoint(id), served, 'a process\'s own endpoint is its own');

        await server.table.ended('server');
        assert.equal(client.table.take(CLSID), null, 'its class went with it');
        assert.equal(client.table.endpoint(id)?.alive, false);
        assert.deepEqual(await client.table.endpoint(id)?.deliver({ kind: 'call', object: 7 }),
            { hr: 0x80010108 | 0, disconnected: true });
    });

test('a server the run has no room for is started beside the process that asked, and waited'
    + ' on until it registers or ends', async()=>{
    const table = createClassTable();
    /** @type {string[]} */
    const started = [];
    /** @type {(() => void) | null} */
    let end = null;
    const client = processOn(table, ()=>null, { launch: request=>{
        started.push(request.command);
        return { exited: new Promise(resolve=>{
            end = ()=>resolve(1);
        }) };
    } });
    const server = processOn(table);
    const launched = client.table.hooks.launch?.({ command: 'server.exe', clsid: CLSID }, 'client');
    assert.deepEqual(started, ['server.exe']);
    const registered = client.table.whenRegistered(CLSID, /** @type {any} */ (launched).exited);
    server.table.register({ clsid: CLSID, endpoint: server.table.attach(endpointOf('server')),
        object: 1, flags: 1, cookie: 1, suspended: false, used: false });
    assert.equal(await registered, true);

    const other = '{00000000-0000-0000-0000-000000000001}';
    const again = client.table.hooks.launch?.({ command: 'other.exe', clsid: other }, 'client');
    const waited = client.table.whenRegistered(other, /** @type {any} */ (again).exited);
    /** @type {any} */ (end)();
    assert.equal(await waited, false, 'a server that ended without registering is given up on');
});

test('a server the run starts in a worker of its own is waited on through the run', async()=>{
    const table = createClassTable();
    /** @type {(() => void) | null} */
    let end = null;
    const client = processOn(table, ()=>({ exited: new Promise(resolve=>{
        end = ()=>resolve(0);
    }) }), { launch: ()=>assert.fail('not started beside') });
    const launched = client.table.hooks.launch?.({ command: 'server.exe', clsid: CLSID }, 'client');
    const registered = client.table.whenRegistered(CLSID, /** @type {any} */ (launched).exited);
    /** @type {any} */ (end)();
    assert.equal(await registered, false);
});

test('a process gone without saying so takes its classes with it', async()=>{
    const table = createClassTable();
    const server = processOn(table);
    server.table.register({ clsid: CLSID, endpoint: server.table.attach(endpointOf('server')),
        object: 1, flags: 1, cookie: 1, suspended: false, used: false });
    await server.side.gone();
    assert.equal(table.take(CLSID), null);
});

test('an RPC endpoint is claimed and found through the run\'s table, and a process that is gone'
    + ' loses it', async()=>{
    const table = createClassTable();
    const server = processOn(table);
    const client = processOn(table);
    const id = server.table.attach(endpointOf('server'));
    assert.equal(server.table.rpcListen('ncalrpc:midl', id), true);
    assert.equal(client.table.rpcServer('ncalrpc:midl'), id);
    assert.equal(client.table.rpcListen('ncalrpc:midl', client.table.attach(endpointOf('client'))),
        false);
    const reply = await client.table.endpoint(id)?.deliver({ kind: 'rpc', proc: 1 });
    assert.deepEqual(reply, { hr: 0, reply: ['rpc', new Uint8Array([1, 2, 3])] });

    server.table.rpcUnlisten(id, 'ncalrpc:midl');
    assert.equal(client.table.rpcServer('ncalrpc:midl'), null);
    assert.equal(server.table.rpcListen('ncalrpc:again', id), true);
    await server.side.gone();
    assert.equal(client.table.rpcServer('ncalrpc:again'), null);
});
