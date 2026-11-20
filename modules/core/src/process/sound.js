/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * sound - the sound output a run's processes play into: lent from the run's
 * own, a span of the parent's arena for a child's voices, given back when it
 * is gone.
 */

/**
 * @param {Record<string, any>} deps  the parts of the process it works on, by the names `app.js`
 *     gives them; asked for, since they are made or set later:
 *     `audioMemory`
 */
export function processSound(deps){
    const {
        events, options,
    } = deps;
    const {
        audioMemory,
    } = deps;


    /**
         * The sound a process started beside `parent` plays into: the run's
         * output, its slots taken as free ones come, and a span of the parent's
         * arena lent for its voices' mirrors -- the largest of four, two, one or
         * half a mebibyte the parent has free, or none, its buffers then played
         * through queues. Given back once the process is gone and has closed
         * what it held.
         *
         * @param {any} parent
         * @param {number} [largest]  the most it is lent
         */
    const lendSound = (parent, largest = 4 << 20)=>{
        let bytes = largest;
        let span = -1;
        for (; bytes >= 512 << 10 && span < 0; bytes /= 2)
        {
            span = parent.audio?.lend?.(bytes) ?? -1;
        }
        bytes *= 2;
        return {
            options: { ...options.audio, memory: audioMemory(),
                beside: { arena: span >= 0 ? [span, bytes] : null } },
            giveBack(){
                if (span >= 0)
                {
                    try
                    {
                        parent.audio.takeBack(span, bytes);
                    }
                    catch {
                        // The parent went before the process it lent to.
                    }
                    span = -1;
                }
            },
        };
    };

    /**
         * The sound of a process beside another whose output has no arena to
         * lend: the parent's output, borrowed, the child's tracks mixed with its
         * own; the child's audio closes them as it goes.
         *
         * @param {any} parent
         */
    const borrowSound = parent=>({
        options: { ...options.audio, memory: undefined, beside: undefined,
            borrow: (/** @type {{ fill?: () => void }} */ asked)=>parent.audio.borrow(asked) },
        announce(){},
        giveBack(){},
    });

    /** The tables `ownSound` has named to the page so far. */
    let soundTables = 0;
    /**
         * The sound of a process started beside another on this thread: a table
         * of its own, which the page is told of and mixes with the run's
         * (`sound-table`), and forgets once the process is gone
         * (`sound-table-closed`) -- two processes' sound as two films' playing
         * at once. On the run's table a process beside another was built as the
         * one in its place, and closed every track it found open there: the
         * parent's music went silent at its first child.
         */
    const ownSound = ()=>{
        const id = ++soundTables;
        let told = false;
        return {
            options: { ...options.audio, memory: undefined, beside: undefined },
            /** @param {any} built */
            announce(built){
                const memory = built?.audio?.memory?.();
                if (memory && 'table' in memory)
                {
                    told = true;
                    events.emit('sound-table', { id, table: memory.table });
                }
            },
            giveBack(){
                if (told)
                {
                    told = false;
                    // Its table is not handed to a speaker connected later.
                    events.withdraw('sound-table', (/** @type {any} */ event)=>event.id === id);
                    events.emit('sound-table-closed', { id });
                }
            },
        };
    };

    return {
        borrowSound, lendSound, ownSound,

    };
}
