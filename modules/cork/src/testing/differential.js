/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The differential driver: one slice, two executors, one diff.
 *
 * From one machine state, the oracle retires a given number of instructions
 * and its state is recorded; the subject is put in the same state and retires
 * the same number; the two records are compared. A region of translated code
 * is not done until it agrees with the oracle on every register, every flag a
 * program can read, the x87 block and every memory word written.
 *
 * Each executor is restored and read through its own host, so the two may be
 * separate machines -- the interpreter running the instruction model, and the
 * translator over a host of its own -- or one host run twice. The oracle's
 * record is taken before the subject runs, so on one host the second run
 * cannot overwrite the first's. The memory spans compared are the caller's to
 * name.
 */

import { compare, restore, snapshot } from './snapshot.js';

/**
 * Retires as close to `instructions` as an executor can, and says how many
 * it actually did. An executor that stops on block boundaries may overrun;
 * the count is reported, not hidden, and a subject that retired a different
 * number from the oracle diverges on `retired` before anything else.
 *
 * @param {(instructions: number) => number} step  runs at most that many, answers retired
 * @param {() => boolean} halted
 * @param {number} instructions
 */
export function retireExactly(step, halted, instructions){
    let retired = 0;
    while (retired < instructions && !halted())
    {
        const ran = step(instructions - retired);
        if (ran === 0)
        {
            break;
        }
        retired += ran;
    }
    return retired;
}

/**
 * An executor over the host its state is restored into and read from.
 *
 * @typedef {import('./snapshot.js').SnapshotHost & {
 *     step: (instructions: number) => number,
 *     halted: () => boolean,
 *     wake: () => void,
 * }} Executor
 */

/**
 * Puts `state` into the executor's host and runs it for `instructions`.
 *
 * @param {Executor} executor
 * @param {import('./snapshot.js').MachineState} state
 * @param {number} instructions
 */
function replay(executor, state, instructions){
    restore(executor, state);
    executor.wake();
    return retireExactly(executor.step, executor.halted, instructions);
}

/**
 * @param {Object} run
 * @param {Executor} run.oracle   The reference executor: its record is the expected one.
 * @param {Executor} run.subject  The executor under test.
 * @param {import('./snapshot.js').MachineState} run.state  The common start.
 * @param {number} run.instructions   How many both must retire.
 * @param {{ address: number, length: number }[]} run.spans  Memory compared afterwards.
 * @param {{ flagsMask?: number, statusMask?: number, x87Ulps?: number }} [run.compare]
 * @returns {{ divergences: import('./snapshot.js').Divergence[],
 *     retiredOracle: number, retiredSubject: number,
 *     oracleState: import('./snapshot.js').MachineState,
 *     subjectState: import('./snapshot.js').MachineState }}
 */
export function replaySlice({ oracle, subject, state, instructions, spans, compare: options = {} }){
    const retiredOracle = replay(oracle, state, instructions);
    const oracleState = snapshot(oracle, spans);

    const retiredSubject = replay(subject, state, instructions);
    const subjectState = snapshot(subject, spans);

    const divergences = compare(oracleState, subjectState, options);
    if (retiredOracle !== retiredSubject)
    {
        divergences.unshift({ name: 'retired', expected: retiredOracle, actual: retiredSubject });
    }
    return { divergences, retiredOracle, retiredSubject, oracleState, subjectState };
}
