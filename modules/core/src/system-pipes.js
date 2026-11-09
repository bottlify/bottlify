/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The pipe ends a process in a worker of its own was started with, served
 * where its parent holds them: a launcher that reads its child's output, or
 * writes its commands, through the pipes CreateProcess handed down.
 *
 * The child holds a stand-in under each number its parent had the end by
 * (`pipes.js`'s `pipeStandIn`) and asks here for every read, write and peek;
 * each is done on the end itself (`EndAcross`), among the other processes'
 * operations on it, so a parent's read waiting on the child's output is
 * answered by the child's write as it would be by a process beside it. The
 * child's handle is one more on the end, let go when it closes the last
 * handle onto the stand-in or when it ends, whichever comes first -- and its
 * reads still waiting then are cancelled, so no byte goes to a process that
 * is gone.
 */

/** What a call on a number no end of the child's is answers: STATUS_INVALID_HANDLE. */
const STATUS_INVALID_HANDLE = 0xc0000008;

/**
 * @param {{ handle: number, type: string, object: any }[] | undefined} inherited
 *     the handles the child inherits, as its parent's CreateProcess found them
 */
export function pipeHandlers(inherited){
    /** @type {Map<number, import('./layers/win32/kernel32/pipes.js').EndAcross>} */
    const ends = new Map();
    for (const { handle, type, object } of inherited ?? [])
    {
        if (type === 'pipe' && typeof object?.across === 'function' && !ends.has(handle >>> 0))
        {
            object.retain();
            ends.set(handle >>> 0, object.across());
        }
    }
    /** @param {number} id */
    const at = id=>ends.get(id >>> 0) ?? null;
    return {
        /** What the child is told of each: its number, and what it can do. */
        described: [...ends].map(([handle, end])=>({ handle, ...end.describe() })),
        pipes: {
            /** @param {number} id @param {number} length */
            read: (id, length)=>at(id)?.read(length) ?? { status: STATUS_INVALID_HANDLE },
            /** @param {number} id @param {Uint8Array} bytes */
            write: (id, bytes)=>at(id)?.write(bytes) ?? { status: STATUS_INVALID_HANDLE },
            /** @param {number} id @param {number} size */
            peek: (id, size)=>at(id)?.peek(size) ?? { status: STATUS_INVALID_HANDLE },
            /** @param {number} id */
            cancel: id=>at(id)?.cancel() ?? 0,
            /** @param {number} id */
            close: id=>{
                at(id)?.release();
                ends.delete(id >>> 0);
            },
        },
        /** The child has ended: every end it still held is let go. */
        dispose(){
            for (const end of ends.values())
            {
                end.release();
            }
            ends.clear();
        },
    };
}
