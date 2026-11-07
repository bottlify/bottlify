/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Sync objects (OpenGL 3.2 section 5.2, GL_ARB_sync).
 *
 * - **A fence is signalled once the commands before it have run on the
 *   device.** Everything a call reads of the program's memory is copied when
 *   the call is made, so what a fence protects -- memory the program wants
 *   to write again -- is free then; what it waits for here is the recording
 *   being replayed (`gpu.js` fence). A context with no device behind it has
 *   run everything by the time the call returns, and its fences are made
 *   signalled.
 * - **glClientWaitSync waits** up to its timeout, the commands flushed first
 *   when it asks (GL_SYNC_FLUSH_COMMANDS_BIT) or when it waits at all: a
 *   fence whose frame is not swapped yet would otherwise never come within a
 *   finite wait. A wait of zero only asks.
 * - **glWaitSync makes the device wait,** which its queue already does: every
 *   command runs after the ones before it.
 * - Sync objects are shared with the share group.
 */

import { GL } from './constants.js';

/** The calls of this file a display list does not record: all of them (section 5.5). */
export const SYNC_CALLS_NOT_COMPILED = Object.freeze([
    'glFenceSync', 'glIsSync', 'glDeleteSync', 'glClientWaitSync', 'glWaitSync', 'glGetSynciv',
]);

export const SYNC = Object.freeze({
    MAX_SERVER_WAIT_TIMEOUT: 0x9111,
    OBJECT_TYPE: 0x9112,
    SYNC_CONDITION: 0x9113,
    SYNC_STATUS: 0x9114,
    SYNC_FLAGS: 0x9115,
    SYNC_FENCE: 0x9116,
    SYNC_GPU_COMMANDS_COMPLETE: 0x9117,
    UNSIGNALED: 0x9118,
    SIGNALED: 0x9119,
    ALREADY_SIGNALED: 0x911a,
    TIMEOUT_EXPIRED: 0x911b,
    CONDITION_SATISFIED: 0x911c,
    WAIT_FAILED: 0x911d,
    SYNC_FLUSH_COMMANDS_BIT: 0x1,
});

/** GL_TIMEOUT_IGNORED, the one timeout glWaitSync takes, as the two words a guest passes. */
export const TIMEOUT_IGNORED = Number.MAX_SAFE_INTEGER;

/** The longest wait the device side takes: it never waits, so any. */
const MAX_SERVER_WAIT = 0;

/**
 * @typedef {{ signalled: () => boolean, done: Promise<void>, flush: () => void }} Fence
 */

/**
 * @param {any} context
 * @param {import('./kernel.js').ContextKernel} kernel
 */
export function installSyncCalls(context, kernel){
    const { enter, setError } = kernel;

    /** @returns {{ next: number, objects: Map<number, Fence> }} the share group's */
    const syncs = ()=>{
        const group = /** @type {any} */ (kernel.shareGroup());
        return group.syncs ??= { next: 1, objects: new Map() };
    };

    const int64 = kernel.side.int64 ??= new Map();
    int64.set(SYNC.MAX_SERVER_WAIT_TIMEOUT, ()=>[MAX_SERVER_WAIT]);

    /** @type {Fence} */
    const SIGNALLED = Object.freeze({ signalled: ()=>true, done: Promise.resolve(),
        flush: ()=>{} });

    /** @param {number} sync @returns {Fence | undefined} */
    const fenceOf = sync=>syncs().objects.get(sync);

    Object.assign(context, {
        /**
         * @param {number} condition @param {number} flags
         * @returns {number} the sync's name, zero when none was made
         */
        glFenceSync(condition, flags){
            if (!enter('glFenceSync', [condition, flags]))
            {
                return 0;
            }
            if (condition !== SYNC.SYNC_GPU_COMMANDS_COMPLETE)
            {
                setError(GL.INVALID_ENUM);
                return 0;
            }
            if (flags !== 0)
            {
                setError(GL.INVALID_VALUE);
                return 0;
            }
            const table = syncs();
            const name = table.next++;
            table.objects.set(name, kernel.fence?.() ?? SIGNALLED);
            return name;
        },

        /** @param {number} sync @returns {number} */
        glIsSync(sync){
            if (!enter('glIsSync', [sync]))
            {
                return GL.FALSE;
            }
            return fenceOf(sync) ? GL.TRUE : GL.FALSE;
        },

        /** @param {number} sync */
        glDeleteSync(sync){
            if (!enter('glDeleteSync', [sync]) || sync === 0)
            {
                return;
            }
            if (!syncs().objects.delete(sync))
            {
                setError(GL.INVALID_VALUE);
            }
        },

        /**
         * @param {number} sync @param {number} flags
         * @param {number} timeout  nanoseconds
         * @returns {number | Promise<number>} what the wait came to; a promise
         *     while it waits
         */
        glClientWaitSync(sync, flags, timeout){
            if (!enter('glClientWaitSync', [sync, flags, timeout]))
            {
                return SYNC.WAIT_FAILED;
            }
            const fence = fenceOf(sync);
            if (!fence || (flags & ~SYNC.SYNC_FLUSH_COMMANDS_BIT) !== 0)
            {
                setError(GL.INVALID_VALUE);
                return SYNC.WAIT_FAILED;
            }
            if (fence.signalled())
            {
                return SYNC.ALREADY_SIGNALED;
            }
            if ((flags & SYNC.SYNC_FLUSH_COMMANDS_BIT) !== 0 || timeout > 0)
            {
                fence.flush();
            }
            if (!(timeout > 0))
            {
                return SYNC.TIMEOUT_EXPIRED;
            }
            /** @type {ReturnType<typeof setTimeout> | undefined} */
            let timer;
            const expired = new Promise(resolve=>{
                timer = setTimeout(()=>resolve(SYNC.TIMEOUT_EXPIRED),
                    Math.min(timeout / 1e6, 0x7fffffff));
            });
            return Promise.race([fence.done.then(()=>SYNC.CONDITION_SATISFIED), expired])
                .then(answer=>{
                    clearTimeout(timer);
                    return /** @type {number} */ (answer);
                });
        },

        /**
         * @param {number} sync @param {number} flags
         * @param {number} timeout  must be GL_TIMEOUT_IGNORED
         */
        glWaitSync(sync, flags, timeout){
            if (!enter('glWaitSync', [sync, flags, timeout]))
            {
                return;
            }
            if (!fenceOf(sync) || flags !== 0 || timeout !== TIMEOUT_IGNORED)
            {
                setError(GL.INVALID_VALUE);
            }
        },

        /**
         * @param {number} sync @param {number} pname
         * @returns {number[] | null}
         */
        glGetSynciv(sync, pname){
            if (!enter('glGetSynciv', [sync, pname]))
            {
                return null;
            }
            const fence = fenceOf(sync);
            if (!fence)
            {
                setError(GL.INVALID_VALUE);
                return null;
            }
            switch (pname)
            {
                case SYNC.OBJECT_TYPE: return [SYNC.SYNC_FENCE];
                case SYNC.SYNC_CONDITION: return [SYNC.SYNC_GPU_COMMANDS_COMPLETE];
                case SYNC.SYNC_FLAGS: return [0];
                case SYNC.SYNC_STATUS:
                    return [fence.signalled() ? SYNC.SIGNALED : SYNC.UNSIGNALED];
                default:
                    setError(GL.INVALID_ENUM);
                    return null;
            }
        },
    });
}
