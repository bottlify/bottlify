/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHttpapiFunctions } from './functions.js';
import { createRegistryService } from '../advapi32/registry-service.js';
import { HKEY_LOCAL_MACHINE, createHive } from '../advapi32/registry.js';

const URL_ACL = 2;
const SSL_CERT = 1;

function setup(){
    const memory = new Uint8Array(0x4000);
    const view = new DataView(memory.buffer);
    /** @type {string[]} */
    const said = [];
    const hive = createRegistryService(createHive());
    const fns = createHttpapiFunctions({
        readMemory: (at, length)=>memory.subarray(at, at + length),
        writeMemory: (at, bytes)=>memory.set(bytes, at),
        readWideString: (at, max)=>{
            let text = '';
            for (let i = 0; i < max; i += 2)
            {
                const unit = view.getUint16(at + i, true);
                if (unit === 0)
                {
                    return text;
                }
                text += String.fromCharCode(unit);
            }
            throw new Error('no terminator');
        },
        hive,
        divergence: (api, detail)=>said.push(`${api}: ${detail}`),
    });
    /** @param {number} at @param {string} text */
    const putWide = (at, text)=>{
        [...text, '\0'].forEach((unit, i)=>view.setUint16(at + i * 2, unit.charCodeAt(0), true));
        return at;
    };
    /** @param {number} at */
    const wideAt = at=>{
        let text = '';
        for (let i = at; view.getUint16(i, true) !== 0; i += 2)
        {
            text += String.fromCharCode(view.getUint16(i, true));
        }
        return text;
    };
    return { memory, view, said, hive, fns, putWide, wideAt };
}

test('HttpInitialize takes version 1.0 or 2.0 and the server and config flags', ()=>{
    const { fns } = setup();
    assert.equal(fns.HttpInitialize.argBytes, 12);
    assert.equal(fns.HttpInitialize.handler([1, 2, 0]), 0, 'config, version 1.0');
    assert.equal(fns.HttpInitialize.handler([2, 3, 0]), 0, 'both, version 2.0');
    assert.equal(fns.HttpInitialize.handler([3, 2, 0]), 87, 'no version 3');
    assert.equal(fns.HttpInitialize.handler([1, 4, 0]), 87, 'no such flag');
    assert.equal(fns.HttpTerminate.handler([2, 0]), 0);
    assert.equal(fns.HttpTerminate.handler([0, 0]), 87);
});

test('a URL reservation is set, found, listed and deleted, and kept in the registry', ()=>{
    const { view, fns, hive, putWide, wideAt } = setup();
    const url = 'http://+:80/Temporary_Listen_Addresses/';
    const sddl = 'D:(A;;GX;;;WD)';
    const record = 0x100;
    view.setUint32(record, putWide(0x200, url), true);
    view.setUint32(record + 4, putWide(0x400, sddl), true);
    assert.equal(fns.HttpSetServiceConfiguration.handler([0, URL_ACL, record, 8, 0]), 0);
    assert.equal(fns.HttpSetServiceConfiguration.handler([0, URL_ACL, record, 8, 0]), 183,
        'ERROR_ALREADY_EXISTS');
    const key = hive.open(/** @type {number} */ (hive.root(HKEY_LOCAL_MACHINE)),
        'SYSTEM\\CurrentControlSet\\Services\\HTTP\\Parameters\\UrlAclInfo');
    assert.ok(key !== null && hive.getValue(key, url), 'where Windows keeps it');

    const query = 0x600;
    view.setUint32(query, 0, true);
    view.setUint32(query + 4, putWide(0x700, url.toUpperCase()), true);
    assert.equal(fns.HttpQueryServiceConfiguration.argBytes, 32);
    assert.equal(fns.HttpQueryServiceConfiguration.handler([0, URL_ACL, query, 12, 0, 0, 0x900, 0]),
        122, 'ERROR_INSUFFICIENT_BUFFER');
    const size = view.getUint32(0x900, true);
    assert.equal(fns.HttpQueryServiceConfiguration.handler([0, URL_ACL, query, 12, 0x1000, size,
        0x900, 0]), 0);
    assert.equal(wideAt(view.getUint32(0x1000, true)), url, 'the prefix as it was reserved');
    assert.equal(wideAt(view.getUint32(0x1004, true)), sddl);

    view.setUint32(query, 1, true);
    view.setUint32(query + 8, 0, true);
    assert.equal(fns.HttpQueryServiceConfiguration.handler([0, URL_ACL, query, 12, 0x1000, 0x400,
        0x900, 0]), 0, 'the first by its place');
    view.setUint32(query + 8, 1, true);
    assert.equal(fns.HttpQueryServiceConfiguration.handler([0, URL_ACL, query, 12, 0x1000, 0x400,
        0x900, 0]), 259, 'ERROR_NO_MORE_ITEMS');

    assert.equal(fns.HttpDeleteServiceConfiguration.handler([0, URL_ACL, record, 8, 0]), 0);
    assert.equal(fns.HttpDeleteServiceConfiguration.handler([0, URL_ACL, record, 8, 0]), 2,
        'ERROR_FILE_NOT_FOUND');
    view.setUint32(query, 0, true);
    assert.equal(fns.HttpQueryServiceConfiguration.handler([0, URL_ACL, query, 12, 0x1000, 0x400,
        0x900, 0]), 2);
});

test('a store kept nowhere takes a set, says so once, and finds nothing', ()=>{
    const { view, fns, said } = setup();
    view.setUint32(0x100, 0, true);
    assert.equal(fns.HttpSetServiceConfiguration.handler([0, SSL_CERT, 0x100, 16, 0]), 0);
    assert.equal(fns.HttpSetServiceConfiguration.handler([0, SSL_CERT, 0x100, 16, 0]), 0);
    assert.equal(said.length, 1);
    assert.equal(fns.HttpQueryServiceConfiguration.handler([0, SSL_CERT, 0x100, 16, 0, 0, 0, 0]),
        2);
    assert.equal(fns.HttpSetServiceConfiguration.handler([0, 9, 0x100, 16, 0]), 87,
        'no such store');
});
