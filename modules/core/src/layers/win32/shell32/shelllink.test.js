/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, Version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createComRegistry } from '../ole32/objects.js';
import { createOleFunctions } from '../ole32/functions.js';
import { parseGuid } from '../ole32/guid.js';
import {
    CLSID_SHELL_LINK, IID_IPERSIST_FILE, IID_ISHELL_LINK_A, IID_ISHELL_LINK_W,
    registerShellLinkClasses,
} from './shelllink.js';

const S_OK = 0x00000000;
const S_FALSE = 0x00000001;
const STG_E_FILENOTFOUND = 0x80030002 | 0;
const COINIT_APARTMENTTHREADED = 0x2;

/** Guest addresses the fixtures use, far enough apart that nothing overlaps. */
const CLSID_ARG = 0x1000;
const IID_ARG = 0x1020;
const PPV = 0x1100;
const STR = 0x2000;
const BUF = 0x2800;

/** A bump allocator standing in for the task heap a GetCurFile string comes from. */
function fakeHeap(base = 0x8000){
    let next = base;
    return {
        /** @param {number} bytes */
        allocate(bytes){
            const at = next;
            next += Math.max(8, bytes);
            return at;
        },
        free: ()=>true,
        block: ()=>null,
        resize: ()=>false,
    };
}

function setup(){
    const bytes = new Uint8Array(0x10000);
    /** @type {string[]} */
    const reported = [];
    /** Every path Save or Load has seen, as the volume would hold it. */
    const volume = new Set();

    /** @param {number} address @param {number} length */
    const readMemory = (address, length)=>bytes.subarray(address, address + length);
    /** @param {number} address @param {Uint8Array} data */
    const writeMemory = (address, data)=>bytes.set(data, address);
    /**
     * As the memory layer reads an ANSI string: in Windows-1252, which is what
     * the Encoding standard calls latin1.
     *
     * @param {number} address @param {number} maxLength
     */
    const readCString = (address, maxLength)=>{
        let end = address;
        while (end - address < maxLength && bytes[end] !== 0)
        {
            end++;
        }
        return new TextDecoder('latin1').decode(bytes.subarray(address, end));
    };
    /** @param {number} address @param {number} maxLength */
    const readWideString = (address, maxLength)=>{
        let text = '';
        for (let at = 0; at < maxLength; at++)
        {
            const unit = bytes[address + at * 2] | (bytes[address + at * 2 + 1] << 8);
            if (unit === 0)
            {
                break;
            }
            text += String.fromCharCode(unit);
        }
        return text;
    };

    const heap = fakeHeap();
    const shellHost = {
        readMemory,
        writeMemory,
        readCString,
        readWideString,
        /** @param {number} size */
        allocate: size=>heap.allocate(size),
        files: {
            /** @param {string} path */
            stat: path=>(volume.has(path) ? { exists: true, isDirectory: false } : null),
            /** @param {string} path */
            open: path=>{
                volume.add(path);
                return { path };
            },
            close: ()=>{},
        },
        /** @param {string} api @param {string} detail */
        divergence: (api, detail)=>reported.push(`${api}: ${detail}`),
    };

    const registry = createComRegistry();
    registerShellLinkClasses(registry, shellHost);

    /** The object the last successful CoCreateInstance published. */
    /** @type {any[]} */
    const created = [];
    let nextVtable = 0x20000;
    const oleHost = {
        readMemory,
        writeMemory,
        /** @param {number} address @param {number} value @param {number} length */
        fillMemory: (address, value, length)=>bytes.fill(value, address, address + length),
        currentThread: ()=>thread,
        heap,
        registry,
        vtables: {
            /** @param {any} object @param {string} interfaceId */
            publish(object, interfaceId){
                const record = object.interfaceFor(interfaceId);
                if (!record)
                {
                    return 0;
                }
                created.push(object);
                nextVtable += 0x100;
                return nextVtable;
            },
        },
        /** @param {string} api @param {string} detail */
        divergence: (api, detail)=>reported.push(`${api}: ${detail}`),
    };
    const thread = { id: 0x100 };
    const fns = createOleFunctions(oleHost);

    return {
        bytes, volume, reported, created, fns, registry,
        /** @param {number} address @param {string} text */
        putAnsi(address, text){
            for (let at = 0; at < text.length; at++)
            {
                bytes[address + at] = text.charCodeAt(at) & 0xff;
            }
            bytes[address + text.length] = 0;
        },
        /** @param {number} address @param {string} text */
        putWide(address, text){
            for (let at = 0; at < text.length; at++)
            {
                bytes[address + at * 2] = text.charCodeAt(at) & 0xff;
                bytes[address + at * 2 + 1] = (text.charCodeAt(at) >>> 8) & 0xff;
            }
            bytes[address + text.length * 2] = 0;
            bytes[address + text.length * 2 + 1] = 0;
        },
        /** @param {number} address @param {string} guid */
        putGuid(address, guid){
            bytes.set(/** @type {Uint8Array} */ (parseGuid(guid)), address);
        },
        /** @param {number} address */
        u32: address=>(bytes[address] | (bytes[address + 1] << 8)
            | (bytes[address + 2] << 16) | (bytes[address + 3] << 24)) >>> 0,
        /** @param {number} address */
        ansiAt: address=>readCString(address, 2048),
        /** @param {number} address */
        wideAt: address=>readWideString(address, 2048),
    };
}

/**
 * Calls a method on a created object by name, the way the bridge's vtable would.
 *
 * @param {any} object @param {string} iid @param {string} name @param {number[]} [args]
 */
function call(object, iid, name, args = []){
    const record = object.interfaceFor(iid);
    assert.ok(record, `no interface ${iid}`);
    const method = record.methods.find(/** @param {any} m */ m=>m.name === name);
    assert.ok(method, `${iid} has no ${name}`);
    assert.ok(method.invoke, `${iid}::${name} is not implemented`);
    return method.invoke(object, args);
}

/**
 * Runs CoCreateInstance for CLSID_ShellLink and answers the object it made.
 *
 * @param {ReturnType<typeof setup>} fx @param {string} [iid]
 */
function createLink(fx, iid = IID_ISHELL_LINK_A){
    fx.putGuid(CLSID_ARG, CLSID_SHELL_LINK);
    fx.putGuid(IID_ARG, iid);
    fx.fns.CoInitializeEx.handler([0, COINIT_APARTMENTTHREADED]);
    const hr = fx.fns.CoCreateInstance.handler([CLSID_ARG, 0, 1, IID_ARG, PPV]);
    assert.equal(hr, S_OK, 'CoCreateInstance succeeded');
    assert.notEqual(fx.u32(PPV), 0, 'an interface pointer came back');
    const object = fx.created.at(-1);
    assert.ok(object, 'the object was published');
    return object;
}

test('CoCreateInstance for CLSID_ShellLink yields an object IPersistFile is on', ()=>{
    const fx = setup();
    const object = createLink(fx);
    // The interface the installer saves through is reachable from the link.
    assert.ok(object.queryInterface(IID_IPERSIST_FILE),
        'QueryInterface(IID_IPersistFile) succeeds');
    assert.ok(object.interfaceFor(IID_ISHELL_LINK_A), 'and it is the ANSI link it asked for');
});

test('the link answers both spellings and IPersistFile from one object', ()=>{
    const fx = setup();
    const object = createLink(fx, IID_ISHELL_LINK_W);
    assert.ok(object.interfaceFor(IID_ISHELL_LINK_W), 'the wide link');
    assert.ok(object.interfaceFor(IID_ISHELL_LINK_A), 'the ANSI link, same object');
    assert.ok(object.interfaceFor(IID_IPERSIST_FILE), 'and IPersistFile');
});

test('the vtables hold the published method order, offsets included', ()=>{
    const fx = setup();
    const object = createLink(fx);
    /** @param {string} iid */
    const names = iid=>object.interfaceFor(iid).methods.map(/** @param {any} m */ m=>m.name);

    // The order is the ABI: a program compiled against the published header
    // calls SetPath at offset 0x50, and a table that paired the getters with
    // their setters would answer that call with Resolve -- a different method
    // with a different argument width, which takes the guest's stack with it.
    assert.deepEqual(names(IID_ISHELL_LINK_A), [
        'QueryInterface', 'AddRef', 'Release',
        'GetPath', 'GetIDList', 'SetIDList',
        'GetDescription', 'SetDescription',
        'GetWorkingDirectory', 'SetWorkingDirectory',
        'GetArguments', 'SetArguments',
        'GetHotkey', 'SetHotkey',
        'GetShowCmd', 'SetShowCmd',
        'GetIconLocation', 'SetIconLocation',
        'SetRelativePath', 'Resolve', 'SetPath',
    ]);
    assert.equal(names(IID_ISHELL_LINK_A).indexOf('SetPath') * 4, 0x50);
    assert.deepEqual(names(IID_ISHELL_LINK_W), names(IID_ISHELL_LINK_A),
        'the wide spelling is the same table over wide strings');
    assert.deepEqual(names(IID_IPERSIST_FILE), [
        'QueryInterface', 'AddRef', 'Release',
        'GetClassID', 'IsDirty', 'Load', 'Save', 'SaveCompleted', 'GetCurFile',
    ]);
    assert.equal(names(IID_IPERSIST_FILE).indexOf('Save') * 4, 0x18,
        'where the installer\'s own code calls Save');
});

test('a relative path is kept and answers for the target until one is set', ()=>{
    const fx = setup();
    const object = createLink(fx);
    fx.putAnsi(STR, 'game.exe');
    assert.equal(call(object, IID_ISHELL_LINK_A, 'SetRelativePath', [STR, 0]), S_OK);

    fx.bytes.fill(0, BUF, BUF + 64);
    call(object, IID_ISHELL_LINK_A, 'GetPath', [BUF, 260, 0, 0]);
    assert.equal(fx.ansiAt(BUF), 'game.exe', 'the relative form, kept as it was given');

    fx.putAnsi(STR, 'C:\\App\\game.exe');
    call(object, IID_ISHELL_LINK_A, 'SetPath', [STR]);
    fx.bytes.fill(0, BUF, BUF + 64);
    call(object, IID_ISHELL_LINK_A, 'GetPath', [BUF, 260, 0, 0]);
    assert.equal(fx.ansiAt(BUF), 'C:\\App\\game.exe', 'the absolute one answers once set');
});

test('SetPath and GetPath round-trip the string a program set', ()=>{
    const fx = setup();
    const object = createLink(fx);
    fx.putAnsi(STR, 'C:\\App\\Warcraft III Demo\\War3Demo.exe');
    assert.equal(call(object, IID_ISHELL_LINK_A, 'SetPath', [STR]), S_OK);

    fx.bytes.fill(0, BUF, BUF + 512);
    assert.equal(call(object, IID_ISHELL_LINK_A, 'GetPath', [BUF, 260, 0, 0]), S_OK);
    assert.equal(fx.ansiAt(BUF), 'C:\\App\\Warcraft III Demo\\War3Demo.exe');
});

test('a target set through the wide interface reads back through the ANSI one', ()=>{
    const fx = setup();
    const object = createLink(fx, IID_ISHELL_LINK_W);
    fx.putWide(STR, 'C:\\App\\game.exe');
    assert.equal(call(object, IID_ISHELL_LINK_W, 'SetPath', [STR]), S_OK);

    fx.bytes.fill(0, BUF, BUF + 512);
    assert.equal(call(object, IID_ISHELL_LINK_A, 'GetPath', [BUF, 260, 0, 0]), S_OK);
    assert.equal(fx.ansiAt(BUF), 'C:\\App\\game.exe', 'one object, one target');
});

test('a target in the upper half of the ANSI page reads back through GetPath in that page', ()=>{
    // 0x80 is the euro sign in Windows-1252, 0x99 the trade mark and 0x97 an
    // em dash: an ANSI target keeps its bytes, and a wide one reaches the
    // ANSI getter, and its WIN32_FIND_DATAA, as WideCharToMultiByte(CP_ACP)
    // writes it.
    const fx = setup();
    const object = createLink(fx);
    fx.bytes.set([0x43, 0x3a, 0x5c, 0x80, 0x99, 0x97, 0], STR);
    assert.equal(call(object, IID_ISHELL_LINK_A, 'SetPath', [STR]), S_OK);
    fx.bytes.fill(0, BUF, BUF + 512);
    assert.equal(call(object, IID_ISHELL_LINK_A, 'GetPath', [BUF, 260, 0, 0]), S_OK);
    assert.deepEqual([...fx.bytes.subarray(BUF, BUF + 7)], [0x43, 0x3a, 0x5c, 0x80, 0x99, 0x97, 0]);

    const wide = createLink(fx, IID_ISHELL_LINK_W);
    fx.putWide(STR, 'C:\\\u2014\u00e9');
    assert.equal(call(wide, IID_ISHELL_LINK_W, 'SetPath', [STR]), S_OK);
    fx.bytes.fill(0, BUF, BUF + 512);
    assert.equal(call(wide, IID_ISHELL_LINK_A, 'GetPath', [BUF, 260, BUF + 0x100, 0]), S_OK);
    assert.deepEqual([...fx.bytes.subarray(BUF, BUF + 6)], [0x43, 0x3a, 0x5c, 0x97, 0xe9, 0]);
    assert.deepEqual([...fx.bytes.subarray(BUF + 0x100 + 44, BUF + 0x100 + 50)],
        [0x43, 0x3a, 0x5c, 0x97, 0xe9, 0], 'cFileName');
});

test('Save leaves a file at the path, which the existence check then finds', ()=>{
    const fx = setup();
    const object = createLink(fx);
    fx.putWide(STR, 'C:\\Start Menu\\Programs\\Game.lnk');
    assert.equal(call(object, IID_IPERSIST_FILE, 'Save', [STR, 1]), S_OK);
    assert.ok(fx.volume.has('C:\\Start Menu\\Programs\\Game.lnk'), 'the file exists');

    // A later Load of the same path succeeds on that existence.
    assert.equal(call(object, IID_IPERSIST_FILE, 'Load', [STR, 0]), S_OK);
});

test('Load of a path nothing saved is the not-found a caller branches on', ()=>{
    const fx = setup();
    const object = createLink(fx);
    fx.putWide(STR, 'C:\\Nowhere\\absent.lnk');
    assert.equal(call(object, IID_IPERSIST_FILE, 'Load', [STR, 0]), STG_E_FILENOTFOUND);
});

test('GetCurFile answers the path Save remembered', ()=>{
    const fx = setup();
    const object = createLink(fx);
    fx.putWide(STR, 'C:\\Start Menu\\Programs\\Game.lnk');
    call(object, IID_IPERSIST_FILE, 'Save', [STR, 1]);

    const out = 0x3000;
    assert.equal(call(object, IID_IPERSIST_FILE, 'GetCurFile', [out]), S_OK);
    const stringAddress = fx.u32(out);
    assert.notEqual(stringAddress, 0, 'a string was allocated');
    assert.equal(fx.wideAt(stringAddress), 'C:\\Start Menu\\Programs\\Game.lnk');
});

test('GetCurFile before any save is S_FALSE with a null, as Windows answers', ()=>{
    const fx = setup();
    const object = createLink(fx);
    const out = 0x3000;
    fx.bytes.fill(0xa5, out, out + 4);
    assert.equal(call(object, IID_IPERSIST_FILE, 'GetCurFile', [out]), S_FALSE);
    assert.equal(fx.u32(out), 0, 'the pointer was zeroed, not left holding the stack');
});

test('the stand-ins say so once each rather than pretending silently', ()=>{
    const fx = setup();
    const object = createLink(fx);
    fx.putWide(STR, 'C:\\Start Menu\\Programs\\Game.lnk');
    call(object, IID_ISHELL_LINK_A, 'Resolve', [0, 0]);
    call(object, IID_ISHELL_LINK_A, 'Resolve', [0, 0]);
    call(object, IID_IPERSIST_FILE, 'Save', [STR, 1]);
    assert.ok(fx.reported.some(line=>line.startsWith('IShellLink::Resolve:')), 'Resolve was named');
    assert.ok(fx.reported.some(line=>line.startsWith('IPersistFile::Save:')), 'Save was named');
    // The shelllink host reports through the app-level deduper in the product;
    // here it is a plain list, so Resolve appearing twice is expected and the
    // "once" contract is the reporter's, asserted in the ole32/app tests.
});

test('IsDirty tracks a Set since the last save', ()=>{
    const fx = setup();
    const object = createLink(fx);
    assert.equal(call(object, IID_IPERSIST_FILE, 'IsDirty', []), S_FALSE, 'fresh link is clean');
    fx.putAnsi(STR, 'C:\\App\\game.exe');
    call(object, IID_ISHELL_LINK_A, 'SetPath', [STR]);
    assert.equal(call(object, IID_IPERSIST_FILE, 'IsDirty', []), S_OK, 'dirty after a Set');
    fx.putWide(STR, 'C:\\Start Menu\\Programs\\Game.lnk');
    call(object, IID_IPERSIST_FILE, 'Save', [STR, 1]);
    assert.equal(call(object, IID_IPERSIST_FILE, 'IsDirty', []), S_FALSE, 'clean after Save');
});

test('GetClassID answers CLSID_ShellLink', ()=>{
    const fx = setup();
    const object = createLink(fx);
    const out = 0x3000;
    assert.equal(call(object, IID_IPERSIST_FILE, 'GetClassID', [out]), S_OK);
    // The GUID's first field is little-endian; 00021401 reads back as 01 14 02 00.
    assert.deepEqual([...fx.bytes.subarray(out, out + 4)], [0x01, 0x14, 0x02, 0x00]);
});
