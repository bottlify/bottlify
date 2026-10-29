/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Child processes, as records rather than as machines.
 *
 * A child is recorded here when its parent asks for it, and whoever drives the
 * machine starts it at once, beside its parent, on a machine of its own -- one
 * made suspended with its first thread waiting for ResumeThread. The record is
 * what the parent holds of it: the image, the command line the parent chose
 * for it, what the parent handed it, the event its exit sets, and an exit code
 * that stays STILL_ACTIVE until it has ended.
 *
 * Nothing here schedules or executes. That is deliberate -- this layer's job is
 * to hold the request so that the decision about when to honour it is made in
 * one place, by the caller that assembled the process.
 */

/**
 * What GetExitCodeProcess reports for a process that has not exited.
 */
export const STILL_ACTIVE = 259;

/**
 * @typedef {Object} ProcessRecord
 * @property {number} id            The child's process id.
 * @property {number} threadId      Its initial thread's id.
 * @property {string} imagePath     Resolved against the volume by the caller.
 * @property {string} commandLine   What the child will believe it was started with.
 * @property {boolean} suspended    CREATE_SUSPENDED: its first thread waits for ResumeThread.
 * @property {boolean} completed
 *           The child already ran and exited: a redistributable installer the
 *           engine itself plays the role of, so the request is answered as
 *           though it had run and left exit code 0. It is never handed over.
 * @property {boolean} started      Its machine has been asked for; no longer pending.
 * @property {number} exitCode
 * @property {any} [exited]  The event its exit sets (the kernel module's `create`).
 * @property {{ thread: any, result: number }[]} [waiters]
 *           The parent's threads blocked on this child, each with what its
 *           wait answers when the child exits.
 * @property {number} handle        Zero until the caller opens one.
 * @property {number} threadHandle
 */

/**
 * Ids start above the running process's own and step by four, for the reason
 * handles do: an id that could be mistaken for a small integer, an index or a
 * handle hides a caller's confusion instead of exposing it.
 */
const FIRST_ID = 0x2000;
const ID_STRIDE = 4;

/**
 * Takes the next of the run's ids of a kind, moving it on by `step`. The run
 * keeps one counter for every process, and a process in a thread of its own
 * takes from it through `take`, which reads and moves it in one step; a
 * counter here is read and moved in place.
 *
 * @param {{ take?: (name: string, step: number) => number } & Record<string, any>} ids
 * @param {'thread' | 'process'} name @param {number} step
 * @returns {number}
 */
export function takeId(ids, name, step){
    if (typeof ids.take === 'function')
    {
        return ids.take(name, step);
    }
    const id = ids[name];
    ids[name] += step;
    return id;
}

/**
 * @param {{ process: number }} [ids]  the run's, where processes are started
 *     from more than one: a child's children are numbered on from its parent's
 */
export function createProcessTable(ids = { process: FIRST_ID }){
    /** @type {ProcessRecord[]} */
    const records = [];
    return {
        /**
         * @param {Object} options
         * @param {string} options.imagePath
         * @param {string} options.commandLine
         * @param {boolean} [options.suspended]
         * @param {boolean} [options.completed]
         *        The child has already run and exited 0. Used for a
         *        redistributable installer the engine answers for: a title
         *        starting `vcredist_x86.exe` gets a process that is over, not a
         *        replacement.
         * @returns {ProcessRecord}
         */
        create({ imagePath, commandLine, suspended = false, completed = false }){
            const id = takeId(ids, 'process', ID_STRIDE * 2);
            const record = {
                id,
                threadId: id + 1,
                imagePath,
                commandLine,
                suspended,
                completed,
                exitCode: completed ? 0 : STILL_ACTIVE,
                started: false,
                handle: 0,
                threadHandle: 0,
            };
            records.push(record);
            return record;
        },

        /**
         * The child asked for and not started yet, if any: started at the
         * parent's next turn, a suspended one too, whose first thread waits
         * for its parent's ResumeThread.
         *
         * @returns {ProcessRecord | null}
         */
        pending(){
            return records.find(record=>!record.completed && !record.started) ?? null;
        },

        /**
         * The child runs now, beside this process, rather than waiting to take
         * its place: it is no longer pending.
         *
         * @param {ProcessRecord} record
         */
        started(record){
            record.started = true;
        },

        /**
         * Whether a record is finished, for a wait or an exit-code query.
         *
         * @param {ProcessRecord} record
         * @returns {boolean}
         */
        finished: record=>record.exitCode !== STILL_ACTIVE,

        /** @returns {ProcessRecord[]} */
        all: ()=>[...records],

        diagnostics(){
            return {
                created: records.length,
                suspended: records.filter(record=>record.suspended).length,
                completed: records.filter(record=>record.completed).length,
                pending: records.find(record=>!record.suspended && !record.completed)
                    ?.imagePath ?? null,
            };
        },
    };
}
