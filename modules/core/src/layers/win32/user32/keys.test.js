/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    characterOf, codeForScan, codeForVk, dikOf, keyFor, keyForCharacter,
} from './keys.js';

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

test('every character a key types is typed by the key keyForCharacter names', ()=>{
    // The two directions are one table read both ways, so each undoes the
    // other for every printable character the layout has.
    for (let character = 0x20; character < 0x7f; character++)
    {
        const key = keyForCharacter(character);
        assert.ok(key !== null, `a key types 0x${character.toString(16)}`);
        const typed = characterOf(key & 0xff,
            { shift: (key & 0x100) !== 0, control: (key & 0x200) !== 0 });
        assert.equal(typed, character);
    }
});

test('caps lock and shift cancel on a letter, and do nothing to a symbol key', ()=>{
    assert.equal(characterOf(0x41, { shift: true, capsLock: true }), 0x61);
    assert.equal(characterOf(0x31, { capsLock: true }), 0x31);
    assert.equal(characterOf(0x70), null, 'a function key types nothing');
});
