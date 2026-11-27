/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Test support: memory64 in node, for the tests of the wide windows. An
 * engine that validates a module declaring a 64-bit memory is left as it is
 * (node 22.22 already, any V8 from 13 on); one that does not is given
 * `--experimental-wasm-memory64`, the flag an earlier V8 kept it behind and
 * a later one no longer knows (V8 14 prints it as unrecognized). A test of a
 * memory the machine has no room for says so and is skipped (`ifRoom`).
 */

import v8 from 'node:v8';

/** The smallest module with a memory64: a memory section of one memory, flags 4, no pages. */
const MEMORY64_MODULE = new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, 5, 3, 1, 4, 0]);

/** Lets the engine make memory64 memories and modules, asking for the flag only where it must. */
export function allowMemory64(){
    if (!WebAssembly.validate(MEMORY64_MODULE))
    {
        v8.setFlagsFromString('--experimental-wasm-memory64');
    }
}

/**
 * A test that makes a big memory - a wide window's memory64, long mode's 4 GiB
 * (`testing/long-machine.js`) - run as node:test's function: where the machine
 * gives no memory for it (another job holding the address space, a limit on
 * virtual memory), it is skipped saying it measured nothing, instead of failing
 * as if the translator were wrong. Only a refusal for want of memory is taken so: an
 * engine that cannot make memory64 at all fails the test, as it should. Asked
 * when the test runs, not ahead of it: a memory made to ask stays reserved
 * until collected, and the test's own would then be the one refused.
 *
 * @param {(t: import('node:test').TestContext) => void | Promise<void>} body
 * @returns {(t: import('node:test').TestContext) => void | Promise<void>}
 */
export function ifRoom(body){
    /** @param {import('node:test').TestContext} t @param {unknown} e */
    const refused = (t, e)=>{
        const message = String(/** @type {Error} */ (e)?.message ?? e);
        if (e instanceof RangeError && /could not allocate|out of memory/i.test(message))
        {
            t.skip(`not measured: this machine gave no memory for it (${message})`);
            return;
        }
        throw e;
    };
    return t=>{
        try
        {
            const done = body(t);
            return done instanceof Promise ? done.catch(e=>refused(t, e)) : done;
        }
        catch (e){
            return refused(t, e);
        }
    };
}
