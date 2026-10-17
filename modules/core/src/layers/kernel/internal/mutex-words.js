/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Mutexes the guest takes and releases by itself while nobody waits.
 *
 * A mutex a program takes and gives back round a piece of shared state, with
 * no other thread wanting it at that moment, crossed into the host twice each
 * time: Call of Duty 4's main thread took and released one some 12 800 times
 * a second, a twentieth of its time spent crossing. Here every mutex of this
 * process has a word in guest memory, which is the mutex while the guest
 * holds it:
 *
 *   bits 8..31  the owner's thread id (what FS:[0x24] holds), 0 when free
 *   bit 7       HOST: the host keeps the mutex now; the guest leaves it alone
 *   bits 0..6   how many times the owner has taken it
 *
 * The guest's WaitForSingleObject takes a free one, or one it owns again, with
 * `lock cmpxchg`; its ReleaseMutex gives one back the same way; everything
 * else -- a mutex another thread holds, one the host keeps, a lost race -- is
 * the host's (`threading.js`). The host, as soon as it touches a mutex,
 * takes the word for itself: it sets HOST with a compare-exchange, so a guest
 * mid-way through its own fails its exchange and crosses, and reads the owner
 * and count out of the word into the object every wait and release already
 * works on (`owner`, `recursion`). It hands the word back once nobody waits
 * and the mutex was not abandoned: an abandoned mutex has to tell its next
 * owner so, which only the host does.
 *
 * A mutex another process shares (a stand-in, `remote`) has no word.
 */

export const MUTEX_WORD = Object.freeze({
    /** The host keeps the mutex: no guest exchange may change it. */
    HOST: 0x80,
    /** The owner's count of takes. */
    RECURSION: 0x7f,
    /** Where the owner's id starts. */
    OWNER_SHIFT: 8,
});

/** Thread ids the word can carry. */
const MAX_OWNER = 1 << 24;

/**
 * @typedef {Object} MutexMemory
 * @property {(address: number) => number} readU32
 * @property {(address: number, expected: number, value: number) => number} compareExchangeU32
 */

/**
 * @param {MutexMemory} memory
 * @param {(id: number) => any} threadById  a thread of this process, or null
 */
export function createMutexWords(memory, threadById){
    let base = 0;
    let slots = 0;
    let used = 0;
    /** Mutexes made before there was room for their words. @type {any[]} */
    const waiting = [];
    /** Mutexes whose word the host keeps now. @type {Set<any>} */
    const kept = new Set();

    /**
     * The host takes the word: HOST set, owner and count read into the object.
     *
     * @param {any} mutex
     */
    const take = mutex=>{
        if (mutex.hostKeeps)
        {
            return;
        }
        let was = memory.readU32(mutex.word);
        for (;;)
        {
            const seen = memory.compareExchangeU32(mutex.word, was, (was | MUTEX_WORD.HOST) >>> 0);
            if (seen === was)
            {
                break;
            }
            was = seen;
        }
        mutex.hostKeeps = true;
        kept.add(mutex);
        const id = was >>> MUTEX_WORD.OWNER_SHIFT;
        const owner = id === 0 ? null : threadById(id) ?? null;
        mutex.heldOwner = owner;
        mutex.heldRecursion = owner === null ? 0 : was & MUTEX_WORD.RECURSION;
        // Its owner gone without the host seeing it go: abandoned.
        if (id !== 0 && owner === null)
        {
            mutex.abandoned = true;
        }
    };

    /**
     * The word back to the guest, where nobody waits and nothing is owed.
     *
     * @param {any} mutex
     */
    const giveBack = mutex=>{
        if (!mutex.hostKeeps || mutex.abandoned || mutex.waiters.length > 0 || mutex.remote)
        {
            return;
        }
        const owner = mutex.heldOwner;
        const count = mutex.heldRecursion;
        if (owner !== null && (owner.id >= MAX_OWNER || owner.id <= 0 || count < 1
            || count > MUTEX_WORD.RECURSION))
        {
            return;
        }
        const word = owner === null ? 0 : ((owner.id << MUTEX_WORD.OWNER_SHIFT) | count) >>> 0;
        const was = memory.readU32(mutex.word);
        memory.compareExchangeU32(mutex.word, was, word);
        mutex.hostKeeps = false;
        kept.delete(mutex);
    };

    /**
     * Gives a mutex its word, and the object its owner and count through it.
     *
     * @param {any} mutex
     */
    const wire = mutex=>{
        if (used >= slots)
        {
            return;
        }
        const owner = mutex.owner;
        const recursion = mutex.recursion;
        mutex.word = base + used * 4;
        used++;
        mutex.hostKeeps = true;
        mutex.heldOwner = owner;
        mutex.heldRecursion = recursion;
        kept.add(mutex);
        Object.defineProperty(mutex, 'owner', {
            get(){
                take(mutex);
                return mutex.heldOwner;
            },
            set(value){
                take(mutex);
                mutex.heldOwner = value;
            },
        });
        Object.defineProperty(mutex, 'recursion', {
            get(){
                take(mutex);
                return mutex.heldRecursion;
            },
            set(value){
                take(mutex);
                mutex.heldRecursion = value;
            },
        });
        giveBack(mutex);
    };

    return {
        /**
         * Where the words go: `count` of them from `at`, which the guest
         * reads and writes; mutexes made before have theirs now.
         *
         * @param {number} at @param {number} count
         */
        attach(at, count){
            base = at >>> 0;
            slots = count;
            for (const mutex of waiting.splice(0))
            {
                wire(mutex);
            }
        },

        /** @param {any} mutex  just made, its owner and count set */
        made(mutex){
            if (mutex.remote)
            {
                return;
            }
            if (slots === 0)
            {
                waiting.push(mutex);
                return;
            }
            wire(mutex);
        },

        /** Hands back every word the host kept whose mutex nobody waits for now. */
        settle(){
            for (const mutex of [...kept])
            {
                giveBack(mutex);
            }
        },

        /** How many words are given out, and how many the host keeps now. */
        diagnostics: ()=>({ words: used, slots, hostKeeps: kept.size }),
    };
}
