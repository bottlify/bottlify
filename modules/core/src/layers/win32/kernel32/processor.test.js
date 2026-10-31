/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    CPUID, PROCESSOR, PROCESSOR_CACHES, PROCESSOR_FEATURES, PROCESSOR_IDENTIFIER, PROCESSOR_LEVEL,
    PROCESSOR_REVISION, createProcessors, processorMask,
} from './processor.js';
import { CPUID_LEAVES } from '../../../../../cork/src/cpuid.js';

test('family, model and stepping come out of the CPUID signature', ()=>{
    assert.equal(CPUID.signature, 0xf65);
    assert.deepEqual([PROCESSOR.family, PROCESSOR.model, PROCESSOR.stepping], [15, 6, 5]);
    assert.equal(PROCESSOR_IDENTIFIER, 'x86 Family 15 Model 6 Stepping 5');
    assert.equal(PROCESSOR_LEVEL, 15, 'the family, not a Pentium\'s 5');
    assert.equal(PROCESSOR_REVISION, 0x0605);
});

test('each feature a program asks for is the CPUID bit that says so', ()=>{
    // MMX, SSE, SSE2, rdtsc and cmpxchg8b from EDX; SSE3 and cmpxchg16b from
    // ECX; no rdrand, which this class of processor did not have.
    /** @type {[number, boolean][]} */
    const expected = [[2, true], [3, true], [6, true], [8, true], [10, true],
        [13, true], [14, true], [28, false], [1, false], [7, false]];
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

test('the record is what cork\'s CPUID answers, leaf 0, leaf 1 and leaf 4', ()=>{
    // One processor's table: the fields more processors move are leaf 1's
    // counts and leaf 4's EAX[31:26], and the record holds neither.
    const leaf = (/** @type {number} */ number)=>/** @type {any} */ (CPUID_LEAVES)[number];
    const vendor = [leaf(0).ebx, leaf(0).edx, leaf(0).ecx].map(word=>String.fromCharCode(
        word & 0xff, word >>> 8 & 0xff, word >>> 16 & 0xff, word >>> 24)).join('');
    assert.equal(CPUID.vendor, vendor);
    assert.deepEqual([CPUID.signature, CPUID.ecx, CPUID.edx],
        [leaf(1).eax, leaf(1).ecx, leaf(1).edx]);
    assert.deepEqual(CPUID.caches, Object.values(leaf(4)).map(({ eax, ebx, ecx })=>
        ({ eax: eax & 0x03ffffff, ebx, ecx })));
});

test('each processor has its own 16 KiB level 1 data cache and a 2 MiB level 2', ()=>{
    // Leaf 4: ways EBX[31:22] + 1, partitions EBX[21:12] + 1, line EBX[11:0] + 1,
    // sets ECX + 1; the kind EAX[4:0] and the level EAX[7:5].
    assert.deepEqual(PROCESSOR_CACHES, [
        { level: 1, type: 'data', ways: 8, lineSize: 64, size: 16 << 10 },
        { level: 2, type: 'unified', ways: 8, lineSize: 64, size: 2 << 20 },
    ]);
});

test('an affinity mask names the processors from the first, up to all 32 bits', ()=>{
    assert.deepEqual([1, 2, 4, 31, 32].map(processorMask),
        [1, 3, 0xf, 0x7fffffff, 0xffffffff]);
});

test('a machine whose kernel says nothing has one processor, and nothing else can be set', ()=>{
    const processors = createProcessors();
    assert.deepEqual([processors.count(), processors.systemMask(), processors.processMask()],
        [1, 1, 1]);
    assert.equal(processors.setProcessMask(3), false, 'a second processor it does not have');
    assert.equal(processors.setProcessMask(0), false, 'no processor');
    assert.equal(processors.setProcessMask(1), true);
    assert.deepEqual([2, 0, 1, 0xffffffff].map(processors.threadMaskFor), [0, 0, 1, 1]);
    assert.equal(processors.processorOf({}), 0);
});

test('the count is the kernel\'s, asked each time, and no more than a mask has bits', ()=>{
    let executors = 4;
    const processors = createProcessors({ processors: ()=>executors });
    assert.deepEqual([processors.count(), processors.systemMask()], [4, 0xf]);
    executors = 64;
    assert.deepEqual([processors.count(), processors.systemMask()], [32, 0xffffffff]);
    executors = 0;
    assert.equal(processors.count(), 1);
});

test('narrowing the process narrows every thread of it, and a thread made after starts there',
    ()=>{
        // Wine's ntdll test_affinity and kernel32 test_thread_processor: the
        // process's mask is each thread's, a thread created later included.
        const threads = [{ affinityMask: 1 }, {}];
        const processors = createProcessors({ processors: ()=>4, threads: ()=>threads });
        assert.equal(processors.setProcessMask(0x10), false, 'past the machine');
        assert.equal(processors.setProcessMask(0), false);
        assert.deepEqual(threads, [{ affinityMask: 1 }, {}], 'nothing changed by a refusal');

        assert.equal(processors.setProcessMask(6), true);
        assert.deepEqual([processors.processMask(), processors.systemMask()], [6, 0xf]);
        assert.deepEqual(threads.map(processors.threadMask), [6, 6]);
        const late = {};
        processors.adopt(late);
        assert.equal(processors.threadMask(late), 6);

        assert.equal(processors.setProcessMask(0xf), true, 'every processor again');
        assert.deepEqual(threads.map(processors.threadMask), [0xf, 0xf]);
        const later = {};
        processors.adopt(later);
        assert.deepEqual(later, {}, 'no mask: every processor, as the scheduler reads it');
        assert.equal(processors.threadMask(later), 0xf);
    });

test('a thread\'s mask loses the bits past the machine and must name only the process\'s', ()=>{
    // Wine's ntdll test_affinity, as Windows from Vista on answers.
    const processors = createProcessors({ processors: ()=>4 });
    assert.equal(processors.threadMaskFor(0x1f), 0xf, 'bits past the processors dropped');
    assert.equal(processors.threadMaskFor(0xfffffffe), 0xe);
    assert.equal(processors.threadMaskFor(0x10), 0, 'nothing left');
    assert.equal(processors.threadMaskFor(0), 0);
    assert.equal(processors.threadMaskFor(0xffffffff), 0xf, 'every processor');
    processors.setProcessMask(2);
    assert.equal(processors.threadMaskFor(1), 0, 'one the process does not have');
    assert.equal(processors.threadMaskFor(2), 2);
    assert.equal(processors.threadMaskFor(0xffffffff), 2, 'every one the process has');
});

test('the processor a thread runs on is the kernel\'s answer', ()=>{
    const thread = {};
    const processors = createProcessors({ processors: ()=>4,
        processorOf: one=>(one === thread ? 3 : 0) });
    assert.equal(processors.processorOf(thread), 3);
    assert.equal(processors.processorOf({}), 0);
});
