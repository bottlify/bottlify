/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    WS_BORDER, WS_CAPTION, WS_CHILD, WS_DLGFRAME, WS_EX_CLIENTEDGE, WS_EX_DLGMODALFRAME,
    WS_EX_STATICEDGE, WS_THICKFRAME, frameOf, frameRings,
} from './frame.js';

const COLOR_WINDOWFRAME = 6;
const COLOR_ACTIVEBORDER = 10;
const COLOR_INACTIVEBORDER = 11;
const COLOR_3DFACE = 15;
const COLOR_3DSHADOW = 16;
const COLOR_3DHILIGHT = 20;
const COLOR_3DDKSHADOW = 21;
const COLOR_3DLIGHT = 22;

/** @param {number} topLeft @param {number} bottomRight */
const ring = (topLeft, bottomRight)=>({ topLeft, bottomRight });
const RAISED = [ring(COLOR_3DLIGHT, COLOR_3DDKSHADOW), ring(COLOR_3DHILIGHT, COLOR_3DSHADOW)];
const SUNKEN = [ring(COLOR_3DSHADOW, COLOR_3DHILIGHT), ring(COLOR_3DDKSHADOW, COLOR_3DLIGHT)];

test('a client edge is sunken, two rings deep, inside whatever frame is round it', ()=>{
    // An edit in a dialog: WS_EX_CLIENTEDGE and nothing else is EDGE_SUNKEN,
    // shadow outside dark shadow along the top and left, highlight outside
    // light along the bottom and right.
    assert.deepEqual(frameRings(WS_CHILD, WS_EX_CLIENTEDGE), SUNKEN);
    // With a border as well, the border's ring is the face colour, outside it.
    assert.deepEqual(frameRings(WS_CHILD | WS_BORDER, WS_EX_CLIENTEDGE),
        [ring(COLOR_3DFACE, COLOR_3DFACE), ...SUNKEN]);
});

test('a dialog frame is raised, the border\'s ring face-coloured inside it', ()=>{
    assert.deepEqual(frameRings(WS_CAPTION), [...RAISED, ring(COLOR_3DFACE, COLOR_3DFACE)]);
    assert.deepEqual(frameRings(WS_DLGFRAME, WS_EX_DLGMODALFRAME),
        [...RAISED, ring(COLOR_3DFACE, COLOR_3DFACE)]);
});

test('a sizing frame has its band in the border colour of the window\'s activity', ()=>{
    assert.deepEqual(frameRings(WS_CAPTION | WS_THICKFRAME, 0, true), [...RAISED,
        ring(COLOR_ACTIVEBORDER, COLOR_ACTIVEBORDER), ring(COLOR_3DFACE, COLOR_3DFACE)]);
    assert.deepEqual(frameRings(WS_THICKFRAME, 0, false)[2],
        ring(COLOR_INACTIVEBORDER, COLOR_INACTIVEBORDER));
});

test('a plain border is one black ring, and a static edge one sunken one', ()=>{
    assert.deepEqual(frameRings(WS_CHILD | WS_BORDER),
        [ring(COLOR_WINDOWFRAME, COLOR_WINDOWFRAME)]);
    assert.deepEqual(frameRings(WS_CHILD, WS_EX_STATICEDGE), [SUNKEN[0]]);
    assert.deepEqual(frameRings(WS_CHILD | WS_BORDER, WS_EX_STATICEDGE),
        [SUNKEN[0], ring(COLOR_WINDOWFRAME, COLOR_WINDOWFRAME)]);
});

test('there is one ring for every pixel of edge the frame takes', ()=>{
    for (const style of [0, WS_BORDER, WS_DLGFRAME, WS_CAPTION, WS_THICKFRAME,
        WS_CAPTION | WS_THICKFRAME])
    {
        for (const exStyle of [0, WS_EX_CLIENTEDGE, WS_EX_STATICEDGE, WS_EX_DLGMODALFRAME,
            WS_EX_CLIENTEDGE | WS_EX_STATICEDGE, WS_EX_DLGMODALFRAME | WS_EX_STATICEDGE])
        {
            assert.equal(frameRings(style, exStyle).length, frameOf(style, exStyle).edge,
                `style 0x${style.toString(16)}, extended 0x${exStyle.toString(16)}`);
        }
    }
});
