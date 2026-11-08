/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The shim's answers as Wine's conformance tests of mscoree say Windows gives
 * them (mscoree.c: test_versioninfo, test_loadlibraryshim,
 * test_createconfigstream, test_createinstance; metahost.c: test_enumruntimes,
 * test_getruntime, test_notification), over a bottle that has the runtime.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CLR_E_SHIM_RUNTIME, CLSID, IID, createHostingFunctions, metadataVersion }
    from './hosting.js';
import { RUNTIME_INFO_UPGRADE_VERSION, requestedRuntime } from './versions.js';

const S_OK = 0;
const S_FALSE = 1;
const E_POINTER = 0x80004003 | 0;
const E_FAIL = 0x80004005 | 0;
const E_HANDLE = 0x80070006 | 0;
const E_NOTIMPL = 0x80004001 | 0;
const E_NOT_SUFFICIENT_BUFFER = 0x8007007a | 0;
const COR_E_FILENOTFOUND = 0x80070002 | 0;
const HOST_E_INVALIDOPERATION = 0x80131022 | 0;

const FRAMEWORK = 'C:\\WINDOWS\\Microsoft.NET\\Framework\\';
const XML = '<?xml version="1.0" ?>\n<Configuration>\n  <Name>Test</Name>\n</Configuration>';

/** @param {{ installed?: boolean }} [shape] */
function machine(shape = {}){
    const bytes = new Uint8Array(1 << 20);
    const view = new DataView(bytes.buffer);
    let next = 0x1000;
    const allocate = (/** @type {number} */ size)=>{
        const at = next;
        next += (size + 15) & ~15;
        return at;
    };
    /** @type {Map<number, { object: any, iid: string }>} */
    const pointers = new Map();
    /** @type {string[]} */
    const loaded = [];
    /** @type {number[]} */
    const exits = [];
    const files = new Map([
        ['C:\\conf.xml', new TextEncoder().encode(XML)],
        [`${FRAMEWORK}v2.0.50727\\fusion.dll`, new Uint8Array(4)],
        [`${FRAMEWORK}v4.0.30319\\fusion.dll`, new Uint8Array(4)],
    ]);
    const fns = createHostingFunctions({
        readMemory: (at, length)=>bytes.subarray(at, at + length),
        writeMemory: (at, data)=>bytes.set(data, at),
        readWideString: at=>{
            let text = '';
            for (let i = at; view.getUint16(i, true) !== 0; i += 2)
            {
                text += String.fromCharCode(view.getUint16(i, true));
            }
            return text;
        },
        windowsDirectory: ()=>'C:\\WINDOWS',
        installed: ()=>shape.installed !== false,
        exists: path=>files.has(path),
        readFile: async path=>files.get(path) ?? null,
        loadLibrary: async path=>{
            loaded.push(path);
            return 0x10000000 + loaded.length;
        },
        publish: (object, iid)=>{
            const at = allocate(16);
            pointers.set(at, { object, iid });
            return at;
        },
        exitProcess: code=>exits.push(code),
        runtimeInterface: async()=>({ pointer: 0x7777 }),
    });
    /** @param {string} text */
    const wide = text=>{
        const at = allocate(text.length * 2 + 2);
        [...text, '\0'].forEach((unit, i)=>view.setUint16(at + i * 2, unit.charCodeAt(0), true));
        return at;
    };
    /** @param {number} at */
    const text = at=>{
        let out = '';
        for (let i = at; view.getUint16(i, true) !== 0; i += 2)
        {
            out += String.fromCharCode(view.getUint16(i, true));
        }
        return out;
    };
    /** @param {string} name */
    const guid = name=>{
        const at = allocate(16);
        const hex = name.replace(/[{}-]/g, '');
        const raw = Uint8Array.from(hex.match(/../g) ?? [], pair=>parseInt(pair, 16));
        const order = [3, 2, 1, 0, 5, 4, 7, 6, 8, 9, 10, 11, 12, 13, 14, 15];
        order.forEach((from, to)=>{
            bytes[at + to] = raw[from];
        });
        return at;
    };
    const out = ()=>allocate(16);
    const buffer = ()=>allocate(1024);
    const u32 = (/** @type {number} */ at)=>view.getUint32(at, true);
    const setU32 = (/** @type {number} */ at, /** @type {number} */ value)=>
        view.setUint32(at, value, true);
    /** @param {number} pointer @param {string} name @param {...number} args */
    const call = (pointer, name, ...args)=>{
        const held = pointers.get(pointer);
        assert.ok(held, `0x${pointer.toString(16)} was handed out`);
        const method = held.object.interfaceFor(held.iid).methods.find(
            (/** @type {any} */ one)=>one.name === name);
        assert.ok(method, name);
        return method.invoke(held.object, args);
    };
    /** QueryInterface, as the bridge answers it: the same object as another interface. */
    const as = (/** @type {number} */ pointer, /** @type {string} */ iid)=>{
        const held = pointers.get(pointer);
        assert.ok(held?.object.queryInterface(iid), `${iid} on 0x${pointer.toString(16)}`);
        const at = allocate(16);
        pointers.set(at, { object: held?.object, iid });
        return at;
    };
    return { fns, wide, text, guid, out, buffer, u32, setU32, call, as, loaded, exits,
        pointers };
}

test('the requested runtime: exact names, and the newest legacy one for an upgrade', ()=>{
    assert.deepEqual(requestedRuntime('v2.0.50727', 0), { runtime: 'v2.0.50727',
        shown: 'v2.0.50727' });
    assert.deepEqual(requestedRuntime('V2.0.50727', 0), { runtime: 'v2.0.50727',
        shown: 'V2.0.50727' }, 'the case asked with is kept');
    assert.deepEqual(requestedRuntime('v4.0.30319', 0)?.runtime, 'v4.0.30319');
    assert.equal(requestedRuntime(null, 0), null, 'no version without the upgrade flag');
    assert.equal(requestedRuntime(null, RUNTIME_INFO_UPGRADE_VERSION)?.shown, 'v2.0.50727');
    for (const old of ['v1.1.4322', 'v1.1.0', 'v2.0.0'])
    {
        assert.equal(requestedRuntime(old, 0), null, old);
        assert.equal(requestedRuntime(old, RUNTIME_INFO_UPGRADE_VERSION)?.shown, 'v2.0.50727',
            `${old} upgraded`);
    }
    assert.equal(requestedRuntime('v9.0.30319', RUNTIME_INFO_UPGRADE_VERSION), null);
});

test('GetCORVersion and GetCORSystemDirectory: 2.0, its directory, the sizes with the'
    + ' terminator', ()=>{
    const m = machine();
    const buffer = m.buffer();
    const size = m.out();
    assert.equal(m.fns.GetCORVersion.handler([buffer, 1, size]), E_NOT_SUFFICIENT_BUFFER);
    assert.equal(m.fns.GetCORVersion.handler([buffer, 260, size]), S_OK);
    assert.equal(m.text(buffer), 'v2.0.50727');
    assert.equal(m.fns.GetCORSystemDirectory.handler([buffer, 260, size]), S_OK);
    assert.equal(m.text(buffer), `${FRAMEWORK}v2.0.50727\\`);
    assert.equal(m.u32(size), m.text(buffer).length + 1);
    assert.equal(m.fns.GetCORSystemDirectory.handler([buffer, m.u32(size) - 1, size]),
        E_NOT_SUFFICIENT_BUFFER);
    assert.equal(m.fns.GetCORSystemDirectory.handler([buffer, 260, 0]), E_POINTER);
    assert.equal(m.fns.CorIsLatestSvc.handler([0, 0]), E_POINTER);
    const none = machine({ installed: false });
    assert.equal(none.fns.GetCORVersion.handler([buffer, 260, size]), CLR_E_SHIM_RUNTIME);
    assert.equal(none.fns.CLRCreateInstance.handler([none.guid(CLSID.CLR_META_HOST),
        none.guid(IID.CLR_META_HOST), none.out()]), E_NOTIMPL, 'no .NET 4: no metahost');
});

test('GetRequestedRuntimeInfo: either buffer alone, a short one refused, the version as asked',
    ()=>{
        const m = machine();
        const path = m.buffer();
        const version = m.buffer();
        const pathLength = m.out();
        const size = m.out();
        const ask = (/** @type {string | null} */ v, /** @type {number} */ flags,
            /** @type {number} */ pathSize = 260, /** @type {number} */ where = path)=>
            m.fns.GetRequestedRuntimeInfo.handler([0, v === null ? 0 : m.wide(v), 0, 0, flags,
                where, pathSize, pathLength, version, 260, size]);
        assert.equal(ask('v2.0.50727', 0), S_OK);
        assert.equal(m.text(path), FRAMEWORK);
        assert.equal(m.text(version), 'v2.0.50727');
        assert.equal(ask(null, 0), CLR_E_SHIM_RUNTIME);
        assert.equal(ask(null, RUNTIME_INFO_UPGRADE_VERSION), S_OK);
        assert.equal(ask('v2.0.50727', 0, 1), E_NOT_SUFFICIENT_BUFFER);
        assert.equal(ask('V2.0.50727', 0, 260, 0), S_OK, 'no directory buffer');
        assert.equal(m.text(version), 'V2.0.50727');
        assert.equal(ask('v1.1.0', RUNTIME_INFO_UPGRADE_VERSION), S_OK);
        assert.equal(m.text(version), 'v2.0.50727');
        assert.equal(ask('v9.0.30319', RUNTIME_INFO_UPGRADE_VERSION), CLR_E_SHIM_RUNTIME);
    });

test('LoadLibraryShim: a runtime\'s own library by version, the newest legacy one without one',
    async()=>{
        const m = machine();
        const module = m.out();
        assert.equal(await m.fns.LoadLibraryShim.handler([m.wide('fusion'), m.wide('v4.0.30319'),
            0, module]), S_OK);
        assert.equal(await m.fns.LoadLibraryShim.handler([m.wide('fusion.dll'), 0, 0, module]),
            S_OK);
        assert.deepEqual(m.loaded, [`${FRAMEWORK}v4.0.30319\\fusion.dll`,
            `${FRAMEWORK}v2.0.50727\\fusion.dll`]);
        assert.equal(await m.fns.LoadLibraryShim.handler([m.wide('fusion'), m.wide('vbogus'), 0,
            module]), E_HANDLE);
        assert.equal(await m.fns.LoadLibraryShim.handler([m.wide('gdi32.dll'),
            m.wide('v2.0.50727'), 0, module]), E_HANDLE, 'not a library of the runtime');
        assert.equal(m.u32(module), 0);
    });

test('CreateConfigStream: reads the file forward and refuses everything else', async()=>{
    const m = machine();
    const out = m.out();
    assert.equal(await m.fns.CreateConfigStream.handler([m.wide('C:\\conf.xml'), 0]), E_POINTER);
    assert.equal(await m.fns.CreateConfigStream.handler([0, out]), E_FAIL);
    assert.equal(await m.fns.CreateConfigStream.handler([m.wide('C:\\none.xml'), out]),
        COR_E_FILENOTFOUND);
    assert.equal(m.u32(out), 0);
    assert.equal(await m.fns.CreateConfigStream.handler([m.wide('C:\\conf.xml'), out]), S_OK);
    const stream = m.u32(out);
    const buffer = m.buffer();
    const count = m.out();
    assert.equal(m.call(stream, 'Read', buffer, XML.length, count), S_OK);
    assert.equal(m.u32(count), XML.length);
    assert.equal(m.call(stream, 'Read', buffer, 256, count), S_OK);
    assert.equal(m.u32(count), 0, 'nothing after the end');
    assert.equal(m.call(stream, 'Write', buffer, 4, count), E_FAIL);
    for (const name of ['Seek', 'SetSize', 'Clone', 'Commit', 'Revert'])
    {
        assert.equal(m.call(stream, name, 0, 0, 0, 0), E_NOTIMPL, name);
    }
});

test('the metahost: its runtimes enumerated and named exactly, one loaded-notification',
    async()=>{
        const m = machine();
        const out = m.out();
        assert.equal(m.fns.CLRCreateInstance.handler([m.guid(CLSID.CLR_META_HOST),
            m.guid(IID.CLR_META_HOST), out]), S_OK);
        const host = m.u32(out);
        assert.equal(m.fns.CreateInterface.handler([m.guid(CLSID.CLR_META_HOST),
            m.guid(IID.CLR_META_HOST), out]), S_OK);
        assert.equal(m.call(host, 'GetRuntime', 0, m.guid(IID.CLR_RUNTIME_INFO), out),
            E_POINTER);
        assert.equal(m.call(host, 'GetRuntime', m.wide('v4.0.0'), m.guid(IID.CLR_RUNTIME_INFO),
            out), CLR_E_SHIM_RUNTIME, 'versions match exactly');

        assert.equal(m.call(host, 'EnumerateInstalledRuntimes', out), S_OK);
        const runtimes = m.u32(out);
        /** @type {string[]} */
        const names = [];
        const one = m.out();
        while (m.call(runtimes, 'Next', 1, one, 0) === S_OK)
        {
            const info = m.as(m.u32(one), IID.CLR_RUNTIME_INFO);
            const count = m.out();
            const buffer = m.buffer();
            m.setU32(count, 1);
            assert.equal(m.call(info, 'GetVersionString', buffer, count), E_NOT_SUFFICIENT_BUFFER);
            assert.ok(m.u32(count) > 1);
            m.setU32(count, 0xdeadbeef);
            assert.equal(m.call(info, 'GetVersionString', 0, count), S_OK);
            m.setU32(count, 260);
            assert.equal(m.call(info, 'GetVersionString', buffer, count), S_OK);
            assert.equal(m.u32(count), m.text(buffer).length + 1);
            names.push(m.text(buffer));
        }
        assert.deepEqual(names, ['v2.0.50727', 'v4.0.30319']);
        assert.equal(m.call(runtimes, 'Next', 1, one, 0), S_FALSE);

        assert.equal(m.call(host, 'RequestRuntimeLoadedNotification', 0), E_POINTER);
        assert.equal(m.call(host, 'RequestRuntimeLoadedNotification', 0x1234), S_OK);
        assert.equal(m.call(host, 'RequestRuntimeLoadedNotification', 0x5678),
            HOST_E_INVALIDOPERATION);

        assert.equal(m.call(host, 'GetRuntime', m.wide('v4.0.30319'),
            m.guid(IID.CLR_RUNTIME_INFO), out), S_OK);
        const info = m.u32(out);
        assert.equal(await m.call(info, 'GetInterface', m.guid(CLSID.CLR_RUNTIME_HOST),
            m.guid(IID.CLR_RUNTIME_HOST), out), S_OK);
        assert.equal(m.u32(out), 0x7777, 'the runtime\'s own interface, made by its starter');
        const loaded = m.out();
        assert.equal(m.call(info, 'IsLoaded', 0, loaded), S_OK);
        assert.equal(m.u32(loaded), 1);
        await m.call(host, 'ExitProcess', 3);
        assert.deepEqual(m.exits, [3]);
    });

test('GetVersionFromFile reads the runtime an assembly was built for from its metadata', ()=>{
    // A PE32 with one section holding a CLI header that points at a metadata
    // root ("BSJB", version string "v4.0.30319").
    const file = new Uint8Array(0x400);
    const view = new DataView(file.buffer);
    view.setUint16(0, 0x5a4d, true);
    view.setUint32(0x3c, 0x80, true);
    view.setUint32(0x80, 0x4550, true);
    view.setUint16(0x86, 1, true);
    view.setUint16(0x94, 224, true);
    view.setUint16(0x98, 0x10b, true);
    const directory = 0x98 + 96 + 14 * 8;
    view.setUint32(directory, 0x2000, true);
    const section = 0x98 + 224;
    view.setUint32(section + 8, 0x200, true);
    view.setUint32(section + 12, 0x2000, true);
    view.setUint32(section + 16, 0x200, true);
    view.setUint32(section + 20, 0x200, true);
    view.setUint32(0x200 + 8, 0x2040, true);
    view.setUint32(0x240, 0x424a5342, true);
    view.setUint32(0x240 + 12, 12, true);
    file.set(new TextEncoder().encode('v4.0.30319'), 0x240 + 16);
    assert.equal(metadataVersion(file), 'v4.0.30319');
    assert.equal(metadataVersion(new Uint8Array(0x80)), null, 'not an image');
});
