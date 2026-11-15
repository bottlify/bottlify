/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A window over a full-screen OpenGL picture, through `createApp` over the
 * recording device: the program covers the screen with a window, clears its
 * GL frame red and swaps, then shows a white window over part of it and
 * pumps its messages. The frame lives on the GPU, the white window only on
 * the desktop the process composed; the screen is to show both. Shown alone,
 * the frame hid the message box a program ended with.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from './app.js';
import { createFakeDevice } from './layers/graphics/webgpu/internal/fake-device.js';
import { buildExe } from '../../../tools/fixtures/make-pe.mjs';
import { setupData, storeEax, u32 } from '../../../tools/fixtures/gl-program.mjs';

/** Where the white window lies on the 640 x 480 screen. */
const BOX = { left: 40, top: 30, right: 140, bottom: 90 };

const program = ()=>buildExe({
    imports: {
        'USER32.dll': ['RegisterClassA', 'CreateWindowExA', 'DefWindowProcA', 'GetDC',
            'GetSystemMetrics', 'PeekMessageA', 'DispatchMessageA'],
        'GDI32.dll': ['ChoosePixelFormat', 'SetPixelFormat', 'SwapBuffers'],
        'OPENGL32.dll': ['wglCreateContext', 'wglMakeCurrent', 'glClearColor', 'glClear'],
        'KERNEL32.dll': ['ExitProcess'],
    },
    codeSize: 0x800,
    data: { ...setupData(), width: [0, 0, 0, 0], height: [0, 0, 0, 0], msg: new Array(28).fill(0) },
    code: ({ iat, at })=>{
        /** @param {number | { mem: number }} value */
        const arg = value=>(typeof value === 'number' ? [0x68, ...u32(value >>> 0)]
            : [0xff, 0x35, ...u32(value.mem)]);
        /** @param {string} name @param {(number | { mem: number })[]} [args] */
        const call = (name, args = [])=>[...[...args].reverse().flatMap(arg),
            0xff, 0x15, ...u32(iat(name))];
        /** @param {string} name */
        const mem = name=>({ mem: at(name) });
        const WS_POPUP_VISIBLE = 0x90000000;
        // PeekMessage(PM_REMOVE) and DispatchMessage of what it took, if it took one.
        const pump = [...call('PeekMessageA', [at('msg'), 0, 0, 0, 1]),
            0x85, 0xc0, 0x74, 11, ...call('DispatchMessageA', [at('msg')])];
        return [
            // lpfnWndProc, hbrBackground (COLOR_WINDOW + 1, white), lpszClassName.
            0xa1, ...u32(iat('DefWindowProcA')), 0xa3, ...u32(at('wndclass') + 4),
            0xc7, 0x05, ...u32(at('wndclass') + 28), ...u32(6),
            0xc7, 0x05, ...u32(at('wndclass') + 36), ...u32(at('className')),
            ...call('RegisterClassA', [at('wndclass')]),
            ...call('GetSystemMetrics', [0]), ...storeEax(at('width')),
            ...call('GetSystemMetrics', [1]), ...storeEax(at('height')),
            ...call('CreateWindowExA', [0, at('className'), at('className'), WS_POPUP_VISIBLE,
                0, 0, mem('width'), mem('height'), 0, 0, 0, 0]),
            0x50, 0xff, 0x15, ...u32(iat('GetDC')), ...storeEax(at('hdc')),
            ...call('ChoosePixelFormat', [mem('hdc'), at('pfd')]),
            0x68, ...u32(at('pfd')), 0x50, 0xff, 0x35, ...u32(at('hdc')),
            0xff, 0x15, ...u32(iat('SetPixelFormat')),
            ...call('wglCreateContext', [mem('hdc')]), ...storeEax(at('hglrc')),
            ...call('wglMakeCurrent', [mem('hdc'), mem('hglrc')]),
            ...call('glClearColor', [0x3f800000, 0, 0, 0x3f800000]),
            ...call('glClear', [0x4000]),
            ...call('SwapBuffers', [mem('hdc')]),
            ...pump, ...pump, ...pump, ...pump,
            ...call('CreateWindowExA', [0, at('className'), at('className'), WS_POPUP_VISIBLE,
                BOX.left, BOX.top, BOX.right - BOX.left, BOX.bottom - BOX.top, 0, 0, 0, 0]),
            ...Array(16).fill(pump).flat(),
            ...call('ExitProcess', [0]),
        ];
    },
});

test('a window over a full-screen GL picture is seen over it, the picture around it',
    { timeout: 120000 }, async t=>{
        const gpu = createFakeDevice();
        const gpuDevice = /** @type {any} */ (gpu.device);
        gpuDevice.features = new Set();
        gpuDevice.createSampler = (/** @type {any} */ descriptor)=>({ kind: 'sampler',
            descriptor });
        const app = await createApp({ executable: program(),
            device: { device: gpu.device, queue: gpu.queue, screen: gpu.screen,
                canvas: gpu.canvas,
                adapter: { vendor: 'fake', architecture: '', description: 'a stand-in' } } });
        t.after(()=>app.dispose());
        assert.equal(await app.run({ timeoutMs: 100000 }), 0, 'the program exits 0');
        const shown = gpu.screen.getCurrentTexture();
        assert.deepEqual([gpu.canvas.width, gpu.canvas.height], [640, 480]);
        // The recording device keeps what reaches a texture, not what a GL
        // clear would draw: the frame is whatever its texture holds.
        const frame = gpu.of('copyTextureToTexture').find((/** @type {any} */ copy)=>
            String(copy.source.texture.descriptor?.label).startsWith('gl-shown'))?.source.texture;
        assert.ok(frame?.bytes, 'the GL frame reached the presenter');
        /** @param {Uint8Array} bytes @param {number} x @param {number} y */
        const pixel = (bytes, x, y)=>[...bytes.subarray((y * 640 + x) * 4, (y * 640 + x) * 4 + 4)];
        const white = [0xff, 0xff, 0xff, 0xff];
        assert.notDeepEqual(pixel(frame.bytes, BOX.left, BOX.top), white,
            'the frame under the window is not the window');
        for (let y = 0; y < 480; y += 3)
        {
            for (let x = 0; x < 640; x += 3)
            {
                const inside = x >= BOX.left && x < BOX.right && y >= BOX.top && y < BOX.bottom;
                assert.deepEqual(pixel(shown.bytes, x, y),
                    inside ? white : pixel(frame.bytes, x, y),
                    `${inside ? 'the window' : 'the GL frame'} at ${x}, ${y}`);
            }
        }
    });
