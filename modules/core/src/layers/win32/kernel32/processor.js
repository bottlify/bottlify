/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The one processor this machine has, described once.
 *
 * A program learns about the processor four ways -- the CPUID instruction,
 * GetSystemInfo, IsProcessorFeaturePresent, the registry keys the kernel wrote
 * at boot -- plus the processor count the process block and the native query
 * carry. Engines read whichever they were written against to pick a vector
 * path or size a thread pool, and a machine that answers two of them
 * differently is one they decide is unsupported. So every answer here comes
 * from this record, and the record is what the emulated processor's own CPUID
 * says: family, model and stepping from leaf 1's EAX, the features from its
 * EDX and ECX. `src/processor.itest.js` runs the instruction and holds the two
 * to each other.
 */

/** CPUID leaf 1's EDX bits this record reads. */
const EDX = Object.freeze({
    FPU: 1 << 0, TSC: 1 << 4, PAE: 1 << 6, CX8: 1 << 8, CMOV: 1 << 15,
    MMX: 1 << 23, FXSR: 1 << 24, SSE: 1 << 25, SSE2: 1 << 26,
});

/** And its ECX bits. */
const ECX = Object.freeze({ SSE3: 1 << 0, POPCNT: 1 << 23, RDRAND: 1 << 30 });

/** What the emulated processor answers to CPUID, leaf 0 and leaf 1. */
export const CPUID = Object.freeze({
    vendor: 'GenuineIntel',
    signature: 0x00000673,
    edx: 0x0780a979,
    ecx: 0xc0800001,
});

/** The processor, as everything below reports it. */
export const PROCESSOR = Object.freeze({
    vendor: CPUID.vendor,
    family: CPUID.signature >>> 8 & 0xf,
    model: CPUID.signature >>> 4 & 0xf,
    stepping: CPUID.signature & 0xf,
    count: 1,
    /**
     * The rate the time-stamp counter advances at, which is what Windows
     * measures at boot and writes as the processor's speed: one tick per host
     * nanosecond, the emulated counter's rate and the base frequency the
     * emulated CPUID reports. A program turns rdtsc deltas into seconds with
     * it, and any other figure puts its clocks out by that ratio.
     */
    mhz: 1000,
});

/** What the registry's CentralProcessor key names the processor. */
export const PROCESSOR_IDENTIFIER =
    `x86 Family ${PROCESSOR.family} Model ${PROCESSOR.model} Stepping ${PROCESSOR.stepping}`;

/** What the processor is called where no engine names it. */
export const PROCESSOR_NAME = 'Bottlify x86';

/** SYSTEM_INFO's wProcessorLevel and wProcessorRevision: the family, then model and stepping. */
export const PROCESSOR_LEVEL = PROCESSOR.family;
export const PROCESSOR_REVISION = PROCESSOR.model << 8 | PROCESSOR.stepping;

/** @param {number} bit */
const hasEdx = bit=>(CPUID.edx & bit) !== 0;
/** @param {number} bit */
const hasEcx = bit=>(CPUID.ecx & bit) !== 0;

/**
 * IsProcessorFeaturePresent's answers, by PF_ number. A feature not listed is
 * one the program must not use, so the default answer is no.
 *
 * Two that CPUID would say yes to are no: execute-disable because nothing
 * enforces it, and PAE because the question is whether the system runs with
 * it on, which a machine without paging does not.
 *
 * @type {ReadonlyMap<number, boolean>}
 */
export const PROCESSOR_FEATURES = new Map([
    [0, false],                  // PF_FLOATING_POINT_PRECISION_ERRATA
    [1, !hasEdx(EDX.FPU)],       // PF_FLOATING_POINT_EMULATED
    [2, hasEdx(EDX.CX8)],        // PF_COMPARE_EXCHANGE_DOUBLE
    [3, hasEdx(EDX.MMX)],        // PF_MMX_INSTRUCTIONS_AVAILABLE
    [6, hasEdx(EDX.SSE)],        // PF_XMMI_INSTRUCTIONS_AVAILABLE
    [7, false],                  // PF_3DNOW_INSTRUCTIONS_AVAILABLE
    [8, hasEdx(EDX.TSC)],        // PF_RDTSC_INSTRUCTION_AVAILABLE
    [9, false],                  // PF_PAE_ENABLED
    [10, hasEdx(EDX.SSE2)],      // PF_XMMI64_INSTRUCTIONS_AVAILABLE
    [12, false],                 // PF_NX_ENABLED
    [13, hasEcx(ECX.SSE3)],      // PF_SSE3_INSTRUCTIONS_AVAILABLE
    [14, false],                 // PF_COMPARE_EXCHANGE128
    [28, hasEcx(ECX.RDRAND)],    // PF_RDRAND_INSTRUCTION_AVAILABLE
]);
