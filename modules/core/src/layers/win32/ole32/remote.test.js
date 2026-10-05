/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REGCLS_MULTIPLEUSE, REGCLS_SUSPENDED, createClassTable } from './remote.js';

const CLSID = '{91814EC0-B5F0-11D2-80B9-00104B1F6CEA}';

/** @param {Partial<import('./remote.js').Registration>} fields */
const entry = fields=>({ clsid: CLSID, endpoint: 1, object: 1, flags: REGCLS_MULTIPLEUSE,
    cookie: 1, suspended: false, used: false, ...fields });

test('a single-use class object serves one client; a multiple-use one serves every client', ()=>{
    const table = createClassTable();
    table.register(entry({ flags: 0 }));
    assert.ok(table.take(CLSID));
    assert.equal(table.take(CLSID), null, 'the next client starts a server of its own');

    table.register(entry({ cookie: 2 }));
    assert.ok(table.take(CLSID));
    assert.ok(table.take(CLSID));
});

test('a suspended registration is found only once the server resumes', ()=>{
    const table = createClassTable();
    table.register(entry({ flags: REGCLS_MULTIPLEUSE | REGCLS_SUSPENDED, suspended: true }));
    assert.equal(table.take(CLSID), null);
    table.resume(1);
    assert.ok(table.take(CLSID));
});

test('a client waits for the server it started, and stops waiting when that server ends',
    async()=>{
        const table = createClassTable();
        const waiting = table.whenRegistered(CLSID, new Promise(()=>{}));
        table.register(entry({}));
        assert.equal(await waiting, true);

        const other = createClassTable();
        /** @type {(value?: unknown) => void} */
        let end = ()=>{};
        const gaveUp = other.whenRegistered(CLSID, new Promise(resolve=>{
            end = resolve;
        }));
        end();
        assert.equal(await gaveUp, false, 'a server that exits without registering fails it');
    });

test('an ended process takes its registrations with it and runs its proxies down', async()=>{
    const table = createClassTable();
    const process = {};
    let rundowns = 0;
    const id = table.attach({ process, alive: true, deliver: async()=>({}),
        rundown: async()=>{
            rundowns++;
        } });
    table.register(entry({ endpoint: id }));
    await table.ended(process);
    assert.equal(table.take(CLSID), null);
    assert.equal(table.endpoint(id), null);
    assert.equal(rundowns, 1);
});

test('a suspended registration is handed to no new client until resumed again', ()=>{
    const table = createClassTable();
    table.register({ clsid: 'A', endpoint: 1, object: 1, flags: REGCLS_MULTIPLEUSE, cookie: 1,
        suspended: false, used: false });
    table.register({ clsid: 'B', endpoint: 2, object: 1, flags: REGCLS_MULTIPLEUSE, cookie: 1,
        suspended: false, used: false });
    table.suspend(1);
    assert.equal(table.take('A'), null);
    assert.equal(table.take('B')?.endpoint, 2, 'another process\'s registration is its own');
    table.resume(1);
    assert.equal(table.take('A')?.endpoint, 1);
});
