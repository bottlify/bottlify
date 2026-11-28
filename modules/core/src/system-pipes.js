/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The run's named pipes, served across a link to the processes in a worker
 * of their own: the pipe ends a process there was started with, and every
 * pipe it makes or opens, live here, in the run's namespace among every
 * other process's, and the process asks for each operation on them.
 *
 * The process holds a stand-in (`pipes.js`'s `pipeStandIn`) under each of
 * its handles, by the number the run gave the end here, and each operation
 * is done on the end itself (`EndAcross`), among the other processes'
 * operations on it: a parent's read waiting on the child's output is
 * answered by the child's write as it would be by a process beside it. The
 * namespace is answered by the same code a process on this thread runs
 * (`createNamedPipes`), on a host whose handles are those numbers. An
 * operation that waits here is answered `{ waiting }`, a token the process
 * then asks the answer of (`waited`) without blocking its worker, its thread
 * parked meanwhile; every other is answered at once, as on this thread.
 *
 * A process's handle is one more on the end, let go when it closes the last
 * handle onto the stand-in or when its link ends, whichever comes first --
 * and what of it still waits then is cancelled, so no byte goes to a
 * process that is gone.
 */

import { claimInherited, createNamedPipes } from './layers/win32/kernel32/pipes.js';

/** What a call on a number no end of the link's is answers: STATUS_INVALID_HANDLE. */
const STATUS_INVALID_HANDLE = 0xc0000008;
/** What an answer asked for twice, or after its link ended, is: STATUS_CANCELLED. */
const STATUS_CANCELLED = 0xc0000120;

/**
 * @param {{ handle: number, type: string, object: any }[] | undefined} inherited
 *     the handles the process inherits, as its parent's CreateProcess found them
 * @param {Map<string, any>} [table]  the run's named objects, where its pipes are named
 * @param {(api: string, detail: string) => void} [divergence]
 */
export function pipeHandlers(inherited, table = new Map(), divergence = undefined){
    /**
     * Every end the link's processes hold, by the number the run gave it.
     *
     * @type {Map<number, { end: any, across: import('./layers/win32/kernel32/pipes.js').EndAcross }>}
     */
    const ends = new Map();
    let nextId = 1;
    /** @param {any} end @returns {number} */
    const add = end=>{
        const id = nextId++;
        ends.set(id, { end, across: end.across() });
        return id;
    };
    /** The process asking, and the rights the last end made here was opened with. */
    const asking = { processId: 0, access: /** @type {number | null} */ (null) };
    const engine = createNamedPipes(/** @type {any} */ ({
        // Nothing waits on this thread's behalf: what waits is the link's
        // (`EndAcross`), so no thread here times out and no event here is signalled.
        kernel: { onTimeout: ()=>{}, setEvent: ()=>{}, resetEvent: ()=>{} },
        handles: {
            open: (/** @type {string} */ type, /** @type {any} */ end,
                /** @type {number | null} */ access = null)=>
            {
                void type;
                asking.access = access;
                return add(end);
            },
            resolve: (/** @type {number} */ id)=>ends.get(id >>> 0)?.end ?? null,
            typeOf: (/** @type {number} */ id)=>(ends.has(id >>> 0) ? 'pipe' : null),
            access: ()=>null,
        },
        table,
        get processId(){
            return asking.processId;
        },
        divergence,
    }));
    /**
     * Each end it inherits: its number in the process, its number here, and
     * the handle's flags in its parent's table.
     *
     * @type {Map<number, { id: number, flags?: number }>}
     */
    const handed = new Map();
    for (const entry of inherited ?? [])
    {
        const { handle, type, object, flags } = /** @type {any} */ (entry);
        if (type === 'pipe' && typeof object?.across === 'function' && !handed.has(handle >>> 0))
        {
            // The handle its parent's CreateProcess held for it, or one more.
            if (!claimInherited(entry))
            {
                object.retain();
            }
            handed.set(handle >>> 0, { id: add(object), flags });
        }
    }
    /** @param {number} id */
    const at = id=>ends.get(id >>> 0)?.across ?? null;
    /** @param {number} id @param {number | null} [access]  the rights it was opened with */
    const described = (id, access = null)=>({ id, access,
        .../** @type {NonNullable<ReturnType<typeof at>>} */ (at(id)).state() });
    /**
     * What waits, by token, until the process asks for it.
     *
     * @type {Map<number, Promise<any>>}
     */
    const waiting = new Map();
    let nextToken = 1;
    /** @param {any} got */
    const answer = got=>{
        if (typeof got?.then !== 'function')
        {
            return got;
        }
        const token = nextToken++;
        waiting.set(token, got);
        return { waiting: token };
    };
    const invalid = { status: STATUS_INVALID_HANDLE };
    return {
        /** What the process is told of each end it inherits: its number, and what it is. */
        described: [...handed].map(([handle, { id, flags }])=>({ handle, flags,
            ...described(id) })),
        pipes: {
            /** @param {string} name @param {any} asked @param {number} processId */
            create(name, asked, processId){
                asking.processId = processId;
                const made = engine.namespace.create(name, asked);
                return 'error' in made ? made : described(made.handle, asking.access);
            },
            /**
             * @param {string} name @param {number} access @param {number} flags
             * @param {number} processId
             */
            open(name, access, flags, processId){
                asking.processId = processId;
                const made = engine.namespace.open(name, access, flags);
                return 'error' in made ? made : described(made.handle, asking.access);
            },
            /** @param {string} name @param {number} processId */
            query(name, processId){
                asking.processId = processId;
                return engine.namespace.query(name);
            },
            /** @param {string} name @param {number} timeout */
            wait: (name, timeout)=>answer(engine.namespace.wait(name, timeout)),
            /** @param {number} token */
            waited(token){
                const got = waiting.get(token);
                waiting.delete(token);
                return got ?? { status: STATUS_CANCELLED };
            },
            /** @param {number} id @param {number} length */
            read: (id, length)=>answer(at(id)?.read(length) ?? invalid),
            /** @param {number} id @param {Uint8Array} bytes @param {boolean} [whole] */
            write: (id, bytes, whole)=>answer(at(id)?.write(bytes, whole) ?? invalid),
            /** @param {number} id @param {number} size */
            peek: (id, size)=>at(id)?.peek(size) ?? invalid,
            /** @param {number} id */
            connect: id=>answer(at(id)?.connect() ?? invalid),
            /** @param {number} id */
            disconnect: id=>at(id)?.disconnect() ?? invalid,
            /** @param {number} id */
            flush: id=>answer(at(id)?.flush() ?? invalid),
            /** @param {number} id @param {Uint8Array} bytes @param {number} room */
            transact: (id, bytes, room)=>answer(at(id)?.transact(bytes, room) ?? invalid),
            /** @param {number} id */
            state: id=>at(id)?.state() ?? null,
            /** @param {number} id @param {boolean} readMessages @param {boolean} nowait */
            setState: (id, readMessages, nowait)=>at(id)?.setState(readMessages, nowait),
            /** @param {number} id */
            cancel: id=>at(id)?.cancel() ?? 0,
            /** @param {number} id */
            close: id=>{
                at(id)?.release();
                ends.delete(id >>> 0);
                engine.closed(id, null);
            },
        },
        /**
         * An end of this link's that a child of its process inherits, started
         * by the run elsewhere: one more handle onto it, held for the child
         * until it claims it (`claimInherited`) or never starts.
         *
         * @param {number} handle  its number in the child
         * @param {number} id  the end's number here
         * @param {number} [flags]  the handle's, as its parent's table has them
         * @returns {import('./layers/win32/kernel32/pipes.js').InheritedEnd | null}
         */
        inherit(handle, id, flags){
            const held = ends.get(id >>> 0);
            if (!held || held.end.closed)
            {
                return null;
            }
            held.end.retain();
            /** @type {import('./layers/win32/kernel32/pipes.js').InheritedEnd} */
            const entry = { handle, type: 'pipe', object: held.end, held: true, flags,
                drop(){
                    if (entry.held)
                    {
                        entry.held = false;
                        held.end.across().release();
                    }
                } };
            return entry;
        },
        /** The link's processes have ended: every end they still held is let go. */
        dispose(){
            for (const { across } of ends.values())
            {
                across.release();
            }
            ends.clear();
            waiting.clear();
        },
    };
}
