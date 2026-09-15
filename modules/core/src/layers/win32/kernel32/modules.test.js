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
 * @param {(name: string) => number} [options.load]  What the assembler answers.
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

test('the wide entry point reaches the same loader', ()=>{
    /** @type {string[]} */
    const asked = [];
    const f = hostFor({ lookup: {}, load: name=>{ asked.push(name); return 0; } });
    const fns = createModuleFunctions(f.host);
    f.say(0x400000, 'Straight.dll');

    assert.equal(fns.LoadLibraryW.handler([0x400000]), 0);
    assert.deepEqual(asked, ['Straight.dll']);
});
