/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withConcurrency } from './concurrency.js';

test('a run where memory cannot be shared is refused, and says which headers turn it on', ()=>{
    assert.throws(()=>withConcurrency({}, false), error=>{
        const text = /** @type {Error} */ (error).message;
        return /needs shared memory/.test(text) && /not cross-origin isolated/.test(text)
            && /Cross-Origin-Opener-Policy: same-origin/.test(text)
            && /Cross-Origin-Embedder-Policy: require-corp/.test(text);
    });
    assert.throws(()=>withConcurrency({ concurrency: 2 }, false), /needs shared memory/,
        'not run one process at a time instead');
});

test('the mode option is refused as removed, whatever it asks for', ()=>{
    for (const mode of ['auto', 'compatible', 'isolated'])
    {
        assert.throws(()=>withConcurrency(/** @type {any} */ ({ mode }), true),
            /unknown option mode .*removed.*shared memory/);
    }
});

test('concurrency is 1, 2 or 4 processes at once, 1 unless asked; the caller\'s settings stand',
    ()=>{
        assert.equal(withConcurrency({}, true).concurrency, 1);
        const two = withConcurrency(
            /** @type {any} */ ({ concurrency: 2, graphics: { maxFrameLatency: 6 } }), true);
        assert.equal(two.concurrency, 2);
        assert.deepEqual(two.graphics, { maxFrameLatency: 6 });
        assert.equal(withConcurrency({ concurrency: 4 }, true).concurrency, 4);
        for (const asked of [0, 3, 8, '2'])
        {
            assert.throws(()=>withConcurrency({ concurrency: /** @type {any} */ (asked) }, true),
                /concurrency is 1, 2 or 4/);
        }
    });
