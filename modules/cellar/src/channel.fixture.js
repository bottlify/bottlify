/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A thread's blocking calls to the keeper, for the tests: one call at a time
 * per thread through a shared word and a buffer of JSON. A program wires the
 * keeper's calls through whatever link its threads already have; the cache
 * itself asks only for `KeeperCalls`.
 */

const IDLE = 0;
const ASKED = 1;
const ANSWERED = 2;
const BYTES = 64 * 1024;

/** The memory of one thread's channel. */
export const channelMemory = ()=>({
    word: new SharedArrayBuffer(8),
    data: new SharedArrayBuffer(BYTES),
});

/** @typedef {ReturnType<typeof channelMemory>} ChannelMemory */

/**
 * @param {ChannelMemory} memory @param {any} value
 */
const write = (memory, value)=>{
    const bytes = new TextEncoder().encode(JSON.stringify(value ?? null));
    const words = new Int32Array(memory.word);
    words[1] = bytes.length;
    new Uint8Array(memory.data).set(bytes);
};

/** @param {ChannelMemory} memory */
const read = memory=>{
    const length = new Int32Array(memory.word)[1];
    return JSON.parse(new TextDecoder().decode(new Uint8Array(memory.data).slice(0, length)));
};

/**
 * The calling side, in a thread that may block: `call(method, ...args)`
 * answers what the serving side's handler returned.
 *
 * @param {ChannelMemory} memory
 */
export function caller(memory){
    const words = new Int32Array(memory.word);
    return {
        /** @param {string} method @param {any[]} args */
        call(method, ...args){
            write(memory, { method, args });
            Atomics.store(words, 0, ASKED);
            Atomics.notify(words, 0);
            while (Atomics.load(words, 0) !== ANSWERED)
            {
                Atomics.wait(words, 0, ASKED, 10_000);
            }
            const answer = read(memory);
            Atomics.store(words, 0, IDLE);
            return answer;
        },
    };
}

/**
 * The serving side, in a thread that must not block: answers each call by
 * `handlers[method](...args)` until `stop`.
 *
 * @param {ChannelMemory} memory @param {Record<string, (...args: any[]) => any>} handlers
 */
export function serve(memory, handlers){
    const words = new Int32Array(memory.word);
    const state = { serving: true };
    (async()=>{
        while (state.serving)
        {
            if (Atomics.load(words, 0) === ASKED)
            {
                const { method, args } = read(memory);
                write(memory, handlers[method](...args));
                Atomics.store(words, 0, ANSWERED);
                Atomics.notify(words, 0);
                continue;
            }
            const waited = /** @type {any} */ (Atomics).waitAsync(words, 0, IDLE, 50);
            if (waited.async)
            {
                await waited.value;
            }
            else
            {
                await new Promise(resolve=>setImmediate(resolve));
            }
        }
    })();
    return {
        stop(){
            state.serving = false;
        },
    };
}
