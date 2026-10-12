/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A thread's calls that go round in a loop, kept out of the journal after the
 * second time round.
 *
 * A program waiting on something -- a flag another thread sets, a packet, a
 * window becoming active -- polls: PeekMessage, GetKeyState, Sleep(0), the
 * same few calls with the same answers, hundreds of thousands of times a
 * second. Written one line each, they fill the journal's ring in a fraction
 * of a second, and the moment the program started waiting -- the one thing a
 * report of a hang is read for -- is gone before anyone asks. Kept to the
 * loop once and a count, the ring holds minutes.
 *
 * A loop is a period of at most `MAX_PERIOD` calls that the thread's last
 * `WINDOW` calls (or two periods, if longer) repeat exactly, name, arguments
 * and answer. Its later turns are counted rather than written, and the count
 * is said when the thread does something else, and every `SAY_EVERY` calls
 * while it does not, so a report taken during the loop shows it.
 */

/** The longest loop recognised, in calls. */
export const MAX_PERIOD = 8;

/** How many calls must already repeat before the next is counted rather than written. */
export const WINDOW = 8;

/** How many counted calls pass between two lines saying the loop still runs. */
export const SAY_EVERY = 1 << 16;

const KEPT = 2 * MAX_PERIOD;

/**
 * @typedef {Object} Repeated
 * @property {number} period  the calls the loop is made of
 * @property {number} calls   the calls counted rather than written
 * @property {boolean} ended  whether the loop ended (or still runs)
 */

/**
 * @returns {{ note: (thread: string, key: string | number) =>
 *     { write: boolean, said: Repeated | null } }}
 */
export function createCallRepeats(){
    /** @type {Map<string, { keys: (string | number)[], period: number, calls: number }>} */
    const threads = new Map();
    return {
        /**
         * A call a thread made: whether to write it, and a loop to say
         * first -- one that it ended, or one that still runs.
         *
         * @param {string} thread
         * @param {string | number} key  what makes two calls the same: name, arguments, answer
         */
        note(thread, key){
            let state = threads.get(thread);
            if (state === undefined)
            {
                state = { keys: [], period: 0, calls: 0 };
                threads.set(thread, state);
            }
            const { keys } = state;
            /** @type {Repeated | null} */
            let said = null;
            if (state.period > 0)
            {
                if (keys[keys.length - state.period] === key)
                {
                    keep(keys, key);
                    state.calls++;
                    if (state.calls % SAY_EVERY === 0)
                    {
                        said = { period: state.period, calls: state.calls, ended: false };
                    }
                    return { write: false, said };
                }
                if (state.calls > 0)
                {
                    said = { period: state.period, calls: state.calls, ended: true };
                }
                state.period = 0;
                state.calls = 0;
            }
            keep(keys, key);
            const period = periodOf(keys);
            // The call that completes the window is written: the loop is
            // shown whole, twice, before its turns are counted.
            if (period > 0 && said === null)
            {
                state.period = period;
            }
            return { write: true, said };
        },
    };
}

/** @param {(string | number)[]} keys @param {string | number} key */
function keep(keys, key){
    keys.push(key);
    if (keys.length > KEPT)
    {
        keys.shift();
    }
}

/**
 * The shortest period the newest calls repeat over the window, or 0.
 *
 * @param {(string | number)[]} keys
 */
function periodOf(keys){
    const count = keys.length;
    for (let period = 1; period <= MAX_PERIOD; period++)
    {
        const window = Math.max(WINDOW, 2 * period);
        if (count < window)
        {
            continue;
        }
        let repeats = true;
        for (let at = count - window + period; at < count && repeats; at++)
        {
            repeats = keys[at] === keys[at - period];
        }
        if (repeats)
        {
            return period;
        }
    }
    return 0;
}
