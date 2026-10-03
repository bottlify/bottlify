/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GRAPHICS_CHOICES, graphicsChoice } from './choice.js';

test('a graphics choice is one of five names, none is no choice, and anything else is refused',
    ()=>{
        assert.equal(graphicsChoice(undefined), undefined);
        assert.equal(graphicsChoice(null), undefined);
        for (const name of ['directx7', 'directx8', 'directx9', 'directx10', 'opengl'])
        {
            assert.equal(graphicsChoice(name), name);
        }
        assert.throws(()=>graphicsChoice('glide'),
            /unknown graphics choice "glide": the choices are directx7, directx8, directx9, directx10, opengl/);
        assert.throws(()=>graphicsChoice('d3d8'), /unknown graphics choice/,
            'the engine\'s own API names are not choices');
        assert.throws(()=>graphicsChoice('toString'), /unknown graphics choice/,
            'not a name an object inherits');
        assert.throws(()=>graphicsChoice(9), /unknown graphics choice 9/);
    });

test('a DirectX choice has every DirectX up to it, OpenGL has itself alone', ()=>{
    assert.deepEqual(Object.fromEntries(Object.entries(GRAPHICS_CHOICES)
        .map(([name, stack])=>[name, [stack.libraries.join(' '), stack.apis.join(' '),
            stack.directx]])), {
        directx7: ['DDRAW.dll', 'ddraw', '7'],
        directx8: ['DDRAW.dll D3D8.dll', 'ddraw d3d8', '8'],
        directx9: ['DDRAW.dll D3D8.dll D3D9.dll', 'ddraw d3d8 d3d9', '9'],
        directx10: ['DDRAW.dll D3D8.dll D3D9.dll D3D10.dll D3D10_1.dll DXGI.dll',
            'ddraw d3d8 d3d9 d3d10', '9'],
        opengl: ['OPENGL32.dll GLU32.dll', 'opengl', null],
    });
});
