/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GRAPHICS_CHOICES, WINDOWS_CHOICES, graphicsChoice, windowsChoice } from './windows.js';
import { WINDOWS_VERSIONS } from '../../core/src/layers/win32/kernel32/versions.js';
import { GRAPHICS_CHOICES as ENGINE_GRAPHICS } from '../../core/src/layers/graphics/choice.js';

test('the choices are the engine\'s own four', ()=>{
    // A name this side accepted and the engine refused would make a bottle
    // that cannot start; one the engine accepts and this side refused, a
    // bottle that cannot be made.
    assert.deepEqual([...WINDOWS_CHOICES], Object.keys(WINDOWS_VERSIONS));
});

test('absent is the engine\'s default, and anything but the four is refused by name', ()=>{
    assert.equal(windowsChoice(undefined), undefined);
    assert.equal(windowsChoice(null), undefined, 'a manifest that wrote null named nothing');
    for (const name of WINDOWS_CHOICES)
    {
        assert.equal(windowsChoice(name), name);
    }
    for (const wrong of ['win98', 'WinXP', 'xp', '', 7])
    {
        assert.throws(()=>windowsChoice(wrong),
            /unknown Windows version .*: the choices are win2000, winxp, win7, win10/,
            JSON.stringify(wrong));
    }
});

test('a bottle\'s graphics is one of the engine\'s five choices, or none', ()=>{
    assert.deepEqual([...GRAPHICS_CHOICES], Object.keys(ENGINE_GRAPHICS));
    assert.equal(graphicsChoice(undefined), undefined);
    assert.equal(graphicsChoice('directx8'), 'directx8');
    for (const wrong of ['glide', 'd3d8', 'DirectX8', '', 8])
    {
        assert.throws(()=>graphicsChoice(wrong),
            /unknown graphics choice .*: the choices are directx7, directx8, directx9, directx10, opengl/,
            JSON.stringify(wrong));
    }
});
