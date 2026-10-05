/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRingMemory } from '../system/ring.js';

test('the engine reads the page\'s messages out of their shared ring as a browser reads one,'
    + ' which decodes no shared view', async()=>{
    // A browser's TextDecoder refuses a view of a SharedArrayBuffer and
    // Node's does not, so the browser's rule is put in its place.
    const Original = globalThis.TextDecoder;
    class BrowserDecoder extends Original {
        /** @param {any} [input] @param {any} [options] */
        decode(input, options){
            if (input?.buffer instanceof SharedArrayBuffer)
            {
                throw new TypeError('The provided ArrayBufferView value must not be shared.');
            }
            return super.decode(input, options);
        }
    }
    globalThis.TextDecoder = BrowserDecoder;
    try
    {
        const stamp = Date.now();
        await import(`../system/codec.js?browser=${stamp}`);
        const { createInboundReader, createInboundWriter } =
            await import(`./inbound.js?browser=${stamp}`);
        const memory = createRingMemory(4096);
        /** @type {any[]} */
        const received = [];
        const reader = createInboundReader(memory, (/** @type {any} */ message)=>
            received.push(message));
        createInboundWriter(memory).send({ type: 'input', event: { kind: 'key', code: 'KeyA' } },
            ()=>{});
        assert.equal(reader.drain(), 1);
        assert.deepEqual(received, [{ type: 'input', event: { kind: 'key', code: 'KeyA' } }]);
    }
    finally
    {
        globalThis.TextDecoder = Original;
    }
});
