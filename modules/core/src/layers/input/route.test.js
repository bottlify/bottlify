/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CORNER, createInputRoute } from './route.js';

/**
 * A program's own cursor as DirectInput's mouse moves it: it starts in the
 * middle, adds up a frame's motion and only then stops at the screen's edges.
 */
const relativeCursor = ()=>{
    const at = { x: 512, y: 384 };
    /** @type {{ x: number, y: number }[]} */
    const pressed = [];
    return {
        at,
        pressed,
        /** @param {any[]} frame */
        read(frame){
            const dx = frame.reduce((sum, event)=>sum + (event.dx ?? 0), 0);
            const dy = frame.reduce((sum, event)=>sum + (event.dy ?? 0), 0);
            at.x = Math.min(1023, Math.max(0, at.x + dx));
            at.y = Math.min(767, Math.max(0, at.y + dy));
            if (frame.some(event=>event.kind === 'pointerButton' && event.down))
            {
                pressed.push({ ...at });
            }
        },
    };
};

test('a click lands on its point on a cursor moved by relative motion, wherever it started', ()=>{
    const cursor = relativeCursor();
    /** @type {any[]} */
    let frame = [];
    const route = createInputRoute(event=>frame.push(event));
    route.click(672, 528);
    route.click(132, 174);
    let frames = 0;
    while (route.pending() > 0)
    {
        frame = [];
        route.tick();
        cursor.read(frame);
        frames++;
        if (frames === 3)
        {
            // The program put its cursor back in the middle, as a menu does
            // when it opens.
            cursor.at.x = 512;
            cursor.at.y = 384;
        }
    }
    assert.deepEqual(cursor.pressed, [{ x: 672, y: 528 }, { x: 132, y: 174 }]);
    assert.equal(frames, 6, 'three frames a click');
});

test('a click\'s steps: the corner, then the move with the press, then the release', ()=>{
    /** @type {any[][]} */
    const frames = [];
    const route = createInputRoute(event=>frames.at(-1)?.push(event));
    route.click(10, 20, { button: 'right' });
    for (let step = 0; step < 4; step++)
    {
        frames.push([]);
        route.tick();
    }
    assert.deepEqual(frames, [
        [{ kind: 'pointerMove', x: 0, y: 0, dx: -CORNER, dy: -CORNER }],
        [{ kind: 'pointerMove', x: 10, y: 20, dx: 10, dy: 20 },
            { kind: 'pointerButton', button: 'right', down: true }],
        [{ kind: 'pointerButton', button: 'right', down: false }],
        [],
    ]);
});

test('a key is held for its frames, and what is queued goes in order', ()=>{
    /** @type {string[]} */
    const sent = [];
    const route = createInputRoute(event=>sent.push(`${event.code ?? event.kind}:${event.down}`));
    route.key('Space', 3);
    route.key('Enter');
    const left = [];
    while (route.pending() > 0)
    {
        left.push(route.tick());
    }
    assert.deepEqual(sent, ['Space:true', 'Space:false', 'Enter:true', 'Enter:false']);
    assert.deepEqual(left, [5, 4, 3, 2, 1, 0], 'Space down, held, held, up; Enter down, up');
});
