/*
 * Copyright © 2026 Bottlify Project
 * Licensed under BSD-2-Clause License
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createShaderCache } from './shaders.js';
import { createFakeDevice } from './fake-device.js';

/** @param {Record<string, any[]>} compilationMessages */
function cache(compilationMessages = {}){
    const gpu = createFakeDevice({ compilationMessages });
    return { gpu, shaders: createShaderCache({ device: gpu.device }) };
}

test('every module build asks the compiler what it thought', async()=>{
    const { gpu, shaders } = cache();

    await shaders.build({ code: 'fn main(){}', label: 'blit' });

    assert.equal(gpu.count('createShaderModule'), 1);
    assert.equal(gpu.count('getCompilationInfo'), 1,
        'a silently degraded module is invisible until the frame is wrong');
});

test('a warning is recorded and the module is still usable', async()=>{
    const { shaders } = cache({
        blit: [{ type: 'warning', message: 'unused binding', lineNum: 3, linePos: 1 }],
    });

    const module = await shaders.build({ code: '', label: 'blit' });

    assert.ok(module);
    const [entry] = shaders.messages();
    assert.equal(entry.label, 'blit');
    assert.equal(entry.type, 'warning');
    assert.equal(entry.message, 'unused binding');
    assert.equal(entry.count, 1);
});

test('a rejected module fails loudly instead of drawing a wrong frame', async()=>{
    const { shaders } = cache({
        lit: [{ type: 'error', message: 'unresolved identifier', lineNum: 12, linePos: 4 }],
    });

    await assert.rejects(()=>shaders.build({ code: '', label: 'lit' }), /unresolved identifier/);
    assert.equal(shaders.messages()[0].type, 'error', 'and the message is kept, not just thrown');
    assert.equal(shaders.stats().errors, 1);
});

test('the same message from repeated builds is counted, not repeated', async()=>{
    const { shaders } = cache({
        blit: [{ type: 'info', message: 'lowered to fp16', lineNum: 1, linePos: 1 }],
    });

    await shaders.build({ code: 'a', label: 'blit' });
    await shaders.build({ code: 'b', label: 'blit' });
    await shaders.build({ code: 'c', label: 'blit' });

    assert.equal(shaders.messages().length, 1, 'a de-duplicating ring, not a log');
    assert.equal(shaders.messages()[0].count, 3);
});

test('the ring drops the oldest distinct message rather than growing without bound', async()=>{
    const gpu = createFakeDevice({
        compilationMessages: {
            a: [{ type: 'info', message: 'first', lineNum: 1, linePos: 1 }],
            b: [{ type: 'info', message: 'second', lineNum: 1, linePos: 1 }],
            c: [{ type: 'info', message: 'third', lineNum: 1, linePos: 1 }],
        },
    });
    const shaders = createShaderCache({ device: gpu.device, ringSize: 2 });

    await shaders.build({ code: '', label: 'a' });
    await shaders.build({ code: '', label: 'b' });
    await shaders.build({ code: '', label: 'c' });

    assert.deepEqual(shaders.messages().map((/** @type {any} */ entry)=>entry.message),
        ['second', 'third']);
    assert.equal(shaders.stats().dropped, 1, 'and says how many it dropped');
});
