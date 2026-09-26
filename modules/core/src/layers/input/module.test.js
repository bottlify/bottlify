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
import { writeGuid } from '../win32/ole32/guid.js';
import { IID_IDirectInput8A, GUID_SysMouse } from './dinput/seam.js';

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
        memory,
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
    assert.deepEqual(Object.keys(api.libraries()),
        ['DINPUT.dll', 'DINPUT8.dll', 'XINPUT9_1_0.dll', 'XINPUT1_4.dll']);
    // No program has created a device, so there is nowhere for the event to be
    // kept -- and saying so is the answer, not silence.
    assert.equal(api.post({ kind: 'key', code: 0x11, down: true }), false);

    await inputModule.dispose();
});

test('XInput is answered too, with no pad in any slot', async()=>{
    // xinput9_1_0.dll and xinput1_4.dll are system libraries no program
    // brings, so an import of XInputGetState from either is answered here or
    // stops the process on its first call.
    const { api } = await open();
    const libraries = api.libraries();
    for (const dll of ['XINPUT9_1_0.dll', 'XINPUT1_4.dll'])
    {
        assert.equal(libraries[dll].XInputGetState.handler([0, 0x100]), 1167,
            `${dll}: ERROR_DEVICE_NOT_CONNECTED`);
    }

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
    assert.deepEqual(metrics.libraries,
        ['DINPUT.dll', 'DINPUT8.dll', 'XINPUT9_1_0.dll', 'XINPUT1_4.dll']);
    assert.deepEqual(metrics.xinput, { asked: 0, enabled: true });
    assert.deepEqual(metrics.devices, [], 'nothing has asked for a device yet');
    assert.deepEqual(metrics.keysDown, ['Space']);
    // Focus posts nothing, and nothing here wired input to a window, so the
    // key is the only message there is.
    assert.equal(metrics.posted, 1, 'the key, and nothing about the page');

    await inputModule.dispose();
    assert.equal(inputModule.diagnostics().status, 'created');
});

test('a mouse a program holds exclusively through DirectInput stops reaching the window', async()=>{
    // The route a program takes, through the layer's own seam: the device's
    // cooperative level and Acquire decide whether a click is a window message
    // as well as a DirectInput event. device8.c test_mouse_keyboard: an
    // exclusive foreground Acquire registers the mouse with RIDEV_NOLEGACY.
    /** @type {Map<number, { object: any, id: string }>} */
    const published = new Map();
    const { api, memory, drain } = await open({ config: {
        publishInterface: (/** @type {any} */ object, /** @type {string} */ id)=>{
            const pointer = 0x10000 + published.size * 4;
            published.set(pointer, { object, id });
            return pointer;
        },
    } });
    const guids = {
        readMemory: memory.readBytes,
        writeMemory: memory.writeBytes,
    };
    const u32 = (/** @type {number} */ at)=>new DataView(memory.readBytes(at, 4).slice().buffer)
        .getUint32(0, true);
    /** @param {number} pointer @param {string} name @param {number[]} args */
    const call = (pointer, name, args = [])=>{
        const entry = /** @type {{ object: any, id: string }} */ (published.get(pointer));
        const method = entry.object.interfaceFor(entry.id).methods
            .find((/** @type {any} */ m)=>m.name === name);
        return method.invoke(entry.object, args) | 0;
    };

    writeGuid(guids, 0x100, IID_IDirectInput8A);
    assert.equal(api.libraries()['DINPUT8.dll'].DirectInput8Create
        .handler([0, 0x0800, 0x100, 0x200, 0]), 0);
    writeGuid(guids, 0x120, GUID_SysMouse);
    assert.equal(call(u32(0x200), 'CreateDevice', [0x120, 0x204, 0]), 0);
    const mouse = u32(0x204);
    memory.writeBytes(0x300, new Uint8Array([0x18, 0, 0, 0, 0x10, 0, 0, 0, 2, 0, 0, 0, 16]));
    assert.equal(call(mouse, 'SetDataFormat', [0x300]), 0);
    const DISCL_EXCLUSIVE = 0x1;
    const DISCL_NONEXCLUSIVE = 0x2;
    const DISCL_FOREGROUND = 0x4;
    assert.equal(call(mouse, 'SetCooperativeLevel', [HWND, DISCL_EXCLUSIVE | DISCL_FOREGROUND]), 0);
    assert.equal(call(mouse, 'Acquire'), 0);

    api.send({ kind: 'pointerMove', x: 10, y: 10, dx: 10, dy: 10 });
    api.send({ kind: 'pointerButton', button: 'left', down: true });
    api.send({ kind: 'pointerButton', button: 'left', down: false });
    api.send({ kind: 'key', code: 'KeyW', down: true });
    assert.deepEqual(drain().map(message=>message.message), [WM.KEYDOWN],
        'the click reaches the program once, through DirectInput');
    assert.equal(api.device(GUID_SysMouse).mouseState().x, 10);

    assert.equal(call(mouse, 'Unacquire'), 0);
    assert.equal(call(mouse, 'SetCooperativeLevel', [HWND, DISCL_NONEXCLUSIVE | DISCL_FOREGROUND]),
        0);
    assert.equal(call(mouse, 'Acquire'), 0);
    api.send({ kind: 'pointerButton', button: 'left', down: true });
    assert.ok(drain().some(message=>message.message === 0x0201),
        'held without DISCL_EXCLUSIVE, the window hears it too');

    await inputModule.dispose();
});
