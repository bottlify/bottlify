/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fitFrame, isShown, placementOf, stretchFrame } from './letterbox.js';

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

/** A 640x480 client area whose origin is at (100, 50) on an 800x600 screen. */
const OWNER = 0x40b4;
const SCREEN = { width: 800, height: 600 };
const CLIENT = { left: 100, top: 50, right: 740, bottom: 530 };
/** @param {number} hwnd */
const clientOf = hwnd=>(hwnd === OWNER ? CLIENT : null);

/**
 * @param {Partial<{ left: number, top: number, width: number, height: number,
 *     visible: boolean, fullScreen: boolean }>} [window]
 * @param {number} [hwnd]
 */
const placed = (window = {}, hwnd = OWNER)=>({
    hwnd,
    window: { left: 16, top: 32, width: 160, height: 120, visible: true, fullScreen: false,
        ...window },
});

test('a video window is placed at its rectangle in its owner\'s client area', ()=>{
    // IVideoWindow's Left and Top are the owner's client coordinates: the
    // video window is a child of it (quartz's videorenderer tests,
    // test_video_window_owner), so on the screen it sits past where that
    // client area begins.
    const target = { left: 116, top: 82, right: 276, bottom: 202 };
    assert.deepEqual(placementOf(placed(), clientOf, SCREEN), { target, visible: target });
});

test('a film fills the screen when nothing places it', ()=>{
    // With no owner the video window is a top-level window of its own, which
    // on one screen is the whole of it; full-screen mode is the same; and a
    // source with no window record, or an owner that names no window, has
    // nowhere else to go.
    assert.equal(placementOf(placed({}, 0), clientOf, SCREEN), null, 'no owner');
    assert.equal(placementOf(placed({ fullScreen: true }), clientOf, SCREEN), null);
    assert.equal(placementOf(placed({}, 0x9999), clientOf, SCREEN), null, 'no such window');
    assert.equal(placementOf({ hwnd: OWNER }, clientOf, SCREEN), null, 'no window record');
});

test('a video window is cut to its owner\'s client area, and may be cut away entirely', ()=>{
    // A child window shows only inside its parent's client area.
    const hanging = placementOf(placed({ left: -40, top: 400, width: 200, height: 200 }),
        clientOf, SCREEN);
    assert.deepEqual(hanging?.target, { left: 60, top: 450, right: 260, bottom: 650 });
    assert.deepEqual(hanging?.visible, { left: 100, top: 450, right: 260, bottom: 530 });

    assert.equal(placementOf(placed({ left: 700, top: 0 }), clientOf, SCREEN)?.visible, null,
        'right of the client area: nothing of it shows');
    assert.equal(placementOf(placed({ width: 0 }), clientOf, SCREEN)?.visible, null,
        'and a window of no width shows nothing either');
});

test('a placed film is stretched over the whole window, as a video renderer fills it', ()=>{
    // The destination is the window's whole client area by default, whatever
    // the film's shape: the picture is scaled to it on both axes, not fitted.
    const film = picture(2, 1, [0, 0, 0, 0]);
    film.bgra.set([10, 20, 30, 0], 0);
    film.bgra.set([40, 50, 60, 0], 4);
    const out = new Uint8Array(16 * 10 * 4).fill(0x7f);
    const target = { left: 2, top: 3, right: 12, bottom: 7 };
    stretchFrame(film, out, 16, 10, { target, visible: target });

    assert.deepEqual(pixel(out, 16, 2, 3), [10, 20, 30, 0xff], 'the left half of the film');
    assert.deepEqual(pixel(out, 16, 11, 6), [40, 50, 60, 0xff], 'the right half, to the corner');
    assert.deepEqual(pixel(out, 16, 1, 3), [0, 0, 0, 0], 'and black around it');
    assert.deepEqual(pixel(out, 16, 12, 3), [0, 0, 0, 0]);
    assert.deepEqual(pixel(out, 16, 2, 7), [0, 0, 0, 0]);
});

test('a window cut short shows the part of the film that falls inside, at the window\'s scale',
    ()=>{
        const film = picture(4, 1, [0, 0, 0, 0]);
        for (let x = 0; x < 4; x++)
        {
            film.bgra.set([x + 1, 0, 0, 0], x * 4);
        }
        const out = new Uint8Array(8 * 1 * 4);
        // Eight wide, the first four of it cut off: the film's right half shows.
        stretchFrame(film, out, 8, 1, {
            target: { left: -4, top: 0, right: 4, bottom: 1 },
            visible: { left: 0, top: 0, right: 4, bottom: 1 },
        });
        assert.deepEqual([0, 1, 2, 3, 4].map(x=>pixel(out, 8, x, 0)[0]), [3, 3, 4, 4, 0]);
    });
