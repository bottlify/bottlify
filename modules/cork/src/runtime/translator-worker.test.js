/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MessageChannel, Worker } from 'node:worker_threads';
import { translatorWorkerUrl } from './runtime.js';

test('a pool\'s worker told its process is gone lets go of the port it served it',
    { timeout: 20000 }, async()=>{
        const worker = new Worker(new URL(/** @type {string} */ (translatorWorkerUrl())));
        try
        {
            const { port1, port2 } = new MessageChannel();
            const closed = new Promise(resolve=>port1.once('close', resolve));
            worker.postMessage({ serve: port2 }, [port2]);
            // The process's runtime never says `done`: it is gone.
            worker.postMessage({ forget: true });
            await closed;
            assert.ok(true, 'the served port was closed by the worker');
        }
        finally
        {
            await worker.terminate();
        }
    });
