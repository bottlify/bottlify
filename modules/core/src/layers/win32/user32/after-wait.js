/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What a handler does after something it waited for: at once when there was
 * no wait, and after one as the call of the thread it was answering when the
 * wait began.
 *
 * A handler that waited has let its thread go: by the time it goes on, the
 * thread the host reads as the caller is whichever ran last, on a machine of
 * several executors one that is not the caller's at all. A message sent then
 * is sent from that thread - to the caller's own window across threads, and
 * waits for the caller to dispatch it, which is waiting here. So the caller is
 * read when the wait begins and named again when it ends (`host.answering`).
 *
 * @param {{ callerThread?: () => unknown,
 *     answering?: <T>(thread: unknown, fn: () => T) => T }} host
 * @returns {(value: any, then: (answer: any) => any) => any}
 */
export function afterWait(host){
    return (value, then)=>{
        if (typeof value?.then !== 'function')
        {
            return then(value);
        }
        const thread = host.callerThread?.() ?? null;
        return value.then((/** @type {any} */ answer)=>(thread !== null && host.answering
            ? host.answering(thread, ()=>then(answer)) : then(answer)));
    };
}
