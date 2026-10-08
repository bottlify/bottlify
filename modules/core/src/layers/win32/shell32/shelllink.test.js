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
import { decodeAnsi } from '../kernel32/locale.js';
import {
    CLSID_SHELL_LINK, IID_IPERSIST_FILE, IID_ISHELL_LINK_A, IID_ISHELL_LINK_W,
    registerShellLinkClasses,
} from './shelllink.js';
import { decodeShellLink, encodeShellLink, SW_SHOWMAXIMIZED } from '../common/shell-link.js';
import { listBytes } from './namespace.js';

const S_OK = 0x00000000;
const S_FALSE = 0x00000001;
const E_FAIL = 0x80004005 | 0;
const E_INVALIDARG = 0x80070057 | 0;
const STG_E_FILENOTFOUND = 0x80030002 | 0;
const E_PATH_NOT_FOUND = 0x80070003 | 0;
const COINIT_APARTMENTTHREADED = 0x2;

/** Guest addresses the fixtures use, far enough apart that nothing overlaps. */
const CLSID_ARG = 0x1000;
const IID_ARG = 0x1020;
const PPV = 0x1100;
const STR = 0x2000;
const BUF = 0x2800;

/** When the fixture's volume says a saved file was written: 2004-06-15 12:30 UTC. */
const SAVED_AT = Date.UTC(2004, 5, 15, 12, 30, 0);

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
    /** Whether the volume answers a read with a promise, as it does for bytes not yet fetched. */
    const fixture = { deferReads: false };
    const bytes = new Uint8Array(0x10000);
    /** @type {string[]} */
    const reported = [];
    /** The files on the volume, by path, and the directories they can go in. */
    /** @type {Map<string, { bytes: Uint8Array, modified: number }>} */
    const volume = new Map();
    const directories = new Set(['C:\\', 'C:\\App', 'C:\\Games', 'C:\\Start Menu',
        'C:\\Start Menu\\Programs']);

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
        return decodeAnsi(bytes.subarray(address, end));
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
            stat: path=>{
                if (directories.has(path))
                {
                    return { exists: true, isDirectory: true, size: 0, modified: 0 };
                }
                const file = volume.get(path);
                return file ? { exists: true, isDirectory: false, size: file.bytes.length,
                    modified: file.modified } : null;
            },
            /** @param {string} path @param {{ write?: boolean }} mode */
            open: (path, mode)=>{
                if (mode.write)
                {
                    if (!directories.has(path.slice(0, path.lastIndexOf('\\'))))
                    {
                        return null;
                    }
                    volume.set(path, { bytes: new Uint8Array(0), modified: SAVED_AT });
                }
                return volume.has(path) ? { path } : null;
            },
            /** @param {{ path: string }} node @param {number} offset @param {number} length */
            read: (node, offset, length)=>{
                const data = /** @type {Uint8Array} */ (
                    volume.get(node.path)?.bytes.slice(offset, offset + length));
                // As the volume answers for blocks a bundle has yet to deliver.
                return fixture.deferReads ? Promise.resolve(data) : data;
            },
            /** @param {{ path: string }} node @param {number} offset @param {Uint8Array} data */
            write: (node, offset, data)=>{
                const file = /** @type {{ bytes: Uint8Array }} */ (volume.get(node.path));
                const grown = new Uint8Array(Math.max(file.bytes.length, offset + data.length));
                grown.set(file.bytes);
                grown.set(data, offset);
                file.bytes = grown;
                return data.length;
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

    return Object.assign(fixture, {
        bytes, volume, directories, reported, created, fns, registry,
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
    });
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
    assert.deepEqual([...fx.bytes.subarray(BUF + 0x100 + 44, BUF + 0x100 + 47)],
        [0x97, 0xe9, 0], 'cFileName: the name, in the same page');
});

test('Save writes a shell link at the path, which Load then reads', ()=>{
    const fx = setup();
    const object = createLink(fx);
    fx.putAnsi(STR, 'C:\\Games\\game.exe');
    call(object, IID_ISHELL_LINK_A, 'SetPath', [STR]);
    fx.putWide(STR, 'C:\\Start Menu\\Programs\\Game.lnk');
    assert.equal(call(object, IID_IPERSIST_FILE, 'Save', [STR, 1]), S_OK);
    const saved = fx.volume.get('C:\\Start Menu\\Programs\\Game.lnk')?.bytes;
    assert.ok(saved, 'the file exists');
    const link = decodeShellLink(saved);
    assert.equal(link?.target, 'C:\\Games\\game.exe', 'and is a link to the target');
    assert.equal(link?.idListPath, 'C:\\Games\\game.exe', 'with the shell\'s id list for it');

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

test('the stand-ins say so rather than pretending silently; a save says nothing', ()=>{
    const fx = setup();
    const object = createLink(fx);
    fx.putWide(STR, 'C:\\Start Menu\\Programs\\Game.lnk');
    call(object, IID_ISHELL_LINK_A, 'Resolve', [0, 0]);
    fx.putAnsi(BUF, 'game.exe');
    call(object, IID_ISHELL_LINK_A, 'SetRelativePath', [BUF, 0]);
    call(object, IID_IPERSIST_FILE, 'Save', [STR, 1]);
    assert.ok(fx.reported.some(line=>line.startsWith('IShellLink::Resolve:')), 'Resolve was named');
    assert.ok(fx.reported.some(line=>line.startsWith('IShellLink::SetRelativePath:')),
        'SetRelativePath was named');
    assert.ok(!fx.reported.some(line=>line.startsWith('IPersistFile::')),
        'a real link is written and read, which is no stand-in');
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

/**
 * Sets every field through IShellLinkA, as Wine's create_lnk does, and saves.
 *
 * @param {ReturnType<typeof setup>} fx @param {string} path
 * @param {{ description?: string, workdir?: string, path?: string, arguments?: string,
 *     showcmd?: number, icon?: string, iconId?: number, hotkey?: number }} desc
 */
function createLnk(fx, path, desc){
    const object = createLink(fx);
    /** @param {string} method @param {string} text @param {number[]} [rest] */
    const set = (method, text, rest = [])=>{
        fx.putAnsi(STR, text);
        assert.equal(call(object, IID_ISHELL_LINK_A, method, [STR, ...rest]), S_OK, method);
    };
    if (desc.description !== undefined)
    {
        set('SetDescription', desc.description);
    }
    if (desc.workdir !== undefined)
    {
        set('SetWorkingDirectory', desc.workdir);
    }
    if (desc.path !== undefined)
    {
        set('SetPath', desc.path);
    }
    if (desc.arguments !== undefined)
    {
        set('SetArguments', desc.arguments);
    }
    if (desc.showcmd !== undefined)
    {
        call(object, IID_ISHELL_LINK_A, 'SetShowCmd', [desc.showcmd]);
    }
    if (desc.icon !== undefined)
    {
        set('SetIconLocation', desc.icon, [desc.iconId ?? 0]);
    }
    if (desc.hotkey !== undefined)
    {
        call(object, IID_ISHELL_LINK_A, 'SetHotkey', [desc.hotkey]);
    }
    fx.putWide(STR, path);
    assert.equal(call(object, IID_IPERSIST_FILE, 'Save', [STR, 1]), S_OK, 'Save');
    assert.equal(call(object, IID_IPERSIST_FILE, 'IsDirty', []), S_FALSE, 'clean once saved');
}

/**
 * Loads a link into a fresh object and reads every getter back through
 * IShellLinkA, as Wine's check_lnk does.
 *
 * @param {ReturnType<typeof setup>} fx @param {string} path
 */
async function checkLnk(fx, path){
    const object = createLink(fx);
    fx.putWide(STR, path);
    assert.equal(await call(object, IID_IPERSIST_FILE, 'Load', [STR, 0]), S_OK, 'Load');
    /** @param {string} method */
    const text = method=>{
        fx.bytes.fill(0x61, BUF, BUF + 0x400);
        call(object, IID_ISHELL_LINK_A, method, [BUF, 0x400, 0x3800]);
        return fx.ansiAt(BUF);
    };
    fx.bytes.fill(0, 0x3800, 0x3804);
    const icon = text('GetIconLocation');
    const iconId = fx.u32(0x3800) | 0;
    call(object, IID_ISHELL_LINK_A, 'GetShowCmd', [0x3800]);
    const showcmd = fx.u32(0x3800);
    call(object, IID_ISHELL_LINK_A, 'GetHotkey', [0x3800]);
    const hotkey = fx.u32(0x3800) & 0xffff;
    fx.bytes.fill(0x61, BUF, BUF + 0x400);
    const pathResult = call(object, IID_ISHELL_LINK_A, 'GetPath', [BUF, 0x400, 0, 0]);
    const target = fx.ansiAt(BUF);
    return {
        object,
        description: text('GetDescription'),
        workdir: text('GetWorkingDirectory'),
        path: target,
        pathResult,
        arguments: text('GetArguments'),
        icon, iconId, showcmd, hotkey,
    };
}

test('an empty link saves and comes back as empty strings', async()=>{
    const fx = setup();
    createLnk(fx, 'C:\\Start Menu\\test.lnk', {});
    const back = await checkLnk(fx, 'C:\\Start Menu\\test.lnk');
    assert.equal(back.description, '');
    assert.equal(back.workdir, '');
    assert.equal(back.path, '');
    assert.equal(back.pathResult, S_FALSE, 'no target is S_FALSE');
    assert.equal(back.arguments, '');
    assert.equal(back.icon, '');
    assert.equal(back.showcmd, 1, 'SW_SHOWNORMAL');
});

test('a link to files that are not there round-trips every field', async()=>{
    const fx = setup();
    const desc = {
        description: '', workdir: 'c:\\Nonexitent\\work\\directory', path: 'c:\\nonexistent\\path',
        arguments: '', icon: 'c:\\nonexistent\\icon\\file', iconId: 1234,
    };
    createLnk(fx, 'C:\\Start Menu\\test.lnk', desc);
    const back = await checkLnk(fx, 'C:\\Start Menu\\test.lnk');
    assert.equal(back.workdir, desc.workdir);
    // Compared without case, as Wine's check_lnk compares: the drive comes
    // back upper-case, which is how Windows answers a path set in lower.
    assert.equal(back.path, 'C:\\nonexistent\\path');
    assert.equal(back.pathResult, S_OK);
    assert.equal(back.icon, desc.icon);
    assert.equal(back.iconId, 1234);
});

test('a link to a file that is there: description, arguments, show command, hotkey', async()=>{
    const fx = setup();
    fx.volume.set('C:\\Games\\game.exe', { bytes: new Uint8Array(4321), modified: SAVED_AT });
    const desc = {
        description: 'test 2', workdir: 'C:\\Games', path: 'C:\\Games\\game.exe',
        arguments: '/option1 /option2 "Some string"', showcmd: SW_SHOWMAXIMIZED,
        icon: 'C:\\Games\\game.exe', iconId: 0, hotkey: 0x1234,
    };
    createLnk(fx, 'C:\\Start Menu\\Programs\\Game.lnk', desc);
    const back = await checkLnk(fx, 'C:\\Start Menu\\Programs\\Game.lnk');
    assert.equal(back.description, desc.description);
    assert.equal(back.workdir, desc.workdir);
    assert.equal(back.path, desc.path);
    assert.equal(back.arguments, desc.arguments);
    assert.equal(back.showcmd, SW_SHOWMAXIMIZED);
    assert.equal(back.icon, desc.icon);
    assert.equal(back.hotkey, 0x1234);

    const saved = decodeShellLink(
        /** @type {Uint8Array} */ (fx.volume.get('C:\\Start Menu\\Programs\\Game.lnk')?.bytes));
    assert.equal(saved?.fileSize, 4321, 'the header records the target as the volume has it');
    assert.equal(saved?.fileAttributes, 0x20);
});

test('a link another writer made answers the getters: what CreateShortcuts leaves', async()=>{
    const fx = setup();
    fx.volume.set('C:\\Start Menu\\Programs\\Tool.lnk', {
        bytes: encodeShellLink({
            target: 'C:\\App\\tool.exe', arguments: '-x', description: 'The tool',
            workingDirectory: 'C:\\App', iconLocation: 'C:\\App\\tool.ico', iconIndex: -3,
            unicode: false,
        }),
        modified: SAVED_AT,
    });
    const back = await checkLnk(fx, 'C:\\Start Menu\\Programs\\Tool.lnk');
    assert.equal(back.path, 'C:\\App\\tool.exe');
    assert.equal(back.arguments, '-x');
    assert.equal(back.description, 'The tool');
    assert.equal(back.workdir, 'C:\\App');
    assert.equal(back.icon, 'C:\\App\\tool.ico');
    assert.equal(back.iconId, -3);

    const out = 0x3000;
    assert.equal(call(back.object, IID_IPERSIST_FILE, 'GetCurFile', [out]), S_OK);
    assert.equal(fx.wideAt(fx.u32(out)), 'C:\\Start Menu\\Programs\\Tool.lnk');
    assert.equal(call(back.object, IID_IPERSIST_FILE, 'IsDirty', []), S_FALSE);
});

test('Load of a file that is no link fails and leaves the link as it was', ()=>{
    const fx = setup();
    fx.volume.set('C:\\Start Menu\\old.lnk', { bytes: new Uint8Array(0), modified: 0 });
    const object = createLink(fx);
    fx.putAnsi(BUF, 'C:\\App\\kept.exe');
    call(object, IID_ISHELL_LINK_A, 'SetPath', [BUF]);
    fx.putWide(STR, 'C:\\Start Menu\\old.lnk');
    assert.equal(call(object, IID_IPERSIST_FILE, 'Load', [STR, 0]), E_FAIL);
    call(object, IID_ISHELL_LINK_A, 'GetPath', [BUF, 260, 0, 0]);
    assert.equal(fx.ansiAt(BUF), 'C:\\App\\kept.exe');
});

test('Load waits for bytes the volume has to fetch', async()=>{
    const fx = setup();
    fx.volume.set('C:\\Start Menu\\far.lnk', {
        bytes: encodeShellLink({ target: 'C:\\App\\far.exe' }), modified: 0,
    });
    fx.deferReads = true;
    const object = createLink(fx);
    fx.putWide(STR, 'C:\\Start Menu\\far.lnk');
    const answer = call(object, IID_IPERSIST_FILE, 'Load', [STR, 0]);
    assert.ok(answer instanceof Promise, 'the bridge parks the caller on a promise');
    assert.equal(await answer, S_OK);
    call(object, IID_ISHELL_LINK_A, 'GetPath', [BUF, 260, 0, 0]);
    assert.equal(fx.ansiAt(BUF), 'C:\\App\\far.exe');
});

test('Save into a directory that is not there is the path-not-found Windows gives', ()=>{
    const fx = setup();
    const object = createLink(fx);
    fx.putWide(STR, 'C:\\Missing\\Game.lnk');
    assert.equal(call(object, IID_IPERSIST_FILE, 'Save', [STR, 1]), E_PATH_NOT_FOUND);
    assert.ok(!fx.volume.has('C:\\Missing\\Game.lnk'));
});

test('Save with no name writes the current file, and needs one', ()=>{
    const fx = setup();
    const object = createLink(fx);
    assert.equal(call(object, IID_IPERSIST_FILE, 'Save', [0, 1]), E_INVALIDARG,
        'nothing saved yet, so no file to save to');
    fx.putWide(STR, 'C:\\Start Menu\\test.lnk');
    assert.equal(call(object, IID_IPERSIST_FILE, 'Save', [STR, 1]), S_OK);
    fx.putAnsi(BUF, 'C:\\App\\new.exe');
    call(object, IID_ISHELL_LINK_A, 'SetPath', [BUF]);
    assert.equal(call(object, IID_IPERSIST_FILE, 'Save', [0, 0]), S_OK);
    assert.equal(call(object, IID_IPERSIST_FILE, 'IsDirty', []), S_FALSE);
    assert.equal(decodeShellLink(
        /** @type {Uint8Array} */ (fx.volume.get('C:\\Start Menu\\test.lnk')?.bytes))?.target,
    'C:\\App\\new.exe');
});

test('a copy saved without remembering leaves the current file and the dirty flag', ()=>{
    const fx = setup();
    const object = createLink(fx);
    fx.putAnsi(BUF, 'C:\\App\\game.exe');
    call(object, IID_ISHELL_LINK_A, 'SetPath', [BUF]);
    fx.putWide(STR, 'C:\\Start Menu\\copy.lnk');
    assert.equal(call(object, IID_IPERSIST_FILE, 'Save', [STR, 0]), S_OK);
    assert.ok(fx.volume.has('C:\\Start Menu\\copy.lnk'));
    assert.equal(call(object, IID_IPERSIST_FILE, 'IsDirty', []), S_OK);
    assert.equal(call(object, IID_IPERSIST_FILE, 'GetCurFile', [0x3000]), S_FALSE);
});

test('SetPath: null refused, quotes and a trailing separator dropped', ()=>{
    const fx = setup();
    const object = createLink(fx);
    assert.equal(call(object, IID_ISHELL_LINK_A, 'SetPath', [0]), E_INVALIDARG);
    for (const [given, kept] of [
        ['c:\\nonexistent\\file\\', 'c:\\nonexistent\\file'],
        ['"c:\\nonexistent\\file"', 'c:\\nonexistent\\file'],
        ['D:\\', 'D:\\'],
    ])
    {
        fx.putAnsi(STR, given);
        assert.equal(call(object, IID_ISHELL_LINK_A, 'SetPath', [STR]), S_OK);
        call(object, IID_ISHELL_LINK_A, 'GetPath', [BUF, 260, 0, 0]);
        assert.equal(fx.ansiAt(BUF), kept, given);
    }
});

test('GetPath fills the find data from the volume: the name, attributes, size', ()=>{
    const fx = setup();
    fx.volume.set('C:\\Games\\game.exe', { bytes: new Uint8Array(0x1234), modified: SAVED_AT });
    const object = createLink(fx);
    fx.putAnsi(STR, 'C:\\Games\\game.exe');
    call(object, IID_ISHELL_LINK_A, 'SetPath', [STR]);
    const find = 0x4000;
    fx.bytes.fill(0xaa, find, find + 320);
    assert.equal(call(object, IID_ISHELL_LINK_A, 'GetPath', [BUF, 260, find, 0]), S_OK);
    assert.equal(fx.u32(find), 0x20, 'dwFileAttributes');
    assert.equal(fx.u32(find + 32), 0x1234, 'nFileSizeLow');
    assert.notEqual(fx.u32(find + 20), 0, 'ftLastWriteTime');
    assert.equal(fx.ansiAt(find + 44), 'game.exe', 'cFileName');

    fx.putAnsi(STR, 'c:\\nonexistent\\file');
    call(object, IID_ISHELL_LINK_A, 'SetPath', [STR]);
    fx.bytes.fill(0xaa, find, find + 320);
    call(object, IID_ISHELL_LINK_A, 'GetPath', [BUF, 260, find, 0]);
    assert.equal(fx.u32(find), 0, 'a target that is not there has no attributes');
    assert.equal(fx.ansiAt(find + 44), 'file');
});

test('SetIDList and GetIDList: the list is the target, and comes back equal', ()=>{
    const fx = setup();
    const object = createLink(fx);
    const list = listBytes('C:\\Games\\game.exe');
    const at = 0x4800;
    fx.bytes.set(list, at);
    assert.equal(call(object, IID_ISHELL_LINK_A, 'SetIDList', [at]), S_OK);
    call(object, IID_ISHELL_LINK_A, 'GetPath', [BUF, 260, 0, 0]);
    assert.equal(fx.ansiAt(BUF), 'C:\\Games\\game.exe', 'the path the list names');

    assert.equal(call(object, IID_ISHELL_LINK_A, 'GetIDList', [0x3000]), S_OK);
    const first = fx.u32(0x3000);
    assert.deepEqual([...fx.bytes.subarray(first, first + list.length)], [...list]);
    call(object, IID_ISHELL_LINK_A, 'GetIDList', [0x3000]);
    assert.notEqual(fx.u32(0x3000), first, 'each call a fresh copy');

    fx.putWide(STR, 'C:\\Start Menu\\list.lnk');
    call(object, IID_IPERSIST_FILE, 'Save', [STR, 1]);
    const saved = decodeShellLink(
        /** @type {Uint8Array} */ (fx.volume.get('C:\\Start Menu\\list.lnk')?.bytes));
    assert.equal(saved?.idListPath, 'C:\\Games\\game.exe',
        'the file holds the shell\'s shapes for the path, not the namespace\'s list');
});

test('GetIDList for a target path, and for no target', ()=>{
    const fx = setup();
    const object = createLink(fx);
    fx.bytes.fill(0xa5, 0x3000, 0x3004);
    assert.equal(call(object, IID_ISHELL_LINK_A, 'GetIDList', [0x3000]), S_FALSE);
    assert.equal(fx.u32(0x3000), 0);

    fx.putAnsi(STR, 'C:\\App\\game.exe');
    call(object, IID_ISHELL_LINK_A, 'SetPath', [STR]);
    assert.equal(call(object, IID_ISHELL_LINK_A, 'GetIDList', [0x3000]), S_OK);
    const list = listBytes('C:\\App\\game.exe');
    assert.deepEqual([...fx.bytes.subarray(fx.u32(0x3000), fx.u32(0x3000) + list.length)],
        [...list], 'the namespace\'s list for the path');
});

test('a loaded link with an id list hands back the namespace\'s list for its path', async()=>{
    const fx = setup();
    fx.volume.set('C:\\Start Menu\\ids.lnk', {
        bytes: encodeShellLink({ target: 'C:\\Games\\game.exe' }), modified: 0,
    });
    const back = await checkLnk(fx, 'C:\\Start Menu\\ids.lnk');
    assert.equal(call(back.object, IID_ISHELL_LINK_A, 'GetIDList', [0x3000]), S_OK);
    const list = listBytes('C:\\Games\\game.exe');
    assert.deepEqual([...fx.bytes.subarray(fx.u32(0x3000), fx.u32(0x3000) + list.length)],
        [...list]);
});
