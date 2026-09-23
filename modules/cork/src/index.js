/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The engine the core's cpu layer loads when a launch selects cork.
 *
 * The contract is the core's, not this package's: `engine.js` in the cpu
 * layer says what an engine factory takes and what the runtime it returns
 * must answer, and this module is one implementation of it. The core reaches
 * this file through a module URL in its configuration, never through an
 * import -- a launch that selects the emulator runs with this package absent.
 *
 * Under `engine: 'cork'` (milestone 5) the core's cork host runs over a memory
 * of its own rather than the emulator's, so it also needs the layout this
 * package translates against and the arithmetic that sizes that memory. Those
 * are re-exported here for the same reason `createEngine` is: the host reaches
 * them through the module URL, never through an import.
 *
 * @typedef {import('../../core/src/layers/cpu/engine.js').EngineEnv} EngineEnv
 * @typedef {import('../../core/src/layers/cpu/engine.js').Runtime} Runtime
 */

import { createCorkRuntime } from './runtime/runtime.js';
import { replaySlice } from './testing/differential.js';

export {
    ownLayout, pagesFor, layoutId, Tables, STATE_BLOCK_SIZE, PAGE,
} from './runtime/layout.js';
export { interpret, blockState } from './interp.js';
export { snapshot, restore, compare } from './testing/snapshot.js';
export { replaySlice };

/**
 * Builds a runtime over the memory and layout the core hands in.
 *
 * @param {EngineEnv} env
 * @returns {Runtime}
 */
export function createEngine(env){
    return createCorkRuntime(env);
}
