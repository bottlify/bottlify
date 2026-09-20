/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The differential driver: one slice, two executors, one diff.
 *
 * From one machine state, the oracle (the emulator) retires a given number
 * of instructions and its state is recorded; the state is put back and the
 * subject (the translator, or in the harness's own proof the emulator again)
 * retires the same number; the two records are compared. This is how an
 * instruction is accepted and how a program is migrated: a region of
 * translated code is not done until it agrees with the oracle on every
 * register, every flag a program can read, the x87 block and every memory
 * word written.
 *
 * Both executors share one host in hybrid mode -- one register file, one
 * memory -- so the driver never copies a machine: it snapshots, runs,
 * snapshots, restores, runs, snapshots. The memory spans in the record are
 * the caller's to name; from the translator's own steps on they come from
 * the subject's undo log, and in the harness's proof they are the corpus
 * case's data area and stack.
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
 * @typedef {Object} Executor
 * @property {(instructions: number) => number} step
 * @property {() => boolean} halted
 * @property {() => void} wake
 */

/**
 * @param {Object} run
 * @param {import('./snapshot.js').SnapshotHost & Executor} run.oracle
 *     The reference executor, whose host is where the state lives.
 * @param {Executor} run.subject
 *     The executor under test, over the same host.
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
    restore(oracle, state);
    oracle.wake();
    const retiredOracle = retireExactly(oracle.step, oracle.halted, instructions);
    const oracleState = snapshot(oracle, spans);

    restore(oracle, state);
    subject.wake();
    const retiredSubject = retireExactly(subject.step, subject.halted, instructions);
    const subjectState = snapshot(oracle, spans);

    const divergences = compare(oracleState, subjectState, options);
    if (retiredOracle !== retiredSubject)
    {
        divergences.unshift({ name: 'retired', expected: retiredOracle, actual: retiredSubject });
    }
    return { divergences, retiredOracle, retiredSubject, oracleState, subjectState };
}
