/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createComObject } from '../ole32/objects.js';
import { createSecurityManager, securityId, zoneOfUrl, URLZONE_INTERNET,
    URLZONE_LOCAL_MACHINE } from './security.js';

const E_INVALIDARG = 0x80070057 | 0;
const E_NOT_SUFFICIENT_BUFFER = 0x8007007a | 0;

test('a file is the local machine\'s zone, anything else the Internet\'s', ()=>{
    assert.equal(zoneOfUrl('file:///C:/App/3DMark11.exe'), URLZONE_LOCAL_MACHINE);
    assert.equal(zoneOfUrl('C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\clr.dll'),
        URLZONE_LOCAL_MACHINE, 'a path is a file URL');
    assert.equal(zoneOfUrl('http://www.winehq.org/'), URLZONE_INTERNET);
});

test('a security id is the scheme, the host and the zone', ()=>{
    // As Wine's conformance tests have Windows answer them (sec_mgr.c).
    assert.deepEqual([...securityId('http://www.winehq.org/site/about')],
        [...Buffer.from('http:www.winehq.org'), 3, 0, 0, 0]);
    assert.deepEqual([...securityId('file:///c:/foo')], [...Buffer.from('file:'), 0, 0, 0, 0]);
});

test('CoInternetCreateSecurityManager makes a manager the program calls through its vtable', ()=>{
    const bytes = new Uint8Array(0x10000);
    const view = new DataView(bytes.buffer);
    /** @type {any} */
    let published = null;
    const put = (/** @type {number} */ at, /** @type {string} */ text)=>{
        [...text].forEach((char, i)=>view.setUint16(at + i * 2, char.charCodeAt(0), true));
        view.setUint16(at + text.length * 2, 0, true);
    };
    const manager = createSecurityManager({
        readMemory: (at, length)=>bytes.subarray(at, at + length),
        writeMemory: (at, data)=>bytes.set(data, at),
        readWideString: at=>{
            let text = '';
            for (let i = at; view.getUint16(i, true) !== 0; i += 2)
            {
                text += String.fromCharCode(view.getUint16(i, true));
            }
            return text;
        },
        vtables: { publish: (object, iid)=>{
            published = object.interfaceFor(iid);
            return 0x5000;
        } },
        makeObject: createComObject,
    });
    assert.equal(manager.CoInternetCreateSecurityManager.handler([0, 0x100, 0]), 0);
    assert.equal(view.getUint32(0x100, true), 0x5000);
    /** @param {string} name @param {number[]} args */
    const call = (name, args)=>published.methods.find((/** @type {any} */ m)=>m.name === name)
        .invoke(null, args);

    put(0x200, 'file:///C:/App/3DMark11.exe');
    assert.equal(call('MapUrlToZone', [0x200, 0x300, 0]), 0);
    assert.equal(view.getUint32(0x300, true), URLZONE_LOCAL_MACHINE);
    assert.equal(call('MapUrlToZone', [0, 0x300, 0]), E_INVALIDARG);

    view.setUint32(0x304, 2, true);
    assert.equal(call('GetSecurityId', [0x200, 0x400, 0x304, 0]), E_NOT_SUFFICIENT_BUFFER);
    assert.equal(view.getUint32(0x304, true), 9, 'the size it needs');
    assert.equal(call('GetSecurityId', [0x200, 0x400, 0x304, 0]), 0);
    assert.deepEqual([...bytes.subarray(0x400, 0x409)], [...Buffer.from('file:'), 0, 0, 0, 0]);

    assert.equal(call('ProcessUrlAction', [0x200, 0x1001, 0x308, 4, 0, 0, 0, 0]), 0);
    assert.equal(view.getUint32(0x308, true), 0, 'URLPOLICY_ALLOW');
});
