/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Semaphores the guest releases and takes by itself while nobody waits.
 *
 * A job system hands a frame's work to its threads through a semaphore: a
 * release for each job, a wait for each one taken. Each was a crossing into
 * the host, from another executor a wait for the process's executor to
 * answer, while it touched nothing the host keeps but the count -- as long as
 * no thread is queued on the semaphore. Here every semaphore of this process
 * has two words in guest memory, which are the semaphore while the guest has
 * it:
 *
 *   word 0, bits 0..30  the count
 *   word 0, bit 31      HOST: the host keeps the semaphore now; the guest leaves it alone
 *   word 1              the maximum count, which never changes
 *
 * The guest's WaitForSingleObject takes a count with `lock cmpxchg`, and its
 * ReleaseSemaphore adds the counts it is given up to the maximum the same way
 * (`semaphore-guest.js`); everything else -- a wait on a semaphore at zero, a
 * release past the maximum, a semaphore the host keeps, a lost race -- is the
 * host's. The host, as soon as it touches a semaphore, takes the word for
 * itself as it does an event's (`event-words.js`): HOST set with a
 * compare-exchange, so a guest mid-way through its own fails its exchange and
 * crosses, and the count read out of the word into the object every wait and
 * release already works on (`count`). It hands the word back once nobody is
 * queued on the semaphore: a thread queued there has to be woken by the
 * release that gives it its count, which only the host does.
 *
 * While the host keeps the word it still writes the count there at every
 * change, and the guest answers a poll of a semaphore at zero by it: a
 * semaphore threads wait on is at zero.
 *
 * A semaphore another process shares (a stand-in, `remote`) has no words.
 */

/**
 * Semaphores made before kernel32 places the words, kept to be given theirs
 * then: a run that never places them (`handleWords: false`) keeps no more than this.
 */
const BEFORE_ROOM = 1024;

export const SEMAPHORE_WORD = Object.freeze({
    /** The host keeps the semaphore: no guest exchange may change it. */
    HOST: 0x80000000,
    /** The count's bits. */
    COUNT: 0x7fffffff,
    /** Bytes a semaphore's words take: the count's and the maximum's. */
    SIZE: 8,
});

/**
 * @typedef {Object} SemaphoreMemory
 * @property {(address: number) => number} readU32
 * @property {(address: number, value: number) => void} writeU32
 * @property {(address: number, expected: number, value: number) => number} compareExchangeU32
 */

/**
 * @param {SemaphoreMemory} memory
 */
export function createSemaphoreWords(memory){
    let base = 0;
    let slots = 0;
    let used = 0;
    /** Semaphores made before there was room for their words. @type {any[]} */
    const waiting = [];
    /** Semaphores whose word the host keeps now. @type {Set<any>} */
    const kept = new Set();
    /** Semaphores whose word the guest has now. @type {Set<any>} */
    const given = new Set();
    /** Set while the host keeps every word (`detach`). */
    let detached = false;
    /** Words handed back to the guest, and taken by the host again. */
    const counts = { givenBack: 0, taken: 0 };

    /**
     * The host takes the word: HOST set, the count read into the object.
     *
     * @param {any} semaphore
     */
    const take = semaphore=>{
        if (semaphore.hostKeeps)
        {
            return;
        }
        let was = memory.readU32(semaphore.word);
        for (;;)
        {
            const seen = memory.compareExchangeU32(semaphore.word, was,
                (was | SEMAPHORE_WORD.HOST) >>> 0);
            if (seen === was)
            {
                break;
            }
            was = seen;
        }
        semaphore.hostKeeps = true;
        kept.add(semaphore);
        given.delete(semaphore);
        semaphore.heldCount = was & SEMAPHORE_WORD.COUNT;
        counts.taken++;
    };

    /**
     * The count written into a word the host keeps, for the guest's poll.
     *
     * @param {any} semaphore
     */
    const publish = semaphore=>{
        memory.compareExchangeU32(semaphore.word, memory.readU32(semaphore.word),
            (SEMAPHORE_WORD.HOST | semaphore.heldCount) >>> 0);
    };

    /**
     * The word back to the guest, where nobody is queued on the semaphore.
     *
     * @param {any} semaphore
     */
    const giveBack = semaphore=>{
        if (detached || !semaphore.hostKeeps || semaphore.waiters.length > 0 || semaphore.remote)
        {
            return;
        }
        // HOST is set: no guest exchange changes the word until this one.
        memory.compareExchangeU32(semaphore.word, memory.readU32(semaphore.word),
            semaphore.heldCount);
        semaphore.hostKeeps = false;
        kept.delete(semaphore);
        given.add(semaphore);
        counts.givenBack++;
    };

    /**
     * Gives a semaphore its words, and the object its count through them.
     *
     * @param {any} semaphore
     */
    const wire = semaphore=>{
        if (used >= slots)
        {
            return;
        }
        const count = semaphore.count;
        semaphore.word = base + used * SEMAPHORE_WORD.SIZE;
        used++;
        semaphore.hostKeeps = true;
        semaphore.heldCount = count;
        kept.add(semaphore);
        memory.writeU32(semaphore.word + 4, semaphore.maximum >>> 0);
        publish(semaphore);
        Object.defineProperty(semaphore, 'count', {
            get(){
                take(semaphore);
                return semaphore.heldCount;
            },
            set(value){
                take(semaphore);
                semaphore.heldCount = value;
                publish(semaphore);
            },
        });
        giveBack(semaphore);
    };

    return {
        /**
         * Where the words go: `count` semaphores' from `at`, which the guest
         * reads and writes; semaphores made before have theirs now.
         *
         * @param {number} at @param {number} count
         */
        attach(at, count){
            base = at >>> 0;
            slots = count;
            for (const semaphore of waiting.splice(0))
            {
                wire(semaphore);
            }
        },

        /** @param {any} semaphore  just made, its count and maximum set */
        made(semaphore){
            if (semaphore.remote)
            {
                return;
            }
            if (slots === 0)
            {
                if (waiting.length < BEFORE_ROOM)
                {
                    waiting.push(semaphore);
                }
                return;
            }
            wire(semaphore);
        },

        /** Hands back every word the host kept whose semaphore nobody is queued on now. */
        settle(){
            for (const semaphore of [...kept])
            {
                giveBack(semaphore);
            }
        },

        /**
         * The host takes every word and keeps it until `reattach`: each wait
         * and release of a semaphore crosses, as where there are no words.
         */
        detach(){
            detached = true;
            for (const semaphore of [...given])
            {
                take(semaphore);
            }
        },

        /** The words back to the guest, where nobody waits. */
        reattach(){
            detached = false;
            for (const semaphore of [...kept])
            {
                giveBack(semaphore);
            }
        },

        /** How many words are given out, how many the host keeps now, and how often each way. */
        diagnostics: ()=>({ words: used, slots, hostKeeps: kept.size, detached, ...counts }),
    };
}
