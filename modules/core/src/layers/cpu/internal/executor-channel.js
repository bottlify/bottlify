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

/**
 * Where each word lies, as indices into the channel's `Int32Array`. `EPOCH`
 * counts the executor's runs of guest code, odd while one is on: a slice
 * makes it odd and its end even, and so do a trap's wait for its answer and
 * the answer -- no test of a page's flags that stores rely on spans a call into
 * the host. The process's write watch reads it (`write-clock.js`). `RETIRED`
 * is what the slice out has retired so far, zeroed by the process as it starts
 * one: a slice runs on for a quarter of a second while nothing else wants the
 * executor, and the scheduler measures what the program gets done by the
 * millisecond (the kernel's `placement.js`). `WAITED` is the microseconds the
 * executor has waited for the process's answers since it opened, never reset:
 * what a thread placed there loses to calls into the host, which the scheduler
 * weighs against the thread's own work when it places it. `PLAYS` is the
 * processor the executor plays, one more than its number, while it is not its
 * own (the kernel trades them), zero otherwise: the one `cpuid` names from the
 * next slice, set only between slices. `SLEEPING` counts the waits asleep on
 * `STATE` (`sleep`): a side ending its turn wakes the other only when it sleeps.
 */
export const Word = Object.freeze({ STATE: 0, VALUE: 1, FLAGS: 2, LENGTH: 3, EPOCH: 4,
    RETIRED: 5, WAITED: 6, PLAYS: 7, SLEEPING: 8 });

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
 * of them on a loaded machine -- two a slice, two a host call.
 */
export const SPIN_MS = 0.05;

/**
 * The bounds, in microseconds, an executor counts its waits for the process's
 * answers by (`answerWaits` in its account): how many a look of each length
 * before the sleep would have caught.
 */
export const ANSWER_BOUNDS_US = Object.freeze([10, 25, 50, 100, 200, 500, 1000, 5000]);

/**
 * Waits until `word[index]` is no longer `value`: a look for `spinMs` (`SPIN_MS`),
 * then a sleep for at most `ms`, counted in `word[sleepers]` when that is given.
 *
 * @param {Int32Array} word @param {number} index @param {number} value @param {number} [ms]
 * @param {number} [spinMs] @param {number} [sleepers]
 * @returns {boolean} whether it slept
 */
export function waitWhile(word, index, value, ms = Infinity, spinMs = SPIN_MS, sleepers = -1){
    const began = performance.now();
    while (Atomics.load(word, index) === value)
    {
        if (performance.now() - began >= spinMs)
        {
            sleep(word, index, value, ms, sleepers);
            return true;
        }
    }
    return false;
}

/**
 * Sleeps on `word[index]` while it is `value`, at most `ms`, counted in
 * `word[sleepers]` (not, when negative) for `wake`. The count is raised before
 * the wait looks at the word, and both are sequentially consistent: a side
 * that stores the word and then finds no sleeper knows that a wait yet to
 * come sees what it stored, and one that finds a sleeper notifies under the
 * lock the wait takes, so no wake is lost between the look and the sleep.
 *
 * @param {Int32Array} word @param {number} index @param {number} value @param {number} ms
 * @param {number} sleepers
 */
export function sleep(word, index, value, ms, sleepers){
    if (sleepers < 0)
    {
        Atomics.wait(word, index, value, ms);
        return;
    }
    Atomics.add(word, sleepers, 1);
    Atomics.wait(word, index, value, ms);
    Atomics.sub(word, sleepers, 1);
}

/**
 * The same sleep without blocking (`Atomics.waitAsync`): counted until it ends,
 * for a side whose other wakes come through its event loop.
 *
 * @param {Int32Array} word @param {number} index @param {number} value @param {number} ms
 * @param {number} sleepers
 * @returns {Promise<void>}
 */
export function sleepAsync(word, index, value, ms, sleepers){
    Atomics.add(word, sleepers, 1);
    const waiting = /** @type {any} */ (Atomics).waitAsync(word, index, value, ms);
    if (!waiting.async)
    {
        Atomics.sub(word, sleepers, 1);
        return Promise.resolve();
    }
    return waiting.value.then(()=>{
        Atomics.sub(word, sleepers, 1);
    });
}

/**
 * Wakes what sleeps on `word[index]`, which the caller has just stored, when
 * something does (`word[sleepers]`, `sleep`): a notify takes a lock every
 * thread of the page shares -- the process's own executor answers every other
 * executor's host calls, and its notify after each answer found the asker
 * mostly still looking.
 *
 * @param {Int32Array} word @param {number} index @param {number} sleepers
 * @returns {boolean} whether it notified
 */
export function wake(word, index, sleepers){
    if (Atomics.load(word, sleepers) === 0)
    {
        return false;
    }
    Atomics.notify(word, index);
    return true;
}

/** Bytes before the text, and the text's room. */
const TEXT_AT = 64;
const TEXT_BYTES = 4096;
export const CHANNEL_BYTES = TEXT_AT + TEXT_BYTES;

/**
 * The words of a bell, as indices into its `Int32Array`: the count of turns
 * rung, whether an executor may go on with its thread past a slice (`goOn`,
 * `hold` in `executor.js`), and the waits asleep on the count (`sleep`).
 */
export const Bell = Object.freeze({ RUNG: 0, GO_ON: 1, SLEEPING: 2 });
export const BELL_BYTES = 12;

/**
 * The views of a channel's memory.
 *
 * @param {SharedArrayBuffer} buffer
 * @param {Int32Array | null} [bell]  a word the process waits on for all its executors at
 *     once, rung after every turn the executor's side ends
 * @param {number} [spinMs]  how long a side looks before it sleeps (`SPIN_MS`)
 */
export function channelOf(buffer, bell = null, spinMs = SPIN_MS){
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
            while (Atomics.load(words, Word.STATE) === state)
            {
                if (waitWhile(words, Word.STATE, state, Infinity, spinMs, Word.SLEEPING))
                {
                    counts.slept++;
                }
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
