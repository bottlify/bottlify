/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The structures only Direct3D 8 declares, as a guest lays them out.
 *
 * They live beside the object model rather than with the shared Direct3D
 * structures because nothing else in this layer passes them: the two clipping
 * dwords are D3D8's own shape -- Direct3D 7 spells the same idea as a flags
 * word, a status word and six floats -- and the creation parameters, the raster
 * status and the gamma ramp have no counterpart in any other version here.
 *
 * **These offsets are recalled rather than read from a header.** Each is a run
 * of dwords with no padding to get wrong, which is what makes the recall
 * defensible; a field read one slot early would still be a plausible number, so
 * anything more intricate belongs in a file someone has checked against a
 * header first.
 */

/**
 * D3DDEVICE_CREATION_PARAMETERS: exactly what CreateDevice was passed, which is
 * why every field of it is a fact rather than a description of this build.
 */
export const D3DDEVICE_CREATION_PARAMETERS = Object.freeze({
    AdapterOrdinal: 0x00,
    DeviceType: 0x04,
    hFocusWindow: 0x08,
    BehaviorFlags: 0x0c,
    SIZE: 0x10,
});

/** D3DRASTER_STATUS: whether the scan-out is in the blanking interval, and where it is. */
export const D3DRASTER_STATUS = Object.freeze({
    InVBlank: 0x00,
    ScanLine: 0x04,
    SIZE: 0x08,
});

/**
 * D3DCLIPSTATUS8. Two dwords of clip-plane bits: the union over the vertices
 * drawn since the last reset, and the intersection.
 */
export const D3DCLIPSTATUS8 = Object.freeze({
    ClipUnion: 0x00,
    ClipIntersection: 0x04,
    SIZE: 0x08,
});

/** The length of each of the identifier's two strings, terminator included. */
export const ADAPTER_STRING_LENGTH = 512;

/**
 * D3DADAPTER_IDENTIFIER8: who made the adapter and what drives it.
 *
 * The one structure here with padding in it: the version is a LARGE_INTEGER
 * and sits on an eight-byte boundary, which the two strings before it happen
 * to satisfy, and the whole is rounded up to eight at the end -- 1072 bytes,
 * where the fields alone end at 1068. Only the fields are ever written. A
 * program built with the structure packed has a 1068-byte buffer with its
 * stack cookie right after it, and the four padding bytes land on the cookie:
 * the process then ends itself with STATUS_STACK_BUFFER_OVERRUN and no fault
 * of its own to show for it.
 */
export const D3DADAPTER_IDENTIFIER8 = Object.freeze({
    Driver: 0x000,
    Description: 0x200,
    DriverVersion: 0x400,
    VendorId: 0x408,
    DeviceId: 0x40c,
    SubSysId: 0x410,
    Revision: 0x414,
    DeviceIdentifier: 0x418,
    WHQLLevel: 0x428,
    FIELDS: 0x42c,
    SIZE: 0x430,
});

/** How many entries each channel of a gamma ramp has. */
export const GAMMA_RAMP_ENTRIES = 256;

/** D3DGAMMARAMP: three channels of 256 sixteen-bit entries, red first. */
export const D3DGAMMARAMP = Object.freeze({
    red: 0x000,
    green: 0x200,
    blue: 0x400,
    SIZE: 0x600,
});
