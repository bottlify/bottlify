/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The cpu layer as the memory layer takes it, for a test or a tool that
 * builds memory over guest bytes of its own (`raw`: readPhysical,
 * writePhysical and what else it has): the rest answering as a cpu whose
 * memory never grows, is charged nothing and watches no writes does.
 *
 * @param {Record<string, any>} raw
 */
export const cpuForMemory = raw=>({
    onGrow: ()=>{},
    chargeGuest: ()=>true,
    giveGuest: ()=>{},
    pageAccess: ()=>false,
    farSpace: ()=>null,
    growTo: ()=>Infinity,
    ramHeld: ()=>Infinity,
    growing: ()=>false,
    engineRange: ()=>({ from: 0, to: 0 }),
    ramView: ()=>null,
    watchWrites: ()=>null,
    /** A dword of the guest's bytes, little-endian, as the cpu reads one. @param {number} at */
    readU32: at=>{
        const bytes = raw.readPhysical(at, 4);
        return (bytes[0] | bytes[1] << 8 | bytes[2] << 16 | bytes[3] << 24) >>> 0;
    },
    ...raw,
});
