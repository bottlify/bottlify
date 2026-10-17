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
 * millisecond (the kernel's `placement.js`).
 */
export const Word = Object.freeze({ STATE: 0, VALUE: 1, FLAGS: 2, LENGTH: 3, EPOCH: 4,
    RETIRED: 5 });

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
 * Waits until `word[index]` is no longer `value`: a look for `spinMs` (`SPIN_MS`),
 * then a sleep for at most `ms`.
 *
 * @param {Int32Array} word @param {number} index @param {number} value @param {number} [ms]
 * @param {number} [spinMs]
 */
export function waitWhile(word, index, value, ms = Infinity, spinMs = SPIN_MS){
    const began = performance.now();
    while (Atomics.load(word, index) === value)
    {
        if (performance.now() - began >= spinMs)
        {
            Atomics.wait(word, index, value, ms);
            return;
        }
    }
}

/** Bytes before the text, and the text's room. */
const TEXT_AT = 64;
const TEXT_BYTES = 4096;
export const CHANNEL_BYTES = TEXT_AT + TEXT_BYTES;

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
    return {
        words,
        /**
         * Ends this side's turn: the state stored, then the other side woken.
         * @param {number} state @param {number} [value] @param {number} [flags]
         */
        say(state, value = 0, flags = 0){
            Atomics.store(words, Word.VALUE, value | 0);
            Atomics.store(words, Word.FLAGS, flags | 0);
            Atomics.store(words, Word.STATE, state);
            Atomics.notify(words, Word.STATE);
            if (bell !== null)
            {
                Atomics.add(bell, 0, 1);
                Atomics.notify(bell, 0);
            }
        },
        /**
         * Waits until the state is no longer `state`, and answers the new one.
         * @param {number} state
         */
        await(state){
            while (Atomics.load(words, Word.STATE) === state)
            {
                waitWhile(words, Word.STATE, state, Infinity, spinMs);
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
