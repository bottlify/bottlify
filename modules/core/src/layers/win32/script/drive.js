/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Runs an evaluator written as a generator to completion.
 *
 * A script engine here evaluates with generators so that a member access on
 * a guest object -- whose answer is a promise, because the guest has to run
 * to give it -- can suspend the whole evaluation without the evaluator being
 * an async function at every node. Everything an evaluator yields is
 * something to wait for; what it is resumed with is what that settled to, or
 * the failure is thrown into it at the yield. An evaluation that never waits
 * finishes synchronously and answers a plain value, which is what lets a
 * host object that answers at once (an installer's session) run a script
 * with no promise anywhere.
 */

/**
 * @param {unknown} value
 * @returns {value is PromiseLike<unknown>}
 */
export function isThenable(value){
    return value !== null && typeof value === 'object'
        && typeof (/** @type {any} */ (value).then) === 'function';
}

/**
 * @template T
 * @param {Generator<unknown, T, unknown>} generator
 * @param {PromiseLike<unknown>} pending
 * @returns {Promise<T>}
 */
async function resume(generator, pending){
    let waiting = pending;
    for (;;)
    {
        let failed = false;
        /** @type {unknown} */
        let settled;
        try
        {
            settled = await waiting;
        }
        catch (e){
            failed = true;
            settled = e;
        }
        // A failure is thrown in at the yield that waited for it, where the
        // script's own handlers can see it.
        let step = failed ? generator.throw(settled) : generator.next(settled);
        while (!step.done && !isThenable(step.value))
        {
            step = generator.next(step.value);
        }
        if (step.done)
        {
            return step.value;
        }
        waiting = /** @type {PromiseLike<unknown>} */ (step.value);
    }
}

/**
 * @template T
 * @param {Generator<unknown, T, unknown>} generator
 * @returns {T | Promise<T>}  A plain value when nothing was waited for.
 */
export function drive(generator){
    let step = generator.next();
    while (!step.done)
    {
        if (isThenable(step.value))
        {
            return resume(generator, step.value);
        }
        step = generator.next(step.value);
    }
    return step.value;
}
