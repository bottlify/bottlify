/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The bytes of an x86 instruction's 32-bit immediate or displacement, as the
 * routines the engine writes into the guest put them together: little-endian,
 * the value's low dword whatever its sign.
 *
 * @param {number} value
 * @returns {number[]}
 */
export const imm32 = value=>[value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff,
    value >>> 24 & 0xff];
