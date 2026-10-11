/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A host call that calls the guest back step by step, written once and run
 * two ways.
 *
 * A handler that sets an effect's states through the program's own state
 * manager makes a guest call per state, and as a promise each of them parks
 * the thread, ends the slice, and comes back a turn of the run loop later:
 * a renderer's frame of a few hundred passes was thousands of turns, and the
 * loop's own work between them was most of the frame. Written as steps -- a
 * generator that yields `{ entry, args }` for each guest call and is handed
 * back what the call returned -- the same handler is run by the bridge in
 * the slice it was called in: the thread goes from the host call into the
 * guest routine and back with no park, no turn and no microtask between.
 *
 * `stepsThroughPromises` runs the same steps the other way, through
 * `callGuest`: what a host that cannot drive them does, and the second path
 * of the gate that holds the two to the same answers.
 */

/** Marks a host call's answer that is the steps themselves, for the bridge to run. */
export const DRIVEN = Symbol('driven');

/**
 * One guest call a step asks for.
 *
 * @typedef {{ entry: number, args?: number[], thread?: any }} GuestCall
 */

/**
 * Steps: a generator that yields a guest call, is handed back what it returned
 * (EAX, signed), and returns the host call's answer.
 *
 * @typedef {Generator<GuestCall, any, number>} Steps
 */

/**
 * The token a handler returns for the bridge to run its steps; `onDone` is
 * told the answer, for a trace that records it when it comes.
 *
 * @typedef {{ [DRIVEN]: true, steps: Steps, first: GuestCall | null,
 *     onDone: ((value: any) => void) | null }} Driven
 */

/**
 * @param {Steps} steps
 * @returns {Driven}
 */
export const driven = steps=>({ [DRIVEN]: true, steps, first: null, onDone: null });

/**
 * @param {any} value
 * @returns {value is Driven}
 */
export const isDriven = value=>typeof value === 'object' && value !== null
    && value[DRIVEN] === true;

/**
 * Runs steps through promises: each guest call through `callGuest`, awaited.
 *
 * @param {Steps} steps
 * @param {(call: GuestCall) => Promise<number>} callGuest
 * @returns {Promise<any>}
 */
export async function stepsThroughPromises(steps, callGuest){
    // Begun once the handler has returned and its caller is parked, as a
    // handler's promise always began: a step's guest call names its thread.
    await null;
    /** @type {number | undefined} */
    let returned;
    for (;;)
    {
        const next = steps.next(/** @type {number} */ (returned));
        if (next.done)
        {
            return next.value;
        }
        returned = await callGuest(next.value);
    }
}
