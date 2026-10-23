/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Events the guest sets, resets and takes by itself while nobody waits.
 *
 * A thread that hands work to another sets an event and the other takes it:
 * each a crossing into the host, from another executor a wait for the
 * process's executor to answer, while the change touches nothing the host
 * keeps but the event's own state as long as no thread is queued on it. Here
 * every event of this process has a word in guest memory, which is the event
 * while the guest has it:
 *
 *   bit 0  SIGNALLED
 *   bit 1  MANUAL: a manual-reset event, which a wait leaves signalled
 *   bit 7  HOST: the host keeps the event now; the guest leaves it alone
 *
 * The guest's SetEvent and ResetEvent change the state with `lock cmpxchg`,
 * and its WaitForSingleObject takes a signalled event the same way (an
 * auto-reset one goes clear, a manual-reset one stays); everything else -- a
 * wait on an event that is not signalled, an event the host keeps, a lost
 * race -- is the host's (`wait-one.js`). The host, as soon as it touches an
 * event, takes the word for itself as it does a mutex's (`mutex-words.js`):
 * HOST set with a compare-exchange, so a guest mid-way through its own fails
 * its exchange and crosses, and the state read out of the word into the
 * object every wait and set already works on (`signalled`). It hands the word
 * back once nobody is queued on the event: a thread queued there has to be
 * woken by the set that releases it, which only the host does.
 *
 * While the host keeps the word it still writes SIGNALLED there at every
 * change, and the guest answers what changes nothing by it: SetEvent of a
 * signalled event (which has no waiter to release), ResetEvent of one that is
 * not, a poll of one that is not. An event threads wait on is not signalled,
 * and a program that resets it before each wait otherwise crossed each time.
 *
 * An event another process shares (a stand-in, `remote`) has no word.
 */

/**
 * Events made before kernel32 places the words, kept to be given theirs then:
 * a run that never places them (`handleWords: false`) keeps no more than this.
 */
const BEFORE_ROOM = 1024;

export const EVENT_WORD = Object.freeze({
    /** The event is signalled. */
    SIGNALLED: 0x1,
    /** A manual-reset event: a wait leaves it signalled. */
    MANUAL: 0x2,
    /** The host keeps the event: no guest exchange may change it. */
    HOST: 0x80,
});

/**
 * @typedef {Object} EventMemory
 * @property {(address: number) => number} readU32
 * @property {(address: number, expected: number, value: number) => number} compareExchangeU32
 */

/**
 * @param {EventMemory} memory
 */
export function createEventWords(memory){
    let base = 0;
    let slots = 0;
    let used = 0;
    /** Events made before there was room for their words. @type {any[]} */
    const waiting = [];
    /** Events whose word the host keeps now. @type {Set<any>} */
    const kept = new Set();
    /** Events whose word the guest has now. @type {Set<any>} */
    const given = new Set();
    /** Set while the host keeps every word (`detach`). */
    let detached = false;
    /** Words handed back to the guest, and taken by the host again: how often the guest had one. */
    const counts = { givenBack: 0, taken: 0 };

    /**
     * The host takes the word: HOST set, the state read into the object.
     *
     * @param {any} event
     */
    const take = event=>{
        if (event.hostKeeps)
        {
            return;
        }
        let was = memory.readU32(event.word);
        for (;;)
        {
            const seen = memory.compareExchangeU32(event.word, was, (was | EVENT_WORD.HOST) >>> 0);
            if (seen === was)
            {
                break;
            }
            was = seen;
        }
        event.hostKeeps = true;
        kept.add(event);
        given.delete(event);
        event.heldSignalled = (was & EVENT_WORD.SIGNALLED) !== 0;
        counts.taken++;
    };

    /**
     * The state written into a word the host keeps, for the guest's answers
     * that change nothing. HOST stays set: no guest exchange changes it.
     *
     * @param {any} event
     */
    const publish = event=>{
        const word = EVENT_WORD.HOST | (event.heldSignalled ? EVENT_WORD.SIGNALLED : 0)
            | (event.manualReset ? EVENT_WORD.MANUAL : 0);
        memory.compareExchangeU32(event.word, memory.readU32(event.word), word);
    };

    /**
     * The word back to the guest, where nobody is queued on the event.
     *
     * @param {any} event
     */
    const giveBack = event=>{
        if (detached || !event.hostKeeps || event.waiters.length > 0 || event.remote)
        {
            return;
        }
        const word = (event.heldSignalled ? EVENT_WORD.SIGNALLED : 0)
            | (event.manualReset ? EVENT_WORD.MANUAL : 0);
        // HOST is set: no guest exchange changes the word until this one.
        memory.compareExchangeU32(event.word, memory.readU32(event.word), word);
        event.hostKeeps = false;
        kept.delete(event);
        given.add(event);
        counts.givenBack++;
    };

    /**
     * Gives an event its word, and the object its state through it.
     *
     * @param {any} event
     */
    const wire = event=>{
        if (used >= slots)
        {
            return;
        }
        const signalled = event.signalled === true;
        event.word = base + used * 4;
        used++;
        event.hostKeeps = true;
        event.heldSignalled = signalled;
        kept.add(event);
        // The host's until given back below, which a detached table waits for.
        publish(event);
        Object.defineProperty(event, 'signalled', {
            get(){
                take(event);
                return event.heldSignalled;
            },
            set(value){
                take(event);
                event.heldSignalled = value === true;
                publish(event);
            },
        });
        giveBack(event);
    };

    return {
        /**
         * Where the words go: `count` of them from `at`, which the guest
         * reads and writes; events made before have theirs now.
         *
         * @param {number} at @param {number} count
         */
        attach(at, count){
            base = at >>> 0;
            slots = count;
            for (const event of waiting.splice(0))
            {
                wire(event);
            }
        },

        /** @param {any} event  just made, its state set */
        made(event){
            if (event.remote)
            {
                return;
            }
            if (slots === 0)
            {
                if (waiting.length < BEFORE_ROOM)
                {
                    waiting.push(event);
                }
                return;
            }
            wire(event);
        },

        /** Hands back every word the host kept whose event nobody is queued on now. */
        settle(){
            for (const event of [...kept])
            {
                giveBack(event);
            }
        },

        /**
         * The host takes every word and keeps it until `reattach`: each wait,
         * set and reset of an event crosses, as where there are no words.
         */
        detach(){
            detached = true;
            for (const event of [...given])
            {
                take(event);
            }
        },

        /** The words back to the guest, where nobody waits. */
        reattach(){
            detached = false;
            for (const event of [...kept])
            {
                giveBack(event);
            }
        },

        /** How many words are given out, how many the host keeps now, and how often each way. */
        diagnostics: ()=>({ words: used, slots, hostKeeps: kept.size, detached, ...counts }),
    };
}
