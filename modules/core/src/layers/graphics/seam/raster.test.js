/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRaster } from './raster.js';

/** A raster at 60 Hz over 480 lines, on a clock the test sets. */
function clocked(){
    let time = 0;
    const raster = createRaster({ now: ()=>time, refresh: ()=>60, height: ()=>480 });
    return {
        raster,
        /** @param {number} ms */
        at(ms){
            time = ms;
            return raster.position();
        },
        /** @param {number} ms */
        advance(ms){
            time += ms;
        },
        now: ()=>time,
    };
}

test('the beam runs down the frame once per refresh and spends the last lines in the blank',
    ()=>{
        const c = clocked();
        const period = 1000 / 60;
        assert.deepEqual(c.at(0), { line: 0, inBlank: false }, 'a frame starts at the top');
        assert.equal(c.at(period / 2).line, 262, 'half a frame is half of its 525 lines');
        assert.equal(c.at(period * 479.5 / 525).inBlank, false, 'the last visible line');
        assert.deepEqual(c.at(period * 500 / 525), { line: 500, inBlank: true });
        assert.deepEqual(c.at(period * 7 + 1), c.at(1), 'and again the next frame');
    });

test('a wait for the blank lands inside it, and a wait for its end on the next frame\'s top',
    ()=>{
        const c = clocked();
        const period = 1000 / 60;
        c.at(2);
        c.advance(c.raster.untilBlank('begin'));
        assert.equal(c.raster.position().inBlank, true);
        assert.equal(c.raster.position().line, 480, 'at its first line');
        assert.ok(c.raster.untilBlank('begin') > period - 1,
            'already at the edge, the edge named is the next frame\'s');

        c.advance(c.raster.untilBlank('end'));
        assert.deepEqual(c.raster.position(), { line: 0, inBlank: false });
        assert.ok(Math.abs(c.now() % period) < 0.01);
    });
