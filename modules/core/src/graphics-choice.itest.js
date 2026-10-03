/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from './app.js';
import { buildExe } from '../../../tools/make-pe.mjs';

test('a bottle that names its graphics has no library beyond it to import', async()=>{
    // A library the bottle lacks is missing as any absent file is: its imports
    // stay unbound and the start goes on, which is this engine's way with a
    // missing library.
    const executable = new Uint8Array(buildExe({
        imports: {
            'DDRAW.dll': ['DirectDrawCreate'],
            'D3D8.dll': ['Direct3DCreate8'],
            'D3D9.dll': ['Direct3DCreate9'],
            'KERNEL32.dll': ['ExitProcess'],
        },
        code: ()=>[0xc3],
    }));
    /** @param {string} [graphicsApi] */
    const unresolved = async graphicsApi=>{
        const app = await createApp({ executable, imagePath: 'C:\\App\\t.exe', storage: null,
            graphicsApi: /** @type {any} */ (graphicsApi) });
        const names = [...app.image?.unresolved ?? []];
        await app.dispose?.();
        return names;
    };

    assert.deepEqual(await unresolved(), [], 'every library by default');
    assert.deepEqual(await unresolved('directx9'), [], 'DirectX 9 has 7 and 8 inside it');
    assert.deepEqual(await unresolved('directx8'), ['D3D9.dll!Direct3DCreate9']);
    assert.deepEqual(await unresolved('directx7'),
        ['D3D8.dll!Direct3DCreate8', 'D3D9.dll!Direct3DCreate9']);
    assert.deepEqual(await unresolved('opengl'), ['DDRAW.dll!DirectDrawCreate',
        'D3D8.dll!Direct3DCreate8', 'D3D9.dll!Direct3DCreate9'], 'OpenGL has no DirectX');
});
