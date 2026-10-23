/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ABSENT_PROFILER, createProfiler } from './profiler.js';

test('the profiler of a build without diagnostics answers every method the real one has', ()=>{
    // The backend calls the same methods whichever it was given, at every
    // draw: a method the stand-in lacks threw at each one, and a build
    // without diagnostics drew nothing while every test, run with them, passed.
    const real = createProfiler({ now: ()=>0 });
    const missing = Object.keys(real).filter(key=>typeof real[key] === 'function'
        && typeof (/** @type {any} */ (ABSENT_PROFILER))[key] !== 'function');
    assert.deepEqual(missing, []);
});
