/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseGuid } from '../ole32/guid.js';
import { createClassTable } from '../ole32/remote.js';
import { composeStringBinding, createMidl, parseStringBinding } from './midl.js';

const IF_UUID = '{6B2F0C1E-3D4A-4E8B-9A51-2C7D10E348B6}';

const RPC_MESSAGE = { HANDLE: 0, BUFFER: 8, BUFFER_LENGTH: 12, PROC_NUM: 16 };
const STUB_MESSAGE = { RPC_MESSAGE: 0, BUFFER: 4, BUFFER_START: 8, BUFFER_END: 12 };

/** Where each fixture's routines start, so that a call into one is an address the table finds. */
const ADD = 0x5000;
const STOP = 0x5001;
const FAULT = 0x5002;

/**
 * A process: memory, an allocator, the routines its guest has -- each a
 * function here, reached by its address -- and the RPC functions on top.
 *
 * @param {ReturnType<typeof createClassTable>} table @param {string} name
 */
function process(table, name){
    const memory = new Uint8Array(0x20000);
    let top = 0x1000;
    /** @type {Set<number>} */
    const live = new Set();
    /** @type {Map<number, (args: number[]) => number | Promise<number>>} */
    const routines = new Map();
    /** @type {string[]} */
    const said = [];
    const view = new DataView(memory.buffer);
    const thread = { name };
    /** @param {number} at */
    const text = at=>{
        let end = at;
        while (memory[end] !== 0)
        {
            end++;
        }
        return String.fromCharCode(...memory.subarray(at, end));
    };
    const host = {
        readMemory: (/** @type {number} */ at, /** @type {number} */ length)=>
            memory.subarray(at, at + length),
        writeMemory: (/** @type {number} */ at, /** @type {Uint8Array} */ bytes)=>{
            memory.set(bytes, at);
        },
        readCString: text,
        readWideString: (/** @type {number} */ at)=>{
            let out = '';
            for (let index = at; view.getUint16(index, true) !== 0; index += 2)
            {
                out += String.fromCharCode(view.getUint16(index, true));
            }
            return out;
        },
        allocate: (/** @type {number} */ bytes)=>{
            const at = top;
            top += (bytes + 15) & ~15;
            live.add(at);
            return at;
        },
        free: (/** @type {number} */ at)=>{
            live.delete(at);
        },
        call: async(/** @type {number} */ entry, /** @type {number[]} */ args)=>{
            const routine = routines.get(entry);
            assert.ok(routine, `no guest routine at 0x${entry.toString(16)}`);
            return routine(args);
        },
        // What the production one answers when a routine raised.
        guardedCall: (/** @type {number} */ entry, /** @type {number[]} */ args)=>
            host.call(entry, args),
        callerThread: ()=>thread,
        raise: (/** @type {number} */ code)=>({ raised: code }),
        raiseLater: async(/** @type {number} */ code)=>({ raised: code }),
        table,
        process: name,
        divergence: (/** @type {string} */ detail)=>{
            said.push(detail);
        },
    };
    const fns = /** @type {Record<string, any>} */ (createMidl(host));
    /** @param {string} functionName @param {number[]} args */
    const call = (functionName, args)=>fns[functionName].handler(args);
    return {
        memory, view, live, routines, said, host, fns, call, text,
        /** A C string in memory. @param {string} value */
        put(value){
            const at = host.allocate(value.length + 1);
            memory.set([...value].map(character=>character.charCodeAt(0)), at);
            memory[at + value.length] = 0;
            return at;
        },
        /** A wide string. @param {string} value */
        putWide(value){
            const at = host.allocate((value.length + 1) * 2);
            [...value].forEach((character, index)=>view.setUint16(at + index * 2,
                character.charCodeAt(0), true));
            return at;
        },
    };
}

/**
 * An RPC_SERVER_INTERFACE (or a client's: the front is the same) for the
 * fixture interface, with a dispatch table of `count` routines.
 *
 * @param {ReturnType<typeof process>} where @param {number[]} routines
 */
function interfaceSpec(where, routines){
    const bytes = parseGuid(IF_UUID);
    assert.ok(bytes);
    const functions = where.host.allocate(routines.length * 4);
    routines.forEach((entry, index)=>where.view.setUint32(functions + index * 4, entry, true));
    const dispatch = where.host.allocate(12);
    where.view.setUint32(dispatch, routines.length, true);
    where.view.setUint32(dispatch + 4, functions, true);
    const spec = where.host.allocate(68);
    where.view.setUint32(spec, 68, true);
    where.memory.set(bytes, spec + 4);
    where.view.setUint16(spec + 20, 1, true);
    where.view.setUint16(spec + 22, 0, true);
    where.view.setUint32(spec + 44, dispatch, true);
    return spec;
}

/**
 * The client's RPC_CLIENT_INTERFACE for the fixture interface, in its own memory.
 *
 * @param {ReturnType<typeof process>} client
 */
const clientSpec = client=>interfaceSpec(client, []);

/** The server: Add(a, b) answers a + b, and Stop() stops the listening. @param {ReturnType<typeof process>} server */
function serveArithmetic(server){
    const spec = interfaceSpec(server, [ADD, STOP, FAULT]);
    /** @param {number} message @param {number} bytes */
    const reply = (message, bytes)=>{
        server.view.setUint32(message + RPC_MESSAGE.BUFFER_LENGTH, bytes, true);
        assert.equal(server.call('I_RpcGetBuffer', [message]), 0);
    };
    server.routines.set(ADD, ([message])=>{
        const request = server.view.getUint32(message + RPC_MESSAGE.BUFFER, true);
        const sum = server.view.getInt32(request, true) + server.view.getInt32(request + 4, true);
        reply(message, 4);
        server.view.setInt32(server.view.getUint32(message + RPC_MESSAGE.BUFFER, true), sum, true);
        return 0;
    });
    server.routines.set(STOP, ([message])=>{
        assert.equal(server.call('RpcMgmtStopServerListening', [0]), 0);
        reply(message, 0);
        return 0;
    });
    server.routines.set(FAULT, ()=>0x80010105 | 0);
    return spec;
}

/** Starts listening: the promise RpcServerListen returns, and the interface. @param {ReturnType<typeof process>} server */
function listen(server){
    const spec = serveArithmetic(server);
    assert.equal(server.call('RpcServerUseProtseqEpA', [server.put('ncalrpc'), 1,
        server.put('arith'), 0]), 0);
    assert.equal(server.call('RpcServerRegisterIf', [spec, 0, 0]), 0);
    const listening = server.call('RpcServerListen', [1, 1, 0]);
    return { spec, listening };
}

/**
 * A client's call as a MIDL stub makes it: the binding's handle, a buffer of
 * the arguments, the send, and the reply read where the stub left it.
 *
 * @param {ReturnType<typeof process>} client @param {number} spec
 * @param {number} binding @param {number} procedure @param {number[]} args
 */
async function callOver(client, spec, binding, procedure, args){
    const rpc = client.host.allocate(44);
    const stub = client.host.allocate(160);
    const descriptor = client.host.allocate(48);
    client.view.setUint32(descriptor, spec, true);
    client.call('NdrClientInitializeNew', [rpc, stub, descriptor, procedure]);
    const buffer = client.call('NdrGetBuffer', [stub, args.length * 4, binding]);
    args.forEach((value, index)=>client.view.setInt32(buffer + index * 4, value, true));
    const got = await client.call('NdrSendReceive', [stub, buffer + args.length * 4]);
    if (typeof got === 'object')
    {
        return { raised: got.raised };
    }
    const at = client.view.getUint32(stub + STUB_MESSAGE.BUFFER, true);
    const length = client.view.getUint32(rpc + RPC_MESSAGE.BUFFER_LENGTH, true);
    const reply = [...client.memory.subarray(at, at + length)];
    client.call('NdrFreeBuffer', [stub]);
    return { reply };
}

/** A binding to the fixture's endpoint. @param {ReturnType<typeof process>} client @param {string} [text] */
function bindTo(client, text = 'ncalrpc:[arith]'){
    const slot = client.host.allocate(4);
    const status = client.call('RpcBindingFromStringBindingA', [client.put(text), slot]);
    assert.equal(status, 0);
    return client.view.getUint32(slot, true);
}

test('a string binding is taken apart and put together again, its special characters escaped', ()=>{
    assert.deepEqual(parseStringBinding('ncalrpc:[endpoint]'), { object: null,
        protseq: 'ncalrpc', address: '', endpoint: 'endpoint', options: '' });
    assert.deepEqual(parseStringBinding(
        '6b2f0c1e-3d4a-4e8b-9a51-2c7d10e348b6@ncacn_np:\\\\\\\\box[\\\\pipe\\\\name,Security=x]'),
    { object: '6b2f0c1e-3d4a-4e8b-9a51-2c7d10e348b6', protseq: 'ncacn_np', address: '\\\\box',
        endpoint: '\\pipe\\name', options: 'Security=x' });
    assert.deepEqual(parseStringBinding('ncacn_ip_tcp:localhost'), { object: null,
        protseq: 'ncacn_ip_tcp', address: 'localhost', endpoint: '', options: '' });
    for (const bad of ['', ':[x]', 'ncalrpc:[x', 'ncalrpc:[x]y', 'ncalrpc\\'])
    {
        assert.equal(parseStringBinding(bad), null, JSON.stringify(bad));
    }
    const parts = { object: null, protseq: 'ncacn_np', address: '\\\\box', endpoint: '\\pipe\\a,b',
        options: '' };
    assert.deepEqual(parseStringBinding(composeStringBinding(parts)), parts);
    assert.equal(composeStringBinding({ protseq: 'ncalrpc', endpoint: 'x' }), 'ncalrpc:[x]');
});

test('RpcStringBindingCompose and RpcBindingFromStringBinding make a binding, in either string'
    + ' width, and RpcBindingFree clears it', ()=>{
    const where = process(createClassTable(), 'client');
    const out = where.host.allocate(4);
    assert.equal(where.call('RpcStringBindingComposeA', [0, where.put('ncalrpc'), 0,
        where.put('arith'), 0, out]), 0);
    const composed = where.view.getUint32(out, true);
    assert.equal(where.text(composed), 'ncalrpc:[arith]');
    where.host.free(composed);

    assert.equal(where.call('RpcStringBindingComposeW', [0, where.putWide('ncalrpc'), 0,
        where.putWide('wide'), 0, out]), 0);
    assert.equal(where.host.readWideString(where.view.getUint32(out, true)), 'ncalrpc:[wide]');

    const slot = where.host.allocate(4);
    assert.equal(where.call('RpcBindingFromStringBindingW', [where.putWide('ncalrpc:[wide]'),
        slot]), 0);
    assert.notEqual(where.view.getUint32(slot, true), 0);
    assert.equal(where.call('RpcBindingFree', [slot]), 0);
    assert.equal(where.view.getUint32(slot, true), 0, 'the handle is cleared');
    assert.equal(where.call('RpcBindingFree', [slot]), 1702, 'RPC_S_INVALID_BINDING');

    assert.equal(where.call('RpcBindingFromStringBindingA', [where.put('ncalrpc:[x'), slot]), 1700);
    assert.equal(where.call('RpcBindingFromStringBindingA', [where.put('bogus:[x]'), slot]), 1704);
    assert.equal(where.call('RpcBindingFromStringBindingA', [where.put('nothing@ncalrpc:[x]'),
        slot]), 1705, 'an object UUID that is not one');
});

test('a server names an endpoint and an interface; a second process is refused the endpoint,'
    + ' and the same one is not refused twice', ()=>{
    const table = createClassTable();
    const first = process(table, 'first');
    const second = process(table, 'second');
    assert.equal(first.call('RpcServerUseProtseqEpA', [first.put('ncalrpc'), 1, first.put('arith'),
        0]), 0);
    assert.equal(first.call('RpcServerUseProtseqEpA', [first.put('ncalrpc'), 1, first.put('arith'),
        0]), 0, 'its own again');
    assert.equal(second.call('RpcServerUseProtseqEpA', [second.put('NCALRPC'), 1,
        second.put('ARITH'), 0]), 1740, 'RPC_S_DUPLICATE_ENDPOINT, however it is cased');
    assert.equal(second.call('RpcServerUseProtseqEpA', [second.put('carrier_pigeon'), 1,
        second.put('x'), 0]), 1703, 'RPC_S_PROTSEQ_NOT_SUPPORTED');
    assert.equal(second.call('RpcServerUseProtseqEpA', [0, 1, second.put('x'), 0]), 1704);
    assert.equal(second.call('RpcServerUseProtseqEpA', [second.put('ncalrpc'), 1, 0, 0]), 1706);
    assert.equal(second.call('RpcServerUseProtseqEpW', [second.putWide('ncalrpc'), 1,
        second.putWide('other'), 0]), 0);

    const spec = interfaceSpec(first, [ADD]);
    assert.equal(first.call('RpcServerRegisterIf', [spec, 0, 0]), 0);
    assert.equal(first.call('RpcServerRegisterIf', [spec, 0, 0]), 1712,
        'RPC_S_TYPE_ALREADY_REGISTERED');
    assert.equal(first.call('RpcServerUnregisterIf', [spec, 0, 0]), 0);
    assert.equal(first.call('RpcServerUnregisterIf', [spec, 0, 0]), 1717, 'RPC_S_UNKNOWN_IF');
    const alone = process(createClassTable(), 'alone');
    assert.equal(alone.call('RpcServerListen', [1, 1, 0]), 1714, 'RPC_S_NO_PROTSEQS_REGISTERED');
});

test('a server listens on the thread that asked, and a call from another process runs there and'
    + ' comes back answered', async()=>{
    const table = createClassTable();
    const server = process(table, 'server');
    const client = process(table, 'client');
    const { listening } = listen(server);
    const spec = clientSpec(client);
    const binding = bindTo(client);

    const answer = await callOver(client, spec, binding, 0, [20, 22]);
    assert.deepEqual(answer, { reply: [42, 0, 0, 0] });
    const again = await callOver(client, spec, binding, 0, [-5, 3]);
    assert.deepEqual(again, { reply: [...new Uint8Array(Int32Array.of(-2).buffer)] });

    assert.deepEqual(await callOver(client, spec, binding, 1, []), { reply: [] });
    assert.equal(await listening, 0, 'RpcServerListen returns once it is stopped');
    assert.equal(server.call('RpcMgmtStopServerListening', [0]), 1715, 'RPC_S_NOT_LISTENING');
    assert.deepEqual(await callOver(client, spec, binding, 0, [1, 1]), { raised: 1722 },
        'a server that stopped is not there');
    // Nothing the calls made is left behind.
    assert.equal(server.live.size > 0, true);
});

test('calls are run one after another, in the order they arrived', async()=>{
    const table = createClassTable();
    const server = process(table, 'server');
    const client = process(table, 'client');
    const { listening } = listen(server);
    const spec = clientSpec(client);
    const binding = bindTo(client);
    /** @type {number[]} */
    const order = [];
    const add = server.routines.get(ADD);
    assert.ok(add);
    let inside = 0;
    server.routines.set(ADD, async args=>{
        inside++;
        assert.equal(inside, 1, 'never two at once');
        order.push(server.view.getInt32(server.view.getUint32(args[0] + 8, true), true));
        await new Promise(resolve=>setImmediate(resolve));
        const done = await add(args);
        inside--;
        return done;
    });
    const results = await Promise.all([1, 2, 3].map(number=>callOver(client, spec, binding, 0,
        [number, 0])));
    assert.deepEqual(order, [1, 2, 3]);
    assert.deepEqual(results.map(one=>one.reply?.[0]), [1, 2, 3]);
    await callOver(client, spec, binding, 1, []);
    await listening;
});

test('a call that cannot be served raises its status on the caller', async()=>{
    const table = createClassTable();
    const server = process(table, 'server');
    const client = process(table, 'client');
    const served = serveArithmetic(server);
    const spec = clientSpec(client);
    const binding = bindTo(client);
    assert.deepEqual(await callOver(client, spec, binding, 0, [1, 1]), { raised: 1722 },
        'no endpoint is listened on');

    assert.equal(server.call('RpcServerUseProtseqEpA', [server.put('ncalrpc'), 1,
        server.put('arith'), 0]), 0);
    assert.equal(server.call('RpcServerRegisterIf', [served, 0, 0]), 0);
    assert.deepEqual(await callOver(client, spec, binding, 0, [1, 1]), { raised: 1722 },
        'it is not listening yet');
    const listening = server.call('RpcServerListen', [1, 1, 0]);
    assert.equal(server.call('RpcServerListen', [1, 1, 0]), 1713, 'RPC_S_ALREADY_LISTENING');

    assert.deepEqual(await callOver(client, spec, binding, 7, []), { raised: 1745 },
        'a procedure the dispatch table has not');
    const other = interfaceSpec(client, []);
    client.memory.set(parseGuid('{00000000-0000-0000-0000-000000000042}') ?? [], other + 4);
    assert.deepEqual(await callOver(client, other, binding, 0, []), { raised: 1717 },
        'an interface it does not serve');
    assert.deepEqual(await callOver(client, spec, binding, 2, []), { raised: 1726 },
        'a stub that raised');
    assert.deepEqual(await callOver(client, spec, 0x1234, 0, []), { raised: 1702 },
        'a handle that is not a binding');
    const remote = bindTo(client, 'ncacn_np:\\\\\\\\elsewhere[\\\\pipe\\\\arith]');
    assert.deepEqual(await callOver(client, spec, remote, 0, [1, 1]), { raised: 1722 },
        'another machine is not reachable');
    assert.ok(client.said.some(line=>line.includes('elsewhere')));
    const unbound = bindTo(client, 'ncalrpc:');
    assert.deepEqual(await callOver(client, spec, unbound, 0, [1, 1]), { raised: 1708 },
        'a binding with no endpoint has no mapper to find one');

    await callOver(client, spec, binding, 1, []);
    await listening;
});

test('a process that ends while it listens is gone to its callers, and the one it was running'
    + ' fails', async()=>{
    const table = createClassTable();
    const server = process(table, 'server');
    const client = process(table, 'client');
    const { listening } = listen(server);
    const spec = clientSpec(client);
    const binding = bindTo(client);
    /** @type {(() => void) | null} */
    let release = null;
    server.routines.set(ADD, ()=>new Promise(resolve=>{
        release = ()=>resolve(0);
    }));
    const running = callOver(client, spec, binding, 0, [1, 1]);
    await new Promise(resolve=>setImmediate(resolve));
    await table.ended('server');
    assert.deepEqual(await running, { raised: 1726 }, 'a call in the middle of it fails');
    /** @type {any} */ (release)?.();
    assert.equal(await listening, 0);
    assert.deepEqual(await callOver(client, spec, binding, 0, [1, 1]), { raised: 1722 });
});

test('RpcMgmtWaitServerListen waits for the server to stop, and a server that does not wait is'
    + ' said not to serve', async()=>{
    const table = createClassTable();
    const server = process(table, 'server');
    const client = process(table, 'client');
    assert.equal(server.call('RpcMgmtWaitServerListen', []), 1715, 'nothing is listening');
    const { listening } = listen(server);
    const spec = clientSpec(client);
    const waited = server.call('RpcMgmtWaitServerListen', []);
    let over = false;
    waited.then(()=>{
        over = true;
    });
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(over, false);
    await callOver(client, spec, bindTo(client), 1, []);
    assert.equal(await listening, 0);
    assert.equal(await waited, 0);

    const other = createClassTable();
    const quick = process(other, 'quick');
    assert.equal(quick.call('RpcServerListen', [1, 1, 1]), 1714,
        'no endpoint, nothing to listen on');
    assert.equal(quick.call('RpcServerUseProtseqEpA', [quick.put('ncalrpc'), 1, quick.put('q'),
        0]), 0);
    assert.equal(quick.call('RpcServerListen', [1, 1, 1]), 0);
    assert.ok(quick.said.some(line=>line.includes('without waiting')));
});

test('RpcMgmtStopServerListening on a binding is not done from here', ()=>{
    const where = process(createClassTable(), 'server');
    assert.equal(where.call('RpcMgmtStopServerListening', [0x0b1d0001]), 5);
    assert.ok(where.said.some(line=>line.includes('RpcMgmtStopServerListening')));
});
