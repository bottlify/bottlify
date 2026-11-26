/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeOpfs } from './opfs.fixture.js';
import { openRunFolder } from './run-folder.js';
import { openPageFile } from './page-file.js';

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

test('a page file is a file of its run\'s folder, let go with it; none without a folder',
    async()=>{
        const opfs = fakeOpfs();
        const run = await openRunFolder({ root: opfs.root });
        assert.ok(run);
        const pageFile = await openPageFile({ runFolder: run, residentBytes: 0 });
        assert.ok(pageFile);
        const [name] = opfs.names('bottlify-runs');
        assert.deepEqual(opfs.names(`bottlify-runs/${name}`), ['pages']);
        pageFile.close();
        await settle();
        assert.deepEqual(opfs.names('bottlify-runs'), []);
        assert.equal(await openPageFile({ runFolder: null }), null);
    });
