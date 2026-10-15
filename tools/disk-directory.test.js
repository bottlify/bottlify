/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { diskDirectory } from './disk-directory.mjs';
import { createDirectoryTranslationStore }
    from '../modules/core/src/layers/cpu/internal/translation-store.js';

test('a translation store over a folder finds, in the next run, what the last one put', async()=>{
    const folder = mkdtempSync(join(tmpdir(), 'store-'));
    try
    {
        const first = await createDirectoryTranslationStore(diskDirectory(folder), 'game');
        await first.put('region a', Uint8Array.of(1, 2, 3));
        await first.put('region b', Uint8Array.of(4, 5));
        await first.flush();
        first.close();

        const second = await createDirectoryTranslationStore(diskDirectory(folder), 'game');
        await second.prepare();
        assert.deepEqual(await second.get('region a'), Uint8Array.of(1, 2, 3));
        assert.deepEqual(await second.get('region b'), Uint8Array.of(4, 5));
        assert.equal(await second.get('region c'), null);
        second.close();
    }
    finally
    {
        rmSync(folder, { recursive: true });
    }
});

test('a folder answers as a directory handle: absent names, kinds, removal', async()=>{
    const folder = mkdtempSync(join(tmpdir(), 'dir-'));
    try
    {
        const root = diskDirectory(folder);
        await assert.rejects(root.getFileHandle('none'), { name: 'NotFoundError' });
        await root.getDirectoryHandle('sub', { create: true });
        await assert.rejects(root.getFileHandle('sub'), { name: 'TypeMismatchError' });
        const file = await root.getFileHandle('file', { create: true });
        const access = await file.createSyncAccessHandle();
        access.write(Uint8Array.of(9, 8, 7, 6), { at: 2 });
        access.truncate(5);
        assert.equal(access.getSize(), 5);
        const back = new Uint8Array(8);
        assert.equal(access.read(back, { at: 1 }), 4);
        assert.deepEqual([...back.subarray(0, 4)], [0, 9, 8, 7]);
        access.close();
        assert.equal((await file.getFile()).size, 5);
        const names = [];
        for await (const [name] of root.entries())
        {
            names.push(name);
        }
        assert.deepEqual(names.sort(), ['file', 'sub']);
        await root.removeEntry('sub', { recursive: true });
        await assert.rejects(root.getDirectoryHandle('sub'), { name: 'NotFoundError' });
    }
    finally
    {
        rmSync(folder, { recursive: true });
    }
});
