/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The structures only Direct3D 8 declares, as a guest lays them out: each
 * declared once as d3d8types.h or d3d8caps.h declares it and laid out by
 * `system/layout.js`.
 *
 * They live beside the object model rather than with the shared Direct3D
 * structures because nothing else in this layer passes them: the two clipping
 * dwords are D3D8's own shape - Direct3D 7 spells the same idea as a flags
 * word, a status word and six floats - and the raster status and the gamma
 * ramp have no counterpart in any other version here. The creation
 * parameters are Direct3D 9's too, field for field.
 */

import { GUID, struct } from '../../../system/layout.js';

/**
 * D3DDEVICE_CREATION_PARAMETERS: exactly what CreateDevice was passed, which is
 * why every field of it is a fact rather than a description of this build.
 * In a 64-bit process the window handle is eight bytes and the end padded to
 * eight; the handle is written whole, sign-extended.
 */
const CREATION_PARAMETERS = struct([['AdapterOrdinal', 'u32'], ['DeviceType', 'u32'],
    ['hFocusWindow', 'handle'], ['BehaviorFlags', 'u32']]);
export const D3DDEVICE_CREATION_PARAMETERS = CREATION_PARAMETERS.at(4);
export const D3DDEVICE_CREATION_PARAMETERS64 = CREATION_PARAMETERS.at(8);

/** D3DRASTER_STATUS: whether the scan-out is in the blanking interval, and where it is. */
export const D3DRASTER_STATUS = struct([['InVBlank', 'i32'], ['ScanLine', 'u32']]).at(4);

/**
 * D3DCLIPSTATUS8. Two dwords of clip-plane bits: the union over the vertices
 * drawn since the last reset, and the intersection.
 */
export const D3DCLIPSTATUS8 = struct([['ClipUnion', 'u32'], ['ClipIntersection', 'u32']]).at(4);

/** The length of each of the identifier's two strings, terminator included. */
export const ADAPTER_STRING_LENGTH = 512;

/**
 * D3DADAPTER_IDENTIFIER8: who made the adapter and what drives it.
 *
 * The one structure here with padding in it: the version is a LARGE_INTEGER
 * and sits on an eight-byte boundary, which the two strings before it happen
 * to satisfy, and the whole is rounded up to eight at the end - 1072 bytes,
 * where the fields alone end at 1068.
 */
export const D3DADAPTER_IDENTIFIER8 = struct([['Driver', 'u8', ADAPTER_STRING_LENGTH],
    ['Description', 'u8', ADAPTER_STRING_LENGTH], ['DriverVersion', 'i64'], ['VendorId', 'u32'],
    ['DeviceId', 'u32'], ['SubSysId', 'u32'], ['Revision', 'u32'], ['DeviceIdentifier', GUID],
    ['WHQLLevel', 'u32']]).at(4);

/**
 * Where D3DADAPTER_IDENTIFIER8's fields end. Only the fields are ever
 * written. A program built with the structure packed has a 1068-byte buffer
 * with its stack cookie right after it, and the four padding bytes land on
 * the cookie: the process then ends itself with STATUS_STACK_BUFFER_OVERRUN
 * and no fault of its own to show for it.
 */
export const D3DADAPTER_IDENTIFIER8_FIELDS = D3DADAPTER_IDENTIFIER8.WHQLLevel + 4;

/** How many entries each channel of a gamma ramp has. */
export const GAMMA_RAMP_ENTRIES = 256;

/** D3DGAMMARAMP: three channels of 256 sixteen-bit entries, red first. */
export const D3DGAMMARAMP = struct([['red', 'u16', GAMMA_RAMP_ENTRIES],
    ['green', 'u16', GAMMA_RAMP_ENTRIES], ['blue', 'u16', GAMMA_RAMP_ENTRIES]]).at(4);
