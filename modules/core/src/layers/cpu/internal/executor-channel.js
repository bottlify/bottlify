/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What a process's thread and one of its executors in a worker of its own
 * share beside their link (Cellar's `link.js`, its word calls): the process
 * asks for a slice (a word call of its budget, answered with what the slice
 * retired and how it ended), and the executor asks back for every trap it
 * reaches (a word call of the value written to the port, answered with
 * `Said` flags) and every fault it takes (a value call, the record). The
 * handlers are the process's, Win32 and the kernel, run there over the
 * executor's registers.
 */

/**
 * The words of an executor's state, as indices into its `Int32Array`. `EPOCH`
 * counts the executor's runs of guest code, odd while one is on: a slice makes
 * it odd and its end even, and so do a trap's wait for its answer and the
 * answer - no test of a page's flags that stores rely on spans a call into the
 * host. The process's write watch reads it (`write-clock.js`). `RETIRED` is
 * what the slice out has retired so far, zeroed by the process as it starts
 * one: a slice runs on for a quarter of a second while nothing else wants the
 * executor, and the process's count of what it retired includes it. `PLAYS` is
 * the processor the executor plays, one more than its number, while it is not
 * its own (the kernel trades them), zero otherwise: the one `cpuid` names from
 * the next slice, set only between slices. `EMITTED` is the milliseconds its
 * translator emitted on its own thread, as it last wrote them: what a pool
 * lending it a worker reads as a want.
 */
export const Word = Object.freeze({ EPOCH: 0, RETIRED: 1, PLAYS: 2, EMITTED: 3 });
export const STATE_BYTES = 16;

/** The bits of a reply's flags or a slice's end: the executor halted, its turn is to end, the
 * process's handler took the fault, a fault no handler took ended the slice. */
export const Said = Object.freeze({ HALTED: 1, STOPPED: 2, CLAIMED: 4, FAULTED: 8 });

/** Each way's ring of an executor's link: a fault's record, many times over. */
export const LINK_BYTES = 64 * 1024;

/**
 * How long a side looks at its doorbell before it sleeps on it, in ms: the
 * other side mostly answers within microseconds, and a sleeping thread's wake
 * costs tens of them on a loaded machine - two a slice, two a host call.
 */
export const SPIN_MS = 0.05;

/**
 * How long a side looks while the host has a core to spare (`lookFor`): an
 * answer slept through comes a wake later, some 100 us on a loaded machine,
 * and costs the answering side a notify. A render thread's frame on a stand,
 * two executors on four cores, took 5.25 ms looking 1 ms against 5.49 looking
 * 0.05; three executors on the same cores, 7.24 against 6.59: with no core to
 * spare the looking side holds one the process's own executor wants.
 */
export const SPARE_SPIN_MS = 1;

/**
 * The threads beside the executors' slices that keep a core of the host busy:
 * the process's own executor, which answers them, and the graphics worker.
 */
export const BUSY_BESIDE = 2;

/**
 * The bounds, in microseconds, an executor counts its waits for the process's
 * answers by (`answerWaits` in its account): how many a look of each length
 * before the sleep would have caught.
 */
export const ANSWER_BOUNDS_US = Object.freeze([10, 25, 50, 100, 200, 500, 1000, 5000]);

/**
 * The words of the process's bell, as indices into its `Int32Array`: a Cellar
 * doorbell (the count of turns rung and the waits asleep on it), whether an
 * executor may go on with its thread past a slice (`goOn`, `hold` in
 * `executor.js`), and the executors with a slice out (`lookFor`).
 */
export const Bell = Object.freeze({ RUNG: 0, SLEEPING: 1, GO_ON: 2, RUNNING: 3 });
export const BELL_BYTES = 16;

/**
 * How long a wait looks before it sleeps, asked as each wait begins:
 * `SPARE_SPIN_MS` while the slices out and the threads beside them
 * (`BUSY_BESIDE`) leave one of the host's `processors` free, and `SPIN_MS`
 * when they do not - or when the host does not say how many it has.
 *
 * @param {Int32Array | null} bell  the process's bell (`Bell.RUNNING`)
 * @param {number | undefined} processors  the host's (`navigator.hardwareConcurrency`)
 * @returns {() => number}
 */
export function lookFor(bell, processors){
    if (bell === null || processors === undefined || !(processors > 0))
    {
        return ()=>SPIN_MS;
    }
    return ()=>(Atomics.load(bell, Bell.RUNNING) + BUSY_BESIDE < processors
        ? SPARE_SPIN_MS : SPIN_MS);
}
