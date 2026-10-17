/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The run's named kernel objects, for a process across a link:
 * what it creates by name lives here, in the run's one namespace,
 * and what it opens by name is whichever process's object holds the name.
 * The process holds a stand-in and asks here for every change and every wait.
 *
 * A wait that cannot be answered at once queues a stand-in thread on the
 * object itself, among the threads of the processes here: the kernel hands
 * an object to the first waiter that can take it and wakes that waiter
 * through its own scheduler (`sync.js`), and a stand-in's scheduler is the
 * link -- the object is taken here, on the process's behalf, and the process
 * is told which of its waits ended and how. So who gets a signalled object is
 * decided once, by the same code for every process, whichever thread waits.
 *
 * Objects are numbered for the link; a number names its object until the
 * last process holding it closes it.
 */

import { createSyncObjects } from './layers/kernel/internal/sync.js';

/** What a process may ask for, kind by kind. */
const KINDS = new Set(['event', 'semaphore', 'mutex']);

/**
 * @param {Object} deps
 * @param {Map<string, { kind: string, object: any, refs: number }>} deps.table
 *     the run's named objects, every process's
 * @param {(token: number, result: number) => Promise<unknown>} deps.wake
 *     tells the process across the link that one of its waits ended
 */
export function objectHandlers({ table, wake }){
    // Made only for what a process across a link names first; its scheduler
    // never blocks anyone, since nothing waits through it.
    const sync = createSyncObjects({ scheduler: {
        block(){
            throw new Error('objects: a wait here is a stand-in\'s, never a block');
        },
        wake(){},
        onTimeout(){},
    } });
    /** @type {Map<number, any>} */
    const byId = new Map();
    /** @type {WeakMap<object, number>} */
    const ids = new WeakMap();
    let next = 1;
    /** @param {any} object */
    const numberOf = object=>{
        let id = ids.get(object);
        if (id === undefined)
        {
            id = next++;
            ids.set(object, id);
            byId.set(id, object);
        }
        return id;
    };
    /** @param {number} id */
    const objectOf = id=>{
        const object = byId.get(id);
        if (!object)
        {
            throw new Error(`objects: nothing is numbered ${id}`);
        }
        return object;
    };

    /**
     * One stand-in thread per thread of the process: what owns a mutex it
     * took, and what is queued while it waits.
     *
     * @type {Map<number, any>}
     */
    const standIns = new Map();
    /** Waits queued, by the token the process named them with. @type {Map<number, any>} */
    const queued = new Map();
    /** Waits ended here whose word has not reached the process yet. @type {Map<number, number>} */
    const ended = new Map();
    /** @param {number} threadId */
    const standInFor = threadId=>{
        let standIn = standIns.get(threadId);
        if (!standIn)
        {
            standIn = { id: threadId, suspendCount: 0, waitSet: null, queuedOn: null,
                state: 'running', token: 0, waitResult: null,
                scheduler: {
                    wake(/** @type {any} */ woken){
                        const { token } = woken;
                        queued.delete(token);
                        woken.state = 'running';
                        ended.set(token, woken.waitResult);
                        wake(token, woken.waitResult).finally(()=>ended.delete(token));
                    },
                } };
            standIns.set(threadId, standIn);
        }
        return standIn;
    };

    /** @param {string} name @param {string} kind */
    const held = (name, kind)=>{
        const entry = table.get(name);
        return !entry ? null : entry.kind === kind ? entry : 'taken';
    };

    return {
        /**
         * The process across the link has ended: what it waited on forgets it,
         * and a mutex one of its threads held is abandoned, as Windows
         * abandons a dead thread's -- the next waiter takes it and is told.
         */
        dispose(){
            for (const { standIn, object } of queued.values())
            {
                const at = object.waiters.indexOf(standIn);
                if (at >= 0)
                {
                    object.waiters.splice(at, 1);
                }
            }
            queued.clear();
            for (const object of byId.values())
            {
                for (const standIn of standIns.values())
                {
                    if (object.kind === 'mutex' && object.owner === standIn)
                    {
                        object.abandoned = true;
                        object.recursion = 1;
                        sync.releaseMutex(object, standIn);
                    }
                }
            }
        },
        objects: {
            /**
             * The object a name stands for, without taking a reference: what a
             * create looks at before deciding to make one.
             *
             * @param {string} kind @param {string} name
             * @returns {{ id: number } | { taken: true } | null}
             */
            peek(kind, name){
                const entry = held(name, kind);
                return entry === null ? null : entry === 'taken' ? { taken: true }
                    : { id: numberOf(entry.object) };
            },

            /**
             * Makes an object under a name, or finds the one already there.
             *
             * @param {string} kind @param {string} name
             * @param {{ manualReset?: boolean, signalled?: boolean, initial?: number,
             *     maximum?: number, owner?: number | null }} state
             * @returns {{ id: number, reused: boolean } | { taken: true }}
             */
            create(kind, name, state){
                if (!KINDS.has(kind))
                {
                    throw new Error(`objects: a ${kind} is not made across a link`);
                }
                const entry = held(name, kind);
                if (entry === 'taken')
                {
                    return { taken: true };
                }
                if (entry)
                {
                    entry.refs++;
                    return { id: numberOf(entry.object), reused: true };
                }
                const object = kind === 'event'
                    ? sync.createEvent({ manualReset: state.manualReset === true,
                        signalled: state.signalled === true, name })
                    : kind === 'semaphore'
                        ? sync.createSemaphore({ initial: state.initial ?? 0,
                            maximum: state.maximum ?? 1, name })
                        : sync.createMutex({ name });
                if (kind === 'mutex' && state.owner !== null && state.owner !== undefined)
                {
                    sync.poll(object, standInFor(state.owner));
                }
                table.set(name, { kind, object, refs: 1 });
                return { id: numberOf(object), reused: false };
            },

            /** One more handle onto it. @param {number} id */
            reference(id){
                const object = objectOf(id);
                for (const entry of table.values())
                {
                    if (entry.object === object)
                    {
                        entry.refs++;
                    }
                }
            },

            /** A handle onto it closed; the last frees the name. @param {number} id */
            close(id){
                const object = objectOf(id);
                for (const [name, entry] of table)
                {
                    if (entry.object === object && --entry.refs <= 0)
                    {
                        table.delete(name);
                        byId.delete(id);
                    }
                }
            },

            /**
             * Waits on behalf of a thread across the link: the answer now, or
             * null and the thread is queued, to be told by `wake` with the
             * token it named the wait by.
             *
             * @param {number} id @param {number} threadId @param {number} token
             * @returns {number | null}
             */
            wait(id, threadId, token){
                const object = objectOf(id);
                const standIn = standInFor(threadId);
                const now = sync.poll(object, standIn);
                if (now !== null)
                {
                    return now;
                }
                standIn.token = token;
                standIn.waitSet = null;
                standIn.queuedOn = [object];
                standIn.state = 'blocked';
                object.waiters.push(standIn);
                queued.set(token, { standIn, object });
                return null;
            },

            /**
             * A wait the process gave up on, its time out. Null when it was
             * still queued and is not any more; the result when it had ended
             * here already -- the object is the thread's, whatever its clock
             * said, and the process answers with that.
             *
             * @param {number} token @returns {number | null}
             */
            cancel(token){
                const wait = queued.get(token);
                if (wait)
                {
                    queued.delete(token);
                    const at = wait.object.waiters.indexOf(wait.standIn);
                    if (at >= 0)
                    {
                        wait.object.waiters.splice(at, 1);
                    }
                    wait.standIn.state = 'running';
                    return null;
                }
                return ended.get(token) ?? null;
            },

            /** @param {number} id @param {number} threadId @returns {number | null} */
            poll: (id, threadId)=>sync.poll(objectOf(id), standInFor(threadId)),
            /** @param {number} id */
            set: id=>void sync.setEvent(objectOf(id)),
            /** @param {number} id */
            reset: id=>sync.resetEvent(objectOf(id)),
            /** @param {number} id @param {number} count @returns {number} */
            release: (id, count)=>sync.releaseSemaphore(objectOf(id), count),
            /** @param {number} id @param {number} threadId @returns {boolean} */
            releaseMutex: (id, threadId)=>sync.releaseMutex(objectOf(id), standInFor(threadId)),
        },
    };
}
