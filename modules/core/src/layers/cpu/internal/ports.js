/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The I/O ports a user-mode program can reach, as Windows 9x left them to it:
 * the timer VxD virtualises the programmable interval timer (ports 0x40-0x43),
 * and programs of that time latch its counter for a seed or a fine clock. The
 * counter runs at the timer's own 1.193182 MHz on the guest's clock, counting
 * down from the 65536 reload Windows programs it with. Every other port reads
 * as a floating bus (all ones) and swallows its writes -- no device answers
 * there -- and each is counted, so a report says which ports a program used.
 */

const PIT_HZ = 1193182;
const PIT_COUNTER0 = 0x40;
const PIT_COMMAND = 0x43;

/**
 * @param {() => number} nowMs  the guest's clock, milliseconds
 */
export function createPorts(nowMs){
    // Channel 0 only: the command's latch, and the low/high byte flip-flop of
    // the lobyte-hibyte access mode every reader of the counter uses.
    /** @type {number | null} */
    let latched = null;
    let highNext = false;
    /** @type {Map<string, number>} */
    const touched = new Map();
    /** @param {string} what */
    const count = what=>touched.set(what, (touched.get(what) ?? 0) + 1);
    const counter = ()=>{
        const ticks = Math.floor(nowMs() * (PIT_HZ / 1000));
        return 0xffff - (ticks & 0xffff);
    };

    return {
        /** @param {number} port @param {number} size @returns {number} */
        read(port, size){
            count(`in ${port.toString(16)}`);
            if (port !== PIT_COUNTER0 || size !== 1)
            {
                return size === 4 ? 0xffffffff : size === 2 ? 0xffff : 0xff;
            }
            const value = latched ?? counter();
            const byte = highNext ? value >>> 8 & 0xff : value & 0xff;
            if (highNext)
            {
                latched = null;
            }
            highNext = !highNext;
            return byte;
        },
        /** @param {number} port @param {number} size @param {number} value */
        write(port, size, value){
            count(`out ${port.toString(16)}`);
            // A latch command (access bits 00) for channel 0 freezes the count
            // until both its bytes are read; any other command restarts the
            // byte sequence at the low byte.
            if (port === PIT_COMMAND && size === 1 && (value & 0xc0) === 0)
            {
                if ((value & 0x30) === 0)
                {
                    latched ??= counter();
                }
                highNext = false;
            }
        },
        /** Each port a program read or wrote, with how often: `in 40 x2`. */
        diagnostics: ()=>[...touched].map(([what, times])=>`${what} x${times}`),
    };
}
