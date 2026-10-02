/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What LoadLibrary answers at run time.
 *
 * Two decisions meet here. The kernel32 layer knows the entry points but not
 * how a name is found; whoever assembled the process owns the volume and the
 * module table, and is handed in as `host.load`. That separation is what lets
 * a title's own `d3dx9_26.dll` beside the program win over the handful of
 * maths functions we would otherwise synthesise for the name: LoadLibrary
 * asks the assembler, and the assembler looks beside the program first for
 * everything that is not a KnownDLL.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createModuleFunctions, searchesBesideProgram } from './modules.js';

/**
 * A module record with the two lookups a load path never reaches here.
 *
 * @param {string} name @param {number} base
 */
const record = (name, base)=>({
    name,
    base,
    addressOf: ()=>null,
    addressOfOrdinal: ()=>null,
});

/**
 * The least of a module host these entry points call.
 *
 * @param {Object} [options]
 * @param {Record<string, number>} [options.lookup]  Name to table base.
 * @param {(name: string, flags?: number) => number} [options.load]  What the assembler answers.
 */
function hostFor({ lookup = {}, load } = {}){
    /** @type {Map<string, ReturnType<typeof record>>} */
    const byName = new Map(Object.entries(lookup)
        .map(([name, base])=>[name.toLowerCase(), record(name, base)]));
    /** @type {Map<number, string>} */
    const strings = new Map();
    let lastError = 0;

    const host = {
        /** @param {number} address */
        readCString: address=>strings.get(address) ?? '',
        /** @param {number} address */
        readWideString: address=>strings.get(address) ?? '',
        writeMemory: ()=>{},
        /** @param {string | null} name */
        find: name=>name === null ? null : byName.get(String(name).toLowerCase()) ?? null,
        /** @param {number} base */
        byBase: base=>[...byName.values()].find(module=>module.base === base) ?? null,
        /** @param {number} code */
        setLastError: code=>{ lastError = code; },
        imagePath: ()=>'C:\\App\\speedDemo.exe',
        load: load ?? (()=>0),
        resolved: ()=>{},
    };
    return {
        host,
        /** @param {number} address @param {string} text */
        say: (address, text)=>{ strings.set(address, text); },
        lastError: ()=>lastError,
    };
}

test('the search beside the program is skipped for a KnownDLL, and for a file already mapped', ()=>{
    assert.equal(searchesBesideProgram(false, false), true,
        'an ordinary name is looked for beside the program');
    assert.equal(searchesBesideProgram(true, false), false,
        'a KnownDLL is never looked for beside the program');
    assert.equal(searchesBesideProgram(false, true), false,
        'a library already mapped out of a file is not searched for again');
    assert.equal(searchesBesideProgram(true, true), false);
});

test('a run-time load asks the assembler, so the program\'s own file beats our table', ()=>{
    // The table has a synthesised d3dx9_26 at 0x1000; the assembler found the
    // runtime the title shipped and mapped it at 0x2000. LoadLibrary has to
    // answer 0x2000: the file beside the program is the module.
    const f = hostFor({ lookup: { 'd3dx9_26.dll': 0x1000 }, load: ()=>0x2000 });
    const fns = createModuleFunctions(f.host);
    f.say(0x400000, 'd3dx9_26.dll');

    assert.equal(fns.LoadLibraryA.handler([0x400000]), 0x2000);
});

test('a KnownDLL answers from the table even though a file of that name exists', ()=>{
    // The assembler ignores a kernel32.dll beside the program and answers with
    // the synthesised module; the entry point still comes through this path so
    // its DllMain runs on the calling thread.
    const f = hostFor({ lookup: { 'kernel32.dll': 0x1000 }, load: ()=>0x1000 });
    const fns = createModuleFunctions(f.host);
    f.say(0x400000, 'kernel32.dll');

    assert.equal(fns.LoadLibraryA.handler([0x400000]), 0x1000);
});

test('a module already in the table answers when the loader finds no file', ()=>{
    // The name is one we provide but the program did not bring: the table is
    // the fallback, and the answer is its base.
    const f = hostFor({ lookup: { 'version.dll': 0x1000 }, load: ()=>0 });
    const fns = createModuleFunctions(f.host);
    f.say(0x400000, 'version.dll');

    assert.equal(fns.LoadLibraryA.handler([0x400000]), 0x1000);
});

test('a name nothing provides is zero and sets ERROR_MOD_NOT_FOUND', ()=>{
    const f = hostFor({ lookup: {}, load: ()=>0 });
    const fns = createModuleFunctions(f.host);
    f.say(0x400000, 'absent.dll');

    assert.equal(fns.LoadLibraryA.handler([0x400000]), 0);
    assert.equal(f.lastError(), 126);
});

test('FreeLibrary gives one reference back to the module, which decides when it is unloaded',
    ()=>{
        const f = hostFor({ lookup: { 'probe.dll': 0x10000000, 'kernel32.dll': 0x77000000 } });
        /** @type {string[]} */
        const released = [];
        const probe = /** @type {any} */ (f.host.byBase(0x10000000));
        probe.release = ()=>{
            released.push(probe.name);
            return 1;
        };
        const fns = createModuleFunctions(f.host);

        assert.equal(fns.FreeLibrary.handler([0x10000000]), 1);
        assert.deepEqual(released, ['probe.dll']);
        assert.equal(fns.FreeLibrary.handler([0x77000000]), 1,
            'a module with no count of its own stays');
        assert.equal(fns.FreeLibrary.handler([0x12345678]), 0, 'and nothing is not a module');
        assert.equal(f.lastError(), 126, 'ERROR_MOD_NOT_FOUND');
    });

test('the wide entry point reaches the same loader', ()=>{
    /** @type {string[]} */
    const asked = [];
    const f = hostFor({ lookup: {}, load: name=>{ asked.push(name); return 0; } });
    const fns = createModuleFunctions(f.host);
    f.say(0x400000, 'Straight.dll');

    assert.equal(fns.LoadLibraryW.handler([0x400000]), 0);
    assert.deepEqual(asked, ['Straight.dll']);
});

test('LoadLibraryEx hands its flags to the loader, in both spellings', ()=>{
    // How a library is loaded -- as data, or mapped without its imports
    // resolved -- is the loader's to act on; this layer only has to pass the
    // request through rather than drop it.
    /** @type {[string, number | undefined][]} */
    const asked = [];
    const f = hostFor({ load: (name, flags)=>{
        asked.push([name, flags]);
        return 0x10000001;
    } });
    const fns = createModuleFunctions(f.host);
    f.say(0x400000, 'probe.dll');
    const LOAD_LIBRARY_AS_DATAFILE = 0x2;
    const DONT_RESOLVE_DLL_REFERENCES = 0x1;

    assert.equal(fns.LoadLibraryExA.handler([0x400000, 0, LOAD_LIBRARY_AS_DATAFILE]), 0x10000001);
    assert.equal(fns.LoadLibraryExW.handler([0x400000, 0, DONT_RESOLVE_DLL_REFERENCES]),
        0x10000001);
    assert.deepEqual(asked, [
        ['probe.dll', LOAD_LIBRARY_AS_DATAFILE], ['probe.dll', DONT_RESOLVE_DLL_REFERENCES],
    ]);
});

test('LoadLibraryEx refuses a file handle, which is reserved and must be NULL', ()=>{
    // Wine's module test: a handle in hFile fails the load, with
    // ERROR_INVALID_PARAMETER on every Windows since XP.
    /** @type {string[]} */
    const asked = [];
    const f = hostFor({ load: name=>{ asked.push(name); return 0x1000; } });
    const fns = createModuleFunctions(f.host);
    f.say(0x400000, 'kernel32.dll');

    assert.equal(fns.LoadLibraryExA.handler([0x400000, 0xdeadbeef, 0]), 0);
    assert.equal(f.lastError(), 87);
    assert.equal(fns.LoadLibraryExW.handler([0x400000, 0xdeadbeef, 0]), 0);
    assert.deepEqual(asked, [], 'nothing was loaded');
});

test('FreeLibrary takes back a data file by the handle LoadLibraryEx gave out', ()=>{
    // A library loaded as data is no module -- GetModuleHandle does not find
    // it -- so its handle, the base with a low bit set, is looked up apart.
    // A handle with those bits that names nothing is a bad image, as Wine's
    // module test has it, rather than a module not found.
    const f = hostFor({});
    /** @type {number[]} */
    const released = [];
    const host = /** @type {any} */ (f.host);
    host.dataFile = (/** @type {number} */ handle)=>(handle === 0x10000001
        ? { ...record('probe.dll', 0x10000000), release: ()=>{
            released.push(handle);
            return 1;
        } }
        : null);
    const fns = createModuleFunctions(f.host);

    assert.equal(fns.FreeLibrary.handler([0x10000001]), 1);
    assert.deepEqual(released, [0x10000001]);
    assert.equal(fns.FreeLibrary.handler([0x10001231]), 0);
    assert.equal(f.lastError(), 193, 'ERROR_BAD_EXE_FORMAT');
});

test('the program\'s file name is written in the ANSI page', ()=>{
    // The euro sign is 0x80 there, the trade mark 0x99 and an em dash 0x97,
    // as the ANSI calls read those bytes; a program installed under such a
    // name finds the same bytes in its own path.
    const f = hostFor({});
    const host = /** @type {any} */ (f.host);
    host.find = (/** @type {string | null} */ name)=>(name === null
        ? record('app.exe', 0x400000) : null);
    host.imagePath = ()=>'C:\\\u20ac\u2122\u2014\u00e9\\app.exe';
    /** @type {Uint8Array[]} */
    const written = [];
    host.writeMemory = (/** @type {number} */ address, /** @type {Uint8Array} */ bytes)=>{
        written.push(bytes.slice());
    };
    const fns = createModuleFunctions(f.host);

    assert.equal(fns.GetModuleFileNameA.handler([0, 0x1000, 64]), 15);
    assert.deepEqual([...written[0].subarray(3, 8)], [0x80, 0x99, 0x97, 0xe9, 0x5c]);
});

test("K32GetModuleInformation reads a module's base, size and entry from its own headers", ()=>{
    // d3d9's device.c test_vtbl_hook asks for d3d9.dll's image to scan it.
    const { host, lastError } = hostFor({ lookup: { 'd3d9.dll': 0x10000 } });
    const image = new Uint8Array(0x400);
    const view = new DataView(image.buffer);
    view.setUint32(0x3c, 0x80, true);
    view.setUint32(0x80 + 24 + 16, 0x1234, true);
    view.setUint32(0x80 + 24 + 56, 0x9000, true);
    const seen = { bytes: /** @type {Uint8Array} */ (new Uint8Array(0)) };
    const fns = createModuleFunctions({
        ...host,
        /** @param {number} address @param {number} length */
        readMemory: (address, length)=>image.slice(address - 0x10000, address - 0x10000 + length),
        /** @param {number} address @param {Uint8Array} bytes */
        writeMemory: (address, bytes)=>{
            assert.equal(address, 0x500);
            seen.bytes = bytes;
        },
    });
    const entry = fns.K32GetModuleInformation;
    assert.equal(entry.argBytes, 16);
    assert.equal(entry.handler([0xffffffff, 0x10000, 0x500, 12]), 1);
    const out = new DataView(seen.bytes.buffer);
    assert.deepEqual([0, 4, 8].map(at=>out.getUint32(at, true)), [0x10000, 0x9000, 0x11234]);
    assert.equal(entry.handler([0xffffffff, 0x10000, 0x500, 8]), 0);
    assert.equal(lastError(), 122, 'ERROR_INSUFFICIENT_BUFFER');
    assert.equal(entry.handler([0xffffffff, 0x20000, 0x500, 12]), 0);
    assert.equal(lastError(), 6, 'ERROR_INVALID_HANDLE');
});
