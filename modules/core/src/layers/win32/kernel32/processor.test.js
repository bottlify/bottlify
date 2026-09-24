/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    CPUID, PROCESSOR, PROCESSOR_FEATURES, PROCESSOR_IDENTIFIER, PROCESSOR_LEVEL,
    PROCESSOR_REVISION,
} from './processor.js';

test('family, model and stepping come out of the CPUID signature', ()=>{
    assert.equal(CPUID.signature, 0x673);
    assert.deepEqual([PROCESSOR.family, PROCESSOR.model, PROCESSOR.stepping], [6, 7, 3]);
    assert.equal(PROCESSOR_IDENTIFIER, 'x86 Family 6 Model 7 Stepping 3');
    assert.equal(PROCESSOR_LEVEL, 6, 'the family, not a Pentium\'s 5');
    assert.equal(PROCESSOR_REVISION, 0x0703);
});

test('each feature a program asks for is the CPUID bit that says so', ()=>{
    // MMX, SSE, SSE2, rdtsc and cmpxchg8b from EDX; SSE3 and rdrand from ECX.
    /** @type {[number, boolean][]} */
    const expected = [[2, true], [3, true], [6, true], [8, true], [10, true],
        [13, true], [28, true], [1, false], [7, false]];
    for (const [feature, present] of expected)
    {
        assert.equal(PROCESSOR_FEATURES.get(feature), present, `PF ${feature}`);
    }
});

test('execute-disable and PAE are no, whatever CPUID says, and anything unlisted is no', ()=>{
    // Both ask what the system runs with, and nothing here pages or enforces.
    assert.equal(PROCESSOR_FEATURES.get(9), false);
    assert.equal(PROCESSOR_FEATURES.get(12), false);
    assert.equal(PROCESSOR_FEATURES.get(40), undefined);
});
