/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The four words `cpuid` answers, one entry per leaf that answers anything
 * but zero. The figures are the pinned emulator's own, read from it once
 * (leaf 0 the vendor and the highest standard leaf, leaf 1 the family, model
 * and stepping, leaf 2 the cache descriptors, leaf 0x80000000 the highest
 * extended leaf), so cork and the emulator agree bit for bit without a
 * crossing -- except leaf 0x16, the base and maximum frequency, which is the
 * 3000 MHz cork's host counts rdtsc at (the emulator's counter runs at 1000).
 * A leaf with no entry answers four zeros.
 *
 * @typedef {Object} CpuidAnswer
 * @property {number} eax
 * @property {number} ebx
 * @property {number} ecx
 * @property {number} edx
 */

/** @type {Readonly<Record<number, CpuidAnswer>>} */
export const CPUID_LEAVES = Object.freeze({
    0x00000000: { eax: 0x16, ebx: 0x756e6547, ecx: 0x6c65746e, edx: 0x49656e69 },
    0x00000001: { eax: 0x00000673, ebx: 0x00010800, ecx: 0xc0800001, edx: 0x0780a979 },
    0x00000002: { eax: 0x665b5001, ebx: 0, ecx: 0, edx: 0x007a7000 },
    0x00000016: { eax: 0x00000bb8, ebx: 0x00000bb8, ecx: 0x0000000a, edx: 0 },
    0x80000000: { eax: 0x00000005, ebx: 0, ecx: 0, edx: 0 },
});

/** The answer to one leaf; four zeros where the table has none. @param {number} leaf */
export function cpuidLeaf(leaf){
    return CPUID_LEAVES[leaf >>> 0] ?? { eax: 0, ebx: 0, ecx: 0, edx: 0 };
}
