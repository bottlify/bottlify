/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { processMemories } from './memories.js';
import { createRunAccount } from './run-cache.js';

const MIB = 1 << 20;

/** A gone process's memory of `mib` MiB, as far as keeping it goes. @param {number} mib */
const spare = mib=>/** @type {any} */ ({ memory: { buffer: { byteLength: mib * MIB } } });

test('a run keeps gone processes\' memories up to 2 GiB of length in all, oldest out first', ()=>{
    const { keepSpare, spareMemories } = processMemories({
        options: { memoryBudget: createRunAccount() } });
    const [a, b, c] = [spare(1024), spare(512), spare(768)];
    keepSpare(a);
    keepSpare(b);
    assert.deepEqual(spareMemories, [a, b], '1.5 GiB kept');
    keepSpare(c);
    assert.deepEqual(spareMemories, [b, c], 'past 2 GiB the oldest went');
    keepSpare(spare(4096));
    assert.deepEqual(spareMemories, [], 'a memory of 4 GiB is never kept, and it pushed the rest');
});
