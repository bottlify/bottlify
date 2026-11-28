/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The run's cache is the run's, its keeper on the run's thread whichever
 * process the facade speaks for: its figures are read from the facade once,
 * at run level, not from any process's tables.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../app.js';
import { RUN_CACHE_BYTES } from '../layers/cache/account.js';
import { TABLE_BYTES } from '../layers/audio/output/mix.js';
import { buildExe } from '../../../../tools/fixtures/make-pe.mjs';

/** @param {number} value */
const u32 = value=>[value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24 & 0xff];

const exitAtOnce = ()=>buildExe({
    imports: { 'KERNEL32.dll': ['ExitProcess'] },
    codeSize: 0x10,
    code: ({ iat })=>[0x6a, 0x00, 0xff, 0x15, ...u32(iat('ExitProcess'))],
});

test('a run answers its cache\'s figures, with the budget it was given and what it held at most',
    { timeout: 60000 }, async t=>{
        const app = await createApp({ executable: exitAtOnce() });
        t.after(()=>app.dispose());
        assert.equal(await app.run(), 0);
        const figures = app.runCache();
        assert.equal(typeof figures, 'object', `figures: ${figures}`);
        assert.equal(figures.budget, RUN_CACHE_BYTES);
        for (const name of ['records', 'hot', 'cold', 'segments', 'segmentBytes', 'placedBytes',
            'written', 'gone', 'peakSegmentBytes', 'peakPlacedBytes'])
        {
            assert.equal(typeof figures[name], 'number', name);
        }
        // The sound output's table, a segment of its own, beside the shared one.
        assert.ok(figures.peakSegmentBytes >= (16 << 20) + TABLE_BYTES,
            `${figures.peakSegmentBytes}`);

        // Room for the sound table beside the shared segment, and little more.
        const smaller = await createApp({ executable: exitAtOnce(), cache: { budget: 48 << 20 } });
        t.after(()=>smaller.dispose());
        assert.equal(smaller.runCache().budget, 48 << 20, 'the budget the run named');
    });
