/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Views of one page-file section that see each other's writes, across the
 * processes of a run on the engine's thread and within one of them.
 *
 * Every process here has guest memory of its own, so a view is a copy of the
 * section, and two views of one section are two copies. Windows gives them
 * one set of pages: what a process writes into its view, the other reads in
 * its own at once. Programs that talk through shared memory (a client and its
 * browser host passing a ring of messages, a lock word, a state flag) see
 * nothing of each other otherwise.
 *
 * The processes on the engine's thread take turns, so the copies are made to
 * agree at the edges of a turn. As a turn begins, every other process's view
 * of a shared section is compared with what it held when last looked at, and
 * the bytes that changed go to the section's own copy -- read out of the
 * other process's memory, which is current whatever that process is doing,
 * since a turn of one may begin while another waits inside its own (a parent
 * waiting in CreateProcess while its child runs). Then this process's views
 * whose section moved on are brought up to date. As a turn ends, its own
 * writes go to the section the same way. A reader in one process sees a write
 * of another from its next turn on. Two views of a section in one process
 * agree from one turn to the next, not within one.
 *
 * Only a section with two views or more costs anything: a turn compares the
 * views of those alone.
 */

/**
 * One process's window onto a section.
 *
 * @typedef {Object} SharedView
 * @property {number} process  Whose turns it agrees at.
 * @property {(address: number, length: number) => Uint8Array} read
 * @property {(address: number, bytes: Uint8Array) => void} write
 * @property {number} address  Where the view is in that process.
 * @property {number} offset   Where it starts in the section.
 * @property {number} length
 * @property {Uint8Array} [seen]     Its bytes as the section had them last.
 * @property {number} [version]      The section's version they were.
 * @property {any} [section]
 */

/**
 * @typedef {Object} SharedSection
 * @property {Uint8Array} bytes   The section's own copy.
 * @property {number} version     Moved on by every turn that changed it.
 * @property {Set<SharedView>} views
 */

export function createSharedViews(){
    /** Sections by the object a mapping is. @type {WeakMap<object, SharedSection>} */
    const sections = new WeakMap();
    /** Those with two views or more: the only ones a turn looks at. @type {Set<SharedSection>} */
    const active = new Set();
    const counts = { flushed: 0, refreshed: 0, compared: 0 };

    /**
     * Copies what a view's process changed into its section.
     *
     * @param {SharedSection} section @param {SharedView} view
     */
    const flush = (section, view)=>{
        // Whether it had the section whole before its own writes went in: a
        // sibling view flushed just before may have moved the section on.
        const current = view.version === section.version;
        // Copied into buffers of their own: a memory's read may be a view
        // into a larger or shared buffer, which word access cannot take.
        const now = new Uint8Array(view.length);
        now.set(view.read(view.address, view.length).subarray(0, view.length));
        const seen = new Uint8Array(view.length);
        seen.set(/** @type {Uint8Array} */ (view.seen));
        counts.compared += view.length;
        let changed = false;
        // Word by word while the words agree, which is nearly all of them.
        const words = view.length >>> 2;
        const nowWords = new Uint32Array(now.buffer, now.byteOffset, words);
        const seenWords = new Uint32Array(seen.buffer, seen.byteOffset, words);
        for (let word = 0; word < words; word++)
        {
            if (nowWords[word] !== seenWords[word])
            {
                for (let at = word * 4; at < word * 4 + 4; at++)
                {
                    if (now[at] !== seen[at])
                    {
                        section.bytes[view.offset + at] = now[at];
                    }
                }
                changed = true;
            }
        }
        for (let at = words * 4; at < view.length; at++)
        {
            if (now[at] !== seen[at])
            {
                section.bytes[view.offset + at] = now[at];
                changed = true;
            }
        }
        if (changed)
        {
            section.version++;
            counts.flushed++;
        }
        view.seen = now;
        if (current)
        {
            view.version = section.version;
        }
    };

    /**
     * Brings a view up to its section.
     *
     * @param {SharedSection} section @param {SharedView} view
     */
    const refresh = (section, view)=>{
        const bytes = section.bytes.slice(view.offset, view.offset + view.length);
        view.write(view.address, bytes);
        view.seen = bytes;
        view.version = section.version;
        counts.refreshed++;
    };

    /**
     * A section down to one view agrees with nothing any more; what the
     * others wrote last is brought to the one left first.
     *
     * @param {SharedSection} section
     */
    const settle = section=>{
        if (section.views.size >= 2)
        {
            return;
        }
        for (const view of section.views)
        {
            // Its own writes since it last agreed go in first, not under.
            flush(section, view);
            if (view.version !== section.version)
            {
                refresh(section, view);
            }
        }
        active.delete(section);
    };

    return {
        /**
         * A view just mapped: given what the section holds, and agreeing with
         * the others from here on.
         *
         * @param {object} mapping  The section's object, the same in every
         *        process that names or inherits it.
         * @param {number} size  The section's size.
         * @param {SharedView} view
         */
        attach(mapping, size, view){
            let section = sections.get(mapping);
            if (!section)
            {
                section = { bytes: new Uint8Array(size), version: 0, views: new Set() };
                sections.set(mapping, section);
            }
            view.section = section;
            for (const other of section.views)
            {
                flush(section, other);
            }
            // A section nobody has written into yet is the zeroes the view
            // already has.
            if (section.version > 0)
            {
                refresh(section, view);
            }
            else
            {
                view.seen = section.bytes.slice(view.offset, view.offset + view.length);
                view.version = 0;
            }
            section.views.add(view);
            if (section.views.size > 1)
            {
                active.add(section);
            }
        },

        /**
         * A view unmapped: what it wrote reaches the section first.
         *
         * @param {SharedView} view
         */
        detach(view){
            const section = /** @type {SharedSection | undefined} */ (view.section);
            if (!section || !section.views.has(view))
            {
                return;
            }
            if (active.has(section))
            {
                flush(section, view);
            }
            section.views.delete(view);
            settle(section);
        },

        /** A process's turn begins. @param {number} process */
        enter(process){
            for (const section of active)
            {
                for (const view of section.views)
                {
                    if (view.process !== process)
                    {
                        flush(section, view);
                    }
                }
                for (const view of section.views)
                {
                    if (view.process === process && view.version !== section.version)
                    {
                        refresh(section, view);
                    }
                }
            }
        },

        /** A process's turn ends. @param {number} process */
        leave(process){
            for (const section of active)
            {
                for (const view of section.views)
                {
                    if (view.process === process)
                    {
                        flush(section, view);
                    }
                }
            }
        },

        /**
         * A process ended: its views go, after its last turn has flushed them
         * -- its memory is let go or reused, and read later it would be taken
         * for writes.
         *
         * @param {number} process
         */
        forget(process){
            for (const section of [...active])
            {
                for (const view of [...section.views])
                {
                    if (view.process === process)
                    {
                        section.views.delete(view);
                    }
                }
                settle(section);
            }
        },

        /** How much agreeing there was, for the diagnostics. */
        diagnostics: ()=>({ sections: active.size, ...counts }),
    };
}
