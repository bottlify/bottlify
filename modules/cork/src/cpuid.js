/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The four words `cpuid` answers, one entry per leaf that answers anything
 * but zero. The figures are the pinned emulator's own, read from it once, so
 * cork and the emulator agree bit for bit without a crossing: leaf 0 the vendor
 * and the highest standard leaf, 1 the family, model, stepping and features,
 * 2 the cache descriptors, 4 the cache parameters (by subleaf), 5 the monitor
 * line sizes, 7 the extended features (subleaf 0), 0x40000000 the hypervisor's
 * name, 0x80000000 the highest extended leaf -- except the clock leaves, 0x15
 * (a 1 GHz crystal times 3/1) and 0x16 (base and maximum), which state the
 * 3000 MHz cork's host counts rdtsc at (`CORK_TSC_MHZ`; the emulator's counter
 * and its leaves run at 1000). A leaf with no entry, or a subleaf a leaf does
 * not list, answers four zeros.
 * The hypervisor bit in leaf 1 and the VMware name at 0x40000000 are the
 * emulator's too: a real processor of this signature has neither, but the two
 * engines must answer alike, and the emulator's answer is compiled into it.
 *
 * @typedef {Object} CpuidAnswer
 * @property {number} eax
 * @property {number} ebx
 * @property {number} ecx
 * @property {number} edx
 */

/**
 * @type {Readonly<Record<number, CpuidAnswer | Readonly<Record<number, CpuidAnswer>>>>}
 *     a leaf's answer, or for a leaf ECX selects a subleaf of, its answers by subleaf
 */
export const CPUID_LEAVES = Object.freeze({
    0x00000000: { eax: 0x16, ebx: 0x756e6547, ecx: 0x6c65746e, edx: 0x49656e69 },
    0x00000001: { eax: 0x00000673, ebx: 0x00010800, ecx: 0xc0800001, edx: 0x0780a979 },
    0x00000002: { eax: 0x665b5001, ebx: 0, ecx: 0, edx: 0x007a7000 },
    0x00000004: Object.freeze({
        0: { eax: 0x00000121, ebx: 0x01c0003f, ecx: 0x0000003f, edx: 0x00000001 },
        1: { eax: 0x00000122, ebx: 0x01c0003f, ecx: 0x0000003f, edx: 0x00000001 },
        2: { eax: 0x00000143, ebx: 0x05c0003f, ecx: 0x00000fff, edx: 0x00000001 },
    }),
    0x00000005: { eax: 0x00000040, ebx: 0x00000040, ecx: 0x00000003, edx: 0x00142120 },
    0x00000007: Object.freeze({ 0: { eax: 0, ebx: 0x00000200, ecx: 0, edx: 0 } }),
    0x00000015: { eax: 0x00000001, ebx: 0x00000003, ecx: 0x3b9aca00, edx: 0 },
    0x00000016: { eax: 0x00000bb8, ebx: 0x00000bb8, ecx: 0x0000000a, edx: 0 },
    0x40000000: { eax: 0, ebx: 0x61774d56, ecx: 0x4d566572, edx: 0x65726177 },
    0x80000000: { eax: 0x00000005, ebx: 0, ecx: 0, edx: 0 },
});

const ZEROS = Object.freeze({ eax: 0, ebx: 0, ecx: 0, edx: 0 });

/**
 * The answer to one leaf and subleaf; four zeros where the table has none.
 *
 * @param {number} leaf  EAX
 * @param {number} [subleaf]  ECX, read only by a leaf with subleaves
 * @returns {CpuidAnswer}
 */
export function cpuidLeaf(leaf, subleaf = 0){
    const entry = CPUID_LEAVES[leaf >>> 0];
    if (entry === undefined)
    {
        return ZEROS;
    }
    return 'eax' in entry ? /** @type {CpuidAnswer} */ (entry)
        : /** @type {Record<number, CpuidAnswer>} */ (entry)[subleaf >>> 0] ?? ZEROS;
}
