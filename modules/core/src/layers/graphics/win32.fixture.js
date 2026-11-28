/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What the graphics layer takes of win32, for a test that builds it alone:
 * every method it calls, answering as a win32 with no windows, no events and
 * nothing deactivated does. `over` replaces any of them.
 *
 * @param {Record<string, any>} [over]
 */
export const graphicsWin32 = (over = {})=>({
    gdi: ()=>({ createSurfaceDc: ()=>0, deleteSurfaceDc: ()=>false, describeDrawable: ()=>null }),
    heap: ()=>({ allocate: ()=>0 }),
    windows: ()=>[],
    windowSurfaces: ()=>[],
    windowSurfaceOf: ()=>null,
    events: ()=>undefined,
    sharedHandles: ()=>undefined,
    user32: ()=>undefined,
    coverWindow: ()=>{},
    processHeapAllocate: ()=>0,
    applicationDeactivated: ()=>false,
    applicationDeactivations: ()=>0,
    setLastError: ()=>{},
    ...over,
});
