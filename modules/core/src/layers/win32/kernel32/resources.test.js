/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createResourceFunctions } from './resources.js';

/** RT_STRING and RT_BITMAP, the two types these tests ask for. */
const RT_BITMAP = 2;
const RT_STRING = 6;

/** @param {{ reply?: (language: number) => number | Promise<number> }} [options] */
function setup({ reply } = {}){
    /** @type {any[]} */
    const asked = [];
    /** @type {number[]} */
    const errors = [];
    /** @type {{ entry: number, args: number[], thread: unknown }[]} */
    const called = [];
    const fns = createResourceFunctions({
        readCString: address=>address === 0x19000 ? 'MYNAME' : 'OTHER',
        setLastError: code=>{
            errors.push(code);
        },
        findResource: (instance, type, name, language = null)=>{
            asked.push(language === null
                ? { instance, type, name } : { instance, type, name, language });
            return type === RT_BITMAP && name === 101
                ? { rva: 0x2000, size: 1234 }
                : null;
        },
        listResources: ()=>[
            { type: RT_STRING, name: 1, language: 1033 },
            { type: RT_STRING, name: 1, language: 1036 },
            { type: RT_STRING, name: 2, language: 1033 },
            { type: RT_BITMAP, name: 'myname', language: 1031 },
        ],
        moduleBase: ()=>0x00400000,
        call: (entry, args, thread)=>{
            called.push({ entry, args, thread });
            return reply ? reply(args[3]) : 1;
        },
        callerThread: ()=>'main',
    });
    return { fns, asked, errors, called };
}

test('the name comes before the type, which is the opposite of the tree', ()=>{
    // FindResourceA(hModule, lpName, lpType). Swapping them finds nothing and
    // says nothing, which is why this is asserted rather than assumed.
    const { fns, asked } = setup();
    fns.FindResourceA.handler([0, 101, RT_BITMAP]);

    assert.deepEqual(asked, [{ instance: 0, type: RT_BITMAP, name: 101 }]);
});

test('FindResourceExA is FindResource with the type and name swapped in order', ()=>{
    // FindResourceExA(hModule, lpType, lpName, wLanguage): type first, unlike
    // FindResourceA, and it stops the stack corruption an unimplemented import
    // causes -- it is a 16-byte stdcall the loader would otherwise pop nothing
    // for.
    const { fns, asked } = setup();
    const found = fns.FindResourceExA.handler([0, RT_BITMAP, 101, 0x409]);

    assert.notEqual(found, 0);
    assert.deepEqual(asked.at(-1), { instance: 0, type: RT_BITMAP, name: 101, language: 0x409 },
        'the language asked for is the language looked up');
    assert.equal(fns.LockResource.handler([found]), 0x00402000,
        'and it lands where FindResourceA would');
    assert.equal(fns.FindResourceExA.argBytes, 16, 'four arguments, so the stack stays whole');
    assert.equal(fns.FindResourceExA.handler([0, RT_BITMAP, 999, 0]), 0);
    assert.deepEqual(asked.at(-1), { instance: 0, type: RT_BITMAP, name: 999 },
        'a language of zero is whatever is there');
});

test('a value below 64 KiB is an identifier and above it is a pointer', ()=>{
    // MAKEINTRESOURCE is exactly this trick. Reading the wrong one of the two
    // turns a numeric type into a wild pointer.
    const { fns, asked } = setup();
    fns.FindResourceA.handler([0, 0x19000, RT_STRING]);

    assert.deepEqual(asked.at(-1), { instance: 0, type: RT_STRING, name: 'MYNAME' });
});

test('a found resource can be sized and locked, and a missing one cannot', ()=>{
    const { fns, errors } = setup();
    const found = fns.FindResourceA.handler([0, 101, RT_BITMAP]);
    assert.notEqual(found, 0);

    assert.equal(fns.SizeofResource.handler([0, found]), 1234);
    // LockResource is arithmetic: the bytes came in with the image and have not
    // moved, so this is the module base plus the resource RVA.
    assert.equal(fns.LoadResource.handler([0, found]), found);
    assert.equal(fns.LockResource.handler([found]), 0x00402000);
    assert.equal(fns.FreeResource.handler(), 1);

    assert.equal(fns.FindResourceA.handler([0, 999, RT_BITMAP]), 0);
    assert.ok(errors.length > 0, 'and the failure is reported through the error slot');
});

test('a handle nobody was given is not a resource', ()=>{
    const { fns } = setup();
    assert.equal(fns.SizeofResource.handler([0, 0x1234]), 0);
    assert.equal(fns.LockResource.handler([0x1234]), 0);
});

test('FindResourceExA takes the type before the name, and the language after both', ()=>{
    const { fns, asked } = setup();
    assert.notEqual(fns.FindResourceExA.handler([0, RT_BITMAP, 101, 1033]), 0);
    assert.deepEqual(asked, [{ instance: 0, type: RT_BITMAP, name: 101, language: 1033 }]);
    assert.equal(fns.FindResourceExA.argBytes, 16);
});

test('the languages of a resource are enumerated as the caller named it, until one says stop', ()=>{
    const { fns, called } = setup();
    assert.equal(fns.EnumResourceLanguagesA.handler([0, RT_STRING, 1, 0x401000, 0x77]), 1);
    assert.deepEqual(called, [
        { entry: 0x401000, args: [0, RT_STRING, 1, 1033, 0x77], thread: 'main' },
        { entry: 0x401000, args: [0, RT_STRING, 1, 1036, 0x77], thread: 'main' },
    ]);

    const stopping = setup({ reply: ()=>0 });
    assert.equal(stopping.fns.EnumResourceLanguagesA.handler([0, RT_STRING, 1, 0x401000, 0]), 1);
    assert.equal(stopping.called.length, 1, 'FALSE from the callback ends the enumeration');
    assert.equal(fns.EnumResourceLanguagesA.argBytes, 20);
});

test('a named resource is enumerated whatever the case, and a missing one is an error', ()=>{
    const { fns, called, errors } = setup();
    // 0x19000 reads as MYNAME; the tree holds it as myname.
    assert.equal(fns.EnumResourceLanguagesA.handler([0, RT_BITMAP, 0x19000, 0x401000, 0]), 1);
    assert.deepEqual(called[0].args, [0, RT_BITMAP, 0x19000, 1031, 0],
        'the pointer is passed through as the caller gave it');
    assert.equal(fns.EnumResourceLanguagesA.handler([0, RT_BITMAP, 999, 0x401000, 0]), 0);
    assert.deepEqual(errors, [1813]);
});

test('a callback that answers late carries the enumeration on a promise', async()=>{
    const { fns, called } = setup({ reply: language=>Promise.resolve(language === 1033 ? 1 : 0) });
    const result = fns.EnumResourceLanguagesA.handler([0, RT_STRING, 1, 0x401000, 0]);
    assert.equal(typeof (/** @type {Promise<number>} */ (result)).then, 'function');
    assert.equal(await result, 1);
    assert.equal(called.length, 2);
});
