/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { createProcessors } from './kernel32/processor.js';

/**
 * What win32 asks of the kernel layer past its handles, clock and current
 * thread, for a test that builds win32 over a kernel of its own: answering as
 * a kernel on one processor, with no threads listed, no processes beside this
 * one and every thread settled at once does.
 */
export const kernelLayerAnswers = Object.freeze({
    processors: ()=>1,
    processorOf: ()=>0,
    threads: ()=>[],
    processCpuMs: ()=>0,
    flushProcessWrites: ()=>true,
    onTimeout: ()=>{},
    settleThread: ()=>true,
    processes: Object.freeze({
        STILL_ACTIVE: 259,
        all: ()=>[],
        run: ()=>[],
        find: ()=>null,
        finished: ()=>false,
        finish: ()=>{},
    }),
});

/**
 * The process's processors as win32 makes them from the kernel, over
 * `kernelLayerAnswers` (one processor) or the kernel answers given: a fresh
 * set each call, its own affinity mask.
 *
 * @param {Record<string, any>} [kernel]
 */
export const testProcessors = (kernel = {})=>createProcessors({ ...kernelLayerAnswers, ...kernel });
