/*
 * Copyright © 2026 Bottlify Project
 * Licensed under BSD-2-Clause License
 * See LICENSE for details
 */

/**
 * The boot ROM: what the guest CPU executes between reset and our code.
 *
 * Bottlify does not boot a BIOS. v86 maps a bios image at `0x100000 - size`,
 * so a 64 KiB image lands at 0xF0000 and the reset vector F000:FFF0 falls
 * inside it — the same entry a real BIOS ROM gets. We hand v86 this image
 * instead of SeaBIOS, so the only instructions executed before the guest
 * program are the ~15 below.
 *
 * The mode switch is performed by real guest instructions (lgdt → CR0.PE →
 * far jump) rather than by writing v86's CPU fields from the host: every
 * descriptor cache and derived segment value inside the emulator then ends up
 * consistent by construction, instead of by us reproducing its invariants.
 *
 * The protected-mode entry jumps *indirectly*, through a dword in RAM. It has
 * to: the ROM is needed to construct the emulator, but the guest entry point
 * is only known after the loader has mapped a PE image, and mapping needs an
 * emulator to write memory into. Indirection breaks that cycle — the ROM stays
 * fixed and the entry point becomes data written before the CPU starts.
 */

export const ROM_SIZE = 0x10000;

/** Linear address the ROM is mapped at, given how v86 places a bios image. */
export const ROM_BASE = 0x100000 - ROM_SIZE;

/** Offsets within the ROM. */
const OFF_INIT16 = 0x000;
const OFF_GDT = 0x100;
const OFF_GDT_PTR = 0x120;
const OFF_PM_ENTRY = 0x200;
const OFF_IDT = 0x400;
const OFF_IDT_PTR = 0x600;
const OFF_FAULT_STUBS = 0x700;
const OFF_RESET = 0xfff0;

/**
 * How many interrupt vectors get a gate.
 *
 * The first thirty-two are the processor's own exceptions, and they are the
 * ones that matter: without a gate the emulator has nowhere to dispatch a fault
 * to and stops the machine, so a divide by zero, a bad pointer or an illegal
 * instruction all arrive as "the emulator gave up" rather than as themselves.
 */
const VECTORS = 32;

/** Bytes each fault stub occupies. Eleven are used; the slot is a round number. */
const FAULT_STUB_SIZE = 16;

/**
 * The trap this ROM raises for vector 0; the rest follow it in order.
 *
 * High, and deliberately clear of anything the bridge hands out: those are
 * allocated from zero as functions are registered, and a collision would send a
 * processor exception into a Win32 handler.
 */
export const FAULT_TRAP_BASE = 0xf000;

/** Where a fault's stub sits, so a caller can tell one from ordinary code. */
export const FAULT_STUBS_BASE = ROM_BASE + OFF_FAULT_STUBS;

/** Selectors in the GDT built below. */
export const SEL_CODE32 = 0x08;
export const SEL_DATA32 = 0x10;

/**
 * A flat 4 GiB segment descriptor: base 0, limit 0xFFFFF, granularity 4 KiB,
 * 32-bit. `access` distinguishes code (0x9A) from data (0x92).
 *
 * @param {number} access
 * @returns {number[]}
 */
const flatDescriptor = access=>[0xff, 0xff, 0x00, 0x00, 0x00, access, 0xcf, 0x00];

/** @param {number} value @returns {number[]} little-endian dword */
const u32 = value=>[value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24 & 0xff];

/** @param {number} value @returns {number[]} little-endian word */
const u16 = value=>[value & 0xff, value >>> 8 & 0xff];

/**
 * Builds the boot ROM image.
 *
 * @param {Object} options
 * @param {number} options.entryVector  Linear address of the dword holding the guest entry point.
 * @param {number} options.initialStack Initial ESP for the guest.
 * @param {number} options.trapPort     Where a fault stub reports to the host.
 * @returns {Uint8Array} a ROM_SIZE image, ready to pass to v86 as its bios
 */
export function buildBootRom({ entryVector, initialStack, trapPort }){
    const rom = new Uint8Array(ROM_SIZE);
    const put = (/** @type {number} */ offset, /** @type {number[]} */ bytes)=>rom.set(bytes, offset);

    // GDT: null, flat 32-bit code, flat 32-bit data.
    put(OFF_GDT, [
        ...[0, 0, 0, 0, 0, 0, 0, 0],
        ...flatDescriptor(0x9a),
        ...flatDescriptor(0x92),
    ]);

    // GDT pointer: limit (3 descriptors - 1), then the GDT's linear base.
    put(OFF_GDT_PTR, [...u16(3 * 8 - 1), ...u32(ROM_BASE + OFF_GDT)]);

    // One interrupt gate per processor exception, each to its own stub.
    //
    // A 32-bit interrupt gate: the handler's offset split in half around its
    // selector, and 0x8e for "present, ring 0, 32-bit interrupt gate". An
    // interrupt gate rather than a trap gate because it clears IF on entry --
    // taking an interrupt while reporting a fault would report the wrong one.
    for (let vector = 0; vector < VECTORS; vector++)
    {
        const handler = ROM_BASE + OFF_FAULT_STUBS + vector * FAULT_STUB_SIZE;
        put(OFF_IDT + vector * 8, [
            ...u16(handler & 0xffff),
            ...u16(SEL_CODE32),
            0x00, 0x8e,
            ...u16(handler >>> 16 & 0xffff),
        ]);

        // The stub itself. It does not return: the fault is reported and the
        // machine stops there, because iret would resume at the instruction
        // that faulted and take the same fault again for ever. Where execution
        // resumes is a decision for whoever is told, not for the ROM.
        put(OFF_FAULT_STUBS + vector * FAULT_STUB_SIZE, [
            0x66, 0xba, ...u16(trapPort), //             mov dx, trapPort
            0xb8, ...u32(FAULT_TRAP_BASE + vector), //   mov eax, trap
            0xef, //                                     out dx, eax
            0xf4, //                                     hlt
            0xeb, 0xfd, //                               jmp $-1
        ]);
    }

    put(OFF_IDT_PTR, [...u16(VECTORS * 8 - 1), ...u32(ROM_BASE + OFF_IDT)]);

    // 16-bit init. DS is pointed at the ROM segment so `lgdt` can reach the
    // pointer above with a 16-bit displacement.
    put(OFF_INIT16, [
        0xfa,                                            // cli
        0xb8, ...u16(ROM_BASE >>> 4),                    // mov ax, 0xF000
        0x8e, 0xd8,                                      // mov ds, ax
        0x66, 0x0f, 0x01, 0x16, ...u16(OFF_GDT_PTR),     // lgdt [OFF_GDT_PTR]
        0x66, 0x0f, 0x01, 0x1e, ...u16(OFF_IDT_PTR),     // lidt [OFF_IDT_PTR]
        0x0f, 0x20, 0xc0,                                // mov eax, cr0
        0x66, 0x83, 0xc8, 0x01,                          // or eax, 1
        0x0f, 0x22, 0xc0,                                // mov cr0, eax
        // jmp far SEL_CODE32:PM_ENTRY
        0x66, 0xea, ...u32(ROM_BASE + OFF_PM_ENTRY), ...u16(SEL_CODE32),
    ]);

    // 32-bit entry: flat data segments, a stack, then indirect jump to the guest.
    put(OFF_PM_ENTRY, [
        0xb8, ...u32(SEL_DATA32),  // mov eax, SEL_DATA32
        0x8e, 0xd8,                // mov ds, ax
        0x8e, 0xc0,                // mov es, ax
        0x8e, 0xd0,                // mov ss, ax
        0x8e, 0xe0,                // mov fs, ax
        0x8e, 0xe8,                // mov gs, ax
        0xbc, ...u32(initialStack), // mov esp, initialStack
        0xff, 0x25, ...u32(entryVector), // jmp dword [entryVector]
    ]);

    // Reset vector: the CPU starts at F000:FFF0, which is this far jump.
    put(OFF_RESET, [0xea, ...u16(OFF_INIT16), ...u16(ROM_BASE >>> 4)]); // jmp far F000:OFF_INIT16

    return rom;
}
