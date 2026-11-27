/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * An address as the engine holds it: one below 4 GiB unsigned, whatever sign a
 * dword gave it, and one past 4 GiB - a 64-bit program's image at its own base
 * there - as it is, where `>>> 0` would leave its low dword, another address.
 *
 * @param {number} address
 */
export const wholeAddress = address=>(address >= 2 ** 32 ? address : address >>> 0);
