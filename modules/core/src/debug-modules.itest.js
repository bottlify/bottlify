/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What a tool that watches a program's own routines asks for first: every
 * image mapped and where, the program's own among them under the name of its
 * file -- the name a hook names it by.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createApp } from './app.js';

const FIXTURE = new URL('../test/fixtures/qsort.exe', import.meta.url);

test('the images mapped are listed once each, the program by its own file name', async()=>{
    const app = await createApp({
        executable: new Uint8Array(await readFile(FIXTURE)),
        imagePath: 'C:\\Games\\Sorter\\SORT.EXE',
    });
    try
    {
        const modules = app.debug.modules();
        const own = modules.filter(module=>module.base === 0x400000);
        assert.deepEqual(own.map(module=>module.name), ['SORT.EXE'],
            'the program once, by its file, not by a stand-in');
        assert.ok(modules.some(module=>/^msvcrt\.dll$/i.test(module.name)),
            'and the libraries it imports, mapped before it runs');
        assert.equal(new Set(modules.map(module=>module.base)).size, modules.length,
            'each image once');
    }
    finally
    {
        await app.dispose();
    }
});
