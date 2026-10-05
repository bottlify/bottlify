/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Child processes, as records rather than as machines.
 *
 * A child is not started alongside its parent -- it is recorded here, and
 * whoever drives the machine starts it once the parent has nothing left to
 * do: on a machine of its own beside the parent's when the parent is waiting
 * on it, so the parent goes on afterwards, or in the parent's place when the
 * parent has exited. Everything a child needs to exist until then is in the
 * record: the image, the command line the parent chose for it, the bytes the
 * parent wrote into it before it was ever mapped, the parent's threads waiting
 * on it, and an exit code that stays STILL_ACTIVE until it has run.
 *
 * Nothing here schedules or executes. That is deliberate -- this layer's job is
 * to hold the request so that the decision about when to honour it is made in
 * one place, by the caller that assembled the process.
 */

/**
 * What GetExitCodeProcess reports for a process that has not exited: every
 * child until it has run and exited beside a parent that waited on it.
 */
export const STILL_ACTIVE = 259;

/**
 * @typedef {Object} MemoryPatch
 * @property {number} address
 * @property {Uint8Array} bytes
 */

/**
 * @typedef {Object} ProcessRecord
 * @property {number} id            The child's process id.
 * @property {number} threadId      Its initial thread's id.
 * @property {string} imagePath     Resolved against the volume by the caller.
 * @property {string} commandLine   What the child will believe it was started with.
 * @property {boolean} suspended    CREATE_SUSPENDED; cleared by ResumeThread.
 * @property {boolean} completed
 *           The child already ran and exited: a redistributable installer the
 *           engine itself plays the role of, so the request is answered as
 *           though it had run and left exit code 0. It is never handed over.
 * @property {boolean} started      Running beside its parent (the `workers` mode), so no
 *                                  longer waiting to take the parent's place.
 * @property {MemoryPatch[]} patches
 *           Writes made into the child before its image exists, replayed once
 *           the PE is mapped. This is process hollowing implemented as a queue.
 * @property {number} exitCode
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
            const id = ids.process;
            const record = {
                id,
                threadId: id + 1,
                imagePath,
                commandLine,
                suspended,
                completed,
                /** @type {MemoryPatch[]} */
                patches: [],
                exitCode: completed ? 0 : STILL_ACTIVE,
                started: false,
                handle: 0,
                threadHandle: 0,
            };
            ids.process += ID_STRIDE * 2;
            records.push(record);
            return record;
        },

        /**
         * The child that should take this process's place, if any.
         *
         * The first one that is not suspended: a parent that asked for a
         * suspended child has told us it is not finished with it yet, and
         * honouring the request before ResumeThread would run a child the
         * parent had not finished writing into.
         *
         * @returns {ProcessRecord | null}
         */
        pending(){
            return records.find(record=>!record.suspended && !record.completed
                && !record.started) ?? null;
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
