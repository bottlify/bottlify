/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The brand string leaves 0x80000002 to 0x80000004 spell, sixteen bytes each,
 * the rest NUL: no product's name, as a virtual machine that does not pass its
 * host's processor through names its own, at the rate the time-stamp counter
 * counts (`CORK_TSC_MHZ` in the core's cork host).
 */
export const BRAND = 'Bottlify Virtual CPU @ 3.00GHz';

/**
 * Leaves 0x80000002..4 as words: the brand's bytes little-endian, four to a register.
 *
 * @returns {CpuidAnswer[]}
 */
function brandLeaves(){
    const bytes = new Uint8Array(48);
    bytes.set(new TextEncoder().encode(BRAND));
    const word = (/** @type {number} */ at)=>(bytes[at] | bytes[at + 1] << 8 | bytes[at + 2] << 16
        | bytes[at + 3] << 24) >>> 0;
    return [0, 16, 32].map(at=>Object.freeze({ eax: word(at), ebx: word(at + 4),
        ecx: word(at + 8), edx: word(at + 12) }));
}
const [BRAND_0, BRAND_1, BRAND_2] = brandLeaves();

/**
 * The four words `cpuid` answers, one entry per leaf that answers anything
 * but zero: the processor every program run here is told it runs on.
 *
 * It is a processor of the class whose instructions the engine executes, so
 * a program that picks its code by what CPUID says picks code that runs: an
 * Intel family 15 (Pentium 4 and Pentium D, 90 and 65 nm), the one line with
 * SSE3 and x86-64 and neither SSSE3 nor SSE4. Leaf 0 the vendor and the
 * highest standard leaf; 1 the signature (family 15, model 6, stepping 5), a
 * 64-byte CLFLUSH line, and the features: x87, TSC, CX8, SYSENTER, CMOV, MMX,
 * FXSR, SSE, SSE2, CLFLUSH, SSE3 and CMPXCHG16B (the 64-bit process's); 2 the
 * descriptors of that class's caches (a 12K-uop trace cache, a 16 KiB 8-way
 * data cache, a 2 MiB 8-way level 2); 4 the same caches by subleaf; 0x15 (a
 * 1 GHz crystal times 3/1) and 0x16 (base and maximum), which state the 3000
 * MHz cork's host counts rdtsc at (`CORK_TSC_MHZ`) for a program that reads
 * its clock from them. The extended leaves: 0x80000001 LAHF/SAHF in 64-bit
 * mode, execute-disable and long mode; the brand (`BRAND`); 0x80000006 the
 * level 2 cache again; 0x80000008 36 physical and 48 linear address bits.
 *
 * Nothing says it is virtual: no hypervisor bit, no hypervisor leaves. Copy
 * protection of the programs' time refuses to run under a hypervisor it finds.
 * A leaf with no entry, or a subleaf a leaf does not list, answers four zeros.
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
    0x00000001: { eax: 0x00000f65, ebx: 0x00010800, ecx: 0x00002001, edx: 0x0788a979 },
    0x00000002: { eax: 0x605b5001, ebx: 0, ecx: 0, edx: 0x007d7040 },
    0x00000004: Object.freeze({
        0: { eax: 0x00000121, ebx: 0x01c0003f, ecx: 0x0000001f, edx: 0x00000001 },
        1: { eax: 0x00000143, ebx: 0x01c0003f, ecx: 0x00000fff, edx: 0x00000001 },
    }),
    0x00000015: { eax: 0x00000001, ebx: 0x00000003, ecx: 0x3b9aca00, edx: 0 },
    0x00000016: { eax: 0x00000bb8, ebx: 0x00000bb8, ecx: 0x0000000a, edx: 0 },
    0x80000000: { eax: 0x80000008, ebx: 0, ecx: 0, edx: 0 },
    0x80000001: { eax: 0, ebx: 0, ecx: 0x00000001, edx: 0x20100000 },
    0x80000002: BRAND_0,
    0x80000003: BRAND_1,
    0x80000004: BRAND_2,
    0x80000006: { eax: 0, ebx: 0, ecx: 0x08006040, edx: 0 },
    0x80000008: { eax: 0x00003024, ebx: 0, ecx: 0, edx: 0 },
});

const ZEROS = Object.freeze({ eax: 0, ebx: 0, ecx: 0, edx: 0 });

/** A table of leaves, as `CPUID_LEAVES`. @typedef {typeof CPUID_LEAVES} Leaves */

/** EDX bit 28 of leaf 1: the package holds more than one logical processor. */
const HTT = 1 << 28;

/**
 * The processors `cpuid` describes: how many, and which one the code asking runs
 * on. One processor, the first, answers the table as it stands.
 *
 * @typedef {Object} Topology
 * @property {number} processors  1 to 32 -- the bits of an x86 affinity mask: a
 *     package of that many cores, one thread each, every core with caches of its own
 * @property {number} processor   0 to processors - 1: the initial APIC id
 */

/** @type {Topology} */
const ONE = Object.freeze({ processors: 1, processor: 0 });

/**
 * The tables made for other topologies, by `processors * 32 + processor`: an
 * interpreter answers `cpuid` from one at every execution.
 *
 * @type {Map<number, Leaves>}
 */
const described = new Map();

/**
 * The processors a layout's executor describes (`StateLayout.processors`), it
 * one of them: its own, or `played` while it plays another's -- an executor
 * running a thread pinned to a processor that is not its own number (the
 * kernel's scheduler trades them), whose `cpuid` names the processor the
 * thread is pinned to, as on the machine.
 *
 * @param {{ processors?: number, processor?: number } | null | undefined} layout
 * @param {number} [played]
 * @returns {Topology}
 */
export const topologyOf = (layout, played)=>(layout?.processors ?? 1) > 1
    ? { processors: /** @type {number} */ (layout?.processors),
        processor: played ?? layout?.processor ?? 0 }
    : ONE;

/**
 * The table as `topology` answers it. Engines count cores the way Intel says
 * to -- leaf 1's logical count and the HTT bit, leaf 4's cores per package,
 * the APIC id each processor its threads are pinned to reads -- so those are
 * the fields that move: EBX[23:16] the processors in the package and
 * EBX[31:24] this one's id, HTT where there is more than one, and EAX[31:26]
 * of every cache subleaf the cores less one. No two processors share a cache
 * (EAX[25:14] stays zero), so a program counts as many cores as threads.
 *
 * @param {Topology} topology
 * @returns {Leaves}
 */
export function cpuidLeaves({ processors, processor }){
    if (processors === 1 && processor === 0)
    {
        return CPUID_LEAVES;
    }
    const key = processors * 32 + processor;
    const made = described.get(key);
    if (made !== undefined)
    {
        return made;
    }
    if (!(Number.isInteger(processors) && processors >= 1 && processors <= 32
        && Number.isInteger(processor) && processor >= 0 && processor < processors))
    {
        throw new Error(`cpuid: processor ${processor} of ${processors}`);
    }
    const one = /** @type {CpuidAnswer} */ (CPUID_LEAVES[1]);
    const caches = /** @type {Readonly<Record<number, CpuidAnswer>>} */ (CPUID_LEAVES[4]);
    const leaves = Object.freeze({
        ...CPUID_LEAVES,
        1: Object.freeze({ ...one,
            ebx: (one.ebx & 0x0000ffff | processors << 16 | processor << 24) >>> 0,
            edx: (processors > 1 ? one.edx | HTT : one.edx) >>> 0 }),
        4: Object.freeze(Object.fromEntries(Object.entries(caches).map(([subleaf, answer])=>
            [subleaf, Object.freeze({ ...answer,
                eax: (answer.eax & 0x03ffffff | processors - 1 << 26) >>> 0 })]))),
    });
    described.set(key, leaves);
    return leaves;
}

/**
 * What the system-table stores answer, as 32-bit Windows has them: the
 * interrupt and global descriptor tables where its kernel keeps them, no
 * local table, the task register's selector, and CR0 with paging, write
 * protection and the FPU's bits set. A program that compares the tables'
 * bases with a virtual machine's finds a machine of its own.
 */
export const SYSTEM_TABLES = Object.freeze({
    idt: Object.freeze({ limit: 0x7ff, base: 0x8003f400 }),
    gdt: Object.freeze({ limit: 0x3ff, base: 0x8003f000 }),
    ldt: 0,
    tr: 0x28,
    cr0: 0x8001003b,
});

/**
 * The answer to one leaf and subleaf; four zeros where the table has none.
 *
 * @param {number} leaf  EAX
 * @param {number} [subleaf]  ECX, read only by a leaf with subleaves
 * @param {Topology} [topology]  the processors described, one unless given
 * @returns {CpuidAnswer}
 */
export function cpuidLeaf(leaf, subleaf = 0, topology = ONE){
    const entry = cpuidLeaves(topology)[leaf >>> 0];
    if (entry === undefined)
    {
        return ZEROS;
    }
    return 'eax' in entry ? /** @type {CpuidAnswer} */ (entry)
        : /** @type {Record<number, CpuidAnswer>} */ (entry)[subleaf >>> 0] ?? ZEROS;
}
