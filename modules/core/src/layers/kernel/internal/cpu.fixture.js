/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What the scheduler asks of the cpu layer past running a slice, for a test
 * that builds it over a processor of its own: answering as a 32-bit cpu
 * with one executor, no worker beside it and nothing watched does.
 */
export const oneExecutorCpu = Object.freeze({
    layout: { memorySize: 16 << 20 },
    bits: ()=>32,
    eip: ()=>0,
    stop: ()=>{},
    processors: ()=>1,
    executors: ()=>[],
    executorBell: ()=>null,
    wantExecutors: ()=>{},
    wantExecutor: ()=>false,
    awaitedBy: ()=>{},
    trapTimed: ()=>{},
    beforeTrap: ()=>{},
    interruptible: ()=>false,
    playProcessor: ()=>{},
    noteUnbroken: ()=>{},
    noteStack: ()=>{},
    raiseFault: ()=>{},
    remoteFault: ()=>{},
    useGuestClock: ()=>{},
    setContextLong: ()=>{},
});
