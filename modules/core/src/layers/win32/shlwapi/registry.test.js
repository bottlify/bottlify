/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shlwapiMachine } from './memory.fixture.js';
import { booleanOf } from './registry.js';
import { createRegistryFunctions } from '../advapi32/functions.js';
import { createHive } from '../advapi32/registry.js';
import { createRegistryService } from '../advapi32/registry-service.js';

const HKEY_CURRENT_USER = 0x80000001;
const HKEY_LOCAL_MACHINE = 0x80000002;
const REG_SZ = 1;
const REG_BINARY = 3;
const REG_DWORD = 4;
const E_INVALIDARG = 0x80070057;

/**
 * shlwapi over advapi32's own registry, and a stand-in for ole32's stream
 * over memory that records what it was handed.
 */
function registryMachine(){
    /** @type {any} */
    let registry = null;
    /** @type {number[][]} */
    const streams = [];
    /** @type {any} */
    let m = null;
    const ole32 = {
        CreateStreamOnHGlobal: { handler: (/** @type {number[]} */ args)=>{
            streams.push(args);
            m.view.setUint32(args[2], 0x7000 + streams.length * 0x10, true);
            return 0;
        } },
    };
    // %X% expands to a longer string, as an environment variable would.
    const kernel32 = {
        ExpandEnvironmentStringsA: { handler: (/** @type {number[]} */ [from, to])=>{
            const text = m.base.readCString(from, 0x1000).replace('%X%', 'expanded');
            m.memory.set(new TextEncoder().encode(`${text}\0`), to);
            return text.length + 1;
        } },
    };
    m = shlwapiMachine({
        advapi32: ()=>registry,
        library: name=>(name === 'ole32.dll' ? ole32 : name === 'KERNEL32.dll' ? kernel32
            : undefined),
    });
    registry = createRegistryFunctions({ ...m.base, hive: createRegistryService(createHive()) });
    /**
     * @param {number} root @param {string} path @param {string} name
     * @param {number} type @param {Uint8Array} data
     */
    const set = (root, path, name, type, data)=>{
        const out = m.count(0);
        assert.equal(registry.RegCreateKeyA.handler([root, m.put(path), out]), 0);
        const key = m.dwordAt(out);
        const at = m.put('', false, data.length + 16);
        m.memory.set(data, at);
        assert.equal(registry.RegSetValueExA.handler([key, m.put(name), 0, type, at,
            data.length]), 0);
        registry.RegCloseKey.handler([key]);
    };
    /** @param {string} text */
    const sz = text=>new TextEncoder().encode(`${text}\0`);
    return { m, set, sz, streams };
}

test('a value reads as a Boolean by its type', ()=>{
    const ascii = (/** @type {string} */ text)=>new TextEncoder().encode(`${text}\0`);
    assert.equal(booleanOf(REG_SZ, ascii('yes'), false), true);
    assert.equal(booleanOf(REG_SZ, ascii('TRUE'), false), true);
    assert.equal(booleanOf(REG_SZ, ascii('No'), false), false);
    assert.equal(booleanOf(REG_SZ, ascii('false'), false), false);
    assert.equal(booleanOf(REG_SZ, ascii('maybe'), false), null);
    assert.equal(booleanOf(REG_SZ, new Uint8Array([0x59, 0, 0x45, 0, 0x53, 0, 0, 0]), true),
        true, 'in UTF-16');
    assert.equal(booleanOf(REG_DWORD, Uint8Array.of(2, 0, 0, 0), false), true);
    assert.equal(booleanOf(REG_DWORD, Uint8Array.of(0, 0, 0, 0), false), false);
    assert.equal(booleanOf(REG_BINARY, Uint8Array.of(1), false), true);
    assert.equal(booleanOf(REG_BINARY, Uint8Array.of(1, 0), false), null);
});

test('SHRegGetBoolUSValue reads the user\'s value, then the machine\'s, then the default', ()=>{
    const { m, set, sz } = registryMachine();
    set(HKEY_CURRENT_USER, 'Software\\Test', 'User', REG_SZ, sz('yes'));
    set(HKEY_LOCAL_MACHINE, 'Software\\Test', 'User', REG_SZ, sz('no'));
    set(HKEY_LOCAL_MACHINE, 'Software\\Test', 'Machine', REG_DWORD, Uint8Array.of(1, 0, 0, 0));
    set(HKEY_CURRENT_USER, 'Software\\Test', 'Odd', REG_SZ, sz('perhaps'));
    for (const [suffix, wide] of /** @type {const} */ ([['A', false], ['W', true]]))
    {
        /** @param {string} name @param {number} ignore @param {number} fallback */
        const get = (name, ignore, fallback)=>m.fns[`SHRegGetBoolUSValue${suffix}`].handler([
            m.put('Software\\Test', wide), m.put(name, wide), ignore, fallback]);
        assert.equal(get('User', 0, 0), 1, 'the user\'s yes');
        assert.equal(get('User', 1, 1), 0, 'the machine\'s no, the user ignored');
        assert.equal(get('Machine', 0, 0), 1, 'the machine\'s, the user having none');
        assert.equal(get('Missing', 0, 1), 1, 'the default');
        assert.equal(get('Missing', 0, 0), 0);
        assert.equal(get('Odd', 0, 1), 1, 'a value that says neither is the default');
    }
    assert.equal(m.fns.SHRegGetBoolUSValueW.argBytes, 16);
    assert.equal(shlwapiMachine().fns.SHRegGetBoolUSValueA.handler([0x10000, 0x10000, 0, 1]), 1,
        'without a registry, the default');
});

test('SHOpenRegStream2 hands out a stream over a copy of the value, or NULL', ()=>{
    const { m, set, streams } = registryMachine();
    set(HKEY_CURRENT_USER, 'Software\\Stream', 'Data', REG_BINARY, Uint8Array.of(1, 2, 3, 4, 5));
    const stream = m.fns.SHOpenRegStream2W.handler([HKEY_CURRENT_USER,
        m.put('Software\\Stream', true), m.put('Data', true), 0]);
    assert.notEqual(stream, 0);
    const [block, release] = streams[0];
    assert.equal(release, 1, 'the block goes with the stream');
    assert.deepEqual([...m.memory.subarray(block, block + 5)], [1, 2, 3, 4, 5]);

    const empty = m.fns.SHOpenRegStream2A.handler([HKEY_CURRENT_USER, m.put('Software\\Stream'),
        m.put('None'), 0]);
    assert.notEqual(empty, 0, 'a value not there is an empty stream');
    assert.equal(streams[1][0], 0, 'over no block');
    assert.equal(m.fns.SHOpenRegStream2A.handler([HKEY_CURRENT_USER, m.put('Software\\Nowhere'),
        m.put('Data'), 0]), 0, 'a key not there is NULL');
    assert.equal(m.fns.SHOpenRegStream2W.handler([HKEY_CURRENT_USER,
        m.put('Software\\Stream', true), m.put('Data', true), 2]), 0,
    'a stream to write is refused');
    assert.equal(m.divergences.length, 1);
    assert.equal(shlwapiMachine().fns.SHOpenRegStream2W.handler([HKEY_CURRENT_USER, 0x10000,
        0x10000, 0]), 0, 'no ole32: NULL');
});

test('SHAutoComplete leaves the edit control as it is and says so once', ()=>{
    const m = shlwapiMachine();
    assert.equal(m.fns.SHAutoComplete.handler([0x10010, 0]), 0);
    assert.equal(m.fns.SHAutoComplete.handler([0x10010, 0x10000000]), 0);
    assert.equal(m.divergences.length, 1);
    assert.equal(m.fns.SHAutoComplete.handler([0, 0]) >>> 0, E_INVALIDARG, 'no window');
    assert.equal(m.fns.SHAutoComplete.argBytes, 8);
});

test('SHQueryValueEx and SHGetValue answer an expandable string expanded, as REG_SZ', async()=>{
    // Wine's test_SHGetValue and test_SHQueryValueEx.
    const REG_EXPAND_SZ = 2;
    const { m, set } = registryMachine();
    set(0x80000001, 'Software\\Wine\\Test', 'Test1', REG_EXPAND_SZ,
        new TextEncoder().encode('a%X%b\0'));
    set(0x80000001, 'Software\\Wine\\Test', 'Test2', REG_SZ, new TextEncoder().encode('plain\0'));
    const get = m.fns.SHGetValueA.handler;
    const key = m.put('Software\\Wine\\Test');
    const type = m.count(0xffffffff);
    const buffer = m.put('0123456789', false, 64);
    let size = m.count(64);
    assert.equal(await get([0x80000001, key, m.put('Test1'), type, buffer, size]), 0);
    assert.equal(m.read(buffer), 'aexpandedb');
    assert.equal(m.dwordAt(type), REG_SZ, 'expanded, it is a plain string');
    assert.equal(m.dwordAt(size), 11, 'the larger of the two lengths');
    assert.equal(await get([0x80000001, key, m.put('Test2'), type, buffer, m.count(64)]), 0);
    assert.equal(m.read(buffer), 'plain');
    m.memory.set(new TextEncoder().encode('0123456789\0'), buffer);
    size = m.count(3);
    assert.equal(await get([0x80000001, key, m.put('Test1'), type, buffer, size]), 234,
        'ERROR_MORE_DATA');
    assert.equal(m.read(buffer), '0123456789', 'no room for what is stored: untouched');
    assert.equal(m.dwordAt(size), 11);
    size = m.count(7);
    assert.equal(await get([0x80000001, key, m.put('Test1'), type, buffer, size]), 234);
    assert.equal(m.read(buffer), '', 'room for what is stored, not for its expansion: empty');
    size = m.count(3);
    assert.equal(await get([0x80000001, key, m.put('Test1'), type, 0, size]), 0);
    assert.equal(m.dwordAt(size), 11, 'no buffer: the size it needs');
    assert.equal(await get([0x80000001, m.put('Software\\None'), m.put('Test1'), type, buffer,
        m.count(64)]), 2, 'no such key');
});
