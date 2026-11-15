/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The machine's time taken out of a counted run: imported first, before the
 * program under the count, it puts `performance.now`, `Date.now` and the
 * timers on a clock that moves by what the program does - a fixed step at
 * every read and at every turn of the event loop - so a timer fires in the
 * order of its due time, never by how long the host took to get there.
 *
 * An app's loop cuts its turns by time and waits by time (`pagePacing`); run
 * on the machine's clock, the moment a translation was published, a call's
 * samples were read or a region was formed again moved from run to run, and
 * two counted runs of one tree differed by a tenth (the PE benchmark's
 * `spread`, 3.906 and 4.313 machine instructions a guest one). On this clock
 * two runs agree to the fourth decimal.
 */

/** What a read of the clock moves it by, in milliseconds. */
const STEP_MS = 0.001;
/** What a turn of the event loop moves it by. */
const TURN_MS = 0.05;

let now = 1_700_000_000_000;
const origin = now;
/** @type {{ due: number, id: number, run: () => void, every: number }[]} */
const timers = [];
let ids = 0;
let armed = false;
const immediate = globalThis.setImmediate;

const turn = ()=>{
    armed = false;
    now += TURN_MS;
    timers.sort((a, b)=>a.due - b.due || a.id - b.id);
    while (timers.length > 0 && timers[0].due <= now)
    {
        const timer = /** @type {typeof timers[0]} */ (timers.shift());
        if (timer.every > 0)
        {
            timers.push({ ...timer, due: now + timer.every });
        }
        timer.run();
    }
    arm();
};

/** A turn asked for while a timer waits: the clock moves only while one does. */
const arm = ()=>{
    if (!armed && timers.length > 0)
    {
        armed = true;
        immediate(turn);
    }
};

/**
 * @param {(...args: any[]) => void} fn @param {number} ms @param {any[]} args
 * @param {number} [every]  an interval's period, 0 for a timeout
 */
const add = (fn, ms, args, every = 0)=>{
    const id = ++ids;
    timers.push({ due: now + Math.max(0, Number(ms) || 0), id, run: ()=>fn(...args), every });
    arm();
    return id;
};

/** @param {unknown} id */
const drop = id=>{
    const at = timers.findIndex(timer=>timer.id === id);
    if (at >= 0)
    {
        timers.splice(at, 1);
    }
};

performance.now = ()=>(now += STEP_MS) - origin;
Date.now = ()=>Math.floor(now += STEP_MS);
Object.assign(globalThis, {
    setTimeout: (/** @type {(...args: any[]) => void} */ fn, /** @type {number} */ ms,
        /** @type {any[]} */ ...args)=>add(fn, ms, args),
    setInterval: (/** @type {(...args: any[]) => void} */ fn, /** @type {number} */ ms,
        /** @type {any[]} */ ...args)=>add(fn, ms, args, Math.max(1, Number(ms) || 1)),
    clearTimeout: drop,
    clearInterval: drop,
});
