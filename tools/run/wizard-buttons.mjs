/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What an unattended run takes for a wizard's button. A framework's button is
 * a window class of its own superclassing BUTTON -- Delphi's VCL registers
 * `TButton`, `TNewButton`, `TBitBtn`, `TNewRadioButton` -- so matching the
 * system class name alone finds no button on such a wizard at all.
 */

/** A label as a person reads it: without the mnemonic's `&`, in any case. */
export const label = (/** @type {string} */ title)=>title.replace(/&/g, '').toLowerCase();

/** Whether a window class is BUTTON or a framework's class built on it. */
export const isButtonClass = (/** @type {string} */ className)=>/button$|^tbitbtn$/i.test(className);
