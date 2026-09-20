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
 * @typedef {import('../../core/src/layers/cpu/engine.js').EngineEnv} EngineEnv
 * @typedef {import('../../core/src/layers/cpu/engine.js').Runtime} Runtime
 */

/**
 * Builds a runtime over the memory and layout the core hands in.
 *
 * Nothing is translated yet: the package exists so the seam can be built and
 * checked before anything crosses it. Until the runtime lands, asking for an
 * engine is refused loudly rather than answered with one that runs nothing.
 *
 * @param {EngineEnv} env
 * @returns {Runtime}
 */
export function createEngine(env){
    void env;
    throw new Error('cork: not built yet');
}
