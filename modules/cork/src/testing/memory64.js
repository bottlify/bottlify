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
 * a later one no longer knows (V8 14 prints it as unrecognized).
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
