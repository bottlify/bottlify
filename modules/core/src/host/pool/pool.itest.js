/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The pool's workers, on threads of their own, lent to a cork runtime over a
 * port: what they publish runs as what the runtime publishes inline (the
 * gate of the lent path), and the emitting was theirs.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { observe } from '../../../../cork/src/testing/seeded-pieces.js';
import { translatorWorkerUrl } from '../../../../cork/src/runtime/runtime.js';
import { openProcessWorker } from '../process-worker.js';
import { createTranslatorPool, portTranslator } from './pool.js';

for (const seed of [21, 22, 23])
{
    test(`what a lent worker publishes runs as what is published inline (seed ${seed})`,
        { timeout: 120000 }, async()=>{
            const url = translatorWorkerUrl();
            assert.ok(url, 'the translation worker\'s file is named');
            const { runs: inline } = await observe(seed, {});
            const pool = createTranslatorPool({ open: ()=>openProcessWorker(url),
                perProcess: 2 });
            /** @type {number[]} */
            const recalled = [];
            try
            {
                const { runs: lent, workerMs } = await observe(seed,
                    { worker: true, translators: 0, timings: true }, async m=>{
                        await pool.addProcess(1, {
                            lend: port=>m.runtime.attachTranslator?.(portTranslator(port)),
                            recall: token=>recalled.push(token),
                        });
                        return 1;
                    });
                assert.ok(!inline.includes('untranslated'), 'inline translated every start');
                assert.deepEqual(lent, inline);
                assert.ok(workerMs > 0, 'the lent worker emitted');
                assert.deepEqual(pool.diagnostics().byProcess, { 1: 1 });
            }
            finally
            {
                pool.removeProcess(1);
                pool.dispose();
            }
        });
}
