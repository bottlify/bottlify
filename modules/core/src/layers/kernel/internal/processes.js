/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Child processes, as records rather than as machines.
 *
 * There is one address space and one emulator, so a child is not started
 * alongside its parent -- it is recorded here, and whoever drives the machine
 * tears the parent down and rebuilds on the child's image once the parent has
 * nothing left to do. Everything a child needs to exist between those two
 * moments is in the record: the image, the command line the parent chose for
 * it, the bytes the parent wrote into it before it was ever mapped, and an exit
 * code nobody can observe as anything but STILL_ACTIVE.
 *
 * Nothing here schedules or executes. That is deliberate -- this layer's job is
 * to hold the request so that the decision about when to honour it is made in
 * one place, by the caller that assembled the process.
 */

/**
 * What GetExitCodeProcess reports for a process that has not exited.
 *
 * A child of this engine never reports anything else: there is no moment at
 * which the parent is running and the child has finished, so any other answer
 * would be a fiction the parent could act on.
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
 * @property {MemoryPatch[]} patches
 *           Writes made into the child before its image exists, replayed once
 *           the PE is mapped. This is process hollowing implemented as a queue.
 * @property {number} exitCode
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

export function createProcessTable(){
    /** @type {ProcessRecord[]} */
    const records = [];
    let nextId = FIRST_ID;

    return {
        /**
         * @param {Object} options
         * @param {string} options.imagePath
         * @param {string} options.commandLine
         * @param {boolean} [options.suspended]
         * @returns {ProcessRecord}
         */
        create({ imagePath, commandLine, suspended = false }){
            const record = {
                id: nextId,
                threadId: nextId + 1,
                imagePath,
                commandLine,
                suspended,
                /** @type {MemoryPatch[]} */
                patches: [],
                exitCode: STILL_ACTIVE,
                handle: 0,
                threadHandle: 0,
            };
            nextId += ID_STRIDE * 2;
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
            return records.find(record=>!record.suspended) ?? null;
        },

        /** @returns {ProcessRecord[]} */
        all: ()=>[...records],

        diagnostics(){
            return {
                created: records.length,
                suspended: records.filter(record=>record.suspended).length,
                pending: records.find(record=>!record.suspended)?.imagePath ?? null,
            };
        },
    };
}
