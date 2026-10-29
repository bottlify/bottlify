/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The VARTYPE numbers and the automation HRESULTs, in one place: the variant
 * calls, the operators and the text conversions all read and answer in them,
 * and a number two files each spelled for themselves is a number that can
 * drift apart.
 */

export const VT_EMPTY = 0;
export const VT_NULL = 1;
export const VT_I2 = 2;
export const VT_I4 = 3;
export const VT_R4 = 4;
export const VT_R8 = 5;
export const VT_CY = 6;
export const VT_DATE = 7;
export const VT_BSTR = 8;
export const VT_DISPATCH = 9;
export const VT_ERROR = 10;
export const VT_BOOL = 11;
export const VT_VARIANT = 12;
export const VT_UNKNOWN = 13;
export const VT_DECIMAL = 14;
export const VT_I1 = 16;
export const VT_UI1 = 17;
export const VT_UI2 = 18;
export const VT_UI4 = 19;
export const VT_I8 = 20;
export const VT_UI8 = 21;
export const VT_INT = 22;
export const VT_UINT = 23;
export const VT_RECORD = 36;
export const VT_CLSID = 72;

/** The bits of a VARTYPE that are not the type. */
export const VT_VECTOR = 0x1000;
export const VT_ARRAY = 0x2000;
export const VT_BYREF = 0x4000;
/** A flag bit VarCmp, VarCat and VarRound read past and the operators refuse. */
export const VT_RESERVED = 0x8000;
export const VT_TYPEMASK = 0x0fff;

/**
 * VARIANT_TRUE is minus one, not one.
 *
 * A program tests `== VARIANT_TRUE` as often as it tests for non-zero, so a
 * boolean stored as 1 reads as neither true nor false to the code that asked.
 */
export const VARIANT_TRUE = -1;
export const VARIANT_FALSE = 0;

export const DISP_E_TYPEMISMATCH = 0x80020005;
export const DISP_E_BADVARTYPE = 0x80020008;
export const DISP_E_OVERFLOW = 0x8002000a;
export const DISP_E_DIVBYZERO = 0x80020012;
