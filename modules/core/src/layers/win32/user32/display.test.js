/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REFRESH_HZ, displayModes } from './display.js';

test('a display offers every size of the era up to its own, smallest first', ()=>{
    const modes = displayModes({ width: 1024, height: 768, bitsPerPixel: 32 });
    assert.deepEqual(modes.map(mode=>`${mode.width}x${mode.height}`),
        ['640x480', '800x600', '1024x768']);
    assert.ok(modes.every(mode=>mode.bitsPerPixel === 32 && mode.refresh === REFRESH_HZ));
});

test('a display of a size the era never had is still in its own list', ()=>{
    // A program reads the current mode and then looks for it among the modes;
    // a list without it leaves that program with a selection it cannot make.
    const modes = displayModes({ width: 1000, height: 700, bitsPerPixel: 32 });
    assert.deepEqual(modes.map(mode=>`${mode.width}x${mode.height}`),
        ['640x480', '800x600', '1000x700']);
});

test('nothing wider than the display is offered', ()=>{
    const modes = displayModes({ width: 640, height: 480, bitsPerPixel: 16 });
    assert.deepEqual(modes.map(mode=>`${mode.width}x${mode.height}`), ['640x480']);
});

test('a program in a small mode is still offered the whole display', ()=>{
    // The mode in effect is what the program set; the display is what it is on.
    // A list bounded by the mode would offer nothing beyond it, which is a
    // resolution menu with one entry.
    const modes = displayModes({ width: 800, height: 600, bitsPerPixel: 32,
        displayWidth: 1920, displayHeight: 1080 });
    const sizes = modes.map(mode=>`${mode.width}x${mode.height}`);
    assert.ok(sizes.includes('800x600'), 'the mode in effect is listed');
    assert.ok(sizes.includes('1920x1080'), 'and so is the display itself');
    assert.deepEqual(sizes, ['640x480', '800x600', '1024x768', '1280x720', '1920x1080'],
        'and only the handful anyone would pick between them');
});
