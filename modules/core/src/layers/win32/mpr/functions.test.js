/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNetworkFunctions } from './functions.js';

const ERROR_INVALID_HANDLE = 6;
const ERROR_INVALID_PARAMETER = 87;
const ERROR_INVALID_LEVEL = 124;
const ERROR_NO_MORE_ITEMS = 259;
const ERROR_INVALID_ADDRESS = 487;
const ERROR_NO_NETWORK = 1222;
const ERROR_NOT_CONNECTED = 2250;

const RESOURCE_CONNECTED = 1;
const RESOURCE_GLOBALNET = 2;
const RESOURCE_REMEMBERED = 3;
const RESOURCE_CONTEXT = 5;
const RESOURCETYPE_ANY = 0;
const RESOURCETYPE_DISK = 1;
const UNIVERSAL_NAME_INFO_LEVEL = 1;
const REMOTE_NAME_INFO_LEVEL = 2;

/** Addresses the fixtures use; nothing about them matters but that they differ. */
const PATH = 0x100;
const OUT = 0x200;
const COUNT = 0x204;
const SIZE = 0x208;
const BUFFER = 0x300;

function setup({ memory = true } = {}){
    const bytes = new Uint8Array(0x400);
    /** @type {number[]} */
    const errors = [];
    const fns = createNetworkFunctions({
        setLastError: code=>errors.push(code),
        ...memory ? {
            /** @param {number} address @param {Uint8Array} data */
            writeMemory: (address, data)=>bytes.set(data, address),
        } : {},
    });
    /** @param {number} at */
    const dword = at=>new DataView(bytes.buffer).getUint32(at, true);
    return { bytes, errors, fns, dword };
}

test('with no network, a drive is not a connection, in either form, and pops twelve bytes', ()=>{
    const { errors, fns } = setup();

    assert.equal(fns.WNetGetConnectionA.handler(), ERROR_NOT_CONNECTED);
    assert.equal(fns.WNetGetConnectionW.handler(), ERROR_NOT_CONNECTED);
    assert.deepEqual(errors, [ERROR_NOT_CONNECTED, ERROR_NOT_CONNECTED]);
    assert.equal(fns.WNetGetConnectionA.argBytes, 12);
    assert.equal(fns.WNetGetConnectionW.argBytes, 12);
    assert.equal(fns.WNetGetUserA.handler(), ERROR_NO_NETWORK);
    assert.equal(fns.WNetGetUserA.argBytes, 12);
});

test('the connections and the remembered ones open as lists that run out at once', ()=>{
    const { bytes, errors, fns, dword } = setup();
    for (const [open, enumerate] of [[fns.WNetOpenEnumA, fns.WNetEnumResourceA],
        [fns.WNetOpenEnumW, fns.WNetEnumResourceW]])
    {
        for (const scope of [RESOURCE_CONNECTED, RESOURCE_REMEMBERED])
        {
            errors.length = 0;
            assert.equal(open.handler([scope, RESOURCETYPE_DISK, 0, 0, OUT]), 0);
            const handle = dword(OUT);
            assert.notEqual(handle, 0);
            new DataView(bytes.buffer).setUint32(COUNT, 0xffffffff, true);
            new DataView(bytes.buffer).setUint32(SIZE, 0x4000, true);
            assert.equal(enumerate.handler([handle, COUNT, BUFFER, SIZE]),
                ERROR_NO_MORE_ITEMS);
            assert.equal(enumerate.handler([handle, COUNT, BUFFER, SIZE]),
                ERROR_NO_MORE_ITEMS, 'and keeps running out');
            assert.equal(dword(SIZE), 0x4000, 'the size is left as it was');
            assert.equal(fns.WNetCloseEnum.handler([handle]), 0);
            assert.deepEqual(errors, [ERROR_NO_MORE_ITEMS, ERROR_NO_MORE_ITEMS]);
            assert.equal(enumerate.handler([handle, COUNT, BUFFER, SIZE]),
                ERROR_INVALID_HANDLE, 'a closed enumeration is no longer one');
            assert.equal(fns.WNetCloseEnum.handler([handle]), ERROR_INVALID_HANDLE,
                'nor closes twice');
        }
    }
    assert.equal(fns.WNetOpenEnumA.argBytes, 20);
    assert.equal(fns.WNetOpenEnumW.argBytes, 20);
    assert.equal(fns.WNetEnumResourceA.argBytes, 16);
    assert.equal(fns.WNetEnumResourceW.argBytes, 16);
    assert.equal(fns.WNetCloseEnum.argBytes, 4);
});

test('two open enumerations are two handles, and a closed one is not handed out again', ()=>{
    const { fns, dword } = setup();
    fns.WNetOpenEnumW.handler([RESOURCE_CONNECTED, RESOURCETYPE_ANY, 0, 0, OUT]);
    const first = dword(OUT);
    fns.WNetOpenEnumW.handler([RESOURCE_CONNECTED, RESOURCETYPE_ANY, 0, 0, OUT]);
    const second = dword(OUT);
    assert.notEqual(first, second);
    fns.WNetCloseEnum.handler([first]);
    fns.WNetOpenEnumW.handler([RESOURCE_CONNECTED, RESOURCETYPE_ANY, 0, 0, OUT]);
    assert.notEqual(dword(OUT), first);
    assert.equal(fns.WNetEnumResourceW.handler([0x1234, COUNT, BUFFER, SIZE]),
        ERROR_INVALID_HANDLE, 'a handle nobody was given');
});

test('the network and the workgroup are not there, and a bad request says which part is bad',
    ()=>{
        const { errors, fns, dword } = setup();
        assert.equal(fns.WNetOpenEnumW.handler([RESOURCE_GLOBALNET, RESOURCETYPE_ANY, 0, 0, OUT]),
            ERROR_NO_NETWORK);
        assert.equal(fns.WNetOpenEnumA.handler([RESOURCE_GLOBALNET, RESOURCETYPE_ANY, 0x13,
            BUFFER, OUT]), ERROR_NO_NETWORK, 'from a container too');
        assert.equal(fns.WNetOpenEnumW.handler([RESOURCE_CONTEXT, RESOURCETYPE_ANY, 0, 0, OUT]),
            ERROR_NO_NETWORK);
        assert.equal(dword(OUT), 0, 'no handle is written for an enumeration that did not open');
        assert.equal(fns.WNetOpenEnumW.handler([9, RESOURCETYPE_ANY, 0, 0, OUT]),
            ERROR_INVALID_PARAMETER, 'no such scope');
        assert.equal(fns.WNetOpenEnumW.handler([RESOURCE_CONNECTED, 8, 0, 0, OUT]),
            ERROR_INVALID_PARAMETER, 'no such resource type');
        assert.equal(fns.WNetOpenEnumW.handler([RESOURCE_CONNECTED, RESOURCETYPE_ANY, 0, 0, 0]),
            ERROR_INVALID_ADDRESS, 'nowhere to put the handle');
        assert.deepEqual(errors, [ERROR_NO_NETWORK, ERROR_NO_NETWORK, ERROR_NO_NETWORK,
            ERROR_INVALID_PARAMETER, ERROR_INVALID_PARAMETER, ERROR_INVALID_ADDRESS]);

        fns.WNetOpenEnumW.handler([RESOURCE_CONNECTED, RESOURCETYPE_ANY, 0, 0, OUT]);
        const handle = dword(OUT);
        assert.equal(fns.WNetEnumResourceW.handler([handle, 0, BUFFER, SIZE]),
            ERROR_INVALID_ADDRESS, 'no count');
        assert.equal(fns.WNetEnumResourceW.handler([handle, COUNT, BUFFER, 0]),
            ERROR_INVALID_ADDRESS, 'no size');
    });

test('with nowhere to write a handle, an enumeration answers as a machine with no provider', ()=>{
    const { errors, fns } = setup({ memory: false });
    assert.equal(fns.WNetOpenEnumW.handler([RESOURCE_CONNECTED, RESOURCETYPE_ANY, 0, 0, OUT]),
        ERROR_NO_NETWORK);
    assert.deepEqual(errors, [ERROR_NO_NETWORK]);
});

test('a local path has no network name at either level, and nothing is written for it', ()=>{
    // mpr's own tests (test_WNetGetUniversalName, test_WNetGetRemoteName): a
    // drive that is not a remote one answers WN_NOT_CONNECTED and keeps the
    // size it was given; no size at all is WN_BAD_POINTER.
    const { bytes, errors, fns, dword } = setup();
    for (const call of [fns.WNetGetUniversalNameA, fns.WNetGetUniversalNameW])
    {
        for (const level of [UNIVERSAL_NAME_INFO_LEVEL, REMOTE_NAME_INFO_LEVEL])
        {
            new DataView(bytes.buffer).setUint32(SIZE, 1024, true);
            assert.equal(call.handler([PATH, level, BUFFER, SIZE]), ERROR_NOT_CONNECTED);
            assert.equal(dword(SIZE), 1024);
            assert.equal(call.handler([PATH, level, 0, SIZE]), ERROR_NOT_CONNECTED,
                'with no buffer either');
            assert.equal(call.handler([PATH, level, BUFFER, 0]), ERROR_INVALID_ADDRESS);
        }
        assert.equal(call.handler([PATH, 3, BUFFER, SIZE]), ERROR_INVALID_LEVEL);
        assert.equal(call.handler([0, UNIVERSAL_NAME_INFO_LEVEL, BUFFER, SIZE]),
            ERROR_INVALID_ADDRESS, 'no path');
        assert.equal(call.argBytes, 16);
    }
    assert.equal(errors.at(-1), ERROR_INVALID_ADDRESS, 'the last error is the answer too');
    assert.ok(bytes.subarray(BUFFER, BUFFER + 0x100).every(byte=>byte === 0));
});
