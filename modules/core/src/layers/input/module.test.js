/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inputModule } from './module.js';
import { WM } from './router.js';
import { createMessageQueue, ANY_WINDOW } from '../win32/user32/messages.js';
import { createStubApi } from '../../system/stub.js';

const HWND = 0x40;

/**
 * The module over a real message queue -- the same one user32 hands to
 * GetMessage -- because the thing worth proving here is the wiring, and a fake
 * queue would prove that a fake queue works.
 *
 * @param {{ win32?: any, config?: any }} [options]
 */
async function open({ win32, config } = {}){
    const queue = createMessageQueue();
    const bytes = new Uint8Array(0x1000);
    const memory = {
        /** @param {number} address @param {number} length */
        readBytes: (address, length)=>bytes.subarray(address, address + length),
        /** @param {number} address @param {Uint8Array} data */
        writeBytes: (address, data)=>bytes.set(data, address),
    };
    const apis = /** @type {Record<string, any>} */ ({
        memory,
        bridge: {},
        win32: win32 ?? { queue: ()=>queue },
    });
    const api = await inputModule.create(
        { foreground: ()=>HWND, ...config },
        /** @type {any} */ ({ requireApi: (/** @type {string} */ name)=>apis[name] }));
    return {
        api,
        queue,
        /** Everything waiting, in order. */
        drain(){
            /** @type {any[]} */
            const taken = [];
            for (;;)
            {
                const entry = queue.peek({ hwnd: ANY_WINDOW, first: 0, last: 0, remove: true });
                if (!entry)
                {
                    return taken;
                }
                taken.push(entry);
            }
        },
    };
}

test('the module keeps the contract it is registered under', ()=>{
    assert.equal(inputModule.name, 'input');
    assert.deepEqual([...inputModule.requires], ['win32', 'bridge', 'memory']);
    assert.equal(typeof inputModule.diagnostics, 'function');
});

test('a key sent to the layer arrives in the window queue the program pumps', async()=>{
    const { api, drain } = await open();

    assert.equal(api.send({ kind: 'key', code: 'KeyW', down: true }), true);
    const [message] = drain();
    assert.equal(message.hwnd, HWND, 'addressed to the foreground window');
    assert.equal(message.message, WM.KEYDOWN);
    assert.equal(message.wParam, 0x57);
    assert.equal(message.lParam, 0x00110001);
    assert.equal(api.keyState(0x57), 0x8000);

    await inputModule.dispose();
});

test('DirectInput is published beside the message path, not instead of it', async()=>{
    const { api } = await open();
    assert.deepEqual(Object.keys(api.libraries()), ['DINPUT.dll', 'DINPUT8.dll']);
    // No program has created a device, so there is nowhere for the event to be
    // kept -- and saying so is the answer, not silence.
    assert.equal(api.post({ kind: 'key', code: 0x11, down: true }), false);

    await inputModule.dispose();
});

test('a build with no win32 still takes input, it just has nowhere to post it', async()=>{
    const { api } = await open({ win32: createStubApi('win32') });

    assert.equal(api.send({ kind: 'key', code: 'KeyW', down: true }), true);
    assert.equal(api.keyState(0x57), 0x8000, 'the state is still there to be read');

    await inputModule.dispose();
});

test('diagnostics report both halves of the layer', async()=>{
    const { api } = await open();
    api.send({ kind: 'key', code: 'Space', down: true });

    const metrics = /** @type {any} */ (inputModule.diagnostics().metrics);
    assert.deepEqual(metrics.libraries, ['DINPUT.dll', 'DINPUT8.dll']);
    assert.deepEqual(metrics.devices, [], 'nothing has asked for a device yet');
    assert.deepEqual(metrics.keysDown, ['Space']);
    // Focus posts nothing, and nothing here wired input to a window, so the
    // key is the only message there is.
    assert.equal(metrics.posted, 1, 'the key, and nothing about the page');

    await inputModule.dispose();
    assert.equal(inputModule.diagnostics().status, 'created');
});
