/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What the speaker has played, read straight from the sound table a page
 * already holds (`app.audio.memory().table`, the one its worklet mixes): the
 * device's rate, the blocks it has asked for, and those that found too little
 * sound - the gaps a person hears as a crackle. Nothing is asked of the
 * engine, so a meter reads it on every animation frame, as it reads the
 * frame clock.
 */

import { BLOCKS, GLOBAL_HEADER_INT32, OUTPUT_RATE, STARVED_BLOCKS, STARVED_FRAMES }
    from '../layers/audio/output/mix.js';

/**
 * @param {Uint8Array} table  the sound output's table, a view of the memory the run holds
 * @returns {{ rate: number, blocks: number, starvedBlocks: number, starvedFrames: number }}
 *     the device's rate in hertz, and since the table was made: output blocks asked
 *     for, those not filled, and the frames they lacked
 */
export function readSoundTable(table){
    const global = new Int32Array(table.buffer, table.byteOffset, GLOBAL_HEADER_INT32);
    return {
        rate: Atomics.load(global, OUTPUT_RATE),
        blocks: Atomics.load(global, BLOCKS) >>> 0,
        starvedBlocks: Atomics.load(global, STARVED_BLOCKS) >>> 0,
        starvedFrames: Atomics.load(global, STARVED_FRAMES) >>> 0,
    };
}
