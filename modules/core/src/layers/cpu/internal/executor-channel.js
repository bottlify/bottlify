/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The channel between a process's thread and one of its executors in a worker
 * of its own: a few words of shared memory and the text of a fault, each turn
 * of the conversation a state stored and notified, waited on by the other side.
 *
 * The process asks for a slice (`RUN`, the budget in `VALUE`); the executor
 * runs it, and every trap it reaches (`TRAP`, the value written to the port) and
 * every fault it takes (`FAULT`, the record as JSON in the text) waits for the
 * process's `REPLY`: the handlers are the process's, Win32 and the kernel, run
 * there over the executor's registers. The slice ends with `DONE`, the
 * instructions it retired in `VALUE`.
 */

import { waitFor, wake } from '../../../../vendor/cellar/cellar.js';

/**
 * Where each word lies, as indices into the channel's `Int32Array`. `EPOCH`
 * counts the executor's runs of guest code, odd while one is on: a slice
 * makes it odd and its end even, and so do a trap's wait for its answer and
 * the answer -- no test of a page's flags that stores rely on spans a call into
 * the host. The process's write watch reads it (`write-clock.js`). `RETIRED`
 * is what the slice out has retired so far, zeroed by the process as it starts
 * one: a slice runs on for a quarter of a second while nothing else wants the
 * executor, and the process's count of what it retired includes it. `PLAYS` is the
 * processor the executor plays, one more than its number, while it is not its
 * own (the kernel trades them), zero otherwise: the one `cpuid` names from the
 * next slice, set only between slices. `SLEEPING` counts the waits asleep on
 * `STATE` (`sleep`): a side ending its turn wakes the other only when it sleeps.
 */
export const Word = Object.freeze({ STATE: 0, VALUE: 1, FLAGS: 2, LENGTH: 3, EPOCH: 4,
    RETIRED: 5, PLAYS: 6, SLEEPING: 7 });

/** The states, each set by the side whose turn it ends. */
export const Turn = Object.freeze({
    IDLE: 0, RUN: 1, TRAP: 2, FAULT: 3, REPLY: 4, DONE: 5, CLOSE: 6,
});

/** The bits of `FLAGS`: what a reply or a slice's end tells -- the executor halted, its turn
 * is to end, the process's handler took the fault, a fault no handler took is in the text. */
export const Said = Object.freeze({ HALTED: 1, STOPPED: 2, CLAIMED: 4, FAULTED: 8 });

/**
 * How long a side looks at a word before it sleeps on it, in ms: the other side
 * mostly answers within microseconds, and a sleeping thread's wake costs tens
 * of them on a loaded machine -- two a slice, two a host call. The waits and
 * wakes are Cellar's bell (`waitFor`, `wake`): a side ending its turn notifies
 * only when the other sleeps on the word.
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

/** Bytes before the text, and the text's room. */
const TEXT_AT = 64;
const TEXT_BYTES = 4096;
export const CHANNEL_BYTES = TEXT_AT + TEXT_BYTES;

/**
 * The words of a bell, as indices into its `Int32Array`: the count of turns
 * rung, whether an executor may go on with its thread past a slice (`goOn`,
 * `hold` in `executor.js`), the waits asleep on the count (`sleep`), and the
 * executors with a slice out (`lookFor`).
 */
export const Bell = Object.freeze({ RUNG: 0, GO_ON: 1, SLEEPING: 2, RUNNING: 3 });
export const BELL_BYTES = 16;

/**
 * How long a wait looks before it sleeps, asked as each wait begins:
 * `SPARE_SPIN_MS` while the slices out and the threads beside them
 * (`BUSY_BESIDE`) leave one of the host's `processors` free, and `SPIN_MS`
 * when they do not -- or when the host does not say how many it has.
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

/**
 * The views of a channel's memory.
 *
 * @param {SharedArrayBuffer} buffer
 * @param {Int32Array | null} [bell]  a word the process waits on for all its executors at
 *     once, rung after every turn the executor's side ends
 * @param {number | (() => number)} [spin]  how long a side looks before it sleeps
 *     (`SPIN_MS`), or what says so as each wait begins (`lookFor`)
 */
export function channelOf(buffer, bell = null, spin = SPIN_MS){
    const look = typeof spin === 'function' ? spin : ()=>spin;
    const words = new Int32Array(buffer, 0, TEXT_AT / 4);
    const text = new Uint8Array(buffer, TEXT_AT, TEXT_BYTES);
    /**
     * The turns this side ended, the other side's sleeps they woke, the
     * process's sleeps on the bell they woke, and this side's own sleeps.
     */
    const counts = { said: 0, woke: 0, wokeBell: 0, slept: 0 };
    return {
        words,
        counts,
        /**
         * Ends this side's turn: the state stored, then the other side woken
         * if it sleeps on it, and the bell rung -- the process woken if it
         * sleeps on that.
         * @param {number} state @param {number} [value] @param {number} [flags]
         */
        say(state, value = 0, flags = 0){
            Atomics.store(words, Word.VALUE, value | 0);
            Atomics.store(words, Word.FLAGS, flags | 0);
            Atomics.store(words, Word.STATE, state);
            counts.said++;
            if (wake(words, Word.STATE, Word.SLEEPING))
            {
                counts.woke++;
            }
            if (bell !== null)
            {
                Atomics.add(bell, Bell.RUNG, 1);
                if (wake(bell, Bell.RUNG, Bell.SLEEPING))
                {
                    counts.wokeBell++;
                }
            }
        },
        /**
         * Waits until the state is no longer `state`, and answers the new one.
         * @param {number} state
         */
        await(state){
            if (waitFor(words, Word.STATE, state, Word.SLEEPING, Infinity, look()) === 'woke')
            {
                counts.slept++;
            }
            return Atomics.load(words, Word.STATE);
        },
        value: ()=>Atomics.load(words, Word.VALUE),
        flags: ()=>Atomics.load(words, Word.FLAGS),
        /** @param {unknown} what */
        write(what){
            const bytes = new TextEncoder().encode(JSON.stringify(what));
            if (bytes.length > TEXT_BYTES)
            {
                throw new Error(`executor: ${bytes.length} bytes of text, the channel holds`
                    + ` ${TEXT_BYTES}`);
            }
            text.set(bytes);
            Atomics.store(words, Word.LENGTH, bytes.length);
        },
        read(){
            // A shared view decodes through a copy: TextDecoder takes no shared memory.
            return JSON.parse(new TextDecoder().decode(
                text.slice(0, Atomics.load(words, Word.LENGTH))));
        },
    };
}
