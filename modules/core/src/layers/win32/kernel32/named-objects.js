/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The one namespace every named kernel object shares.
 *
 * A mutex, an event, a semaphore, a waitable timer and a file mapping are
 * different kinds of object, but Windows keeps a single table of names across
 * all of them -- a name is not decoration, it is how one process coordinates
 * with itself across libraries, and how a second copy of a program discovers
 * the first. Kept here rather than in the kernel because naming is a Win32
 * idea: the kernel has objects and no namespace.
 *
 * A name lives exactly as long as some handle onto its object does, counted
 * here rather than asked of the handle table: the handle table is rebuilt
 * from nothing on every process replacement, while this table is handed in
 * from outside and survives one, the same way the log's sinks and the sound
 * ring do. A live count on the table's own entry answers "is this still
 * open" correctly in both cases -- within one process, where the canonical
 * single-instance idiom probes for a copy, closes it and creates one for
 * real, and across a replacement, where a parent's object was never closed
 * at all, just carried into the process that took its place.
 */

/** What a create reports when the name was already taken. */
const ERROR_ALREADY_EXISTS = 183;
const ERROR_SUCCESS = 0;

/** A live name standing for an object of a different kind. */
export const TAKEN = Symbol('taken');

/**
 * @param {Object} [options]
 * @param {Map<string, { kind: string, object: any, refs: number }>} [options.table]
 *        The backing store. Handed in so it can be created once and outlive a
 *        process replacement, and defaults to one that does not, for a caller
 *        with nothing to carry across.
 */
export function createNamedObjects({ table = new Map() } = {}){
    /**
     * The references this process holds, by name: what its end takes back,
     * since a process's exit closes every handle it held and closes none of
     * them one by one. A name it opened and an ended process kept would keep
     * that process's object - and through it the process - for the run.
     *
     * @type {Map<string, number>}
     */
    const mine = new Map();
    /** @param {string} name @param {number} by */
    const count = (name, by)=>{
        const now = (mine.get(name) ?? 0) + by;
        if (now > 0)
        {
            mine.set(name, now);
        }
        else
        {
            mine.delete(name);
        }
    };
    return {
        /**
         * The object this name already stands for, TAKEN if another kind holds
         * it, or null if the name is free.
         *
         * @param {string | null} name @param {string} kind
         */
        existing(name, kind){
            if (name === null)
            {
                return null;
            }
            const held = table.get(name);
            return !held ? null : held.kind === kind ? held.object : TAKEN;
        },

        /**
         * Records the name and reports what the create should leave behind: a
         * create that found its name already taken says so through the last
         * error, and a reuse counts the handle this create is about to open --
         * the reference that keeps the name alive until it, too, is closed.
         *
         * @param {string | null} name @param {string} kind @param {any} made
         * @param {boolean} reused
         * @param {(code: number) => void} setLastError
         */
        remember(name, kind, made, reused, setLastError){
            if (name !== null)
            {
                const held = table.get(name);
                if (reused && held)
                {
                    held.refs++;
                }
                else
                {
                    table.set(name, { kind, object: made, refs: 1 });
                }
                count(name, 1);
            }
            setLastError(reused ? ERROR_ALREADY_EXISTS : ERROR_SUCCESS);
        },

        /**
         * An Open* call found the name and is about to hand back a handle onto
         * it -- one more reference, counted the same as a create's, but with
         * no last error of its own to set: opening an existing named object is
         * success, not ERROR_ALREADY_EXISTS, which is a create's answer alone.
         *
         * @param {any} object
         */
        reference(object){
            for (const [name, held] of table)
            {
                if (held.object === object)
                {
                    held.refs++;
                    count(name, 1);
                    return;
                }
            }
        },

        /**
         * A handle onto a named object was closed. The last one closes the
         * name too, freeing it for a create that means it for real -- the
         * "probe, close, create again" idiom this table exists to support. A
         * no-op for a handle onto anything unnamed, which is most of them.
         *
         * @param {any} object
         */
        forget(object){
            for (const [name, held] of table)
            {
                if (held.object === object)
                {
                    held.refs--;
                    count(name, -1);
                    if (held.refs <= 0)
                    {
                        table.delete(name);
                    }
                    return;
                }
            }
        },

        /**
         * The process has ended: every reference it still held goes, as its
         * handles close, and a name nobody else holds is free again. What
         * another process still holds stays, and is told this process is gone
         * (`forsake`): its threads leave the object's queue, a mutex they
         * hold is abandoned. Once is enough; a second call finds nothing.
         *
         * @param {(object: any) => void} [forsake]
         */
        ended(forsake){
            for (const [name, held] of mine)
            {
                const entry = table.get(name);
                if (entry)
                {
                    entry.refs -= Math.min(held, entry.refs);
                    if (entry.refs <= 0)
                    {
                        table.delete(name);
                    }
                }
            }
            mine.clear();
            if (forsake)
            {
                for (const entry of table.values())
                {
                    forsake(entry.object);
                }
            }
        },
    };
}

/**
 * The run's one namespace as a process across a link reaches it
 * (`system-objects.js`): a name it creates is made there, one it opens is
 * whichever process's object holds it, and the object here is a stand-in --
 * a kernel object of the kind that names the real one by `remote`, so the
 * kernel asks there for every change and wait (`sync.js`). The same
 * operations as the table here, so kernel32 does not know which it has.
 *
 * @param {Object} options
 * @param {any} options.objects  the link's `objects` calls
 * @param {any} options.kernel   for the stand-ins
 */
export function createRemoteNamedObjects({ objects, kernel }){
    /** One stand-in per object, so two handles onto it are one object here. @type {Map<number, any>} */
    const standIns = new Map();
    // A file mapping or a waitable timer is not carried across the link yet:
    // its name is this process's own, as every name was before.
    const own = createNamedObjects();
    /** @param {string} kind */
    const across = kind=>kind === 'event' || kind === 'semaphore' || kind === 'mutex';
    /** The references this process holds there, by number, for its end to close. @type {Map<number, number>} */
    const mine = new Map();
    /** @param {number} id @param {number} by */
    const count = (id, by)=>{
        const now = (mine.get(id) ?? 0) + by;
        if (now > 0)
        {
            mine.set(id, now);
        }
        else
        {
            mine.delete(id);
        }
    };
    /** @param {string} kind @param {number} id @param {string} name */
    const standInFor = (kind, id, name)=>{
        let made = standIns.get(id);
        if (!made)
        {
            made = kind === 'event' ? kernel.createEvent({ name })
                : kind === 'semaphore' ? kernel.createSemaphore({ initial: 0, maximum: 1, name })
                    : kernel.createMutex({ name });
            made.remote = id;
            standIns.set(id, made);
        }
        return made;
    };
    return {
        /** @param {string | null} name @param {string} kind */
        existing(name, kind){
            if (!across(kind))
            {
                return own.existing(name, kind);
            }
            if (name === null)
            {
                return null;
            }
            const found = objects.peek(kind, name);
            return found === null ? null : found.taken ? TAKEN : standInFor(kind, found.id, name);
        },

        /**
         * A fresh object made here is made there instead, with the state it
         * was made in, and becomes its stand-in.
         *
         * @param {string | null} name @param {string} kind @param {any} made
         * @param {boolean} reused
         * @param {(code: number) => void} setLastError
         */
        remember(name, kind, made, reused, setLastError){
            if (!across(kind))
            {
                own.remember(name, kind, made, reused, setLastError);
                return;
            }
            if (name !== null)
            {
                if (reused)
                {
                    objects.reference(made.remote);
                    count(made.remote, 1);
                }
                else
                {
                    const answer = objects.create(kind, name, {
                        manualReset: made.manualReset === true, signalled: made.signalled === true,
                        initial: made.count, maximum: made.maximum,
                        owner: made.owner ? made.owner.id : null,
                    });
                    made.remote = answer.id;
                    standIns.set(answer.id, made);
                    count(answer.id, 1);
                    reused = answer.reused === true;
                }
            }
            setLastError(reused ? ERROR_ALREADY_EXISTS : ERROR_SUCCESS);
        },

        /** @param {any} object */
        reference(object){
            if (object.remote)
            {
                objects.reference(object.remote);
                count(object.remote, 1);
                return;
            }
            own.reference(object);
        },

        /** @param {any} object */
        forget(object){
            if (object.remote)
            {
                objects.close(object.remote);
                count(object.remote, -1);
                return;
            }
            own.forget(object);
        },

        /**
         * The process has ended: the references it held there close, as its
         * handles do, so a name only it held is free in the run again.
         *
         * @param {(object: any) => void} [forsake]
         */
        ended(forsake){
            const held = [...mine];
            mine.clear();
            for (const [id, times] of held)
            {
                try
                {
                    for (let left = times; left > 0; left--)
                    {
                        objects.close(id);
                    }
                }
                catch {
                    // Gone there already (the run let the name go with a
                    // duplicate's last close): nothing of this process's is.
                }
            }
            standIns.clear();
            own.ended(forsake);
        },
    };
}
