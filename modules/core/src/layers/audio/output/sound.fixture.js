/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A sound output's memory as a test's mixer is handed it: held in a real
 * cache (`cache/testing.fixture.js` `roomy`), as the audio layer holds one in
 * the run's.
 */

import { TABLE_BYTES } from './mix.js';
import { roomy } from '../../cache/testing.fixture.js';

let outputs = 0;

/**
 * The outputs handed out and not let go of yet, oldest first: a test's
 * mixers live for one test, and a file of them would otherwise hold a table
 * each for as long as it runs.
 *
 * @type {(() => void)[]}
 */
const out = [];

/** Outputs a test holds at once, at most. */
const AT_ONCE = 8;

/** @returns {import('./mixer.js').SoundMemory} */
export function soundMemory(){
    while (out.length >= AT_ONCE)
    {
        out.shift()?.();
    }
    const held = roomy.api.space('sound').hold(`output/${++outputs}`, TABLE_BYTES);
    if (held === null)
    {
        throw new Error('no room for a sound output in the test\'s cache');
    }
    out.push(held.release);
    return { table: held.bytes, release: held.release };
}
