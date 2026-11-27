/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeOpfs } from './opfs.fixture.js';
import { openRunFolder } from './run-folder.js';

/** Lets the removals a release starts without waiting run. */
const settle = ()=>new Promise(resolve=>setTimeout(resolve, 0));

test('a run\'s folder takes away what runs that are gone left, and goes once its last user '
    + 'lets go', async()=>{
    const opfs = fakeOpfs();
    const runs = await opfs.root.getDirectoryHandle('bottlify-runs', { create: true });
    const left = await runs.getDirectoryHandle('gone-run', { create: true });
    await left.getFileHandle('pages', { create: true });
    opfs.put('bottlify-pages', new Uint8Array(0));
    const run = await openRunFolder({ root: opfs.root });
    assert.ok(run);
    assert.deepEqual(opfs.names(), ['bottlify-runs'], 'the folder of an older build goes too');
    const [name] = opfs.names('bottlify-runs');
    assert.notEqual(name, 'gone-run', 'a run that is gone left it');
    assert.equal(opfs.names('bottlify-runs').length, 1);

    const pages = run.use();
    const cache = run.use();
    pages();
    pages();
    await settle();
    assert.deepEqual(opfs.names('bottlify-runs'), [name], 'a user that lets go twice counts once');
    cache();
    await settle();
    assert.deepEqual(opfs.names('bottlify-runs'), [], 'gone with its last user');
});

test('a run\'s folder the origin refuses is null, and said', async()=>{
    /** @type {any[]} */
    const said = [];
    const root = { getDirectoryHandle: async()=>{
        throw new DOMException('no room', 'QuotaExceededError');
    } };
    assert.equal(await openRunFolder({ root, onFailure: error=>said.push(error) }), null);
    assert.equal(said.length, 1);
    assert.equal(said[0].name, 'QuotaExceededError');
});
