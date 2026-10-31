/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The engine the core's cpu layer loads.
 *
 * The contract is the core's, not this package's: `engine.js` in the cpu
 * layer says what an engine factory takes and what the runtime it returns
 * must answer, and this module is its implementation. The core reaches this
 * file through a module URL in its configuration, never through an import.
 *
 * The core's cork host runs over a memory laid out as this package translates
 * against, so it also needs that layout and the arithmetic that sizes the
 * memory. Those are re-exported here for the same reason `createEngine` is:
 * the host reaches them through the module URL, never through an import.
 *
 * @typedef {import('../../core/src/layers/cpu/engine.js').EngineEnv} EngineEnv
 * @typedef {import('../../core/src/layers/cpu/engine.js').Runtime} Runtime
 */

import { createCorkRuntime, translatorWorkerUrl } from './runtime/runtime.js';

/** The version of the core's engine contract (`ENGINE_CONTRACT` in its `engine.js`) this implements. */
export const contract = 1;

/** This package's version, which the core names the processor after. */
export { VERSION as version } from './version.js';
import { replaySlice } from './testing/differential.js';

export {
    ownLayout, executorLayout, executorBytes, sharedLayout, basesOf, pagesFor, layoutId, Tables,
    tablesSize, blockFields, LOW_STATE,
    STATE_BLOCK_SIZE, STATE_BLOCK_SIZE_64, stateBlockSize, PAGE,
} from './runtime/layout.js';
export { interpret, blockState } from './interp.js';
export { interpret64, blockState64 } from './interp64.js';
export {
    createWasmInterpreter, WasmExit, WASM_INTERPRETER_AREA, WASM_INTERPRETER_STATICS,
    WASM_INTERPRETER_STATICS_AT, HOT_SLOTS,
} from './interp-wasm.js';
export { eflagsOf, setEflags } from './emit/flags.js';
export { SHARED_CODE_BYTES } from './runtime/shared-code.js';
export { createArena } from './runtime/arena.js';
export { snapshot, restore, compare } from './testing/snapshot.js';
export { readUndoLog, resetUndoLog, spansOf } from './emit/memory.js';
export { slotOf } from './runtime/entries.js';
export { replaySlice, translatorWorkerUrl };
export { createMachine } from './machine.js';
export { regionModule } from './region-module.js';

/**
 * Builds a runtime over the memory and layout the core hands in.
 *
 * @param {EngineEnv} env
 * @returns {Runtime}
 */
export function createEngine(env){
    return createCorkRuntime(env);
}
