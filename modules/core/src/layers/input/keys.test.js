/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keyFor, dikOf, codeForVk, codeForScan } from './keys.js';

test('codeForVk finds the physical key a virtual key names', ()=>{
    const w = keyFor('KeyW');
    assert.equal(codeForVk(/** @type {any} */ (w).vk), 'KeyW');
});

test('a generic modifier virtual key resolves to its left key, as Windows does', ()=>{
    const VK_SHIFT = 0x10;
    const VK_CONTROL = 0x11;
    const VK_MENU = 0x12;
    assert.equal(codeForVk(VK_SHIFT), 'ShiftLeft');
    assert.equal(codeForVk(VK_CONTROL), 'ControlLeft');
    assert.equal(codeForVk(VK_MENU), 'AltLeft');
});

test('the side-specific virtual keys resolve to the side that has them', ()=>{
    const shiftRight = /** @type {any} */ (keyFor('ShiftRight'));
    const controlRight = /** @type {any} */ (keyFor('ControlRight'));
    assert.equal(codeForVk(shiftRight.vkSide), 'ShiftRight');
    assert.equal(codeForVk(controlRight.vkSide), 'ControlRight');
});

test('codeForScan finds the physical key at a scan code, prefixed or not', ()=>{
    const w = /** @type {any} */ (keyFor('KeyW'));
    assert.equal(codeForScan(w.scan, false), 'KeyW');

    // The numeric keypad and the arrow cluster share scan codes; only the E0
    // prefix -- carried here as `extended` -- tells them apart.
    const numpad8 = /** @type {any} */ (keyFor('Numpad8'));
    const arrowUp = /** @type {any} */ (keyFor('ArrowUp'));
    assert.equal(numpad8.scan, arrowUp.scan, 'the fixture the rest of this test relies on');
    assert.equal(codeForScan(numpad8.scan, false), 'Numpad8');
    assert.equal(codeForScan(arrowUp.scan, true), 'ArrowUp');
});

test('an unknown virtual key or scan code resolves to nothing', ()=>{
    assert.equal(codeForVk(0xff), null);
    assert.equal(codeForScan(0xff, false), null);
});

test('dikOf still folds the E0 prefix into bit 7', ()=>{
    const mapping = /** @type {any} */ (keyFor('ArrowUp'));
    assert.equal(dikOf(mapping), mapping.scan | 0x80);
});
