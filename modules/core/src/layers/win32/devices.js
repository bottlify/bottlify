/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What the machine calls its devices, wherever a program asks: DirectDraw's
 * and Direct3D's adapter identifier, DXGI, OpenGL's renderer, the display
 * devices, DxDiag and WMI for the video adapter; DirectSound's enumeration,
 * the wave device's capabilities and WMI for the sound adapter. One name each,
 * so a program that asks two of them is told of one card.
 */

export const VIDEO_ADAPTER_NAME = 'Bottlify WebGPU Video Adapter';
export const SOUND_ADAPTER_NAME = 'Bottlify Sound Adapter';
/**
 * The sound adapter's DirectSound device GUID: DirectSoundEnumerate,
 * GetDeviceID, devenum's DSGuid, the endpoint's GUID. A random one, as a real
 * device's is, every byte of it in play: a program that compared the second
 * half of the GUID it was given with the zeroes it started from took
 * {00000001-0000-0000-0000-000000000000} for no change of device, never
 * tested a format and kept its sound off.
 */
export const SOUND_DEVICE_GUID = '{BD6DD71B-3DEB-4BF1-B3A6-2F5C9A8E7D41}';
/**
 * The sound device's interface name: winmm's DRV_QUERYDEVICEINTERFACE and
 * DirectSound's private device description. A program keys its saved settings
 * on it, and it names nothing it could open.
 */
export const SOUND_DEVICE_INTERFACE = '\\\\?\\bottlify#wave#out';
/** The one display's device name: EnumDisplayDevices, CreateDC, DxDiag. */
export const DISPLAY_DEVICE_NAME = '\\\\.\\DISPLAY1';
