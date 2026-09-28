/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plain } from './serve.js';

test('a diagnostics table holding an object that refers back to itself is posted without it', ()=>{
    /** @type {any} */
    const texture = { width: 64, surfaces: [] };
    texture.surfaces.push({ level: 0, parent: texture });
    const shared = { n: 1 };
    const table = { frame: [{ texture }], again: shared, twice: shared, call: ()=>0 };

    assert.deepEqual(plain(table), {
        frame: [{ texture: { width: 64, surfaces: [{ level: 0 }] } }],
        again: { n: 1 },
        twice: { n: 1 },
    }, 'the cycle is cut, an object met twice side by side is copied both times');
});
