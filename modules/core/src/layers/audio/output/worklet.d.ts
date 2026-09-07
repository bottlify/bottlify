/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The audio worklet's own global scope, which no lib describes here.
 *
 * A worklet does not run in a window or in a worker: it has a third global
 * scope with a handful of names of its own, and nothing in the checker's world
 * knows about them. Declared rather than reached for through `any`, because the
 * shape is the contract between this file and the browser, and getting it wrong
 * is silence rather than an error.
 *
 * Ambient only. Nothing here is compiled or shipped.
 */

declare class AudioWorkletProcessor {
    readonly port: MessagePort;
    constructor(options?: unknown);
}

declare function registerProcessor(
    name: string,
    processor: new (options?: any) => AudioWorkletProcessor,
): void;
