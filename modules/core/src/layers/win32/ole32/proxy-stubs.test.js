/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProxyStubs } from './proxy-stubs.js';

const IID = '{9428A859-6DA5-4B68-B599-3751B6C6B281}';
const OWN = '{0A0B0C0D-0000-0000-0000-000000000002}';
const NAMED = '{0A0B0C0D-0000-0000-0000-000000000001}';

/**
 * The lookups' host: a registry entry, the class objects registered by
 * class, and the DLLs the registry names.
 */
function machine(){
    /** @type {Map<string, number>} */
    const registered = new Map();
    /** @type {string[]} */
    const said = [];
    const counts = { released: 0, loads: 0 };
    /** Whose call each guest call was made for. @type {unknown[]} */
    const threads = [];
    const stubs = createProxyStubs({
        registryClass: iid=>(iid === IID ? NAMED.toLowerCase() : null),
        registeredFactory: (clsid, thread)=>{
            threads.push(thread);
            return registered.get(clsid) ?? 0;
        },
        release: (_factory, thread)=>{
            threads.push(thread);
            counts.released++;
        },
        loadFactory: async(clsid, thread)=>{
            threads.push(thread);
            counts.loads++;
            return clsid === NAMED ? 0x5000 : 0;
        },
        divergence: detail=>{
            said.push(detail);
        },
    });
    return { stubs, registered, said, counts, threads };
}

test('the class the process registered for an interface goes ahead of the registry\'s', ()=>{
    const { stubs } = machine();
    assert.equal(stubs.classOf(IID), NAMED, 'the registry\'s, canonical');
    assert.equal(stubs.classOf('{00000000-0000-0000-0000-00000000BEEF}'), null);
    stubs.register(IID.toLowerCase(), OWN);
    assert.equal(stubs.classOf(IID), OWN);
});

test('a registered class object is the factory, asked each time and never kept; a DLL\'s is'
    + ' loaded once', async()=>{
    const { stubs, registered, said, counts, threads } = machine();
    assert.equal(await stubs.factory(IID, 'caller'), 0x5000, 'the registry\'s DLL');
    assert.deepEqual(threads, ['caller', 'caller'],
        'each guest call made for the caller\'s thread');
    assert.equal(await stubs.factory(IID, 'caller'), 0x5000);
    assert.equal(counts.loads, 1, 'loaded once and held');

    stubs.register(IID, OWN);
    registered.set(OWN, 0x6000);
    assert.equal(await stubs.factory(IID, 'caller'), 0x6000,
        'the class object the process registered');
    assert.equal(counts.released, 1,
        'the query\'s reference given back: the registration holds it');

    // Revoked, its module unloaded and loaded again elsewhere: the new one.
    registered.set(OWN, 0x7000);
    assert.equal(await stubs.factory(IID, 'caller'), 0x7000);
    registered.delete(OWN);
    assert.equal(await stubs.factory(IID, 'caller'), 0, 'none registered and no DLL for the class');
    assert.equal(said.length, 1);
    assert.match(said[0], /gave no IPSFactoryBuffer/);
});

test('the universal marshaler\'s classes are not asked for a factory', async()=>{
    const { stubs, counts } = machine();
    stubs.register(IID, '{00020424-0000-0000-C000-000000000046}');
    assert.equal(await stubs.factory(IID, 'caller'), 0);
    stubs.register(IID, '{00020420-0000-0000-C000-000000000046}');
    assert.equal(await stubs.factory(IID, 'caller'), 0);
    assert.equal(counts.loads, 0);
});
