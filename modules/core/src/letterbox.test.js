/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fitFrame, isShown } from './letterbox.js';

/** @param {number} width @param {number} height @param {number[]} colour */
function picture(width, height, colour){
    const bgra = new Uint8Array(width * height * 4);
    for (let at = 0; at < bgra.length; at += 4)
    {
        bgra.set(colour, at);
    }
    return { bgra, width, height };
}

/** @param {Uint8Array} out @param {number} width @param {number} x @param {number} y */
const pixel = (out, width, x, y)=>[...out.subarray((y * width + x) * 4, (y * width + x) * 4 + 4)];

test('a film keeps the display it was given, whatever shape it is', ()=>{
    // The defect this pins was visible from across the room: starting a
    // cinematic resized the canvas, because the frame was presented at the
    // film's own dimensions and everything downstream took those for the
    // display's. A display does not change shape because a film started.
    const out = new Uint8Array(640 * 480 * 4);
    fitFrame(picture(800, 368, [10, 20, 30, 0]), out, 640, 480);

    assert.equal(out.length, 640 * 480 * 4, 'the buffer is the screen, not the film');
    // 800x368 into 640x480 fits by width: 640x294, centred vertically.
    assert.deepEqual(pixel(out, 640, 320, 240), [10, 20, 30, 0xff], 'the middle is the film');
    assert.deepEqual(pixel(out, 640, 320, 2), [0, 0, 0, 0], 'and the margins are black');
    assert.deepEqual(pixel(out, 640, 320, 477), [0, 0, 0, 0]);
});

test('a film narrower than the display is fitted by height and centred across', ()=>{
    const out = new Uint8Array(640 * 480 * 4);
    fitFrame(picture(320, 480, [1, 2, 3, 0]), out, 640, 480);

    assert.deepEqual(pixel(out, 640, 320, 240), [1, 2, 3, 0xff]);
    assert.deepEqual(pixel(out, 640, 2, 240), [0, 0, 0, 0]);
    assert.deepEqual(pixel(out, 640, 637, 240), [0, 0, 0, 0]);
});

test('nothing is written outside the buffer, whatever the film claims to be', ()=>{
    const out = new Uint8Array(64 * 64 * 4).fill(0x7f);
    fitFrame(picture(0, 0, [1, 2, 3, 0]), out, 64, 64);
    assert.ok(out.every(byte=>byte === 0), 'a film with no pixels leaves a black screen');

    const small = new Uint8Array(8 * 8 * 4);
    fitFrame(picture(1920, 1080, [4, 5, 6, 0]), small, 8, 8);
    assert.equal(small.length, 8 * 8 * 4);
});

test('a frame of a hidden video window is not shown; one with no window record is', ()=>{
    // IVideoWindow's Visible: a program that hides the window still plays the
    // film -- its sound, its clock -- and expects nothing on the screen.
    const frame = { bgra: new Uint8Array(4), width: 1, height: 1 };
    assert.equal(isShown({ ...frame, window: { visible: false } }), false);
    assert.equal(isShown({ ...frame, window: { visible: true } }), true);
    assert.equal(isShown(frame), true);
});
