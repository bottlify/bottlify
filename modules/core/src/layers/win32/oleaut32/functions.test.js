/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHive, HKEY_CLASSES_ROOT } from '../advapi32/registry.js';
import { buildImage, buildResources } from '../../loader/internal/resources.test.js';
import { createAutomationFunctions, OLEAUT32_ORDINALS } from './functions.js';
import { IID_ITYPELIB } from './objects.js';

const S_OK = 0x00000000;
const E_INVALIDARG = 0x80070057;
const DISP_E_TYPEMISMATCH = 0x80020005;
const DISP_E_OVERFLOW = 0x8002000a;

const VT_EMPTY = 0;
const VT_I2 = 2;
const VT_I4 = 3;
const VT_R8 = 5;
const VT_BSTR = 8;
const VT_UNKNOWN = 13;
const VT_UI1 = 17;
const VT_BYREF = 0x4000;

const VARIANT_ALPHABOOL = 0x0002;
const VT_BOOL = 11;

/** Guest addresses the fixtures use; far enough apart that nothing overlaps. */
const TEXT = 0x1000;
const VARIANT_A = 0x2000;
const VARIANT_B = 0x2020;
const SLOT = 0x2100;

function fakeHost(){
    const bytes = new Uint8Array(0x10000);
    /** @type {Map<number, number>} */
    const live = new Map();
    /** @type {string[]} */
    const said = [];
    let next = 0x8000;

    const host = {
        bytes,
        live,
        said,
        exhausted: false,
        heap: {
            /** @param {number} size */
            allocate(size){
                if (host.exhausted)
                {
                    return 0;
                }
                const address = next;
                next += Math.max(8, size) + 8;
                live.set(address, size);
                return address;
            },
            /** @param {number} address */
            free: address=>live.delete(address),
        },
        /** @param {number} address @param {number} length */
        readMemory: (address, length)=>bytes.subarray(address, address + length),
        /** @param {number} address @param {Uint8Array} data */
        writeMemory: (address, data)=>bytes.set(data, address),
        /** @param {number} address @param {number} value @param {number} length */
        fillMemory: (address, value, length)=>bytes.fill(value, address, address + length),
        /** @param {string} api @param {string} detail */
        divergence: (api, detail)=>said.push(`${api}: ${detail}`),
        /** @param {number} address */
        u16: address=>bytes[address] | (bytes[address + 1] << 8),
        /** @param {number} address */
        u32: address=>(bytes[address] | (bytes[address + 1] << 8)
            | (bytes[address + 2] << 16) | (bytes[address + 3] << 24)) >>> 0,
        /** @param {number} address @param {number} value */
        putU16(address, value){
            bytes[address] = value & 0xff;
            bytes[address + 1] = (value >>> 8) & 0xff;
        },
        /** @param {number} address @param {number} value */
        putU32(address, value){
            for (let index = 0; index < 4; index++)
            {
                bytes[address + index] = (value >>> (index * 8)) & 0xff;
            }
        },
        /** Lays out an OLECHAR string with its terminator. @param {number} at @param {string} text */
        putWide(at, text){
            for (let index = 0; index < text.length; index++)
            {
                host.putU16(at + index * 2, text.charCodeAt(index));
            }
            host.putU16(at + text.length * 2, 0);
        },
        /** @param {number} at @param {number} type @param {number} value */
        putVariant(at, type, value){
            bytes.fill(0, at, at + 16);
            host.putU16(at, type);
            host.putU32(at + 8, value);
        },
    };
    return host;
}

/** @type {ReturnType<typeof fakeHost>} */
let host;
/** @type {Record<string, { argBytes: number, handler: (args: number[]) => number | Promise<number> }>} */
let fx;

/** @param {string} name @param {number[]} args */
const call = (name, args)=>(/** @type {number} */ (fx[name].handler(args))) >>> 0;

const setUp = ()=>{
    host = fakeHost();
    fx = createAutomationFunctions(host);
};

test('error information is held once, handed over once, and absent by default', ()=>{
    setUp();
    host.putU32(SLOT, 0xdeadbeef);
    assert.equal(call('GetErrorInfo', [0, SLOT]), 1, 'S_FALSE: nothing set');
    assert.equal(host.u32(SLOT), 0, 'and the out pointer is cleared');
    assert.equal(call('SetErrorInfo', [0, 0x12340]), 0);
    assert.equal(call('GetErrorInfo', [0, SLOT]), 0);
    assert.equal(host.u32(SLOT), 0x12340);
    assert.equal(call('GetErrorInfo', [0, SLOT]), 1, 'collected once, gone');
    assert.equal(fx.GetErrorInfo.argBytes, 8);
    assert.equal(fx.SetErrorInfo.argBytes, 8);
});

test('a BSTR carries its byte count in front of the pointer it hands out', ()=>{
    setUp();
    host.putWide(TEXT, 'hi');
    const bstr = call('SysAllocString', [TEXT]);

    assert.notEqual(bstr, 0);
    // The four bytes before the string are its length in BYTES, and the caller
    // holds the address after them. A program reads that prefix directly, so
    // getting it wrong hands it whatever the allocator left in front.
    assert.equal(host.u32(bstr - 4), 4, 'two characters is four bytes');
    assert.equal(host.u16(bstr), 'h'.charCodeAt(0));
    assert.equal(host.u16(bstr + 2), 'i'.charCodeAt(0));
    assert.equal(host.u16(bstr + 4), 0, 'and it is terminated after the last character');
    assert.ok(host.live.has(bstr - 4), 'the block starts at the prefix, not the pointer');
});

test('length is asked in characters and in bytes, and the two differ', ()=>{
    setUp();
    host.putWide(TEXT, 'abcd');
    const bstr = call('SysAllocString', [TEXT]);

    assert.equal(call('SysStringLen', [bstr]), 4);
    assert.equal(call('SysStringByteLen', [bstr]), 8);
});

test('an embedded NUL is kept, because the length is the prefix and not a scan', ()=>{
    setUp();
    const bstr = call('SysAllocStringLen', [TEXT, 3]);
    host.putU16(bstr + 2, 0);

    assert.equal(call('SysStringLen', [bstr]), 3, 'still three characters long');
});

test('SysAllocStringLen(NULL, n) is a real string of n characters, zeroed', ()=>{
    setUp();
    host.bytes.fill(0xa5, 0x8000, 0x8100);
    const bstr = call('SysAllocStringLen', [0, 3]);

    assert.notEqual(bstr, 0, 'a NULL source allocates rather than refusing');
    assert.equal(call('SysStringLen', [bstr]), 3);
    assert.deepEqual([...host.bytes.subarray(bstr, bstr + 8)], [0, 0, 0, 0, 0, 0, 0, 0],
        'the characters and the terminator, with nothing left over from before');
});

test('SysAllocString(NULL) answers NULL rather than an empty string', ()=>{
    setUp();
    assert.equal(call('SysAllocString', [0]), 0);
    assert.equal(host.live.size, 0, 'and allocates nothing');
});

test('SysFreeString(NULL) does nothing at all', ()=>{
    setUp();
    host.putWide(TEXT, 'x');
    const bstr = call('SysAllocString', [TEXT]);

    call('SysFreeString', [0]);
    assert.equal(host.live.size, 1, 'the string that does exist is untouched');
    call('SysFreeString', [bstr]);
    assert.equal(host.live.size, 0);
});

test('SysAllocStringByteLen counts bytes, so an odd length is possible', ()=>{
    setUp();
    host.bytes.set([0x41, 0x42, 0x43], TEXT);
    const bstr = call('SysAllocStringByteLen', [TEXT, 3]);

    assert.equal(call('SysStringByteLen', [bstr]), 3);
    assert.deepEqual([...host.bytes.subarray(bstr, bstr + 3)], [0x41, 0x42, 0x43],
        'the bytes are copied as they are, not interpreted as characters');
});

test('SysReAllocString replaces the string in the slot and frees the old one', ()=>{
    setUp();
    host.putWide(TEXT, 'old');
    const first = call('SysAllocString', [TEXT]);
    host.putU32(SLOT, first);

    host.putWide(TEXT, 'longer');
    assert.equal(call('SysReAllocString', [SLOT, TEXT]), 1);

    const second = host.u32(SLOT);
    assert.notEqual(second, first);
    assert.equal(call('SysStringLen', [second]), 6);
    assert.equal(host.live.has(first - 4), false, 'the old string is gone');
});

test('VariantInit empties the whole variant, not only its type', ()=>{
    setUp();
    host.bytes.fill(0xa5, VARIANT_A, VARIANT_A + 16);
    call('VariantInit', [VARIANT_A]);

    assert.deepEqual([...host.bytes.subarray(VARIANT_A, VARIANT_A + 16)], new Array(16).fill(0));
});

test('VariantClear frees the string a variant held and empties the type', ()=>{
    setUp();
    host.putWide(TEXT, 'held');
    const bstr = call('SysAllocString', [TEXT]);
    host.putVariant(VARIANT_A, VT_BSTR, bstr);

    assert.equal(call('VariantClear', [VARIANT_A]), S_OK);
    assert.equal(host.u16(VARIANT_A), VT_EMPTY);
    assert.equal(host.u32(VARIANT_A + 8), 0);
    assert.equal(host.live.has(bstr - 4), false);
});

test('VariantCopy of a string makes a second string, not a second pointer', ()=>{
    setUp();
    host.putWide(TEXT, 'shared');
    const bstr = call('SysAllocString', [TEXT]);
    host.putVariant(VARIANT_A, VT_BSTR, bstr);

    assert.equal(call('VariantCopy', [VARIANT_B, VARIANT_A]), S_OK);
    const copy = host.u32(VARIANT_B + 8);
    assert.notEqual(copy, bstr, 'the copy owns its own storage');
    assert.equal(call('SysStringLen', [copy]), 6);

    // The two are independent, which is the whole point: clearing one must not
    // leave the other pointing at a freed block.
    call('VariantClear', [VARIANT_A]);
    assert.equal(call('SysStringLen', [copy]), 6);
});

test('VariantCopy keeps a reference a reference; only CopyInd follows it', ()=>{
    setUp();
    host.putU32(SLOT, 77);
    host.putVariant(VARIANT_A, VT_I4 | VT_BYREF, SLOT);

    assert.equal(call('VariantCopy', [VARIANT_B, VARIANT_A]), S_OK);
    assert.equal(host.u16(VARIANT_B), VT_I4 | VT_BYREF);
    assert.equal(host.u32(VARIANT_B + 8), SLOT);

    assert.equal(call('VariantCopyInd', [VARIANT_B, VARIANT_A]), S_OK);
    assert.equal(host.u16(VARIANT_B), VT_I4, 'the reference is gone');
    assert.equal(host.u32(VARIANT_B + 8), 77, 'and the value is here');
});

test('a number becomes a string and reads back as the same number', ()=>{
    setUp();
    host.putVariant(VARIANT_A, VT_I4, 4294967295); // -1 as a signed long

    assert.equal(call('VariantChangeType', [VARIANT_B, VARIANT_A, 0, VT_BSTR]), S_OK);
    assert.equal(host.u16(VARIANT_B), VT_BSTR);
    const bstr = host.u32(VARIANT_B + 8);
    assert.equal(call('SysStringLen', [bstr]), 2, '"-1"');

    assert.equal(call('VariantChangeType', [VARIANT_A, VARIANT_B, 0, VT_I4]), S_OK);
    assert.equal(host.u32(VARIANT_A + 8), 0xffffffff);
});

test('a boolean is minus one, not one', ()=>{
    setUp();
    host.putVariant(VARIANT_A, VT_I4, 5);

    assert.equal(call('VariantChangeType', [VARIANT_B, VARIANT_A, 0, VT_BOOL]), S_OK);
    // A program tests `== VARIANT_TRUE` as readily as it tests non-zero, so a
    // boolean stored as 1 is neither true nor false to the code that asked.
    assert.equal(host.u16(VARIANT_B + 8), 0xffff);
});

test('a boolean spells itself as a number unless words were asked for', ()=>{
    setUp();
    host.putVariant(VARIANT_A, VT_BOOL, 0xffff);

    assert.equal(call('VariantChangeType', [VARIANT_B, VARIANT_A, 0, VT_BSTR]), S_OK);
    assert.equal(call('SysStringLen', [host.u32(VARIANT_B + 8)]), 2, '"-1"');

    assert.equal(
        call('VariantChangeType', [VARIANT_B, VARIANT_A, VARIANT_ALPHABOOL, VT_BSTR]), S_OK);
    assert.equal(call('SysStringLen', [host.u32(VARIANT_B + 8)]), 4, '"True"');
});

test('a value that will not fit the target overflows rather than wrapping', ()=>{
    setUp();
    host.putVariant(VARIANT_A, VT_I4, 300);

    assert.equal(call('VariantChangeType', [VARIANT_B, VARIANT_A, 0, VT_UI1]), DISP_E_OVERFLOW);
    assert.equal(host.u16(VARIANT_B), VT_EMPTY, 'and nothing is left in the destination');
});

test('a rounded conversion goes to nearest, with halves away from zero', ()=>{
    setUp();
    const value = new Uint8Array(8);
    new DataView(value.buffer).setFloat64(0, 2.5, true);
    host.putVariant(VARIANT_A, VT_R8, 0);
    host.bytes.set(value, VARIANT_A + 8);

    assert.equal(call('VariantChangeType', [VARIANT_B, VARIANT_A, 0, VT_I2]), S_OK);
    assert.equal(host.u16(VARIANT_B + 8), 3);
});

test('a string that is not a number is a type mismatch, not a zero', ()=>{
    setUp();
    host.putWide(TEXT, 'banana');
    host.putVariant(VARIANT_A, VT_BSTR, call('SysAllocString', [TEXT]));

    assert.equal(call('VariantChangeType', [VARIANT_B, VARIANT_A, 0, VT_I4]),
        DISP_E_TYPEMISMATCH);
});

test('a conversion may write over its own source', ()=>{
    setUp();
    host.putWide(TEXT, '42');
    host.putVariant(VARIANT_A, VT_BSTR, call('SysAllocString', [TEXT]));

    assert.equal(call('VariantChangeType', [VARIANT_A, VARIANT_A, 0, VT_I4]), S_OK);
    assert.equal(host.u16(VARIANT_A), VT_I4);
    assert.equal(host.u32(VARIANT_A + 8), 42, 'read before the destination was freed');
});

test('a NULL variant is rejected rather than written through', ()=>{
    setUp();
    assert.equal(call('VariantClear', [0]), E_INVALIDARG);
    assert.equal(call('VariantCopy', [0, VARIANT_A]), E_INVALIDARG);
    assert.equal(call('VariantChangeType', [VARIANT_B, 0, 0, VT_I4]), E_INVALIDARG);
});

test('an interface a variant held is dropped, and the difference is reported', ()=>{
    setUp();
    host.putVariant(VARIANT_A, VT_UNKNOWN, 0x4444);

    assert.equal(call('VariantClear', [VARIANT_A]), S_OK);
    assert.equal(host.u16(VARIANT_A), VT_EMPTY);
    // Accepting a call and not doing all of it is the defect class that shows
    // up as behaviour rather than as an error, so it has to be said out loud.
    assert.ok(host.said.some(line=>line.includes('Release')),
        `nothing reported the missing Release: ${JSON.stringify(host.said)}`);
});

test('an exhausted heap fails the allocation instead of answering a bad pointer', ()=>{
    setUp();
    host.putWide(TEXT, 'x');
    host.exhausted = true;

    assert.equal(call('SysAllocString', [TEXT]), 0);
    assert.equal(call('SysReAllocString', [SLOT, TEXT]), 0, 'and the slot is left alone');
    assert.equal(host.u32(SLOT), 0);
});

test('every ordinal names a function this library actually has', ()=>{
    setUp();
    // A program of this era imports oleaut32 by number alone -- there is no
    // name in its import table -- so an ordinal pointing at nothing is a call
    // that binds and then jumps into nowhere with nothing to name it.
    for (const [ordinal, name] of Object.entries(OLEAUT32_ORDINALS))
    {
        assert.ok(name in fx, `ordinal ${ordinal} names ${name}, which is not implemented`);
    }
});

test('the property frame is refused out loud, with the stack it was pushed', ()=>{
    setUp();
    // Imported by number and never by name, so nothing in a program's import
    // table would say which call this is. Declared all the same: the loader's
    // stub for an unclaimed ordinal pops nothing, and eleven arguments left on
    // the stack corrupt the caller from there on.
    assert.equal(fx.OleCreatePropertyFrame.argBytes, 44);
    assert.equal(call('OleCreatePropertyFrame', [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
        0x80004001, 'E_NOTIMPL, which a caller checks');
    assert.ok(host.said.some(line=>line.includes('OleCreatePropertyFrame')),
        `nothing reported the refusal: ${JSON.stringify(host.said)}`);
});

test('the ordinals are the ones a real oleaut32 exports', ()=>{
    // Read off a real export directory. A wrong number here binds a call to a
    // different function and nothing anywhere would say so.
    assert.equal(OLEAUT32_ORDINALS[2], 'SysAllocString');
    assert.equal(OLEAUT32_ORDINALS[6], 'SysFreeString');
    assert.equal(OLEAUT32_ORDINALS[7], 'SysStringLen');
    assert.equal(OLEAUT32_ORDINALS[8], 'VariantInit');
    assert.equal(OLEAUT32_ORDINALS[9], 'VariantClear');
    assert.equal(OLEAUT32_ORDINALS[12], 'VariantChangeType');
    // The SafeArray block: a program that imports 15 wants an array made,
    // and one bound to the dimension count instead corrupts its stack.
    assert.equal(OLEAUT32_ORDINALS[15], 'SafeArrayCreate');
    assert.equal(OLEAUT32_ORDINALS[16], 'SafeArrayDestroy');
    assert.equal(OLEAUT32_ORDINALS[17], 'SafeArrayGetDim');
    assert.equal(OLEAUT32_ORDINALS[18], 'SafeArrayGetElemsize');
    assert.equal(OLEAUT32_ORDINALS[19], 'SafeArrayGetUBound');
    assert.equal(OLEAUT32_ORDINALS[20], 'SafeArrayGetLBound');
    assert.equal(OLEAUT32_ORDINALS[21], 'SafeArrayLock');
    assert.equal(OLEAUT32_ORDINALS[22], 'SafeArrayUnlock');
    assert.equal(OLEAUT32_ORDINALS[23], 'SafeArrayAccessData');
    assert.equal(OLEAUT32_ORDINALS[24], 'SafeArrayUnaccessData');
    assert.equal(OLEAUT32_ORDINALS[25], 'SafeArrayGetElement');
    assert.equal(OLEAUT32_ORDINALS[26], 'SafeArrayPutElement');
    assert.equal(OLEAUT32_ORDINALS[27], 'SafeArrayCopy');
    assert.equal(OLEAUT32_ORDINALS[28], 'DispGetParam');
    assert.equal(OLEAUT32_ORDINALS[29], 'DispGetIDsOfNames');
    assert.equal(OLEAUT32_ORDINALS[40], 'SafeArrayRedim');
    assert.equal(OLEAUT32_ORDINALS[147], 'VariantChangeTypeEx');
    assert.equal(OLEAUT32_ORDINALS[149], 'SysStringByteLen');
    assert.equal(OLEAUT32_ORDINALS[150], 'SysAllocStringByteLen');
    assert.equal(OLEAUT32_ORDINALS[161], 'LoadTypeLib');
    assert.equal(OLEAUT32_ORDINALS[163], 'RegisterTypeLib');
    assert.equal(OLEAUT32_ORDINALS[417], 'OleCreatePropertyFrame');
});

test('without a volume or vtables no type library loads, and the pointer says so', ()=>{
    setUp();
    host.putWide(TEXT, 'C:\\lib.tlb');
    host.putU32(SLOT, 0xdeadbeef);
    assert.equal(call('LoadTypeLib', [TEXT, SLOT]) | 0, 0x80029c4a | 0);
    assert.equal(host.u32(SLOT), 0);
    host.putU32(SLOT, 0xdeadbeef);
    assert.equal(call('LoadRegTypeLib', [TEXT, 1, 0, 0, SLOT]) | 0, 0x8002801d | 0);
    assert.equal(host.u32(SLOT), 0);
    assert.equal(call('RegisterTypeLib', [0x1234, TEXT, 0]) | 0, 0x80070057 | 0);
    assert.equal(fx.LoadTypeLib.argBytes, 8);
    assert.equal(fx.LoadTypeLibEx.argBytes, 12);
    assert.equal(fx.LoadRegTypeLib.argBytes, 20);
    assert.equal(fx.RegisterTypeLib.argBytes, 12);
    assert.equal(fx.UnRegisterTypeLib.argBytes, 20);
});

/** An MSFT type library, as a .tlb file holds it. */
const FIXTURE_LIBRARY = new Uint8Array(
    readFileSync(new URL('./msft-typelib.bin', import.meta.url)));

/**
 * The fixture library, on a one-file volume, with a hive and a publisher.
 *
 * @param {string} [where]  The one file's path. @param {Uint8Array} [content]  Its bytes.
 */
function libraryHost(where = 'c:\\lib\\engine.tlb', content = undefined){
    const base = fakeHost();
    const bytes = content ?? FIXTURE_LIBRARY;
    /** @type {{ object: any, id: string }[]} */
    const published = [];
    /** @type {string[]} */
    const opened = [];
    const hive = createHive();
    return {
        ...base,
        hive,
        published,
        opened,
        files: {
            /** @param {string} path */
            stat: path=>(path.toLowerCase() === where
                ? { exists: true, isDirectory: false, size: bytes.length }
                : { exists: false, isDirectory: false, size: 0 }),
            /** @param {string} path */
            open: path=>{
                opened.push(path);
                return { path };
            },
            /** @param {any} node @param {number} offset @param {number} length */
            read: (node, offset, length)=>(opened.length % 2 === 0
                ? Promise.resolve(bytes.subarray(offset, offset + length))
                : bytes.subarray(offset, offset + length)),
            close: ()=>{},
        },
        vtables: {
            /** @param {any} object @param {string} id */
            publish: (object, id)=>{
                published.push({ object, id });
                return 0x7000 + published.length * 16;
            },
        },
        call: ()=>Promise.resolve(0),
    };
}

test('LoadTypeLib reads a library an executable carries as its TYPELIB resource', async()=>{
    // A COM server names its own image to register its library: the library
    // is resource TYPELIB 1 inside it, and \\N after the path names another.
    const rsrc = buildResources([{ type: 'TYPELIB',
        names: [{ name: 1, langs: [{ lang: 0, data: [...FIXTURE_LIBRARY] }] }] }]);
    const lib = libraryHost('c:\\lib\\kernel.exe', buildImage(rsrc).bytes);
    const fns = createAutomationFunctions(lib);
    lib.putWide(TEXT, 'C:\\lib\\kernel.exe');
    assert.equal(await fns.LoadTypeLib.handler([TEXT, SLOT]), 0);
    assert.equal(lib.published[0].id, IID_ITYPELIB);
    lib.putWide(TEXT, 'C:\\lib\\kernel.exe\\2');
    assert.equal(await fns.LoadTypeLib.handler([TEXT, SLOT]) | 0, 0x80029c4a | 0,
        'no second library in it: TYPE_E_CANTLOADLIBRARY');
});

test('LoadTypeLib reads the file off the volume, and the library registers and loads back',
    async()=>{
        const lib = libraryHost();
        const fns = createAutomationFunctions(lib);
        lib.putWide(TEXT, 'C:\\lib\\engine.tlb');
        assert.equal(fns.LoadTypeLib.handler([TEXT, SLOT]), 0);
        const pointer = lib.u32(SLOT);
        assert.equal(pointer, 0x7010);
        assert.equal(lib.published[0].id, IID_ITYPELIB);
        assert.equal(lib.opened.length, 1, 'read once, whole');

        assert.equal(fns.RegisterTypeLib.handler([pointer, TEXT, 0]), 0);
        const root = /** @type {any} */ (lib.hive.root(HKEY_CLASSES_ROOT));
        const version = lib.hive.open(root, 'TypeLib\\{94636247-BC39-4B8B-A728-2D1FBEBFA76A}\\1.0');
        assert.ok(version, 'the version key, in hex');
        const text = (/** @type {Uint8Array} */ data)=>String.fromCharCode(
            ...data.subarray(0, data.indexOf(0)));
        assert.equal(text(/** @type {any} */ (lib.hive.getValue(version, '')).data),
            'InstallShield Professional Setup Kernel 7.0');
        const win32 = /** @type {any} */ (lib.hive.open(version, '0\\win32'));
        assert.equal(text(/** @type {any} */ (lib.hive.getValue(win32, '')).data),
            'C:\\lib\\engine.tlb');
        assert.equal(text(/** @type {any} */ (lib.hive.getValue(
            /** @type {any} */ (lib.hive.open(version, 'HELPDIR')), '')).data), 'C:\\lib');
        assert.equal(text(/** @type {any} */ (lib.hive.getValue(
            /** @type {any} */ (lib.hive.open(version, 'FLAGS')), '')).data), '0');

        // Loaded back by GUID and version, through a read that arrives later.
        lib.writeMemory(0x3000, Uint8Array.from([0x47, 0x62, 0x63, 0x94, 0x39, 0xbc, 0x8b, 0x4b,
            0xa7, 0x28, 0x2d, 0x1f, 0xbe, 0xbf, 0xa7, 0x6a]));
        const loading = fns.LoadRegTypeLib.handler([0x3000, 1, 0, 0, SLOT]);
        assert.ok(loading instanceof Promise, 'parked on the bytes');
        assert.equal(await loading, 0);
        assert.equal(lib.u32(SLOT), 0x7020, 'a second library object');
        assert.equal(lib.live.size, 0, 'the path string made for the load is freed');
        assert.equal(/** @type {number} */ (fns.LoadRegTypeLib.handler([0x3000, 2, 0, 0, SLOT])) | 0,
            0x8002801d | 0, 'only the registered version');

        assert.equal(fns.UnRegisterTypeLib.handler([0x3000, 1, 0, 0, 1]), 0);
        assert.equal(lib.hive.open(root, 'TypeLib\\{94636247-BC39-4B8B-A728-2D1FBEBFA76A}'), null);
        assert.equal(fns.UnRegisterTypeLib.handler([0x3000, 1, 0, 0, 1]) | 0, 0x8002801d | 0);
        assert.equal(/** @type {number} */ (fns.LoadRegTypeLib.handler([0x3000, 1, 0, 0, SLOT])) | 0,
            0x8002801d | 0);

        lib.putWide(TEXT, 'C:\\lib\\missing.tlb');
        assert.equal(/** @type {number} */ (fns.LoadTypeLib.handler([TEXT, SLOT])) | 0,
            0x80029c4a | 0);
        assert.equal(lib.u32(SLOT), 0);
        assert.ok(lib.said.some(line=>line.includes('missing.tlb')));
    });

test('a library registered from a path in the upper half of the ANSI page loads back from it',
    async()=>{
        // The registry keeps a string in the ANSI page, where 0x80 is the euro
        // sign: the path RegisterTypeLib keeps is in that page, and
        // LoadRegTypeLib reads it back in that page, so it names the same file.
        const lib = libraryHost();
        const original = lib.files;
        lib.files = { ...original,
            stat: (/** @type {string} */ path)=>original.stat(path.replace('\u20ac', '')) };
        const fns = createAutomationFunctions(lib);
        lib.putWide(TEXT, 'C:\\lib\u20ac\\engine.tlb');
        assert.equal(fns.LoadTypeLib.handler([TEXT, SLOT]), 0);
        assert.equal(fns.RegisterTypeLib.handler([lib.u32(SLOT), TEXT, 0]), 0);
        const root = /** @type {any} */ (lib.hive.root(HKEY_CLASSES_ROOT));
        const win32 = /** @type {any} */ (lib.hive.open(root,
            'TypeLib\\{94636247-BC39-4B8B-A728-2D1FBEBFA76A}\\1.0\\0\\win32'));
        assert.deepEqual([.../** @type {any} */ (lib.hive.getValue(win32, '')).data
            .subarray(6, 8)], [0x80, 0x5c]);

        lib.writeMemory(0x3000, Uint8Array.from([0x47, 0x62, 0x63, 0x94, 0x39, 0xbc, 0x8b, 0x4b,
            0xa7, 0x28, 0x2d, 0x1f, 0xbe, 0xbf, 0xa7, 0x6a]));
        assert.equal(await fns.LoadRegTypeLib.handler([0x3000, 1, 0, 0, SLOT]), 0);
        assert.ok(lib.opened.at(-1)?.includes('\u20ac'), 'the file it was registered from');
    });

test('LoadTypeLibEx registers when asked to, and DispGetIDsOfNames reaches a type', async()=>{
    const lib = libraryHost();
    const fns = createAutomationFunctions(lib);
    lib.putWide(TEXT, 'C:\\lib\\engine.tlb');
    assert.equal(fns.LoadTypeLibEx.handler([TEXT, 2, SLOT]), 0, 'REGKIND_NONE');
    const root = /** @type {any} */ (lib.hive.root(HKEY_CLASSES_ROOT));
    assert.equal(lib.hive.open(root, 'TypeLib\\{94636247-BC39-4B8B-A728-2D1FBEBFA76A}'), null,
        'the library is not registered yet');
    // The fake volume's second read arrives later, so the registration waits.
    assert.equal(await fns.LoadTypeLibEx.handler([TEXT, 1, SLOT]), 0, 'REGKIND_REGISTER');
    assert.ok(lib.hive.open(root, 'TypeLib\\{94636247-BC39-4B8B-A728-2D1FBEBFA76A}\\1.0'));

    // A type of the library, then a name looked up through the flat entry.
    const library = lib.u32(SLOT);
    const record = lib.published.find(entry=>entry.id === IID_ITYPELIB && entry.object);
    assert.ok(record);
    const getTypeInfo = record.object.interfaceFor(IID_ITYPELIB).methods
        .find((/** @type {any} */ m)=>m.name === 'GetTypeInfo');
    assert.equal(getTypeInfo.invoke(record.object, [33, SLOT]), 0);
    const typeInfo = lib.u32(SLOT);
    assert.notEqual(typeInfo, library);
    lib.putWide(0x3000, 'Count');
    lib.putU32(0x3100, 0x3000);
    assert.equal(fns.DispGetIDsOfNames.handler([typeInfo, 0x3100, 1, 0x3200]), 0);
    assert.equal(lib.u32(0x3200), 1);
    assert.equal(fns.DispGetIDsOfNames.handler([0x4444, 0x3100, 1, 0x3200]) | 0, 0x80070057 | 0,
        'not a type information this library gave out');
});

test('a SAFEARRAY is read off its descriptor, locked, and copied whole', ()=>{
    setUp();
    // Two dimensions: [1..3] outer, [0..1] inner, of 4-byte elements.
    const psa = 0x3000;
    host.putU16(psa, 2);
    host.putU16(psa + 2, 0x80); // FADF_HAVEVARTYPE
    host.putU32(psa + 4, 4);
    host.putU32(psa + 8, 0);
    host.putU32(psa + 12, 0x3100);
    host.putU32(psa + 16, 2);
    host.putU32(psa + 20, 0);
    host.putU32(psa + 24, 3);
    host.putU32(psa + 28, 1);
    for (let index = 0; index < 6; index++)
    {
        host.putU32(0x3100 + index * 4, 100 + index);
    }
    assert.equal(call('SafeArrayGetDim', [psa]), 2);
    assert.equal(call('SafeArrayGetElemsize', [psa]), 4);
    assert.equal(call('SafeArrayGetUBound', [psa, 1, SLOT]), 0);
    assert.equal(host.u32(SLOT), 3, 'dimension 1 is the outer one, bound last');
    assert.equal(call('SafeArrayGetLBound', [psa, 1, SLOT]), 0);
    assert.equal(host.u32(SLOT), 1);
    assert.equal(call('SafeArrayGetUBound', [psa, 2, SLOT]), 0);
    assert.equal(host.u32(SLOT), 1);
    assert.equal(call('SafeArrayGetUBound', [psa, 3, SLOT]) | 0, 0x8002000b | 0, 'DISP_E_BADINDEX');
    assert.equal(call('SafeArrayGetDim', [0]), 0);

    assert.equal(call('SafeArrayLock', [psa]), 0);
    assert.equal(call('SafeArrayLock', [psa]), 0);
    assert.equal(host.u32(psa + 8), 2);
    assert.equal(call('SafeArrayUnlock', [psa]), 0);
    assert.equal(call('SafeArrayUnlock', [psa]), 0);
    assert.equal(call('SafeArrayUnlock', [psa]) | 0, 0x8000ffff | 0, 'E_UNEXPECTED below zero');
    assert.equal(call('SafeArrayLock', [0]) | 0, 0x80070057 | 0);

    host.putU32(psa + 8, 1);
    assert.equal(call('SafeArrayCopy', [psa, SLOT]), 0);
    const copy = host.u32(SLOT);
    assert.notEqual(copy, 0);
    assert.equal(host.u16(copy), 2);
    assert.equal(host.u32(copy + 8), 0, 'the copy is unlocked');
    const data = host.u32(copy + 12);
    assert.notEqual(data, 0x3100, 'its own data');
    assert.deepEqual([...Array(6)].map((_, i)=>host.u32(data + i * 4)),
        [100, 101, 102, 103, 104, 105]);
    assert.deepEqual([host.u32(copy + 16), host.u32(copy + 24)], [2, 3]);
    assert.equal(call('SafeArrayCopy', [0, SLOT]) | 0, 0x80070057 | 0);
    assert.equal(host.u32(SLOT), 0);
});

test('an array of strings is copied string by string', ()=>{
    setUp();
    const psa = 0x3000;
    host.putU16(psa, 1);
    host.putU16(psa + 2, 0x100); // FADF_BSTR
    host.putU32(psa + 4, 4);
    host.putU32(psa + 12, 0x3100);
    host.putU32(psa + 16, 2);
    host.putU32(psa + 20, 0);
    host.putWide(TEXT, 'one');
    const one = call('SysAllocString', [TEXT]);
    host.putU32(0x3100, one);
    host.putU32(0x3104, 0);
    assert.equal(call('SafeArrayCopy', [psa, SLOT]), 0);
    const data = host.u32(host.u32(SLOT) + 12);
    const copied = host.u32(data);
    assert.notEqual(copied, one, 'a new string');
    assert.equal(call('SysStringLen', [copied]), 3);
    assert.equal(host.u32(data + 4), 0, 'NULL stays NULL');
});

test('DispGetParam picks the positional argument and converts it', ()=>{
    setUp();
    // Two positional arguments after one named one: [named, second, first].
    const params = 0x3000;
    host.putU32(params, 0x3100);
    host.putU32(params + 4, 0x3200);
    host.putU32(params + 8, 3);
    host.putU32(params + 12, 1);
    host.putVariant(0x3100, VT_I4, 9);
    host.putVariant(0x3110, VT_I4, 200);
    host.putVariant(0x3120, VT_I4, 100);
    host.putVariant(VARIANT_A, 0, 0);
    assert.equal(call('DispGetParam', [params, 0, VT_BSTR, VARIANT_A, SLOT]), 0);
    assert.equal(host.u16(VARIANT_A), VT_BSTR);
    assert.equal(call('SysStringLen', [host.u32(VARIANT_A + 8)]), 3, '"100"');
    assert.equal(call('DispGetParam', [params, 1, VT_I4, VARIANT_A, SLOT]), 0);
    assert.equal(host.u32(VARIANT_A + 8), 200);
    host.putU32(SLOT, 0);
    assert.equal(call('DispGetParam', [params, 2, VT_I4, VARIANT_A, SLOT]) | 0, 0x80020004 | 0,
        'DISP_E_PARAMNOTFOUND: the named one does not count');
    host.putVariant(0x3110, VT_UNKNOWN, 0x5555);
    assert.equal(call('DispGetParam', [params, 1, VT_I4, VARIANT_A, SLOT]) | 0, 0x80020005 | 0);
    assert.equal(host.u32(SLOT), 1, 'which argument was wrong');
});

test('CreateErrorInfo hands out an object with one reference', ()=>{
    const lib = libraryHost();
    const fns = createAutomationFunctions(lib);
    assert.equal(fns.CreateErrorInfo.handler([SLOT]), 0);
    assert.notEqual(lib.u32(SLOT), 0);
    assert.equal(lib.published[0].id, '{22F03340-547D-101B-8E65-08002B2BD119}');
    assert.equal(fns.CreateErrorInfo.handler([0]) | 0, 0x80070057 | 0);
    setUp();
    assert.equal(call('CreateErrorInfo', [SLOT]) | 0, 0x8007000e | 0, 'nowhere to put one');
    assert.equal(host.u32(SLOT), 0);
});

test('a SAFEARRAY is made, filled, read back and destroyed', ()=>{
    setUp();
    const BOUNDS = 0x3000;
    const INDICES = 0x3040;
    const VALUE = 0x3080;
    // Two dimensions, the leftmost first as the caller names them: [2..3] x [0..2].
    host.putU32(BOUNDS, 2);
    host.putU32(BOUNDS + 4, 2);
    host.putU32(BOUNDS + 8, 3);
    host.putU32(BOUNDS + 12, 0);
    const psa = call('SafeArrayCreate', [3, 2, BOUNDS]);
    assert.notEqual(psa, 0);
    assert.equal(call('SafeArrayGetDim', [psa]), 2);
    assert.equal(call('SafeArrayGetElemsize', [psa]), 4);
    assert.equal(call('SafeArrayGetLBound', [psa, 1, SLOT]), 0);
    assert.equal(host.u32(SLOT), 2, 'dimension 1 is the leftmost');
    assert.equal(call('SafeArrayGetUBound', [psa, 2, SLOT]), 0);
    assert.equal(host.u32(SLOT), 2);

    for (let outer = 2; outer <= 3; outer++)
    {
        for (let inner = 0; inner <= 2; inner++)
        {
            host.putU32(INDICES, outer);
            host.putU32(INDICES + 4, inner);
            host.putU32(VALUE, outer * 10 + inner);
            assert.equal(call('SafeArrayPutElement', [psa, INDICES, VALUE]), 0);
        }
    }
    // The leftmost index varies fastest in memory.
    assert.equal(call('SafeArrayAccessData', [psa, SLOT]), 0);
    const data = host.u32(SLOT);
    assert.deepEqual([0, 1, 2, 3, 4, 5].map(index=>host.u32(data + index * 4)),
        [20, 30, 21, 31, 22, 32]);
    assert.equal(call('SafeArrayDestroy', [psa]) | 0, 0x8002000d | 0, 'locked by the access');
    assert.equal(call('SafeArrayUnaccessData', [psa]), 0);
    host.putU32(INDICES, 3);
    host.putU32(INDICES + 4, 1);
    assert.equal(call('SafeArrayGetElement', [psa, INDICES, VALUE]), 0);
    assert.equal(host.u32(VALUE), 31);
    host.putU32(INDICES + 4, 3);
    assert.equal(call('SafeArrayGetElement', [psa, INDICES, VALUE]) | 0, 0x8002000b | 0,
        'DISP_E_BADINDEX');
    assert.equal(call('SafeArrayDestroy', [psa]), 0);
    assert.equal(host.live.has(psa), false);
    assert.equal(host.live.has(data), false);

    // Strings: the array owns copies, and a caller gets a copy of its own.
    host.putU32(BOUNDS, 2);
    host.putU32(BOUNDS + 4, 0);
    const strings = call('SafeArrayCreate', [8, 1, BOUNDS]);
    host.putWide(TEXT, 'hello');
    const bstr = call('SysAllocString', [TEXT]);
    host.putU32(INDICES, 1);
    assert.equal(call('SafeArrayPutElement', [strings, INDICES, bstr]), 0);
    assert.equal(call('SafeArrayGetElement', [strings, INDICES, VALUE]), 0);
    const got = host.u32(VALUE);
    assert.notEqual(got, bstr, 'a copy');
    assert.equal(host.u32(got - 4), 10, 'five characters, in bytes');
    assert.equal(host.u16(got), 'h'.charCodeAt(0));
    host.putU32(INDICES, 0);
    assert.equal(call('SafeArrayGetElement', [strings, INDICES, VALUE]), 0);
    assert.equal(host.u32(VALUE), 0, 'an element never put is NULL');
    assert.equal(call('SafeArrayDestroy', [strings]), 0);
    assert.ok(host.live.has(got - 4), 'what the caller got is its own');
    assert.ok(host.live.has(bstr - 4), 'and so is what it put');

    // Redimensioned: the last elements go, then room is made for more.
    host.putU32(BOUNDS, 3);
    host.putU32(BOUNDS + 4, 0);
    const grown = call('SafeArrayCreate', [8, 1, BOUNDS]);
    host.putWide(TEXT, 'kept');
    host.putU32(INDICES, 1);
    assert.equal(call('SafeArrayPutElement', [grown, INDICES, call('SysAllocString', [TEXT])]), 0);
    host.putU32(INDICES, 2);
    assert.equal(call('SafeArrayPutElement', [grown, INDICES, call('SysAllocString', [TEXT])]), 0);
    const blocks = host.live.size;
    host.putU32(BOUNDS, 2);
    assert.equal(call('SafeArrayRedim', [grown, BOUNDS]), 0);
    assert.equal(host.live.size, blocks - 1, 'the dropped string was freed');
    host.putU32(BOUNDS, 5);
    assert.equal(call('SafeArrayRedim', [grown, BOUNDS]), 0);
    assert.equal(call('SafeArrayGetUBound', [grown, 1, SLOT]), 0);
    assert.equal(host.u32(SLOT), 4);
    host.putU32(INDICES, 1);
    assert.equal(call('SafeArrayGetElement', [grown, INDICES, VALUE]), 0);
    assert.equal(host.u16(host.u32(VALUE)), 'k'.charCodeAt(0), 'the kept one is still there');
    host.putU32(INDICES, 4);
    assert.equal(call('SafeArrayGetElement', [grown, INDICES, VALUE]), 0);
    assert.equal(host.u32(VALUE), 0, 'the new ones are empty');
    assert.equal(call('SafeArrayDestroy', [grown]), 0);

    assert.equal(call('SafeArrayCreate', [0x1234, 1, BOUNDS]), 0, 'no such element type');
    assert.equal(call('SafeArrayDestroy', [0]), 0, 'NULL is nothing to destroy');
});

test('the argument list of each entry is the one the guest pushed', ()=>{
    setUp();
    // stdcall: the callee pops, so a wrong count leaves the stack misaligned
    // and the caller returns into rubbish -- a crash with nothing to point at.
    const expected = {
        SysAllocString: 4, SysAllocStringLen: 8, SysAllocStringByteLen: 8,
        SysReAllocString: 8, SysReAllocStringLen: 12, SysFreeString: 4,
        SysStringLen: 4, SysStringByteLen: 4,
        VariantInit: 4, VariantClear: 4, VariantCopy: 8, VariantCopyInd: 8,
        VariantChangeType: 16, VariantChangeTypeEx: 20,
        SafeArrayGetDim: 4, SafeArrayGetElemsize: 4, SafeArrayGetUBound: 12,
        SafeArrayGetLBound: 12, SafeArrayLock: 4, SafeArrayUnlock: 4, SafeArrayCopy: 8,
        SafeArrayCreate: 12, SafeArrayDestroy: 4, SafeArrayGetElement: 12,
        SafeArrayPutElement: 12, SafeArrayAccessData: 8, SafeArrayUnaccessData: 4,
        SafeArrayRedim: 8,
        DispGetParam: 20, DispGetIDsOfNames: 16, CreateErrorInfo: 4,
    };
    for (const [name, argBytes] of Object.entries(expected))
    {
        assert.equal(fx[name].argBytes, argBytes, name);
    }
});
