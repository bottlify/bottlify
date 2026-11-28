/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What win32 asks of the memory layer past reading and writing, for a test
 * that builds win32 over a memory of its own: answering as a memory with
 * room for anything, no far space and nothing watched does.
 */
export const memoryLayerAnswers = Object.freeze({
    reach: ()=>Infinity,
    charge: ()=>true,
    pageAccess: ()=>false,
    farSpace: ()=>null,
    watchWrites: ()=>null,
    wordsOver: ()=>null,
});
