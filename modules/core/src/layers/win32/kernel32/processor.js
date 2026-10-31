/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The processor this machine has, described once, and how many of it.
 *
 * A program learns about the processor four ways -- the CPUID instruction,
 * GetSystemInfo, IsProcessorFeaturePresent, the registry keys the kernel wrote
 * at boot -- plus the processor count the process block, the native query,
 * the environment and WMI carry. Engines read whichever they were written
 * against to pick a vector path or size a thread pool, and a machine that
 * answers two of them differently is one they decide is unsupported. So every
 * answer here comes from this record, and the record is what the emulated
 * processor's own CPUID says: family, model and stepping from leaf 1's EAX,
 * the features from its EDX and ECX, the caches from leaf 4.
 * `src/processor.itest.js` runs the instruction and holds the two to each
 * other.
 *
 * The count is not part of the record: it is the run's, one processor for each
 * executor the process runs its threads on, and only the kernel knows it. Every
 * interface asks it through `createProcessors`, at the call, so none can
 * answer a count another has not been told.
 */

/** CPUID leaf 1's EDX bits this record reads. */
const EDX = Object.freeze({
    FPU: 1 << 0, TSC: 1 << 4, PAE: 1 << 6, CX8: 1 << 8, CMOV: 1 << 15,
    MMX: 1 << 23, FXSR: 1 << 24, SSE: 1 << 25, SSE2: 1 << 26,
});

/** And its ECX bits. */
const ECX = Object.freeze({ SSE3: 1 << 0, CX16: 1 << 13, POPCNT: 1 << 23, RDRAND: 1 << 30 });

/**
 * What the emulated processor answers to CPUID, leaf 0, leaf 1 and leaf 4, as
 * one processor: with more, leaf 1 also sets HTT and names the count and the
 * asking processor in EBX (cork's `cpuidLeaves`).
 */
export const CPUID = Object.freeze({
    vendor: 'GenuineIntel',
    signature: 0x00000f65,
    edx: 0x0788a979,
    ecx: 0x00002001,
    /**
     * Leaf 4's subleaves, EAX, EBX and ECX, one per cache: a level 1 data
     * cache of 16 KiB, then a unified level 2 of 2 MiB (the class's level 1
     * instructions are a trace cache, which leaf 4 does not list). More
     * processors change only EAX[31:26], the cores in the package less one,
     * which nothing here reads: no two processors share a cache.
     */
    caches: Object.freeze([
        Object.freeze({ eax: 0x00000121, ebx: 0x01c0003f, ecx: 0x0000001f }),
        Object.freeze({ eax: 0x00000143, ebx: 0x01c0003f, ecx: 0x00000fff }),
    ]),
});

/** The processor, as everything below reports it. */
export const PROCESSOR = Object.freeze({
    vendor: CPUID.vendor,
    family: CPUID.signature >>> 8 & 0xf,
    model: CPUID.signature >>> 4 & 0xf,
    stepping: CPUID.signature & 0xf,
    /**
     * The speed Windows measures at boot and writes for the processor where
     * no engine gives its own. A run's is the rate cork's host counts rdtsc
     * at, which CPUID's leaves 0x15 and 0x16 and its brand state and
     * `createApp` passes in as `processorMhz`: a program turns rdtsc deltas
     * into seconds with it, and any other figure puts its clocks out by that
     * ratio.
     */
    mhz: 1000,
});

/** What the registry's CentralProcessor key names the processor. */
export const PROCESSOR_IDENTIFIER =
    `x86 Family ${PROCESSOR.family} Model ${PROCESSOR.model} Stepping ${PROCESSOR.stepping}`;

/** What the processor is called where no engine names it: CPUID's brand string. */
export const PROCESSOR_NAME = 'Bottlify Virtual CPU @ 3.00GHz';

/** SYSTEM_INFO's wProcessorLevel and wProcessorRevision: the family, then model and stepping. */
export const PROCESSOR_LEVEL = PROCESSOR.family;
export const PROCESSOR_REVISION = PROCESSOR.model << 8 | PROCESSOR.stepping;

/** Leaf 4's cache type, EAX[4:0]. */
const CACHE_KINDS = Object.freeze(/** @type {const} */ ({ 1: 'data', 2: 'instruction',
    3: 'unified' }));

/**
 * @typedef {Object} ProcessorCache
 * @property {number} level
 * @property {'data' | 'instruction' | 'unified'} type
 * @property {number} ways  How many lines a set holds.
 * @property {number} lineSize  In bytes.
 * @property {number} size  In bytes: ways, partitions, line and sets multiplied.
 */

/**
 * Each processor's caches, as leaf 4 describes them: what a program asking
 * GetLogicalProcessorInformation sizes its blocks from, and what one running
 * CPUID itself reads.
 *
 * @type {readonly ProcessorCache[]}
 */
export const PROCESSOR_CACHES = Object.freeze(CPUID.caches.map(({ eax, ebx, ecx })=>{
    const ways = (ebx >>> 22) + 1;
    const lineSize = (ebx & 0xfff) + 1;
    return Object.freeze({
        level: eax >>> 5 & 7,
        type: CACHE_KINDS[/** @type {1 | 2 | 3} */ (eax & 0x1f)],
        ways,
        lineSize,
        size: ways * ((ebx >>> 12 & 0x3ff) + 1) * lineSize * ((ecx >>> 0) + 1),
    });
}));

/**
 * The most processors a process can be told of: the bits of a 32-bit
 * affinity mask, and MAXIMUM_PROCESSORS on x86.
 */
export const MAXIMUM_PROCESSORS = 32;

/**
 * A count of processors as a machine can have it: at least one, and no more
 * than a mask has bits.
 *
 * @param {number} asked
 */
export const processorCount = asked=>Math.min(MAXIMUM_PROCESSORS, Math.max(1, Math.trunc(asked)));

/**
 * The affinity mask naming processors 0 to `count` - 1.
 *
 * @param {number} count  1 to MAXIMUM_PROCESSORS
 */
export const processorMask = count=>(2 ** count - 1) >>> 0;

/**
 * What of the kernel's API the processors are asked of. Each part is optional
 * so a kernel that has not learned it answers as one processor always has.
 *
 * @typedef {Object} ProcessorKernel
 * @property {() => number} [processors]  How many the machine has: the
 *           process's executors.
 * @property {(thread: any) => number} [processorOf]  The one a thread runs
 *           on now; 0 for one that runs nowhere.
 * @property {() => any[]} [threads]  The process's threads.
 */

/**
 * The processors one process is told of and may run on: as many as the
 * kernel says the machine has, and the masks SetProcessAffinityMask and
 * SetThreadAffinityMask narrow, which the scheduler honours as
 * `thread.affinityMask` (undefined is every processor). One of these per
 * process, handed to every interface that reports or sets either -- two would
 * be two owners of the process's mask.
 *
 * @param {ProcessorKernel} [kernel]  Absent, a machine of one processor.
 */
export function createProcessors(kernel = {}){
    /**
     * The process's mask once a program has narrowed it; null while it is
     * the whole machine.
     *
     * @type {number | null}
     */
    let narrowed = null;
    const count = ()=>processorCount(kernel.processors?.() ?? 1);
    const systemMask = ()=>processorMask(count());
    const processMask = ()=>narrowed ?? systemMask();

    return {
        count,
        systemMask,
        processMask,

        /** @param {any} thread */
        threadMask: thread=>(thread.affinityMask ?? processMask()) >>> 0,

        /** @param {any} thread */
        processorOf: thread=>kernel.processorOf?.(thread) ?? 0,

        /**
         * SetProcessAffinityMask: the process, and every thread of it, on
         * the processors `mask` names -- Windows gives each thread its
         * process's mask. False, with nothing changed, for a mask naming none
         * or one the machine does not have (Wine's ntdll test_affinity).
         *
         * @param {number} mask
         */
        setProcessMask(mask){
            const wanted = mask >>> 0;
            if (wanted === 0 || (wanted & ~systemMask()) !== 0)
            {
                return false;
            }
            narrowed = wanted === systemMask() ? null : wanted;
            for (const thread of kernel.threads?.() ?? [])
            {
                thread.affinityMask = wanted;
            }
            return true;
        },

        /**
         * The mask SetThreadAffinityMask gives a thread for `mask`, or 0 where
         * it refuses, as Windows from Vista on answers (Wine's kernel32 and
         * ntdll affinity tests): every bit set is every processor the process
         * has; any other mask loses the bits past the machine's processors,
         * and what is left must name at least one, and only the process's.
         *
         * @param {number} mask
         */
        threadMaskFor(mask){
            const asked = mask >>> 0;
            if (asked === 0xffffffff)
            {
                return processMask();
            }
            const wanted = (asked & systemMask()) >>> 0;
            return wanted !== 0 && (wanted & ~processMask()) === 0 ? wanted : 0;
        },

        /**
         * A thread just made starts on its process's processors, which is
         * every one until a program narrows them.
         *
         * @param {any} thread
         */
        adopt(thread){
            if (narrowed !== null)
            {
                thread.affinityMask = narrowed;
            }
        },
    };
}

/** @typedef {ReturnType<typeof createProcessors>} Processors */

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
    [14, hasEcx(ECX.CX16)],      // PF_COMPARE_EXCHANGE128
    [28, hasEcx(ECX.RDRAND)],    // PF_RDRAND_INSTRUCTION_AVAILABLE
]);
