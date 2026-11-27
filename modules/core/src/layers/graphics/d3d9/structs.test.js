/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    D3DADAPTER_IDENTIFIER9, D3DBOX, D3DCAPS9, D3DCAPS9_FLOATS, D3DCLIPSTATUS9, D3DDISPLAYMODEEX,
    D3DDISPLAYMODEFILTER, D3DINDEXBUFFER_DESC9, D3DSURFACE_DESC9, D3DVERTEXBUFFER_DESC9,
    D3DVERTEXELEMENT9, D3DVIEWPORT9, D3DVOLUME_DESC9,
} from './structs.js';
import {
    D3DADAPTER_IDENTIFIER8, D3DCLIPSTATUS8, D3DDEVICE_CREATION_PARAMETERS,
    D3DDEVICE_CREATION_PARAMETERS64, D3DGAMMARAMP, D3DRASTER_STATUS,
} from '../d3d8/structs.js';

// sizeof and offsetof of each under d3d9types.h, d3d9caps.h, d3d8types.h and
// d3d8caps.h by the x86 compiler's rule; the creation parameters at 8 under
// _WIN64 too, where the HWND is eight bytes on an eight-byte boundary.

test('Direct3D 9\'s own structures have their headers\' sizes and offsets', ()=>{
    assert.deepEqual([D3DCAPS9.MaxVertexW, D3DCAPS9.PixelShader1xMaxValue, D3DCAPS9.DevCaps2,
        D3DCAPS9.StretchRectFilterCaps, D3DCAPS9.VS20Caps_Caps, D3DCAPS9.PS20Caps_Caps,
        D3DCAPS9.PS20Caps_NumInstructionSlots, D3DCAPS9.VertexTextureFilterCaps,
        D3DCAPS9.MaxPixelShader30InstructionSlots, D3DCAPS9.SIZE],
    [0x70, 0xd0, 0xd4, 0xf4, 0xf8, 0x108, 0x118, 0x11c, 0x12c, 0x130]);
    assert.deepEqual([...D3DCAPS9_FLOATS], ['MaxVertexW', 'GuardBandLeft', 'GuardBandTop',
        'GuardBandRight', 'GuardBandBottom', 'ExtentsAdjust', 'MaxPointSize',
        'PixelShader1xMaxValue', 'MaxNpatchTessellationLevel']);
    assert.deepEqual([D3DVERTEXELEMENT9.Offset, D3DVERTEXELEMENT9.Type,
        D3DVERTEXELEMENT9.UsageIndex, D3DVERTEXELEMENT9.SIZE], [2, 4, 7, 8]);
    assert.deepEqual([D3DSURFACE_DESC9.MultiSampleQuality, D3DSURFACE_DESC9.Height,
        D3DSURFACE_DESC9.SIZE], [0x14, 0x1c, 0x20]);
    assert.deepEqual([D3DVOLUME_DESC9.Depth, D3DVOLUME_DESC9.SIZE], [0x18, 0x1c]);
    assert.deepEqual([D3DVERTEXBUFFER_DESC9.FVF, D3DVERTEXBUFFER_DESC9.SIZE], [0x14, 0x18]);
    assert.deepEqual([D3DINDEXBUFFER_DESC9.Size, D3DINDEXBUFFER_DESC9.SIZE], [0x10, 0x14]);
    assert.deepEqual([D3DVIEWPORT9.MinZ, D3DVIEWPORT9.SIZE], [0x10, 0x18]);
    assert.deepEqual([D3DDISPLAYMODEEX.ScanLineOrdering, D3DDISPLAYMODEEX.SIZE], [0x14, 0x18]);
    assert.deepEqual([D3DDISPLAYMODEFILTER.ScanLineOrdering, D3DDISPLAYMODEFILTER.SIZE],
        [0x08, 0x0c]);
    assert.deepEqual([D3DADAPTER_IDENTIFIER9.DeviceName, D3DADAPTER_IDENTIFIER9.DriverVersion,
        D3DADAPTER_IDENTIFIER9.DeviceIdentifier, D3DADAPTER_IDENTIFIER9.WHQLLevel,
        D3DADAPTER_IDENTIFIER9.SIZE], [0x400, 0x420, 0x438, 0x448, 0x450]);
    assert.deepEqual([D3DCLIPSTATUS9.ClipIntersection, D3DCLIPSTATUS9.SIZE], [4, 8]);
    assert.deepEqual([D3DBOX.Front, D3DBOX.Back, D3DBOX.SIZE], [0x10, 0x14, 0x18]);
});

test('Direct3D 8\'s own structures have their headers\' sizes and offsets', ()=>{
    assert.deepEqual([D3DDEVICE_CREATION_PARAMETERS.hFocusWindow,
        D3DDEVICE_CREATION_PARAMETERS.BehaviorFlags, D3DDEVICE_CREATION_PARAMETERS.SIZE],
    [0x08, 0x0c, 0x10]);
    assert.deepEqual([D3DDEVICE_CREATION_PARAMETERS64.hFocusWindow,
        D3DDEVICE_CREATION_PARAMETERS64.BehaviorFlags, D3DDEVICE_CREATION_PARAMETERS64.SIZE],
    [0x08, 0x10, 0x18]);
    assert.deepEqual([D3DRASTER_STATUS.ScanLine, D3DRASTER_STATUS.SIZE], [4, 8]);
    assert.deepEqual([D3DCLIPSTATUS8.ClipIntersection, D3DCLIPSTATUS8.SIZE], [4, 8]);
    assert.deepEqual([D3DADAPTER_IDENTIFIER8.DriverVersion, D3DADAPTER_IDENTIFIER8.VendorId,
        D3DADAPTER_IDENTIFIER8.DeviceIdentifier, D3DADAPTER_IDENTIFIER8.WHQLLevel,
        D3DADAPTER_IDENTIFIER8.SIZE], [0x400, 0x408, 0x418, 0x428, 0x430]);
    assert.deepEqual([D3DGAMMARAMP.green, D3DGAMMARAMP.blue, D3DGAMMARAMP.SIZE],
        [0x200, 0x400, 0x600]);
});
