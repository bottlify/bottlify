/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The runtime under a proxy/stub DLL, with the DLL's data laid out as MIDL's
 * dlldata.c and generated tables lay it out, and a guest whose functions are
 * addresses mapped to routines here: a vtable slot, a DLL's dispatch table
 * entry and a host routine the runtime registers are all called the same way.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRuntime } from './runtime.js';
import { FC, POINTER, PROXY_PHASE, RPC_MESSAGE, STUB_MESSAGE } from './ndr.js';
import { HKEY_CLASSES_ROOT, createHive } from '../advapi32/registry.js';
import { parseGuid } from '../ole32/guid.js';

const IID_PROBE = '{8C5E2F10-4B1D-4E7A-9A61-3D2F0C9B7E01}';
const IID_IPSFACTORYBUFFER = '{D5F569D0-593B-101A-B569-08002B2DBF7A}';

/**
 * A guest: memory, a heap, functions by address, and the DLL's tables.
 */
function guest(){
    const memory = new Uint8Array(0x40000);
    const view = new DataView(memory.buffer);
    let top = 0x20000;
    let nextFunction = 0x3f000;
    /** @type {Map<number, (args: number[]) => any>} */
    const functions = new Map();
    /** @type {number[]} */
    const freed = [];
    /** @type {{ code: number, later: boolean }[]} */
    const raised = [];
    /** @type {string[]} */
    const said = [];
    /** @param {number} at */
    const u32 = at=>view.getUint32(at, true);
    /** @param {number} at @param {number} value */
    const w32 = (at, value)=>view.setUint32(at, value >>> 0, true);
    /** @param {number} bytes */
    const allocate = bytes=>{
        const at = (top + 7) & ~7;
        top = at + Math.max(bytes, 4);
        return at;
    };
    /** @param {(args: number[]) => any} routine */
    const define = routine=>{
        const address = nextFunction;
        nextFunction += 4;
        functions.set(address, routine);
        return address;
    };
    const hive = createHive();
    const runtime = createRuntime({
        readMemory: (address, length)=>memory.subarray(address, address + length),
        writeMemory: (address, bytes)=>memory.set(bytes, address),
        allocate,
        free: address=>{
            freed.push(address);
        },
        call: async(entry, args)=>{
            const routine = functions.get(entry >>> 0);
            if (!routine)
            {
                throw new Error(`no function at 0x${entry.toString(16)}`);
            }
            return (await routine(args)) | 0;
        },
        callerThread: ()=>'main',
        register: (_name, fn)=>define(fn.handler),
        raise: code=>{
            raised.push({ code, later: false });
            return 0;
        },
        raiseLater: async code=>{
            raised.push({ code, later: true });
            return 0;
        },
        hive,
        modulePath: module=>module === 0x10000000 ? 'C:\\App\\probe_ps.dll' : null,
        marshaler: ()=>null,
        divergence: detail=>{
            said.push(detail);
        },
    });
    /** @param {string} text */
    const place = (text, bytes = parseGuid(text) ?? new Uint8Array(0))=>{
        const at = allocate(bytes.length);
        memory.set(bytes, at);
        return at;
    };
    return { memory, u32, w32, allocate, define, functions, freed, raised, said, hive, runtime,
        place };
}

/**
 * The tables one interface of four methods of its own compiles to: the
 * proxy vtable (IUnknown's three from rpcrt4, then the DLL's methods), the
 * stub vtable with its dispatch table pointed three entries early, the names,
 * and the ProxyFileInfo list.
 *
 * @param {ReturnType<typeof guest>} g
 * @param {{ tableVersion?: number, stubless?: boolean, delegating?: boolean }} [options]
 *     `delegating`: the stub vtable as MIDL leaves it for an interface that
 *     delegates to its base's, zero but for Release.
 */
function proxyDll(g, { tableVersion = 1, stubless = false, delegating = false } = {}){
    const { runtime } = g;
    const iid = g.place(IID_PROBE);
    /** @type {number[][]} */
    const stubCalls = [];
    const stubRoutine = g.define(args=>{
        stubCalls.push(args);
        return 0;
    });
    const factory = g.allocate(16);
    const methods = [0, 1, 2, 3].map(()=>stubless ? 0xffffffff : g.define(()=>0));
    const header = tableVersion > 1 ? 8 : 4;
    const proxyVtbl = g.allocate(header + 7 * 4);
    g.w32(proxyVtbl + header - 4, iid);
    [runtime.IUnknown_QueryInterface_Proxy, runtime.IUnknown_AddRef_Proxy,
        runtime.IUnknown_Release_Proxy].forEach((fn, index)=>
        g.w32(proxyVtbl + header + index * 4, g.define(fn.handler)));
    methods.forEach((address, index)=>g.w32(proxyVtbl + header + (3 + index) * 4, address));

    const table = g.allocate(4 * 4);
    for (let index = 0; index < 4; index++)
    {
        g.w32(table + index * 4, stubRoutine);
    }
    const stubVtbl = g.allocate(16 + 10 * 4);
    g.memory.fill(0, stubVtbl, stubVtbl + 16 + 10 * 4);
    g.w32(stubVtbl, iid);
    g.w32(stubVtbl + 8, 7);
    g.w32(stubVtbl + 12, table - 3 * 4);
    if (delegating)
    {
        g.w32(stubVtbl + 16 + 2 * 4, g.define(([stub])=>
            runtime.NdrCStdStubBuffer2_Release.handler([stub, factory])));
    }
    else
    {
        [runtime.CStdStubBuffer_QueryInterface, runtime.CStdStubBuffer_AddRef,
            runtime.CStdStubBuffer_Release, runtime.CStdStubBuffer_Connect,
            runtime.CStdStubBuffer_Disconnect, runtime.CStdStubBuffer_Invoke]
            .forEach((fn, index)=>g.w32(stubVtbl + 16 + index * 4, g.define(fn.handler)));
    }

    const name = g.place('', Uint8Array.from([...'IProbe\0'].map(c=>c.charCodeAt(0))));
    const lists = g.allocate(12);
    g.w32(lists, proxyVtbl);
    g.w32(lists + 4, stubVtbl);
    g.w32(lists + 8, name);
    const file = g.allocate(40);
    g.memory.fill(0, file, file + 40);
    g.w32(file, lists);
    g.w32(file + 4, lists + 4);
    g.w32(file + 8, lists + 8);
    g.memory[file + 20] = 1;
    g.memory[file + 22] = tableVersion;
    const list = g.allocate(8);
    g.w32(list, file);
    g.w32(list + 4, 0);
    g.memory.fill(0, factory, factory + 16);
    return { iid, list, factory, proxyVtbl: proxyVtbl + header, stubVtbl, stubCalls };
}

/**
 * @param {ReturnType<typeof guest>} g
 * @param {number} pointer @param {number} slot @param {number[]} args
 */
async function callSlot(g, pointer, slot, args){
    const routine = g.functions.get(g.u32(g.u32(pointer) + slot * 4));
    if (!routine)
    {
        throw new Error(`no method in slot ${slot}`);
    }
    return (await routine([pointer, ...args])) | 0;
}

/** @param {any} hive @param {string} path @param {string} name */
function registryText(hive, path, name = ''){
    const key = hive.open(hive.root(HKEY_CLASSES_ROOT), path);
    const value = key && hive.getValue(key, name);
    return value ? String.fromCharCode(...value.data.subarray(0, value.data.indexOf(0))) : null;
}

test('a proxy DLL registers its interfaces and its factory class, and unregisters them', ()=>{
    const g = guest();
    const dll = proxyDll(g);
    const { NdrDllRegisterProxy, NdrDllUnregisterProxy } = g.runtime;
    assert.equal(NdrDllRegisterProxy.handler([0x10000000, dll.list, 0]), 0);
    // With no class named, the factory is registered under the first IID.
    assert.equal(registryText(g.hive, `Interface\\${IID_PROBE}`), 'IProbe');
    assert.equal(registryText(g.hive, `Interface\\${IID_PROBE}\\NumMethods`), '7');
    assert.equal(registryText(g.hive, `Interface\\${IID_PROBE}\\ProxyStubClsid32`), IID_PROBE);
    assert.equal(registryText(g.hive, `CLSID\\${IID_PROBE}`), 'PSFactoryBuffer');
    assert.equal(registryText(g.hive, `CLSID\\${IID_PROBE}\\InprocServer32`),
        'C:\\App\\probe_ps.dll');
    assert.equal(registryText(g.hive, `CLSID\\${IID_PROBE}\\InprocServer32`, 'ThreadingModel'),
        'Both');

    const named = '{0A0B0C0D-0000-0000-0000-000000000001}';
    assert.equal(NdrDllRegisterProxy.handler([0x10000000, dll.list, g.place(named)]), 0);
    assert.equal(registryText(g.hive, `Interface\\${IID_PROBE}\\ProxyStubClsid32`), named);

    assert.equal(NdrDllUnregisterProxy.handler([0x10000000, dll.list, g.place(named)]), 0);
    assert.equal(registryText(g.hive, `Interface\\${IID_PROBE}`), null);
    assert.equal(registryText(g.hive, `CLSID\\${named}`), null);
});

test('the factory is the DLL\'s own buffer, handed out for its class and no other', ()=>{
    const g = guest();
    const dll = proxyDll(g);
    const { NdrDllGetClassObject, NdrDllCanUnloadNow } = g.runtime;
    const out = g.allocate(4);
    const factoryIid = g.place(IID_IPSFACTORYBUFFER);
    const other = g.place('{00000000-0000-0000-0000-00000000BEEF}');
    assert.equal(NdrDllGetClassObject.handler([other, factoryIid, out, dll.list, 0, dll.factory])
        >>> 0, 0x80040111, 'CLASS_E_CLASSNOTAVAILABLE');
    assert.equal(g.u32(out), 0);
    assert.equal(NdrDllCanUnloadNow.handler([dll.factory]), 0, 'S_OK: nothing holds it');
    assert.equal(NdrDllGetClassObject.handler([dll.iid, factoryIid, out, dll.list, 0,
        dll.factory]), 0);
    assert.equal(g.u32(out), dll.factory);
    assert.notEqual(g.u32(dll.factory), 0, 'with a vtable of its own');
    assert.equal(g.u32(dll.factory + 8), dll.list);
    assert.equal(NdrDllCanUnloadNow.handler([dll.factory]), 1, 'S_FALSE while it is held');

    // With a class of its own, for that class and for the IID of an
    // interface it carries alike; for anything else, still not.
    const named = g.place('{0A0B0C0D-0000-0000-0000-00000000C1A5}');
    assert.equal(NdrDllGetClassObject.handler([named, factoryIid, out, dll.list, named,
        dll.factory]), 0);
    assert.equal(NdrDllGetClassObject.handler([dll.iid, factoryIid, out, dll.list, named,
        dll.factory]), 0, 'an interface\'s IID names the factory too');
    assert.equal(NdrDllGetClassObject.handler([other, factoryIid, out, dll.list, named,
        dll.factory]) >>> 0, 0x80040111);
});

test('a proxy is a CStdProxyBuffer aggregated on its outer object', async()=>{
    const g = guest();
    const dll = proxyDll(g);
    const out = g.allocate(4);
    g.runtime.NdrDllGetClassObject.handler([dll.iid, g.place(IID_IPSFACTORYBUFFER), out,
        dll.list, 0, dll.factory]);
    const factory = g.u32(out);

    // The outer object: counts its references, answers QueryInterface.
    let outerRefs = 1;
    /** @type {number[][]} */
    const queried = [];
    const outerVtbl = g.allocate(12);
    g.w32(outerVtbl, g.define(args=>{
        queried.push(args);
        return 0;
    }));
    g.w32(outerVtbl + 4, g.define(()=>++outerRefs));
    g.w32(outerVtbl + 8, g.define(()=>--outerRefs));
    const outer = g.allocate(4);
    g.w32(outer, outerVtbl);

    const results = g.allocate(8);
    assert.equal(await callSlot(g, factory, 3, [outer, dll.iid, results, results + 4]), 0);
    const buffer = g.u32(results);
    const proxy = g.u32(results + 4);
    assert.equal(proxy, buffer + 4, 'the interface is the word after the proxy buffer\'s');
    assert.equal(g.u32(proxy), dll.proxyVtbl, 'and points at the DLL\'s vtable');
    assert.equal(g.u32(proxy + 8), outer);
    assert.equal(outerRefs, 2, 'the interface is handed out with a reference on the outer');
    assert.equal(g.u32(dll.factory + 4), 2, 'and the proxy holds the factory');

    await callSlot(g, proxy, 1, []);
    assert.equal(outerRefs, 3, 'IUnknown_AddRef_Proxy counts on the outer object');
    await callSlot(g, proxy, 0, [dll.iid, g.allocate(4)]);
    assert.equal(queried.length, 1, 'and QueryInterface asks it');

    // Connect takes a reference on the channel; Disconnect gives it back.
    let channelRefs = 1;
    const channelVtbl = g.allocate(12);
    g.w32(channelVtbl + 4, g.define(()=>++channelRefs));
    g.w32(channelVtbl + 8, g.define(()=>--channelRefs));
    const channel = g.allocate(4);
    g.w32(channel, channelVtbl);
    assert.equal(await callSlot(g, buffer, 3, [channel]), 0);
    assert.equal(g.u32(proxy + 12), channel);
    assert.equal(channelRefs, 2);
    await callSlot(g, buffer, 4, []);
    assert.equal(channelRefs, 1);
    assert.equal(g.u32(proxy + 12), 0);

    assert.equal(await callSlot(g, buffer, 2, []), 0, 'the buffer\'s last reference');
    assert.deepEqual(g.freed, [buffer]);
    assert.equal(g.u32(dll.factory + 4), 1);
});

test('a stubless proxy table is refused, and said to be', async()=>{
    const g = guest();
    const dll = proxyDll(g, { tableVersion: 2, stubless: true });
    const out = g.allocate(4);
    g.runtime.NdrDllGetClassObject.handler([dll.iid, g.place(IID_IPSFACTORYBUFFER), out,
        dll.list, 0, dll.factory]);
    const results = g.allocate(8);
    assert.equal(await callSlot(g, g.u32(out), 3, [0, dll.iid, results, results + 4]) >>> 0,
        0x80004001, 'E_NOTIMPL');
    assert.match(g.said[0], /stubless/);
});

test('a call forwarded to a base stub that was never built is raised, and said to be', ()=>{
    const g = guest();
    assert.equal(g.runtime.NdrStubForwardingFunction.argBytes, 16);
    g.runtime.NdrStubForwardingFunction.handler();
    assert.deepEqual(g.raised.map(one=>one.code), [1764], 'RPC_S_CANNOT_SUPPORT');
    assert.match(g.said[0], /NdrStubForwardingFunction/);
});

test('a stub holds the server object and dispatches by method number', async()=>{
    const g = guest();
    const dll = proxyDll(g);
    const out = g.allocate(4);
    g.runtime.NdrDllGetClassObject.handler([dll.iid, g.place(IID_IPSFACTORYBUFFER), out,
        dll.list, 0, dll.factory]);
    const factory = g.u32(out);

    let serverRefs = 1;
    const serverVtbl = g.allocate(12);
    const server = g.allocate(4);
    g.w32(server, serverVtbl);
    g.w32(serverVtbl, g.define(([self, , ppv])=>{
        g.w32(ppv, self);
        serverRefs++;
        return 0;
    }));
    g.w32(serverVtbl + 8, g.define(()=>--serverRefs));

    const slot = g.allocate(4);
    assert.equal(await callSlot(g, factory, 4, [dll.iid, server, slot]), 0);
    const stub = g.u32(slot);
    assert.equal(g.u32(stub), dll.stubVtbl + 16, 'its vtable is the DLL\'s');
    assert.equal(g.u32(stub + 8), server, 'the server object, where generated stubs read it');
    assert.equal(serverRefs, 2);

    const rpc = g.allocate(RPC_MESSAGE.SIZE);
    const channel = g.allocate(4);
    g.w32(rpc + RPC_MESSAGE.PROC_NUM, 5);
    assert.equal(await callSlot(g, stub, 5, [rpc, channel]), 0);
    assert.equal(dll.stubCalls.length, 1);
    const [self, through, message, phase] = dll.stubCalls[0];
    assert.deepEqual([self, through, message], [stub, channel, rpc]);
    assert.ok(phase !== 0, 'with a phase word of its own');

    g.w32(rpc + RPC_MESSAGE.PROC_NUM, 7);
    assert.equal(await callSlot(g, stub, 5, [rpc, channel]) >>> 0, 0x800706d1,
        'a method past the table is RPC_S_PROCNUM_OUT_OF_RANGE');

    assert.equal(await g.runtime.NdrCStdStubBuffer_Release.handler([stub, dll.factory]), 0);
    assert.equal(serverRefs, 1, 'the last release lets go of the server');
    assert.ok(g.freed.includes(stub));

    // A delegating interface's stub goes through the second entry the same way.
    assert.equal(await callSlot(g, factory, 4, [dll.iid, server, slot]), 0);
    const second = g.u32(slot);
    assert.equal(await g.runtime.NdrCStdStubBuffer2_Release.handler([second, dll.factory]), 0);
    assert.equal(serverRefs, 1);
    assert.ok(g.freed.includes(second));
    assert.equal(g.runtime.NdrCStdStubBuffer2_Release.argBytes, 8);
});

test('a delegating interface\'s stub vtable, zero but for Release, is filled in from rpcrt4\'s'
    + ' own as the factory is made, and its stub dispatches like any other', async()=>{
    // cpsf.c init_psfactory; MIDL's CStdStubBuffer_DELEGATING_METHODS.
    const g = guest();
    const dll = proxyDll(g, { delegating: true });
    const release = g.u32(dll.stubVtbl + 16 + 2 * 4);
    const out = g.allocate(4);
    assert.equal(g.runtime.NdrDllGetClassObject.handler([dll.iid, g.place(IID_IPSFACTORYBUFFER),
        out, dll.list, 0, dll.factory]), 0);
    for (let slot = 0; slot < 10; slot++)
    {
        assert.ok(g.functions.has(g.u32(dll.stubVtbl + 16 + slot * 4)), `slot ${slot} filled`);
    }
    assert.equal(g.u32(dll.stubVtbl + 16 + 2 * 4), release, 'the DLL\'s own Release kept');

    const server = g.allocate(4);
    const serverVtbl = g.allocate(12);
    g.w32(server, serverVtbl);
    g.w32(serverVtbl, g.define(([self, , ppv])=>{
        g.w32(ppv, self);
        return 0;
    }));
    g.w32(serverVtbl + 8, g.define(()=>0));
    const slot = g.allocate(4);
    assert.equal(await callSlot(g, g.u32(out), 4, [dll.iid, server, slot]), 0);
    const stub = g.u32(slot);
    const rpc = g.allocate(RPC_MESSAGE.SIZE);
    g.w32(rpc + RPC_MESSAGE.PROC_NUM, 4);
    assert.equal(await callSlot(g, stub, 5, [rpc, g.allocate(4)]), 0, 'Invoke');
    assert.equal(dll.stubCalls.length, 1, 'the method\'s stub routine ran');
    assert.equal(await callSlot(g, stub, 2, []), 0, 'and the DLL\'s Release lets it go');
    assert.ok(g.freed.includes(stub));
});

test('a proxy call takes its buffer from the channel, sends it, and gives it back', async()=>{
    const g = guest();
    const dll = proxyDll(g);
    const { runtime } = g;

    const proxy = g.allocate(24) + 4;
    g.w32(proxy, dll.proxyVtbl);
    /** @type {string[]} */
    const done = [];
    const channelVtbl = g.allocate(24);
    const reply = g.allocate(16);
    g.w32(reply, 42);
    g.w32(reply + 4, 0);
    g.w32(channelVtbl + 12, g.define(([, rpc, riid])=>{
        done.push(`get ${g.u32(rpc + RPC_MESSAGE.BUFFER_LENGTH)} ${riid === dll.iid}`);
        g.w32(rpc + RPC_MESSAGE.BUFFER, g.allocate(g.u32(rpc + RPC_MESSAGE.BUFFER_LENGTH)));
        return 0;
    }));
    g.w32(channelVtbl + 16, g.define(([, rpc])=>{
        done.push(`send ${g.u32(rpc + RPC_MESSAGE.BUFFER_LENGTH)}`);
        g.w32(rpc + RPC_MESSAGE.BUFFER, reply);
        g.w32(rpc + RPC_MESSAGE.BUFFER_LENGTH, 8);
        return 0;
    }));
    g.w32(channelVtbl + 20, g.define(([, rpc])=>{
        done.push(`free ${g.u32(rpc + RPC_MESSAGE.BUFFER) === reply}`);
        return 0;
    }));
    const channel = g.allocate(4);
    g.w32(channel, channelVtbl);
    g.w32(proxy + 12, channel);

    const rpc = g.allocate(RPC_MESSAGE.SIZE);
    const message = g.allocate(STUB_MESSAGE.SIZE);
    const descriptor = g.allocate(80);
    g.memory.fill(0, descriptor, descriptor + 80);
    runtime.NdrProxyInitialize.handler([proxy, rpc, message, descriptor, 3]);
    assert.equal(g.u32(rpc + RPC_MESSAGE.PROC_NUM), 3);
    assert.equal(g.u32(rpc + RPC_MESSAGE.DATA_REPRESENTATION), 0x10);
    assert.equal(g.u32(message + STUB_MESSAGE.STUB_PHASE), PROXY_PHASE.CALCSIZE);

    g.w32(message + STUB_MESSAGE.BUFFER_LENGTH, 12);
    await runtime.NdrProxyGetBuffer.handler([proxy, message]);
    assert.equal(g.u32(message + STUB_MESSAGE.STUB_PHASE), PROXY_PHASE.MARSHAL);
    const start = g.u32(message + STUB_MESSAGE.BUFFER);
    assert.equal(g.u32(message + STUB_MESSAGE.BUFFER_END), start + 12);
    g.w32(message + STUB_MESSAGE.BUFFER, start + 8);

    await runtime.NdrProxySendReceive.handler([proxy, message]);
    assert.equal(g.u32(message + STUB_MESSAGE.STUB_PHASE), PROXY_PHASE.UNMARSHAL);
    assert.equal(g.u32(message + STUB_MESSAGE.BUFFER), reply);
    assert.equal(g.u32(message + STUB_MESSAGE.BUFFER_END), reply + 8);

    await runtime.NdrProxyFreeBuffer.handler([proxy, message]);
    await runtime.NdrProxyFreeBuffer.handler([proxy, message]);
    assert.deepEqual(done, ['get 12 true', 'send 8', 'free true'],
        'only what was written is sent, and the buffer goes back once');
    assert.deepEqual(g.raised, []);
});

test('a failed send is raised on the calling thread, where the proxy\'s handler takes it',
    async()=>{
        const g = guest();
        const dll = proxyDll(g);
        const { runtime } = g;
        const proxy = g.allocate(24) + 4;
        g.w32(proxy, dll.proxyVtbl);
        const channelVtbl = g.allocate(24);
        g.w32(channelVtbl + 12, g.define(([, rpc])=>{
            g.w32(rpc + RPC_MESSAGE.BUFFER, g.allocate(8));
            return 0;
        }));
        g.w32(channelVtbl + 16, g.define(()=>0x80010108 | 0));
        const channel = g.allocate(4);
        g.w32(channel, channelVtbl);
        g.w32(proxy + 12, channel);
        const rpc = g.allocate(RPC_MESSAGE.SIZE);
        const message = g.allocate(STUB_MESSAGE.SIZE);
        const descriptor = g.allocate(80);
        runtime.NdrProxyInitialize.handler([proxy, rpc, message, descriptor, 3]);
        await runtime.NdrProxyGetBuffer.handler([proxy, message]);
        await runtime.NdrProxySendReceive.handler([proxy, message]);
        assert.deepEqual(g.raised, [{ code: 0x80010108, later: true }]);
        assert.equal(g.u32(message + STUB_MESSAGE.STUB_PHASE), PROXY_PHASE.UNMARSHAL,
            'past the send, so the filter MIDL writes takes it');

        assert.equal(runtime.NdrProxyErrorHandler.handler([0x80010108]) >>> 0, 0x80010108);
        assert.equal(runtime.NdrProxyErrorHandler.handler([1780]) >>> 0, 0x800706f4,
            'an RPC status becomes an HRESULT');

        g.w32(proxy + 12, 0);
        runtime.NdrProxyInitialize.handler([proxy, rpc, message, descriptor, 3]);
        assert.deepEqual(g.raised.at(-1), { code: 0x800401fd, later: false },
            'CO_E_OBJNOTCONNECTED for a proxy nobody connected');
    });

test('a stub reads the request where the channel put it and asks the channel for its reply',
    async()=>{
        const g = guest();
        const dll = proxyDll(g);
        const { runtime } = g;
        const stub = g.allocate(28);
        g.w32(stub, dll.stubVtbl + 16);
        const request = g.allocate(8);
        const rpc = g.allocate(RPC_MESSAGE.SIZE);
        g.memory.fill(0, rpc, rpc + RPC_MESSAGE.SIZE);
        g.w32(rpc + RPC_MESSAGE.BUFFER, request);
        g.w32(rpc + RPC_MESSAGE.BUFFER_LENGTH, 8);
        g.w32(rpc + RPC_MESSAGE.DATA_REPRESENTATION, 0x10);
        const message = g.allocate(STUB_MESSAGE.SIZE);
        const descriptor = g.allocate(80);
        const channelVtbl = g.allocate(16);
        /** @type {number[]} */
        const asked = [];
        g.w32(channelVtbl + 12, g.define(([, taken, riid])=>{
            asked.push(g.u32(taken + RPC_MESSAGE.BUFFER_LENGTH), riid);
            g.w32(taken + RPC_MESSAGE.BUFFER, g.allocate(16));
            return 0;
        }));
        const channel = g.allocate(4);
        g.w32(channel, channelVtbl);

        runtime.NdrStubInitialize.handler([rpc, message, descriptor, channel]);
        assert.equal(g.u32(message + STUB_MESSAGE.BUFFER), request);
        assert.equal(g.u32(message + STUB_MESSAGE.BUFFER_END), request + 8);
        assert.equal(g.memory[message + STUB_MESSAGE.IS_CLIENT], 0);
        runtime.NdrConvert.handler([message, 0]);
        assert.deepEqual(g.raised, [], 'the local representation needs no conversion');

        g.w32(message + STUB_MESSAGE.BUFFER_LENGTH, 16);
        await runtime.NdrStubGetBuffer.handler([stub, channel, message]);
        assert.deepEqual(asked, [16, dll.iid]);
        assert.equal(g.u32(message + STUB_MESSAGE.BUFFER), g.u32(rpc + RPC_MESSAGE.BUFFER));

        g.w32(rpc + RPC_MESSAGE.DATA_REPRESENTATION, 0x00);
        runtime.NdrConvert.handler([message, 0]);
        assert.equal(g.raised.length, 1, 'a big-endian buffer is not converted');
        assert.match(g.said[0], /data representation/);
    });

test('an engine entry point that fails raises its status on the calling thread', async()=>{
    const g = guest();
    const { runtime } = g;
    const message = g.allocate(STUB_MESSAGE.SIZE);
    g.memory.fill(0, message, message + STUB_MESSAGE.SIZE);
    const format = g.place('', Uint8Array.of(FC.RP, POINTER.SIMPLE_POINTER, FC.LONG, FC.PAD));
    await runtime.NdrPointerBufferSize.handler([message, 0, format]);
    assert.deepEqual(g.raised, [{ code: 1780, later: true }], 'RPC_X_NULL_REF_POINTER');
});
