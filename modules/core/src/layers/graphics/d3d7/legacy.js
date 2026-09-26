/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Direct3D as DirectX 3, 5 and 6 shaped it, as views over the Direct3D 7
 * device.
 *
 * The older versions draw what the seventh draws -- the same transforms,
 * render states, texture stages and primitives -- but reach it through
 * objects the seventh folded into the device: a viewport is an object a
 * device holds a list of, a light belongs to a viewport rather than to a
 * device slot, a material and a texture are named by handles, and lighting
 * is a state of its own. So each legacy device wraps one Direct3D 7 device
 * and translates:
 *
 * - **The current viewport** sets the device's viewport rectangle, and its
 *   clip volume -- DirectX 3 to 6 let a viewport show any part of the unit
 *   cube -- rides on the projection, which the device keeps as the program
 *   set it and hands the Direct3D 7 device multiplied by the volume's map.
 * - **Lighting** is decided per draw, because these versions have no render
 *   state for it: a draw is lit when a material handle is set, the vertices
 *   carry normals and no pre-transformed position, and the draw did not say
 *   D3DDP_DONOTLIGHT (Wine's ddraw4.c test_lighting_interface_versions spells
 *   out the last three; test_lighting draws a quad with normals unlit while
 *   no material is set). Its lights are the active ones of the current
 *   viewport.
 * - **Legacy render states** that name texturing -- the texture handle, the
 *   map blend, the filters, the address modes -- are turned into the stage
 *   states that do the same on stage zero.
 *
 * Nothing here reads guest memory; `seam/d3dlegacy.js` translates the calls.
 */

import {
    D3DCOLOR_RGB, D3DDP_DONOTLIGHT, D3DERR_INBEGIN, D3DERR_INVALIDVERTEXTYPE,
    D3DERR_LIGHTHASVIEWPORT, D3DERR_LIGHTNOTINTHISVIEWPORT, D3DERR_MATRIX_DESTROY_FAILED,
    D3DERR_MATRIX_SETDATA_FAILED, D3DERR_NOCURRENTVIEWPORT, D3DERR_NOTINBEGIN,
    D3DERR_VIEWPORTDATANOTSET, D3DERR_VIEWPORTHASNODEVICE, D3DFILTER, D3DLIGHTSTATE,
    D3DLIGHT_ACTIVE, D3DLIGHT_GLSPOT, D3DLIGHT_NO_SPECULAR, D3DLIGHT_PARALLELPOINT, D3DNEXT_HEAD,
    D3DNEXT_NEXT, D3DNEXT_TAIL, D3DPT, D3DRENDERSTATE_D3D7_ONLY, D3DTA, D3DTBLEND, D3DTOP,
    D3DTRANSFORMSTATE, D3D_OK, DDERR_INVALIDPARAMS, DDERR_NOTFOUND, DEVICE_IDS, floatToDword,
} from './constants.js';
import { D3DTSS } from '../d3d8/constants.js';
import { IDENTITY, multiplyMatrices } from '../d3d8/render.js';
import { decodeFvf } from '../webgpu/internal/vertexformat.js';
import { DDPF_ALPHAPIXELS } from '../ddraw/constants.js';

/** The render states these versions number and the Direct3D 7 device answers too. */
const RS = Object.freeze({
    ...D3DRENDERSTATE_D3D7_ONLY,
    SPECULARENABLE: 29,
    FOGSTART: 36,
    FOGEND: 37,
    FOGDENSITY: 38,
    WRAP0: 128,
    LIGHTING: 137,
    AMBIENT: 139,
    FOGVERTEXMODE: 140,
    COLORVERTEX: 141,
});

/** D3DTADDRESS_WRAP, and D3DWRAP_U / _V in D3DRENDERSTATE_WRAP0. */
const D3DTADDRESS_WRAP = 1;
const D3DWRAP_U = 0x1;
const D3DWRAP_V = 0x2;

/** Direct3D 7's filter numbering, which its device's stage states take. */
const D3DTFG_POINT = 1;
const D3DTFG_LINEAR = 2;
const D3DTFP_NONE = 1;
const D3DTFP_POINT = 2;
const D3DTFP_LINEAR = 3;

/** The most lights a draw is lit by, as Direct3D 7 reports it. */
const MAX_ACTIVE_LIGHTS = 8;

/** FVF bits the lighting rule reads. */
const FVF_POSITION_MASK = 0x00e;
const FVF_XYZRHW = 0x004;
const FVF_NORMAL = 0x010;

/** Direct3D 7's light types, which a legacy light becomes. */
const D3DLIGHT7_SPOT = 2;
const D3DLIGHT7_DIRECTIONAL = 3;

/**
 * The devices the older versions can make: the software rasteriser and the
 * hardware one. A transform-and-lighting device is Direct3D 7's alone.
 */
export const LEGACY_DEVICES = /** @type {readonly string[]} */ (
    Object.freeze([DEVICE_IDS.RGB, DEVICE_IDS.HAL]));

/**
 * @typedef {{ r: number, g: number, b: number, a: number }} Colour
 * @typedef {{ x: number, y: number, z: number }} Vector
 *
 * @typedef {Object} ViewportData  D3DVIEWPORT2, the form the object keeps.
 * @property {number} x
 * @property {number} y
 * @property {number} width
 * @property {number} height
 * @property {number} clipX
 * @property {number} clipY
 * @property {number} clipWidth
 * @property {number} clipHeight
 * @property {number} minZ
 * @property {number} maxZ
 *
 * @typedef {Object} ScaledViewport  D3DVIEWPORT's fields past the rectangle.
 * @property {number} x
 * @property {number} y
 * @property {number} width
 * @property {number} height
 * @property {number} scaleX
 * @property {number} scaleY
 * @property {number} maxX
 * @property {number} maxY
 * @property {number} minZ
 * @property {number} maxZ
 *
 * @typedef {Object} LegacyLight  D3DLIGHT or D3DLIGHT2's fields.
 * @property {number} type
 * @property {Colour} color
 * @property {Vector} position
 * @property {Vector} direction
 * @property {number} range
 * @property {number} falloff
 * @property {number} attenuation0
 * @property {number} attenuation1
 * @property {number} attenuation2
 * @property {number} theta
 * @property {number} phi
 * @property {number} flags
 *
 * @typedef {Object} LegacyMaterial  D3DMATERIAL's fields.
 * @property {Colour} diffuse
 * @property {Colour} ambient
 * @property {Colour} specular
 * @property {Colour} emissive
 * @property {number} power
 * @property {number} texture   hTexture.
 * @property {number} rampSize
 */

/** @returns {Colour} */
const black = ()=>({ r: 0, g: 0, b: 0, a: 0 });

/** @returns {LegacyMaterial} what a material is before it is set */
const emptyMaterial = ()=>({
    diffuse: black(), ambient: black(), specular: black(), emissive: black(),
    power: 0, texture: 0, rampSize: 0,
});

/** @param {Colour} colour @returns {number} the D3DCOLOR a clear takes */
function colourToArgb(colour){
    const byte = (/** @type {number} */ value)=>Math.round(Math.min(Math.max(value, 0), 1) * 255);
    return ((byte(colour.a) << 24) | (byte(colour.r) << 16) | (byte(colour.g) << 8)
        | byte(colour.b)) >>> 0;
}

/**
 * Reference counting of the objects below; `gone` runs once, when the last
 * reference goes.
 *
 * @param {() => void} gone
 */
function counted(gone){
    let count = 1;
    return {
        get refCount(){
            return count;
        },
        addRef(){
            count++;
            return count;
        },
        release(){
            if (count === 0)
            {
                return 0;
            }
            count--;
            if (count === 0)
            {
                gone();
            }
            return count;
        },
    };
}

/**
 * The stage-zero states a D3DTEXTUREBLEND mode stands for, as the DirectX 5
 * documentation describes each mode. MODULATE's alpha is the texture's when
 * the texture has any and the vertex's otherwise, which a stage state cannot
 * say; that half is settled per draw.
 *
 * @param {number} mode
 * @returns {[number, number][]} stage state and value pairs
 */
function blendStates(mode){
    const texture = D3DTA.TEXTURE;
    const current = D3DTA.CURRENT;
    switch (mode)
    {
        case D3DTBLEND.DECAL:
        case D3DTBLEND.DECALMASK:
        case D3DTBLEND.COPY:
            return [[D3DTSS.COLOROP, D3DTOP.SELECTARG1], [D3DTSS.COLORARG1, texture],
                [D3DTSS.ALPHAOP, D3DTOP.SELECTARG1], [D3DTSS.ALPHAARG1, texture]];
        case D3DTBLEND.DECALALPHA:
            return [[D3DTSS.COLOROP, D3DTOP.BLENDTEXTUREALPHA], [D3DTSS.COLORARG1, texture],
                [D3DTSS.COLORARG2, current], [D3DTSS.ALPHAOP, D3DTOP.SELECTARG2],
                [D3DTSS.ALPHAARG2, current]];
        case D3DTBLEND.MODULATEALPHA:
            return [[D3DTSS.COLOROP, D3DTOP.MODULATE], [D3DTSS.COLORARG1, texture],
                [D3DTSS.COLORARG2, current], [D3DTSS.ALPHAOP, D3DTOP.MODULATE],
                [D3DTSS.ALPHAARG1, texture], [D3DTSS.ALPHAARG2, current]];
        case D3DTBLEND.ADD:
            return [[D3DTSS.COLOROP, D3DTOP.ADD], [D3DTSS.COLORARG1, texture],
                [D3DTSS.COLORARG2, current], [D3DTSS.ALPHAOP, D3DTOP.SELECTARG2],
                [D3DTSS.ALPHAARG2, current]];
        default:
            return [[D3DTSS.COLOROP, D3DTOP.MODULATE], [D3DTSS.COLORARG1, texture],
                [D3DTSS.COLORARG2, current], [D3DTSS.ALPHAOP, D3DTOP.SELECTARG1],
                [D3DTSS.ALPHAARG1, texture], [D3DTSS.ALPHAARG2, current]];
    }
}

/**
 * The magnification, minification and mip filters a D3DTEXTUREFILTER names,
 * in Direct3D 7's numbering.
 *
 * @param {number} filter
 * @returns {{ filter: number, mip: number }}
 */
function filterStates(filter){
    switch (filter)
    {
        case D3DFILTER.LINEAR:
            return { filter: D3DTFG_LINEAR, mip: D3DTFP_NONE };
        case D3DFILTER.MIPNEAREST:
            return { filter: D3DTFG_POINT, mip: D3DTFP_POINT };
        case D3DFILTER.MIPLINEAR:
            return { filter: D3DTFG_LINEAR, mip: D3DTFP_POINT };
        case D3DFILTER.LINEARMIPNEAREST:
            return { filter: D3DTFG_POINT, mip: D3DTFP_LINEAR };
        case D3DFILTER.LINEARMIPLINEAR:
            return { filter: D3DTFG_LINEAR, mip: D3DTFP_LINEAR };
        default:
            return { filter: D3DTFG_POINT, mip: D3DTFP_NONE };
    }
}

/**
 * How many primitives a draw of this many vertices or indices makes.
 *
 * @param {number} type @param {number} count
 */
function primitivesOf(type, count){
    switch (type)
    {
        case D3DPT.POINTLIST:
            return count;
        case D3DPT.LINELIST:
            return count >> 1;
        case D3DPT.LINESTRIP:
            return Math.max(count - 1, 0);
        case D3DPT.TRIANGLELIST:
            return Math.floor(count / 3);
        default:
            return Math.max(count - 2, 0);
    }
}

/**
 * The map from the unit cube to a viewport's clip volume, appended to the
 * projection: a volume of (-1, 1, 2, 2) is the identity, which is what
 * Direct3D 7 always draws with.
 *
 * @param {ViewportData} data
 * @returns {Float32Array}
 */
export function clipVolumeMatrix(data){
    const sx = data.clipWidth !== 0 ? 2 / data.clipWidth : 1;
    const sy = data.clipHeight !== 0 ? 2 / data.clipHeight : 1;
    return Float32Array.from([
        sx, 0, 0, 0,
        0, sy, 0, 0,
        0, 0, 1, 0,
        -data.clipX * sx - 1, 1 - data.clipY * sy, 0, 1,
    ]);
}

/**
 * The texture handles of every surface: a handle is a small number a program
 * passes back in a render state or an execute buffer, and it names one
 * surface for as long as that lives. They belong to the surface rather than
 * to a Direct3D object -- asked through devices of two DirectDraw objects, a
 * texture answers one handle (Wine's ddraw2.c test_multiple_devices).
 */
export function createTextureHandles(){
    /** @type {Map<number, any>} */
    const surfaces = new Map();
    /** @type {WeakMap<object, number>} */
    const handles = new WeakMap();
    let next = 1;

    /** @param {any} surface @returns {number} its handle, or zero before it was asked for */
    const existing = surface=>{
        const handle = handles.get(surface) ?? 0;
        return handle !== 0 && surfaces.get(handle) === surface ? handle : 0;
    };

    return {
        existing,

        /**
         * A surface's handle, made on first asking. Nothing keeps a surface
         * alive for its handle; a handle to a released surface names nothing.
         *
         * @param {any} surface
         */
        handleOf(surface){
            let handle = existing(surface);
            if (handle === 0)
            {
                handle = next++;
                handles.set(surface, handle);
                surfaces.set(handle, surface);
            }
            return handle;
        },

        /** @param {number} handle @returns {any | null} */
        surfaceOf(handle){
            const surface = surfaces.get(handle >>> 0) ?? null;
            if (surface && surface.destroyed)
            {
                surfaces.delete(handle >>> 0);
                return null;
            }
            return surface;
        },

        /**
         * Two surfaces trade handles, which is how a program that drew with
         * one texture's handle draws with another's without resetting a
         * state. Both must have been given a handle first (Wine's ddraw2.c
         * test_multiple_devices: E_INVALIDARG until both have asked).
         *
         * @param {any} first @param {any} second
         */
        swap(first, second){
            const a = existing(first);
            const b = existing(second);
            if (a === 0 || b === 0)
            {
                return DDERR_INVALIDPARAMS;
            }
            surfaces.set(a, second);
            surfaces.set(b, first);
            handles.set(first, b);
            handles.set(second, a);
            return D3D_OK;
        },
    };
}

/**
 * A viewport, which a program makes on the Direct3D object and adds to one
 * device. Its data is kept as a D3DVIEWPORT2; the first generation's scale
 * form is converted each way the way Wine's ddraw4.c test_viewport_object
 * pins it: a scale is the rectangle over the clip extent, the volume is
 * centred, and the depth range read or written through it is always zero
 * to one.
 *
 * @param {(handle: number) => any} materialOf  The Direct3D object's material handles.
 */
function createViewport(materialOf){
    /** @type {ViewportData | null} */
    let data = null;
    /** @type {any} */
    let device = null;
    /** @type {any[]} */
    const lights = [];
    let background = 0;
    /** @type {any} */
    let backgroundDepth = null;

    const life = counted(()=>{
        for (const light of lights.splice(0))
        {
            light.leave();
            light.release();
        }
        backgroundDepth?.release();
        backgroundDepth = null;
    });

    const viewport = {
        get refCount(){
            return life.refCount;
        },
        addRef: ()=>life.addRef(),
        release: ()=>life.release(),
        get device(){
            return device;
        },
        /** @param {any} owner */
        attach(owner){
            device = owner;
        },
        detach(){
            device = null;
        },
        get data(){
            return data;
        },
        get lights(){
            return lights;
        },

        /** @param {ScaledViewport} v  D3DVIEWPORT */
        setViewport(v){
            const clipWidth = v.scaleX !== 0 ? v.width / v.scaleX : 2;
            const clipHeight = v.scaleY !== 0 ? v.height / v.scaleY : 2;
            return viewport.setViewport2({
                x: v.x, y: v.y, width: v.width, height: v.height,
                clipX: -clipWidth / 2, clipY: clipHeight / 2, clipWidth, clipHeight,
                minZ: 0, maxZ: 1,
            });
        },

        /**
         * A rectangle the device's target cannot hold is refused by the
         * DrawPrimitive devices (Wine's ddraw2.c and ddraw4.c test_viewport)
         * and kept by the execute-buffer device, which then draws nothing
         * through it (ddraw1.c test_viewport).
         *
         * @param {ViewportData} v  D3DVIEWPORT2
         */
        setViewport2(v){
            if (!device)
            {
                return D3DERR_VIEWPORTHASNODEVICE;
            }
            if (device.version >= 2 && !device.holds(v))
            {
                return DDERR_INVALIDPARAMS;
            }
            data = { ...v };
            device.viewportChanged(viewport);
            return D3D_OK;
        },

        /** @returns {{ hr: number, viewport?: ScaledViewport }} */
        getViewport(){
            if (!data)
            {
                return { hr: D3DERR_VIEWPORTDATANOTSET };
            }
            return {
                hr: D3D_OK,
                viewport: {
                    x: data.x, y: data.y, width: data.width, height: data.height,
                    scaleX: data.clipWidth !== 0 ? data.width / data.clipWidth : 0,
                    scaleY: data.clipHeight !== 0 ? data.height / data.clipHeight : 0,
                    maxX: data.clipX + data.clipWidth,
                    maxY: data.clipY,
                    minZ: 0, maxZ: 1,
                },
            };
        },

        /** @returns {{ hr: number, viewport?: ViewportData }} */
        getViewport2(){
            return data ? { hr: D3D_OK, viewport: { ...data } }
                : { hr: D3DERR_VIEWPORTDATANOTSET };
        },

        /**
         * A material handle whose diffuse colour a Clear fills with. Zero
         * names none and is refused, leaving the one set before (Wine's
         * ddraw4.c test_material).
         *
         * @param {number} handle
         */
        setBackground(handle){
            if (handle === 0 || !materialOf(handle))
            {
                return DDERR_INVALIDPARAMS;
            }
            background = handle >>> 0;
            return D3D_OK;
        },
        getBackground(){
            return { handle: background, valid: background !== 0 };
        },
        /** @param {any} surface  A depth surface, or null. */
        setBackgroundDepth(surface){
            surface?.addRef();
            backgroundDepth?.release();
            backgroundDepth = surface ?? null;
            return D3D_OK;
        },
        /** @returns {{ surface: any, valid: boolean }} the surface with a reference for the caller */
        getBackgroundDepth(){
            backgroundDepth?.addRef();
            return { surface: backgroundDepth, valid: backgroundDepth !== null };
        },

        /**
         * Clear with the background: the background material's diffuse
         * colour, or black without one; depth to the far plane.
         *
         * @param {readonly any[] | null} rects D3DRECTs
         * @param {number} flags D3DCLEAR
         */
        clear(rects, flags){
            if (!device)
            {
                return D3DERR_VIEWPORTHASNODEVICE;
            }
            const material = materialOf(background);
            return viewport.clear2(rects, flags,
                material ? colourToArgb(material.data.diffuse) : 0, 1, 0);
        },

        /**
         * A clear of no rectangles clears nothing and succeeds, whether the
         * count or the pointer said so (Wine's ddraw4.c test_clear_rect_count).
         *
         * @param {readonly any[] | null} rects @param {number} flags @param {number} colour
         * @param {number} z @param {number} stencil
         */
        clear2(rects, flags, colour, z, stencil){
            if (!device)
            {
                return D3DERR_VIEWPORTHASNODEVICE;
            }
            if (!rects || rects.length === 0)
            {
                return D3D_OK;
            }
            return device.clearThrough(viewport, rects, flags, colour, z, stencil);
        },

        /** @param {any} light */
        addLight(light){
            if (!light)
            {
                return DDERR_INVALIDPARAMS;
            }
            if (light.viewport)
            {
                return D3DERR_LIGHTHASVIEWPORT;
            }
            lights.push(light);
            light.join(viewport);
            light.addRef();
            return D3D_OK;
        },
        /** @param {any} light */
        deleteLight(light){
            const index = light ? lights.indexOf(light) : -1;
            if (index < 0)
            {
                return D3DERR_LIGHTNOTINTHISVIEWPORT;
            }
            lights.splice(index, 1);
            light.leave();
            light.release();
            return D3D_OK;
        },
        /**
         * The list from its head or tail, or on from a light in it; the light
         * handed back carries a reference of its own (Wine's d3d.c: NextLight
         * from the head raises the light's count).
         *
         * @param {any} from @param {number} flags D3DNEXT
         */
        nextLight(from, flags){
            return nextOf(lights, from, flags);
        },
    };
    return viewport;
}

/**
 * The head, the tail, or the one after `from` in a list, with a reference
 * for the caller.
 *
 * @param {any[]} list @param {any} from @param {number} flags D3DNEXT
 * @returns {{ hr: number, found: any }}
 */
function nextOf(list, from, flags){
    let found = null;
    if (flags === D3DNEXT_HEAD)
    {
        found = list[0] ?? null;
    }
    else if (flags === D3DNEXT_TAIL)
    {
        found = list[list.length - 1] ?? null;
    }
    else if (flags === D3DNEXT_NEXT)
    {
        const index = from ? list.indexOf(from) : -1;
        found = index < 0 ? null : list[index + 1] ?? null;
    }
    if (!found)
    {
        return { hr: DDERR_INVALIDPARAMS, found: null };
    }
    found.addRef();
    return { hr: D3D_OK, found };
}

/**
 * A light, which belongs to one viewport at a time. A D3DLIGHT, the first
 * form, carries no flags and is always on; a D3DLIGHT2 is on only when its
 * flags say D3DLIGHT_ACTIVE, and reads its flags back as set (Wine's
 * ddraw4.c test_lighting).
 */
function createLight(){
    /** @type {LegacyLight | null} */
    let data = null;
    /** @type {any} */
    let viewport = null;
    const life = counted(()=>{});
    return {
        get refCount(){
            return life.refCount;
        },
        addRef: ()=>life.addRef(),
        release: ()=>life.release(),
        get viewport(){
            return viewport;
        },
        /** @param {any} owner */
        join(owner){
            viewport = owner;
        },
        leave(){
            viewport = null;
        },
        get data(){
            return data;
        },
        get active(){
            return data !== null && (data.flags & D3DLIGHT_ACTIVE) !== 0;
        },
        /**
         * @param {LegacyLight} light
         * @param {boolean} withFlags  A D3DLIGHT2 rather than a D3DLIGHT.
         */
        setLight(light, withFlags){
            if (!(light.type >= 1 && light.type <= D3DLIGHT_GLSPOT))
            {
                return DDERR_INVALIDPARAMS;
            }
            data = { ...light, flags: withFlags ? light.flags >>> 0 : D3DLIGHT_ACTIVE };
            return D3D_OK;
        },
        /** @returns {LegacyLight | null} */
        getLight(){
            return data ? { ...data } : null;
        },
    };
}

/**
 * The Direct3D object of the older versions, over one Direct3D 7 object.
 * Material handles are the object's: a handle is a small number a program
 * passes back in a light state, a background or an execute buffer.
 *
 * @param {any} d3d7  What createDirect3D7 made for the same DirectDraw object.
 * @param {ReturnType<typeof createTextureHandles>} textures  The surfaces' handles.
 */
export function createLegacyDirect3D(d3d7, textures){
    /** @type {Map<number, any>} */
    const materials = new Map();
    let nextMaterial = 1;

    /** @param {number} handle @returns {any | null} */
    const materialOf = handle=>materials.get(handle >>> 0) ?? null;

    const legacy = {
        textures,
        materialOf,

        /** The devices the older versions enumerate and create, as Direct3D 7 describes them. */
        devices: ()=>d3d7.enumDevices().filter((/** @type {any} */ device)=>
            LEGACY_DEVICES.includes(device.id)),

        createViewport: ()=>createViewport(materialOf),
        createLight,

        createMaterial(){
            let handle = 0;
            let data = emptyMaterial();
            const life = counted(()=>{
                if (handle !== 0)
                {
                    materials.delete(handle);
                }
            });
            const material = {
                get refCount(){
                    return life.refCount;
                },
                addRef: ()=>life.addRef(),
                release: ()=>life.release(),
                get data(){
                    return data;
                },
                /** @param {LegacyMaterial} value */
                setMaterial(value){
                    data = {
                        diffuse: { ...value.diffuse }, ambient: { ...value.ambient },
                        specular: { ...value.specular }, emissive: { ...value.emissive },
                        power: value.power, texture: value.texture >>> 0,
                        rampSize: value.rampSize >>> 0,
                    };
                    return D3D_OK;
                },
                /** The handle that names this material, made on first asking and kept. */
                getHandle(){
                    if (handle === 0)
                    {
                        handle = nextMaterial++;
                        materials.set(handle, material);
                    }
                    return handle;
                },
            };
            return material;
        },

        /**
         * @param {string} deviceId
         * @param {any} surface  The render target.
         * @param {1 | 2 | 3} version
         * @returns {{ hr: number, device: any }}
         */
        createDevice(deviceId, surface, version){
            if (!LEGACY_DEVICES.includes(deviceId))
            {
                return { hr: DDERR_NOTFOUND, device: null };
            }
            const made = d3d7.createDevice(deviceId, surface);
            if (made.hr !== D3D_OK)
            {
                return made;
            }
            return { hr: D3D_OK, device: createLegacyDevice(made.device, version, legacy) };
        },

        /** @param {{ caps: number, fvf: number, numVertices: number }} desc */
        createVertexBuffer: desc=>d3d7.createVertexBuffer(desc),
    };
    return legacy;
}

/**
 * A device of the older versions over a Direct3D 7 device.
 *
 * @param {any} inner   The Direct3D 7 device, owned: it goes with this one's last reference.
 * @param {1 | 2 | 3} version
 * @param {ReturnType<typeof createLegacyDirect3D>} legacy  The object that made it.
 */
function createLegacyDevice(inner, version, legacy){
    const { materialOf, textures } = legacy;
    /** @type {any[]} */
    const viewports = [];
    /** @type {any} */
    let current = null;
    /** The projection as the program set it, before the clip volume's map. */
    let projection = Float32Array.from(IDENTITY);

    /** @type {Map<number, number>} */
    const lightStates = new Map([
        [D3DLIGHTSTATE.MATERIAL, 0],
        [D3DLIGHTSTATE.AMBIENT, 0],
        [D3DLIGHTSTATE.COLORMODEL, D3DCOLOR_RGB],
        [D3DLIGHTSTATE.FOGMODE, 0],
        [D3DLIGHTSTATE.FOGSTART, floatToDword(0)],
        [D3DLIGHTSTATE.FOGEND, floatToDword(1)],
        [D3DLIGHTSTATE.FOGDENSITY, floatToDword(1)],
        [D3DLIGHTSTATE.COLORVERTEX, 1],
    ]);

    /**
     * The legacy render states this device answers for itself, with their
     * defaults; everything else is the Direct3D 7 device's.
     *
     * @type {Map<number, number>}
     */
    const ownStates = new Map([
        [RS.TEXTUREHANDLE, 0],
        [RS.TEXTUREMAPBLEND, D3DTBLEND.MODULATE],
        [RS.TEXTUREMAG, D3DFILTER.NEAREST],
        [RS.TEXTUREMIN, D3DFILTER.NEAREST],
        [RS.TEXTUREADDRESS, D3DTADDRESS_WRAP],
        [RS.TEXTUREADDRESSU, D3DTADDRESS_WRAP],
        [RS.TEXTUREADDRESSV, D3DTADDRESS_WRAP],
        [RS.WRAPU, 0],
        [RS.WRAPV, 0],
        [RS.BORDERCOLOR, 0],
        [RS.MIPMAPLODBIAS, 0],
        [RS.ANISOTROPY, 1],
        [RS.LIGHTING, 1],
    ]);

    /**
     * Whether stage zero is still what TEXTUREMAPBLEND set. A stage state
     * written with another value turns the legacy blend off, and setting
     * the blend to what it already is does not turn it back on -- only a
     * different mode does (Wine's ddraw4.c test_texturemapblend).
     */
    let legacyBlend = true;
    /** @type {Map<number, number>} */
    let blendSet = new Map(blendStates(D3DTBLEND.MODULATE));
    for (const [type, value] of blendSet)
    {
        inner.SetTextureStageState(0, type, value);
    }
    // No render state lights a draw in these versions; the rule above does.
    inner.SetRenderState(RS.LIGHTING, 0);
    // Specular highlights start on through IDirect3DDevice2 and off through
    // the third (Wine's ddraw2.c and ddraw4.c test_lighting_interface_versions).
    inner.SetRenderState(RS.SPECULARENABLE, version < 3 ? 1 : 0);

    /**
     * Whether stage zero's texture is the one TEXTUREHANDLE names, looked up
     * at each draw so that a handle swap is seen; a SetTexture on stage zero
     * takes the stage back.
     */
    let textureByHandle = false;

    /** Draws, by kind, for GetStats. */
    const stats = { triangles: 0, lines: 0, points: 0, vertices: 0 };

    /** @type {Map<number, Float32Array>} the first generation's matrices, by handle */
    const matrices = new Map();
    let nextMatrix = 1;

    /**
     * An immediate-mode primitive being built by Begin, Vertex and Index.
     *
     * @type {{ type: number, fvf: number, flags: number, stride: number,
     *   vertices: Uint8Array[], indexed: Uint8Array | null, indices: number[] } | null}
     */
    let building = null;

    let count = 1;
    let enabledLights = 0;

    /**
     * A viewport's rectangle as the Direct3D 7 device's, cut to the target:
     * the older versions accepted any rectangle and clipped to the surface.
     *
     * @param {ViewportData} data
     */
    const applyRectangle = data=>{
        /** @type {{ surface?: any }} */
        const held = {};
        inner.GetRenderTarget(held);
        const target = held.surface;
        target.release();
        const x = Math.max(0, Math.min(data.x, target.width - 1));
        const y = Math.max(0, Math.min(data.y, target.height - 1));
        inner.SetViewport({
            X: x, Y: y,
            Width: Math.max(1, Math.min(data.width, target.width - x)),
            Height: Math.max(1, Math.min(data.height, target.height - y)),
            MinZ: data.minZ, MaxZ: data.maxZ,
        });
    };

    /**
     * The viewport draws go through: the current one, or the one an
     * execute buffer is run through while it runs. Its lights are the ones
     * lit by.
     *
     * @type {any}
     */
    let active = null;
    const inEffect = ()=>active ?? current;

    /** The Direct3D 7 viewport and projection the viewport in effect stands for. */
    const applyViewport = ()=>{
        const data = inEffect()?.data ?? null;
        if (!data)
        {
            inner.SetTransform(D3DTRANSFORMSTATE.PROJECTION, projection);
            return;
        }
        applyRectangle(data);
        inner.SetTransform(D3DTRANSFORMSTATE.PROJECTION,
            multiplyMatrices(projection, clipVolumeMatrix(data)));
    };

    /** The active lights of the viewport in effect, as the Direct3D 7 device's first few. */
    const syncLights = ()=>{
        const on = (inEffect()?.lights ?? []).filter((/** @type {any} */ light)=>light.active)
            .slice(0, MAX_ACTIVE_LIGHTS);
        on.forEach((/** @type {any} */ light, /** @type {number} */ index)=>{
            inner.SetLight(index, lightFor(light.data));
            inner.LightEnable(index, true);
        });
        for (let index = on.length; index < enabledLights; index++)
        {
            inner.LightEnable(index, false);
        }
        enabledLights = on.length;
    };

    /** The material the MATERIAL light state names, handed to the Direct3D 7 device. */
    const applyMaterial = ()=>{
        const material = materialOf(lightStates.get(D3DLIGHTSTATE.MATERIAL) ?? 0);
        if (material)
        {
            const m = material.data;
            inner.SetMaterial({ Diffuse: m.diffuse, Ambient: m.ambient, Specular: m.specular,
                Emissive: m.emissive, Power: m.power });
            syncLights();
        }
        return material;
    };

    /**
     * Lighting, material and lights for one draw, the texture a handle
     * names, and the stage-zero alpha TEXTUREMAPBLEND's MODULATE means for
     * the texture bound now. Answers what to put back afterwards.
     *
     * @param {number} fvf @param {number} flags
     * @returns {() => void}
     */
    const prepare = (fvf, flags)=>{
        if (textureByHandle)
        {
            inner.SetTexture(0, textures.surfaceOf(ownStates.get(RS.TEXTUREHANDLE) ?? 0));
        }
        const lit = (fvf & FVF_POSITION_MASK) !== FVF_XYZRHW && (fvf & FVF_NORMAL) !== 0
            && (flags & D3DDP_DONOTLIGHT) === 0 && applyMaterial() !== null;
        inner.SetRenderState(RS.LIGHTING, lit ? 1 : 0);
        const mode = ownStates.get(RS.TEXTUREMAPBLEND);
        if (legacyBlend && (mode === D3DTBLEND.MODULATE || mode === D3DTBLEND.MODULATEMASK))
        {
            /** @type {{ surface?: any }} */
            const bound = {};
            inner.GetTexture(0, bound);
            const hasAlpha = bound.surface
                && (bound.surface.pixelFormat.flags & DDPF_ALPHAPIXELS) !== 0;
            bound.surface?.release();
            if (!hasAlpha)
            {
                /** @type {{ value?: number }} */
                const kept = {};
                inner.GetTextureStageState(0, D3DTSS.ALPHAOP, kept);
                inner.SetTextureStageState(0, D3DTSS.ALPHAOP, D3DTOP.SELECTARG2);
                return ()=>inner.SetTextureStageState(0, D3DTSS.ALPHAOP, kept.value);
            }
        }
        return ()=>{};
    };

    /**
     * One draw through the Direct3D 7 device, lit or not by the rule.
     *
     * @param {number} type @param {number} fvf @param {number} flags
     * @param {number} elements  The vertices or indices the draw names.
     * @param {number} vertices  How many vertices it reads.
     * @param {() => number} run
     */
    const draw = (type, fvf, flags, elements, vertices, run)=>{
        const restore = prepare(fvf, flags);
        const hr = run();
        restore();
        if (hr === D3D_OK)
        {
            const primitives = primitivesOf(type, elements);
            stats.vertices += vertices;
            if (type === D3DPT.POINTLIST)
            {
                stats.points += primitives;
            }
            else if (type === D3DPT.LINELIST || type === D3DPT.LINESTRIP)
            {
                stats.lines += primitives;
            }
            else
            {
                stats.triangles += primitives;
            }
        }
        return hr;
    };

    /** @param {number} fvf @returns {number} the stride, or zero for a format with none */
    const strideOf = fvf=>{
        try
        {
            return decodeFvf(fvf >>> 0).stride;
        }
        catch (e){
            void e;
            return 0;
        }
    };

    const device = {
        version,
        inner,
        legacy,
        get refCount(){
            return count;
        },
        addRef(){
            count++;
            return count;
        },
        /**
         * The last reference takes the viewports with it, and the Direct3D 7
         * device, which holds the target (Wine's ddraw4.c test_viewport_object:
         * the device's release leaves a viewport at the program's own count).
         * Before the third generation the current viewport's reference is
         * not given back (ddraw2.c test_viewport_object, where Windows keeps
         * it and Wine does not yet).
         */
        release(){
            count--;
            if (count > 0)
            {
                return count;
            }
            for (const viewport of viewports.splice(0))
            {
                viewport.detach();
                viewport.release();
            }
            if (version >= 3)
            {
                current?.release();
            }
            current = null;
            inner.release();
            return 0;
        },

        // --- viewports ---

        /** @param {any} viewport */
        addViewport(viewport){
            if (!viewport || viewports.includes(viewport) || viewport.device)
            {
                return DDERR_INVALIDPARAMS;
            }
            viewports.push(viewport);
            viewport.addRef();
            viewport.attach(device);
            return D3D_OK;
        },

        /**
         * A deleted current viewport is current no more. The third
         * generation gives back the reference that made it current; the
         * older ones keep it, and nothing ever releases it (Wine's ddraw4.c
         * and ddraw2.c test_viewport_object).
         *
         * @param {any} viewport
         */
        deleteViewport(viewport){
            const index = viewport ? viewports.indexOf(viewport) : -1;
            if (index < 0)
            {
                return DDERR_INVALIDPARAMS;
            }
            viewports.splice(index, 1);
            viewport.detach();
            if (current === viewport)
            {
                current = null;
                if (version >= 3)
                {
                    viewport.release();
                }
            }
            viewport.release();
            return D3D_OK;
        },

        /** @param {any} from @param {number} flags D3DNEXT */
        nextViewport: (from, flags)=>nextOf(viewports, from, flags),

        /** @param {any} viewport  One of this device's; the device holds a reference to it. */
        setCurrentViewport(viewport){
            if (!viewport || !viewports.includes(viewport))
            {
                return DDERR_INVALIDPARAMS;
            }
            if (viewport !== current)
            {
                viewport.addRef();
                current?.release();
                current = viewport;
            }
            applyViewport();
            return D3D_OK;
        },

        /** @returns {{ hr: number, viewport: any }} with a reference for the caller */
        getCurrentViewport(){
            if (!current)
            {
                return { hr: D3DERR_NOCURRENTVIEWPORT, viewport: null };
            }
            current.addRef();
            return { hr: D3D_OK, viewport: current };
        },

        /** @param {any} viewport */
        viewportChanged(viewport){
            if (viewport === inEffect())
            {
                applyViewport();
            }
        },

        /**
         * Whether the render target holds a viewport's rectangle.
         *
         * @param {ViewportData} data
         */
        holds(data){
            /** @type {{ surface?: any }} */
            const held = {};
            inner.GetRenderTarget(held);
            const target = held.surface;
            target.release();
            return data.x + data.width <= target.width && data.y + data.height <= target.height;
        },

        /**
         * Runs `run` with `viewport` in effect -- its rectangle, its clip
         * volume and its lights -- and puts the current one back after. How
         * IDirect3DDevice::Execute draws through the viewport it is handed.
         *
         * @param {any} viewport  One of this device's.
         * @param {() => number} run
         */
        through(viewport, run){
            if (!viewports.includes(viewport))
            {
                return DDERR_INVALIDPARAMS;
            }
            active = viewport;
            applyViewport();
            try
            {
                return run();
            }
            finally
            {
                active = null;
                applyViewport();
            }
        },

        /**
         * A clear through a viewport, over its rectangle whether it is the
         * current one or not.
         *
         * @param {any} viewport @param {readonly any[]} rects @param {number} flags
         * @param {number} colour @param {number} z @param {number} stencil
         */
        clearThrough(viewport, rects, flags, colour, z, stencil){
            /** @type {{ viewport?: any }} */
            const kept = {};
            inner.GetViewport(kept);
            if (viewport.data)
            {
                applyRectangle(viewport.data);
            }
            const hr = inner.Clear(rects.length, rects, flags, colour, z, stencil);
            inner.SetViewport(kept.viewport);
            return hr;
        },

        // --- target and scene ---

        BeginScene: ()=>inner.BeginScene(),
        EndScene: ()=>inner.EndScene(),

        /** @param {any} surface */
        setRenderTarget(surface){
            const hr = inner.SetRenderTarget(surface);
            if (hr === D3D_OK)
            {
                applyViewport();
            }
            return hr;
        },

        // --- states ---

        /** @param {number} state @param {number} value */
        setRenderState(state, value){
            if (!ownStates.has(state))
            {
                return inner.SetRenderState(state, value);
            }
            const previous = ownStates.get(state);
            ownStates.set(state, value >>> 0);
            switch (state)
            {
                case RS.TEXTUREHANDLE:
                    textureByHandle = true;
                    return inner.SetTexture(0, textures.surfaceOf(value));
                case RS.TEXTUREMAPBLEND:
                    if (value !== previous)
                    {
                        legacyBlend = true;
                        blendSet = new Map(blendStates(value));
                        for (const [type, setting] of blendSet)
                        {
                            inner.SetTextureStageState(0, type, setting);
                        }
                    }
                    return D3D_OK;
                case RS.TEXTUREMAG:
                    return inner.SetTextureStageState(0, D3DTSS.MAGFILTER,
                        filterStates(value).filter);
                case RS.TEXTUREMIN: {
                    const { filter, mip } = filterStates(value);
                    inner.SetTextureStageState(0, D3DTSS.MINFILTER, filter);
                    return inner.SetTextureStageState(0, D3DTSS.MIPFILTER, mip);
                }
                case RS.TEXTUREADDRESS:
                    inner.SetTextureStageState(0, D3DTSS.ADDRESSU, value);
                    return inner.SetTextureStageState(0, D3DTSS.ADDRESSV, value);
                case RS.TEXTUREADDRESSU:
                    return inner.SetTextureStageState(0, D3DTSS.ADDRESSU, value);
                case RS.TEXTUREADDRESSV:
                    return inner.SetTextureStageState(0, D3DTSS.ADDRESSV, value);
                case RS.WRAPU:
                case RS.WRAPV: {
                    /** @type {{ value?: number }} */
                    const wrap = {};
                    inner.GetRenderState(RS.WRAP0, wrap);
                    const bit = state === RS.WRAPU ? D3DWRAP_U : D3DWRAP_V;
                    return inner.SetRenderState(RS.WRAP0,
                        value !== 0 ? (wrap.value ?? 0) | bit : (wrap.value ?? 0) & ~bit);
                }
                case RS.BORDERCOLOR:
                    return inner.SetTextureStageState(0, D3DTSS.BORDERCOLOR, value);
                case RS.MIPMAPLODBIAS:
                    return inner.SetTextureStageState(0, D3DTSS.MIPMAPLODBIAS, value);
                case RS.ANISOTROPY:
                    return inner.SetTextureStageState(0, D3DTSS.MAXANISOTROPY, value);
                default:
                    // D3DRENDERSTATE_LIGHTING is not a state of these
                    // versions: it is kept for reading back and does nothing.
                    return D3D_OK;
            }
        },

        /** @param {number} state @param {{ value?: number }} out */
        getRenderState(state, out){
            if (ownStates.has(state))
            {
                out.value = ownStates.get(state);
                return D3D_OK;
            }
            return inner.GetRenderState(state, out);
        },

        /** @param {number} state @param {number} value */
        setLightState(state, value){
            if (!lightStates.has(state))
            {
                return DDERR_INVALIDPARAMS;
            }
            lightStates.set(state, value >>> 0);
            switch (state)
            {
                case D3DLIGHTSTATE.AMBIENT:
                    return inner.SetRenderState(RS.AMBIENT, value);
                case D3DLIGHTSTATE.FOGMODE:
                    return inner.SetRenderState(RS.FOGVERTEXMODE, value);
                case D3DLIGHTSTATE.FOGSTART:
                    return inner.SetRenderState(RS.FOGSTART, value);
                case D3DLIGHTSTATE.FOGEND:
                    return inner.SetRenderState(RS.FOGEND, value);
                case D3DLIGHTSTATE.FOGDENSITY:
                    return inner.SetRenderState(RS.FOGDENSITY, value);
                case D3DLIGHTSTATE.COLORVERTEX:
                    return inner.SetRenderState(RS.COLORVERTEX, value);
                default:
                    return D3D_OK;
            }
        },

        /** @param {number} state @param {{ value?: number }} out */
        getLightState(state, out){
            if (!lightStates.has(state))
            {
                return DDERR_INVALIDPARAMS;
            }
            out.value = lightStates.get(state);
            return D3D_OK;
        },

        /** @param {number} type @param {ArrayLike<number>} matrix */
        setTransform(type, matrix){
            if (type !== D3DTRANSFORMSTATE.PROJECTION)
            {
                return inner.SetTransform(type, matrix);
            }
            if (!matrix || matrix.length !== 16)
            {
                return DDERR_INVALIDPARAMS;
            }
            projection = Float32Array.from(matrix);
            applyViewport();
            return D3D_OK;
        },

        /** @param {number} type @param {{ matrix?: Float32Array }} out */
        getTransform(type, out){
            if (type !== D3DTRANSFORMSTATE.PROJECTION)
            {
                return inner.GetTransform(type, out);
            }
            out.matrix = Float32Array.from(projection);
            return D3D_OK;
        },

        /** @param {number} type @param {ArrayLike<number>} matrix */
        multiplyTransform(type, matrix){
            if (type !== D3DTRANSFORMSTATE.PROJECTION)
            {
                return inner.MultiplyTransform(type, matrix);
            }
            if (!matrix || matrix.length !== 16)
            {
                return DDERR_INVALIDPARAMS;
            }
            projection = Float32Array.from(multiplyMatrices(projection, matrix));
            applyViewport();
            return D3D_OK;
        },

        /** @param {number} stage @param {number} type @param {number} value */
        setTextureStageState(stage, type, value){
            const hr = inner.SetTextureStageState(stage, type, value);
            if (hr === D3D_OK && stage === 0 && legacyBlend && blendSet.has(type)
                && blendSet.get(type) !== value >>> 0)
            {
                legacyBlend = false;
            }
            return hr;
        },

        /** @param {number} stage @param {any} surface */
        setTexture(stage, surface){
            const hr = inner.SetTexture(stage, surface);
            if (hr === D3D_OK && stage === 0)
            {
                textureByHandle = false;
            }
            return hr;
        },

        // --- drawing ---

        /**
         * @param {number} type @param {number} fvf @param {Uint8Array | null} vertices
         * @param {number} vertexCount @param {number} flags
         */
        drawPrimitive: (type, fvf, vertices, vertexCount, flags)=>draw(type, fvf, flags,
            vertexCount, vertexCount, ()=>inner.DrawPrimitive(type, fvf, vertices, vertexCount)),

        /**
         * @param {number} type @param {number} fvf @param {Uint8Array | null} vertices
         * @param {number} vertexCount @param {Uint8Array | null} indices
         * @param {number} indexCount @param {number} flags
         */
        drawIndexedPrimitive: (type, fvf, vertices, vertexCount, indices, indexCount, flags)=>
            draw(type, fvf, flags, indexCount, vertexCount, ()=>inner.DrawIndexedPrimitive(type,
                fvf, vertices, vertexCount, indices, indexCount)),

        /**
         * @param {number} type @param {any} buffer @param {number} start
         * @param {number} vertexCount @param {number} flags
         */
        drawPrimitiveVB: (type, buffer, start, vertexCount, flags)=>draw(type,
            buffer ? buffer.fvf : 0, flags, vertexCount, vertexCount,
            ()=>inner.DrawPrimitiveVB(type, buffer, start, vertexCount)),

        /**
         * The whole buffer is the vertices an indexed draw may reach, in this
         * version: it names no range.
         *
         * @param {number} type @param {any} buffer @param {number} indexAddress
         * @param {number} indexCount @param {number} flags
         */
        drawIndexedPrimitiveVB: (type, buffer, indexAddress, indexCount, flags)=>draw(type,
            buffer ? buffer.fvf : 0, flags, indexCount, buffer ? buffer.numVertices : 0,
            ()=>inner.DrawIndexedPrimitiveVB(type, buffer, 0, buffer ? buffer.numVertices : 0,
                indexAddress, indexCount)),

        /**
         * Immediate mode: a primitive given a vertex at a time.
         *
         * @param {number} type @param {number} fvf @param {number} flags
         */
        begin(type, fvf, flags){
            if (building)
            {
                return D3DERR_INBEGIN;
            }
            const stride = strideOf(fvf);
            if (stride === 0)
            {
                return D3DERR_INVALIDVERTEXTYPE;
            }
            building = { type, fvf, flags, stride, vertices: [], indexed: null, indices: [] };
            return D3D_OK;
        },

        /**
         * @param {number} type @param {number} fvf @param {Uint8Array | null} vertices
         * @param {number} flags
         */
        beginIndexed(type, fvf, vertices, flags){
            if (!vertices)
            {
                return DDERR_INVALIDPARAMS;
            }
            const hr = device.begin(type, fvf, flags);
            if (hr === D3D_OK && building)
            {
                building.indexed = vertices;
            }
            return hr;
        },

        /** The stride Vertex reads, while a Begin is open. */
        get beginStride(){
            return building ? building.stride : 0;
        },

        /** @param {Uint8Array} vertex */
        vertex(vertex){
            if (!building || building.indexed)
            {
                return D3DERR_NOTINBEGIN;
            }
            building.vertices.push(vertex);
            return D3D_OK;
        },

        /** @param {number} index */
        index(index){
            if (!building || !building.indexed)
            {
                return D3DERR_NOTINBEGIN;
            }
            building.indices.push(index & 0xffff);
            return D3D_OK;
        },

        end(){
            if (!building)
            {
                return D3DERR_NOTINBEGIN;
            }
            const made = building;
            building = null;
            if (made.indexed)
            {
                const indices = new Uint8Array(Uint16Array.from(made.indices).buffer);
                return device.drawIndexedPrimitive(made.type, made.fvf, made.indexed,
                    Math.floor(made.indexed.byteLength / made.stride), indices,
                    made.indices.length, made.flags);
            }
            const vertices = new Uint8Array(made.vertices.length * made.stride);
            made.vertices.forEach((vertex, index)=>vertices.set(vertex, index * made.stride));
            return device.drawPrimitive(made.type, made.fvf, vertices, made.vertices.length,
                made.flags);
        },

        getStats: ()=>({ ...stats }),

        /**
         * What ProcessVertices reads of this device: the Direct3D 7 state,
         * lit by this version's rule -- a material handle set is lighting on.
         */
        processingState(){
            const material = applyMaterial();
            const state = inner.processingState();
            return {
                ...state,
                renderState: (/** @type {number} */ which)=>(which === RS.LIGHTING
                    ? (material ? 1 : 0)
                    : state.renderState(which)),
            };
        },

        // --- the first generation's matrices ---

        createMatrix(){
            const handle = nextMatrix++;
            matrices.set(handle, Float32Array.from(IDENTITY));
            return handle;
        },
        /** @param {number} handle @param {ArrayLike<number>} matrix */
        setMatrix(handle, matrix){
            if (!matrices.has(handle))
            {
                return D3DERR_MATRIX_SETDATA_FAILED;
            }
            matrices.set(handle, Float32Array.from(matrix));
            return D3D_OK;
        },
        /** @param {number} handle @returns {Float32Array | null} */
        getMatrix: handle=>matrices.get(handle) ?? null,
        /** @param {number} handle */
        deleteMatrix: handle=>(matrices.delete(handle) ? D3D_OK : D3DERR_MATRIX_DESTROY_FAILED),
    };
    return device;
}

/**
 * A light of these versions as the Direct3D 7 device lights with one. The
 * colour is its diffuse and, unless the light says otherwise, its specular;
 * a parallel point light is a directional one pointing away from where it
 * is, and a GL spot is a spot.
 *
 * @param {LegacyLight} light
 */
function lightFor(light){
    const parallel = light.type === D3DLIGHT_PARALLELPOINT;
    let type = light.type;
    if (parallel)
    {
        type = D3DLIGHT7_DIRECTIONAL;
    }
    else if (light.type === D3DLIGHT_GLSPOT)
    {
        type = D3DLIGHT7_SPOT;
    }
    return {
        Type: type,
        Diffuse: { ...light.color },
        Specular: (light.flags & D3DLIGHT_NO_SPECULAR) !== 0 ? black() : { ...light.color },
        Ambient: black(),
        Position: { ...light.position },
        Direction: parallel
            ? { x: -light.position.x, y: -light.position.y, z: -light.position.z }
            : { ...light.direction },
        Range: light.range,
        Falloff: light.falloff,
        Attenuation0: light.attenuation0,
        Attenuation1: light.attenuation1,
        Attenuation2: light.attenuation2,
        Theta: light.theta,
        Phi: light.phi,
    };
}
