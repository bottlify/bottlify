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

/** Wide names at these addresses; any other address reads as OTHER. */
const WIDE = new Map([[0x1a000, 'TestDll'], [0x1b000, 'TESTDLL'], [0x1c000, '#101']]);

/**
 * @param {{ reply?: (language: number) => number | Promise<number>, wide?: boolean }}
 *     [options]
 */
function setup({ reply, wide = true } = {}){
    /** @type {any[]} */
    const asked = [];
    /** @type {number[]} */
    const errors = [];
    /** @type {{ entry: number, args: number[], thread: unknown }[]} */
    const called = [];
    /** @type {{ bytes: number, text?: string }[]} */
    const placed = [];
    /** @type {number[]} */
    const freed = [];
    const fns = createResourceFunctions({
        readCString: address=>address === 0x19000 ? 'MYNAME'
            : address === 0x19100 ? '#101' : 'OTHER',
        ...wide ? { readWideString: (/** @type {number} */ address)=>
            WIDE.get(address) ?? 'OTHER' } : {},
        setLastError: code=>{
            errors.push(code);
        },
        findResource: (instance, type, name, language = null)=>{
            asked.push(language === null
                ? { instance, type, name } : { instance, type, name, language });
            if (type === RT_BITMAP && name === 101 && (language === null || language === 1033))
            {
                return { rva: 0x2000, size: 1234 };
            }
            return typeof type === 'string' && type.toLowerCase() === 'testdll'
                && name === 'OTHER' ? { rva: 0x3000, size: 16 } : null;
        },
        listResources: ()=>[
            { type: RT_STRING, name: 1, language: 1033 },
            { type: RT_STRING, name: 1, language: 1036 },
            { type: RT_STRING, name: 2, language: 1033 },
            { type: RT_BITMAP, name: 'myname', language: 1031 },
            { type: RT_BITMAP, name: 101, language: 1033 },
            { type: 'TESTDLL', name: 'OTHER', language: 1033 },
        ],
        moduleBase: ()=>0x00400000,
        call: (entry, args, thread)=>{
            called.push({ entry, args, thread });
            return reply ? reply(args[3]) : 1;
        },
        callerThread: ()=>'main',
        allocate: bytes=>{
            placed.push({ bytes });
            return 0x50000;
        },
        writeMemory: (address, bytes)=>{
            placed[placed.length - 1].text = String.fromCharCode(...bytes);
        },
        free: address=>{
            freed.push(address);
        },
    });
    return { fns, asked, errors, called, placed, freed };
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
    assert.equal(fns.LoadResource.handler([0, found]), 0x00402000,
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
    // LoadResource is arithmetic: the bytes came in with the image and have not
    // moved, so this is the module base plus the resource RVA.
    assert.equal(fns.LoadResource.handler([0, found]), 0x00402000);
    assert.equal(fns.LockResource.handler([0x00402000]), 0x00402000);
    assert.equal(fns.FreeResource.handler(), 1);

    assert.equal(fns.FindResourceA.handler([0, 999, RT_BITMAP]), 0);
    assert.ok(errors.length > 0, 'and the failure is reported through the error slot');
});

test('LoadResource answers the address of the data, and LockResource hands back its argument', ()=>{
    // A program that skips LockResource and reads straight through what
    // LoadResource returned is relying on Win32, not on a quirk: the HGLOBAL is
    // the pointer. So is one that locks a handle it never got from us.
    const { fns } = setup();
    const found = fns.FindResourceA.handler([0, 101, RT_BITMAP]);
    const loaded = fns.LoadResource.handler([0, found]);

    assert.equal(loaded, 0x00402000, 'module base plus the resource RVA');
    assert.equal(fns.LockResource.handler([loaded]), loaded);
    assert.equal(fns.LockResource.handler([0x00350000]), 0x00350000);
    assert.equal(fns.LoadResource.handler([0, 0]), 0, 'no HRSRC, nothing loaded');
});

test('a handle nobody was given is not a resource', ()=>{
    const { fns } = setup();
    assert.equal(fns.SizeofResource.handler([0, 0x1234]), 0);
    assert.equal(fns.LoadResource.handler([0, 0x1234]), 0);
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
    assert.deepEqual(errors, [1814], 'the type is there and the name is not');
});

test('a callback that answers late carries the enumeration on a promise', async()=>{
    const { fns, called } = setup({ reply: language=>Promise.resolve(language === 1033 ? 1 : 0) });
    const result = fns.EnumResourceLanguagesA.handler([0, RT_STRING, 1, 0x401000, 0]);
    assert.equal(typeof (/** @type {Promise<number>} */ (result)).then, 'function');
    assert.equal(await result, 1);
    assert.equal(called.length, 2);
});

test('FindResourceW takes the name before the type and reads both as wide strings', ()=>{
    // dinput's tests carry their drivers as FindResourceW(NULL, name, L"TESTDLL").
    const { fns, asked } = setup();
    const found = fns.FindResourceW.handler([0, 0x2a000, 0x1a000]);

    assert.notEqual(found, 0);
    assert.deepEqual(asked.at(-1), { instance: 0, type: 'TestDll', name: 'OTHER' });
    assert.equal(fns.LoadResource.handler([0, found]), 0x00403000);
    assert.equal(fns.SizeofResource.handler([0, found]), 16);
    assert.equal(fns.FindResourceW.argBytes, 12);
    assert.notEqual(fns.FindResourceW.handler([0, 101, RT_BITMAP]), 0, 'and integers as integers');
});

test('FindResourceExW takes the type first and the language after the name', ()=>{
    const { fns, asked } = setup();
    assert.notEqual(fns.FindResourceExW.handler([0, RT_BITMAP, 101, 1033]), 0);
    assert.deepEqual(asked.at(-1), { instance: 0, type: RT_BITMAP, name: 101, language: 1033 });
    assert.notEqual(fns.FindResourceExW.handler([0, RT_BITMAP, 101, 0]), 0,
        'LANG_NEUTRAL is whatever is there');
    assert.equal(fns.FindResourceExW.argBytes, 16);
});

test('a name that is # and digits is the integer it spells, in either width', ()=>{
    const { fns, asked } = setup();
    assert.notEqual(fns.FindResourceA.handler([0, 0x19100, RT_BITMAP]), 0);
    assert.deepEqual(asked.at(-1), { instance: 0, type: RT_BITMAP, name: 101 });
    assert.notEqual(fns.FindResourceW.handler([0, 0x1c000, RT_BITMAP]), 0);
    assert.deepEqual(asked.at(-1), { instance: 0, type: RT_BITMAP, name: 101 });
});

test('a failed lookup says whether the type, the name or the language was missing', ()=>{
    // Wine's kernel32 resource test, test_find_resource: RT_DIALOG where the
    // image has none is the type, a second menu the name, a language the menu
    // is not in the language.
    const { fns, errors } = setup();
    assert.equal(fns.FindResourceW.handler([0, 101, 5]), 0);
    assert.equal(fns.FindResourceW.handler([0, 102, RT_BITMAP]), 0);
    assert.equal(fns.FindResourceExW.handler([0, RT_BITMAP, 101, 0x407]), 0);
    assert.deepEqual(errors, [1813, 1814, 1815]);
});

test('without a wide reader a W call still finds by integer, and a named one is not found', ()=>{
    const { fns, errors } = setup({ wide: false });
    assert.notEqual(fns.FindResourceW.handler([0, 101, RT_BITMAP]), 0);
    assert.equal(fns.FindResourceW.handler([0, 0x2a000, 0x1a000]), 0);
    assert.deepEqual(errors, [1813]);
});

test('EnumResourceLanguagesW reads the names wide and passes them on as given', ()=>{
    const { fns, called } = setup();
    assert.equal(fns.EnumResourceLanguagesW.handler([0, 0x1b000, 0x2a000, 0x401000, 5]), 1);
    assert.deepEqual(called, [
        { entry: 0x401000, args: [0, 0x1b000, 0x2a000, 1033, 5], thread: 'main' },
    ]);
    assert.equal(fns.EnumResourceLanguagesW.argBytes, 20);
});

test('the names of a type are enumerated once each, a string name placed for its callback', ()=>{
    const { fns, called, placed, freed } = setup();
    assert.equal(fns.EnumResourceNamesA.handler([0, RT_STRING, 0x401000, 0x77]), 1);
    assert.deepEqual(called.map(({ args })=>args),
        [[0, RT_STRING, 1, 0x77], [0, RT_STRING, 2, 0x77]],
        'a name in two languages is one name');

    const named = setup();
    assert.equal(named.fns.EnumResourceNamesA.handler([0, RT_BITMAP, 0x401000, 0]), 1);
    assert.deepEqual(named.called.map(({ args })=>args[2]), [0x50000, 101]);
    assert.deepEqual(named.placed, [{ bytes: 7, text: 'myname ' }]);
    assert.deepEqual(named.freed, [0x50000], 'the string lives for its callback only');
    assert.equal(placed.length + freed.length, 0);
    assert.equal(fns.EnumResourceNamesA.argBytes, 16);
});

test('a callback that says stop ends the name enumeration with FALSE', ()=>{
    const { fns, called } = setup({ reply: ()=>0 });
    assert.equal(fns.EnumResourceNamesA.handler([0, RT_STRING, 0x401000, 0]), 0);
    assert.equal(called.length, 1);
    const missing = setup();
    assert.equal(missing.fns.EnumResourceNamesW.handler([0, 99, 0x401000, 0]), 0);
    assert.deepEqual(missing.errors, [1813]);
});

test('the types of an image are enumerated once each, a string type placed for its callback', ()=>{
    const { fns, called, placed, freed } = setup();
    assert.equal(fns.EnumResourceTypesA.handler([0, 0x401000, 0x77]), 1);
    assert.deepEqual(called.map(({ args })=>args),
        [[0, RT_STRING, 0x77], [0, RT_BITMAP, 0x77], [0, 0x50000, 0x77]],
        'a type with several names is one type');
    assert.deepEqual(placed, [{ bytes: 8, text: 'TESTDLL\0' }]);
    assert.deepEqual(freed, [0x50000], 'the string lives for its callback only');
    assert.equal(fns.EnumResourceTypesW.argBytes, 12);

    const stopped = setup({ reply: ()=>0 });
    assert.equal(stopped.fns.EnumResourceTypesW.handler([0, 0x401000, 0]), 0, 'stopped: FALSE');
    assert.equal(stopped.called.length, 1);

    const none = setup();
    assert.equal(none.fns.EnumResourceTypesA.handler([0, 0, 0]), 0);
    assert.deepEqual(none.errors, [1812], 'no callback: ERROR_RESOURCE_DATA_NOT_FOUND');
});
