/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REFRESH_HZ, displayModes } from './display.js';

/** Every size of the era, as the table lists them. */
const ERA = ['640x480', '800x600', '1024x768', '1152x864', '1280x720', '1280x800', '1280x832',
    '1280x960', '1280x1024', '1400x1050', '1440x900', '1512x982', '1600x900', '1600x1200',
    '1680x1050', '1728x1117', '1920x1080', '1920x1200', '1920x1440', '2048x1536', '2560x1440',
    '2560x1600', '2560x1664', '2880x1800', '3024x1964', '3456x2234'];
/** Each size at each rate, as the list walks them. */
const ERA_MODES = ERA.flatMap(size=>[`${size}@60`, `${size}@120`]);
/** @param {import('./display.js').DisplayMode[]} modes */
const names = modes=>modes.map(mode=>`${mode.width}x${mode.height}@${mode.refresh}`);

test('a display offers every size of the era whatever its own, smallest first', ()=>{
    // The picture is a canvas the page scales: a mode larger than the display
    // is shown smaller, not refused, so a person on a small screen still gets
    // the size the program looks best at.
    const modes = displayModes({ width: 1024, height: 768, bitsPerPixel: 32 });
    assert.deepEqual(names(modes), ERA_MODES);
    assert.ok(modes.every(mode=>mode.bitsPerPixel === 32));
    assert.equal(modes[0].refresh, REFRESH_HZ);
});

test('a program that keeps only 4:3 sizes finds the ladder a driver lists, not three', ()=>{
    // An older program filters the adapter's list to 4:3 and builds its menu
    // from what is left; with three such sizes its menu had three entries.
    const fourByThree = [...new Set(displayModes({ width: 1024, height: 768, bitsPerPixel: 32 })
        .filter(mode=>mode.width * 3 === mode.height * 4)
        .map(mode=>`${mode.width}x${mode.height}`))];
    assert.deepEqual(fourByThree, ['640x480', '800x600', '1024x768', '1152x864', '1280x960',
        '1400x1050', '1600x1200', '1920x1440', '2048x1536']);
});

test('a display of a size the era never had is still in its own list', ()=>{
    // A program reads the current mode and then looks for it among the modes;
    // a list without it leaves that program with a selection it cannot make.
    const modes = displayModes({ width: 1000, height: 700, bitsPerPixel: 32 });
    assert.deepEqual([...new Set(modes.map(mode=>`${mode.width}x${mode.height}`))],
        ['640x480', '800x600', '1000x700', ...ERA.slice(2)]);
});

test('a size of the era is listed once, whether or not the display is that size', ()=>{
    const modes = displayModes({ width: 640, height: 480, bitsPerPixel: 16 });
    assert.deepEqual(names(modes), ERA_MODES);
    assert.ok(modes.every(mode=>mode.bitsPerPixel === 16));
});

test('a program in a small mode is still offered the whole display', ()=>{
    // The mode in effect is what the program set; the display is what it is on.
    // A list bounded by the mode would offer nothing beyond it, which is a
    // resolution menu with one entry.
    const modes = displayModes({ width: 800, height: 600, bitsPerPixel: 32,
        displayWidth: 1920, displayHeight: 1080 });
    const sizes = [...new Set(modes.map(mode=>`${mode.width}x${mode.height}`))];
    assert.ok(sizes.includes('800x600'), 'the mode in effect is listed');
    assert.ok(sizes.includes('1920x1080'), 'and so is the display itself');
    assert.deepEqual(sizes, ERA,
        'and only the handful anyone would pick between them');
});
