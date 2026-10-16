/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * For a test that runs guest code on a cork host of its own and then reads what
 * the code left: the code is run to its halt, slice after slice. One slice is
 * not enough to be sure of: a slice that interprets ends once it has taken its
 * time (`sliceMs`, 8 ms), and the first run of a routine, before it is
 * translated, took longer than that on a machine running a dozen test files at
 * once -- a gate read the registers of a routine stopped halfway, EBX still the
 * routine's own.
 */

/**
 * Runs `host` from where it stands until it halts.
 *
 * @param {Record<string, any>} host  a cork host (`createCorkHost`)
 * @param {number} [budget]  each slice's
 * @param {number} [slices]  the most it runs before it gives up
 * @returns {number} the instructions retired
 */
export function runToHalt(host, budget = 1_000_000, slices = 1000){
    let retired = 0;
    for (let slice = 0; slice < slices; slice++)
    {
        retired += host.runSlice(budget);
        if (host.halted())
        {
            return retired;
        }
    }
    throw new Error(`the guest did not halt in ${slices} slices of ${budget}`);
}
