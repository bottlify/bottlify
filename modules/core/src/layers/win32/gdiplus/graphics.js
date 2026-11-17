/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * GDI+'s Graphics: a surface - a bitmap's pixels, or a DC's - and the
 * state a program draws on it with: world and page transforms, a clip, the
 * rendering hints, saved states and containers. Drawing builds the shape
 * as a path of the path family's own (`path.js`), takes it to device
 * pixels and lays the brush's colour on what it covers inside the clip
 * (`raster.js`).
 *
 * A bitmap's pixels are drawn in place. A DC's are read through a DIB
 * section, drawn, and written back with BitBlt, so what GDI drew before
 * stays under what GDI+ draws over it. A state saved and a container begun
 * share one stack of tokens numbered across every graphics, as GDI+'s do.
 * While a program holds the DC GetDC handed it, every other call on the
 * graphics is ObjectBusy.
 */

import { Status, fn } from './kit.js';
import { IDENTITY, MatrixOrderAppend, apply, combine, invert, multiply, rotation } from
    './matrix.js';
import {
    DASHES, FLATNESS_DEFAULT, FillModeAlternate, FillModeWinding, PathPointTypeCloseSubpath,
    PathPointTypePathTypeMask, PathPointTypeStart, dashed, emptyPath, flatten,
} from './path.js';
import {
    boundsOfNode, cloneNode, combine as combineRegion, contains, infinite, rectNode, areaOf,
    transformNode, CombineMode, pathNode,
} from './region.js';
import { LineCap, boxOf, coverage, hatchPattern, paint, shaderOf, strokePolygons } from
    './raster.js';
import { combineAreas } from '../gdi32/regions.js';

/** Unit. */
export const Unit = Object.freeze({ World: 0, Display: 1, Pixel: 2, Point: 3, Inch: 4,
    Document: 5, Millimeter: 6 });

/** CoordinateSpace. */
const CoordinateSpaceWorld = 0;
const CoordinateSpaceDevice = 2;

/** SmoothingMode, InterpolationMode, PixelOffsetMode, CompositingMode. */
const SmoothingModeNone = 3;
const SmoothingModeAntiAlias = 4;
const SmoothingModeAntiAlias8x8 = 6;
const InterpolationModeBilinear = 3;
const InterpolationModeHighQualityBicubic = 7;
const InterpolationModeNearestNeighbor = 5;
const PixelOffsetModeHalf = 4;
const PixelOffsetModeHighQuality = 2;
const CompositingModeSourceCopy = 1;

/** The colour a bitmap's DC starts filled with, to tell what GDI drew: COLORREF 0x0c0b0d, as GDI+'s. */
const DC_KEY = 0x0d0b0c;

/** The ROP BitBlt copies with. */
const SRCCOPY = 0x00cc0020;

/** How far a figure's straight pieces may stray from its curves, in device pixels. */
const FLATNESS = FLATNESS_DEFAULT;

/**
 * Pixels in one of a unit at a resolution.
 *
 * @param {number} unit @param {number} dpi
 */
export const pixelsPer = (unit, dpi)=>{
    switch (unit)
    {
        case Unit.Point: return dpi / 72;
        case Unit.Inch: return dpi;
        case Unit.Document: return dpi / 300;
        case Unit.Millimeter: return dpi / 25.4;
        default: return 1;
    }
};

/**
 * @typedef {import('./raster.js').Box} Box
 *
 * @typedef {Object} Target
 * @property {() => Box} bounds  the device pixels there are
 * @property {(box: Box, edit: (pixels: Uint8Array) => void) => void} modify  the box's
 *     pixels as BGRA, straight alpha, handed to `edit` and kept
 * @property {boolean} opaque  whether the surface keeps no alpha
 * @property {number} hdc  the DC, for a DC's graphics
 * @property {number} image  the bitmap's handle, for an image's
 *
 * @typedef {Object} State
 * @property {import('./matrix.js').Elements} world
 * @property {number} pageUnit @property {number} pageScale
 * @property {import('./region.js').Node} clip  in device pixels
 * @property {number} smoothing @property {number} compositing @property {number} quality
 * @property {number} interpolation @property {number} pixelOffset
 * @property {number} textHint @property {number} textContrast
 * @property {[number, number]} origin
 * @property {import('./matrix.js').Elements} base  a container's transform
 * @property {import('./region.js').Node} baseClip  a container's clip
 *
 * @typedef {Object} Graphics
 * @property {Target} target
 * @property {number} dpiX @property {number} dpiY
 * @property {State} state
 * @property {{ token: number, container: boolean, state: State }[]} stack
 * @property {number} heldDc  the DC GetDC handed out, 0 for none
 * @property {(() => void) | null} release  what ReleaseDC does with it
 * @property {number} window  the window a graphics of one keeps its DC for
 */

/** @returns {State} */
const freshState = ()=>({ world: [...IDENTITY], pageUnit: Unit.Display, pageScale: 1,
    clip: infinite(), smoothing: SmoothingModeNone, compositing: 0, quality: 0,
    interpolation: InterpolationModeBilinear, pixelOffset: 0, textHint: 0, textContrast: 4,
    origin: [0, 0], base: [...IDENTITY], baseClip: infinite() });

/** @param {State} state @returns {State} */
const copyState = state=>({ ...state, world: [...state.world], clip: cloneNode(state.clip),
    origin: [...state.origin], base: [...state.base], baseClip: cloneNode(state.baseClip) });

/**
 * @param {import('./kit.js').Kit} kit
 * @param {Object} deps
 * @param {import('./image.js').ImageHost & { divergence?: (api: string, detail: string,
 *     kind?: string) => void }} deps.host
 * @param {{ elements: (at: number) => (import('./matrix.js').Elements | undefined),
 *     set: (at: number, m: import('./matrix.js').Elements) => boolean }} deps.matrices
 * @param {{ functions: Record<string, { handler: (args: number[]) => any }>,
 *     get: (at: number) => (import('./path.js').Path | undefined) }} deps.paths
 * @param {{ get: (at: number) => (import('./brush.js').Brush | undefined) }} deps.brushes
 * @param {{ get: (at: number) => (import('./pen.js').Pen | undefined) }} deps.pens
 * @param {{ node: (at: number) => (import('./region.js').Node | undefined),
 *     set: (at: number, node: import('./region.js').Node) => boolean,
 *     hrgnRects: (hrgn: number) => number[][] | null }} deps.regions
 * @param {ReturnType<typeof import('./image.js').createImageFunctions>} deps.images
 * @param {(at: number) => ((pixel: number[]) => number[]) | null} deps.attributes  an
 *     ImageAttributes' colour adjustment, null for none
 */
export function createGraphicsFunctions(kit, deps){
    const { host, matrices, paths, brushes, pens, regions, images, attributes } = deps;
    const { Ok, InvalidParameter, OutOfMemory, ObjectBusy, GenericError, NotImplemented }
        = Status;
    const gdi32 = host.gdi32;
    /** Tokens of saved states and containers, numbered across every graphics. */
    let nextToken = 1;
    /** @param {number} at @returns {Graphics | undefined} */
    const get = at=>kit.get(at, 'graphics');

    /** The divergences said: each once. @type {Set<string>} */
    const said = new Set();
    /** @param {string} api @param {string} detail @param {string} [kind] */
    const diverge = (api, detail, kind)=>{
        if (!said.has(`${api}:${detail}`))
        {
            said.add(`${api}:${detail}`);
            host.divergence?.(api, detail, kind);
        }
    };

    /**
     * Memory of `bytes` for the length of `use`.
     *
     * @template T
     * @param {number} bytes @param {(at: number) => T} use @param {T} none
     * @returns {T}
     */
    const withBlock = (bytes, use, none)=>{
        const at = host.allocate(bytes);
        if (at === 0)
        {
            return none;
        }
        try
        {
            return use(at);
        }
        finally
        {
            host.free(at);
        }
    };

    /** @param {number} at @returns {Target} */
    const imageTarget = at=>({
        bounds: ()=>{
            const image = images.get(at);
            return { left: 0, top: 0, right: image?.width ?? 0, bottom: image?.height ?? 0 };
        },
        modify: (box, edit)=>{
            const image = images.get(at);
            if (!image)
            {
                return;
            }
            const width = box.right - box.left;
            const height = box.bottom - box.top;
            const pixels = images.readBgra(image, box.left, box.top, width, height);
            edit(pixels);
            images.writeBgra(image, box.left, box.top, width, height, pixels);
        },
        get opaque(){
            return ((images.get(at)?.format ?? 0) & 0xc0000) === 0;
        },
        hdc: 0,
        image: at,
    });

    /**
     * A DC's surface: its bounds GetClipBox's, its pixels through a DIB
     * section BitBlt fills from it and copies back.
     *
     * @param {number} hdc @returns {Target}
     */
    const dcTarget = hdc=>({
        bounds: ()=>withBlock(16, at=>{
            if (!gdi32 || gdi32('GetClipBox', [hdc, at]) === 0)
            {
                return { left: 0, top: 0, right: 0, bottom: 0 };
            }
            const [left, top, right, bottom] = kit.i32s(at, 4);
            return { left, top, right, bottom };
        }, { left: 0, top: 0, right: 0, bottom: 0 }),
        modify: (box, edit)=>{
            if (!gdi32)
            {
                return;
            }
            const width = box.right - box.left;
            const height = box.bottom - box.top;
            withBlock(48, info=>{
                const header = new DataView(new ArrayBuffer(40));
                header.setUint32(0, 40, true);
                header.setInt32(4, width, true);
                header.setInt32(8, -height, true);
                header.setUint16(12, 1, true);
                header.setUint16(14, 32, true);
                kit.write(info, new Uint8Array(header.buffer));
                const memory = gdi32('CreateCompatibleDC', [hdc]);
                const section = gdi32('CreateDIBSection', [memory, info, 0, info + 40, 0, 0]);
                if (memory === 0 || section === 0)
                {
                    diverge('GdipDraw', 'a DC whose pixels could not be read', 'loss');
                    if (memory)
                    {
                        gdi32('DeleteDC', [memory]);
                    }
                    return;
                }
                const bits = kit.u32(info + 40);
                const old = gdi32('SelectObject', [memory, section]);
                gdi32('BitBlt', [memory, 0, 0, width, height, hdc, box.left, box.top, SRCCOPY]);
                const pixels = kit.read(bits, width * height * 4);
                for (let i = 3; i < pixels.length; i += 4)
                {
                    pixels[i] = 255;
                }
                edit(pixels);
                kit.write(bits, pixels);
                gdi32('BitBlt', [hdc, box.left, box.top, width, height, memory, 0, 0, SRCCOPY]);
                gdi32('SelectObject', [memory, old]);
                gdi32('DeleteObject', [section]);
                gdi32('DeleteDC', [memory]);
            }, undefined);
        },
        opaque: true,
        hdc,
        image: 0,
    });

    /**
     * A new graphics on a surface, published to `out`.
     *
     * @param {Target} target @param {number} out @param {number} [dpiX] @param {number} [dpiY]
     * @param {number} [window]
     */
    const create = (target, out, dpiX = 96, dpiY = 96, window = 0)=>{
        /** @type {Graphics} */
        const graphics = { target, dpiX, dpiY, state: freshState(), stack: [], heldDc: 0,
            release: null, window };
        kit.add('graphics', graphics, out);
        return Ok;
    };

    /** Page units to device pixels. @param {Graphics} g */
    const pageFactor = g=>{
        const { pageUnit, pageScale } = g.state;
        return pixelsPer(pageUnit, g.dpiX) * pageScale;
    };
    /** World to device. @param {Graphics} g @returns {import('./matrix.js').Elements} */
    const deviceOf = g=>{
        const s = pageFactor(g);
        return multiply(multiply(g.state.world, [s, 0, 0, s, 0, 0]), g.state.base);
    };
    /** @param {Graphics} g */
    const effectiveClip = g=>(g.state.baseClip.type === 'infinite' ? g.state.clip
        : combineRegion(cloneNode(g.state.baseClip), g.state.clip, CombineMode.Intersect));
    /** The pixel-centre offset of the graphics' PixelOffsetMode. @param {Graphics} g */
    const offsetOf = g=>(g.state.pixelOffset === PixelOffsetModeHalf
        || g.state.pixelOffset === PixelOffsetModeHighQuality ? 0.5 : 0);
    /** @param {Graphics} g */
    const antialiased = g=>g.state.smoothing >= SmoothingModeAntiAlias
        && g.state.smoothing <= SmoothingModeAntiAlias8x8;

    /**
     * The clip as a mask over a box, 1 where it lets a pixel through; null
     * where it lets every one through.
     *
     * @param {Graphics} g @param {Box} box
     */
    const clipMask = (g, box)=>{
        const clip = effectiveClip(g);
        if (clip.type === 'infinite')
        {
            return null;
        }
        const width = box.right - box.left;
        const mask = new Uint8Array(width * (box.bottom - box.top));
        for (const r of areaOf(clip))
        {
            const left = Math.max(r.left, box.left);
            const right = Math.min(r.right, box.right);
            for (let y = Math.max(r.top, box.top); y < Math.min(r.bottom, box.bottom); y++)
            {
                if (right > left)
                {
                    mask.fill(1, (y - box.top) * width + left - box.left,
                        (y - box.top) * width + right - box.left);
                }
            }
        }
        return mask;
    };

    /**
     * Sources a shader reads: a texture's pixels and a hatch's pattern.
     *
     * @param {Graphics} g
     */
    const sources = g=>({
        /** @param {number} at */
        texture: at=>{
            const image = images.get(at);
            return image ? { width: image.width, height: image.height,
                pixels: images.readBgra(image, 0, 0, image.width, image.height) } : null;
        },
        /** @param {number} style */
        hatch: style=>hatchPattern(style),
        origin: /** @type {[number, number]} */ (g.state.origin),
    });

    /**
     * Lays a shader on device polygons inside the clip.
     *
     * @param {Graphics} g @param {[number, number][][]} polygons @param {number} fill
     * @param {import('./raster.js').Shader} shader
     * @param {boolean} [aa]  antialiasing, the graphics' own by default
     */
    const lay = (g, polygons, fill, shader, aa = antialiased(g))=>{
        const box = boxOf(polygons, g.target.bounds());
        if (!box)
        {
            return Ok;
        }
        const offset = offsetOf(g);
        const cover = coverage(polygons, fill, box, aa, offset);
        const mask = clipMask(g, box);
        g.target.modify(box, pixels=>paint(pixels, cover, mask, box, shader,
            g.state.compositing === CompositingModeSourceCopy, g.target.opaque, offset));
        return Ok;
    };

    /**
     * A path in world space taken to device polygons, flattened there.
     *
     * @param {Graphics} g @param {import('./path.js').Path} path
     */
    const devicePath = (g, path)=>{
        const m = deviceOf(g);
        return { ...path, points: path.points.map(p=>/** @type {[number, number]} */ (
            [p[0] * m[0] + p[1] * m[2] + m[4], p[0] * m[1] + p[1] * m[3] + m[5]])) };
    };

    /** @param {import('./path.js').Path} path */
    const polygonsOf = path=>{
        const flat = flatten(path, FLATNESS);
        /** @type {{ line: [number, number][], closed: boolean }[]} */
        const lines = [];
        flat.types.forEach((type, at)=>{
            if ((type & PathPointTypePathTypeMask) === PathPointTypeStart || lines.length === 0)
            {
                lines.push({ line: [], closed: false });
            }
            const figure = lines[lines.length - 1];
            figure.line.push(flat.points[at]);
            figure.closed = (type & PathPointTypeCloseSubpath) !== 0;
        });
        return lines;
    };

    /**
     * Fills a world-space path with a brush.
     *
     * @param {Graphics} g @param {import('./brush.js').Brush} brush
     * @param {import('./path.js').Path} path @param {string} api
     */
    const fillPath = (g, brush, path, api)=>{
        const shader = shaderOf(brush, deviceOf(g), sources(g));
        if (!shader)
        {
            diverge(api, `a brush of type ${brush.type} that could not be laid`, 'loss');
            return Ok;
        }
        return lay(g, polygonsOf(devicePath(g, path)).map(l=>l.line), path.fill, shader);
    };

    /**
     * Strokes a world-space path with a pen: the pen's width in device
     * pixels (a world width through the transform's scale, at least one
     * pixel), its dashes, joins and caps.
     *
     * @param {Graphics} g @param {import('./pen.js').Pen} pen
     * @param {import('./path.js').Path} path @param {string} api
     */
    const strokePath = (g, pen, path, api)=>{
        const m = deviceOf(g);
        const scale = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
        const width = Math.max(1, pen.unit === Unit.World ? pen.width * scale
            : pen.width * pixelsPer(pen.unit, g.dpiX));
        if (pen.compound.length > 0 || pen.alignment !== 0 || pen.customStart || pen.customEnd)
        {
            diverge(api, 'a pen\'s compound lines, inset alignment and custom caps are drawn '
                + 'as a plain pen');
        }
        const pattern = pen.dashStyle === 5 ? pen.dashes : DASHES[pen.dashStyle] ?? [];
        /** @type {{ line: [number, number][], closed: boolean }[]} */
        const lines = [];
        for (const { line, closed } of polygonsOf(devicePath(g, path)))
        {
            if (pattern.length === 0)
            {
                lines.push({ line, closed });
                continue;
            }
            for (const piece of dashed(closed ? [...line, line[0]] : line, pattern, width))
            {
                lines.push({ line: piece, closed: false });
            }
        }
        const polygons = strokePolygons(lines, { width, startCap: pen.startCap & 0xff,
            endCap: pen.endCap & 0xff, join: pen.join, miterLimit: pen.miterLimit });
        if (pen.startCap === LineCap.Custom || pen.endCap === LineCap.Custom)
        {
            diverge(api, 'a custom line cap is drawn flat');
        }
        const shader = shaderOf(pen.brush, m, sources(g));
        if (!shader)
        {
            diverge(api, `a pen's brush of type ${pen.brush.type} that could not be laid`, 'loss');
            return Ok;
        }
        return lay(g, polygons, FillModeWinding, shader);
    };

    /**
     * A temporary path built by the path family's own export, handed to `use`.
     *
     * @param {string} adder  the GdipAddPath* export
     * @param {number[]} args  its arguments after the path
     * @param {(path: import('./path.js').Path) => number} use
     * @param {number} [fill]
     */
    const withShape = (adder, args, use, fill = FillModeAlternate)=>{
        const at = kit.add('path', emptyPath(fill));
        try
        {
            const status = paths.functions[adder].handler([at, ...args]);
            if (status !== Ok)
            {
                return status;
            }
            return use(/** @type {import('./path.js').Path} */ (paths.get(at)));
        }
        finally
        {
            kit.remove(at, 'path');
        }
    };

    /**
     * @param {(g: Graphics, args: number[]) => number | Promise<number>} body
     * @returns {(args: number[]) => number | Promise<number>}
     */
    const onGraphics = body=>([at, ...rest])=>{
        const g = get(at);
        if (!g)
        {
            return InvalidParameter;
        }
        return g.heldDc !== 0 ? ObjectBusy : body(g, rest);
    };

    /**
     * A Draw* export: a pen along the shape a path adder makes.
     *
     * @param {number} argBytes @param {string} adder @param {string} api
     */
    const draw = (argBytes, adder, api)=>fn(argBytes, onGraphics((g, [penAt, ...args])=>{
        const pen = pens.get(penAt);
        if (!pen)
        {
            return InvalidParameter;
        }
        return withShape(adder, args, path=>strokePath(g, pen, path, api));
    }));

    /**
     * A Fill* export: a brush inside the shape a path adder makes.
     *
     * @param {number} argBytes @param {string} adder @param {string} api
     * @param {(args: number[]) => number} [fillOf]  where the fill mode is among the arguments
     */
    const fillShape = (argBytes, adder, api, fillOf)=>fn(argBytes,
        onGraphics((g, [brushAt, ...args])=>{
            const brush = brushes.get(brushAt);
            if (!brush)
            {
                return InvalidParameter;
            }
            const fill = fillOf ? fillOf(args) : FillModeAlternate;
            if (fill !== FillModeAlternate && fill !== FillModeWinding)
            {
                return InvalidParameter;
            }
            return withShape(adder, fillOf ? args.slice(0, -1) : args,
                path=>fillPath(g, brush, path, api), fill);
        }));

    /**
     * The polygons of a region in world space, in device pixels.
     *
     * @param {Graphics} g @param {import('./region.js').Node} node
     */
    const regionPolygons = (g, node)=>areaOf(transformNode(node, deviceOf(g))).map(r=>
        /** @type {[number, number][]} */ ([[r.left, r.top], [r.right, r.top], [r.right, r.bottom],
            [r.left, r.bottom]]));

    /**
     * Combines a world-space shape into the clip.
     *
     * @param {Graphics} g @param {import('./region.js').Node} node @param {number} mode
     * @param {boolean} [device]  whether the shape is in device pixels already
     */
    const clipWith = (g, node, mode, device = false)=>{
        if ((mode | 0) < 0 || (mode | 0) > CombineMode.Complement)
        {
            return InvalidParameter;
        }
        const shape = device ? node : transformNode(node, deviceOf(g));
        g.state.clip = combineRegion(g.state.clip, shape, mode | 0);
        return Ok;
    };

    /** The clip in world space. @param {Graphics} g */
    const worldClip = g=>{
        const inverse = invert(deviceOf(g));
        return inverse ? transformNode(g.state.clip, inverse) : g.state.clip;
    };

    /** What of the surface the clip lets through, in device pixels. @param {Graphics} g */
    const visibleArea = g=>{
        const b = g.target.bounds();
        return combineAreas(areaOf(effectiveClip(g)), b.right > b.left && b.bottom > b.top
            ? [b] : [], 1) ?? [];
    };

    /**
     * World bounds of device pixels.
     *
     * @param {Graphics} g @param {import('../gdi32/regions.js').Rect[]} area
     */
    const worldBounds = (g, area)=>{
        if (area.length === 0)
        {
            return [0, 0, 0, 0];
        }
        const left = Math.min(...area.map(r=>r.left));
        const top = Math.min(...area.map(r=>r.top));
        const right = Math.max(...area.map(r=>r.right));
        const bottom = Math.max(...area.map(r=>r.bottom));
        const inverse = invert(deviceOf(g)) ?? [...IDENTITY];
        return boundsOfNode(transformNode(rectNode([left, top, right - left, bottom - top]),
            inverse)) ?? [0, 0, 0, 0];
    };

    /**
     * The matrix from one coordinate space to another.
     *
     * @param {Graphics} g @param {number} space
     * @returns {import('./matrix.js').Elements}
     */
    const toDevice = (g, space)=>{
        if (space === CoordinateSpaceWorld)
        {
            return deviceOf(g);
        }
        if (space === CoordinateSpaceDevice)
        {
            return [...IDENTITY];
        }
        const s = pageFactor(g);
        return multiply([s, 0, 0, s, 0, 0], g.state.base);
    };

    /**
     * Draws an image: its source rectangle onto the parallelogram whose
     * top-left, top-right and bottom-left corners are `corners` in world
     * space, sampled nearest or bilinear as the interpolation asks, through
     * the image attributes given.
     *
     * @param {Graphics} g @param {number} imageAt @param {[number, number][]} corners
     * @param {number[]} source  x y width height, in `unit`
     * @param {number} unit @param {number} attributesAt
     */
    const drawImage = (g, imageAt, corners, source, unit, attributesAt)=>{
        const image = images.get(imageAt);
        if (!image)
        {
            return InvalidParameter;
        }
        const factor = unit === Unit.Pixel || unit === Unit.World || unit === Unit.Display ? 1
            : pixelsPer(unit, image.dpiX);
        const [sx, sy, sw, sh] = source.map(v=>v * factor);
        if (!(sw !== 0 && sh !== 0))
        {
            return Ok;
        }
        const m = deviceOf(g);
        const [p0, p1, p2] = corners.map(p=>/** @type {[number, number]} */ (
            [p[0] * m[0] + p[1] * m[2] + m[4], p[0] * m[1] + p[1] * m[3] + m[5]]));
        const p3 = /** @type {[number, number]} */ ([p1[0] + p2[0] - p0[0], p1[1] + p2[1] - p0[1]]);
        // Source pixels from device: the inverse of the map taking the source rectangle there.
        const map = invert([(p1[0] - p0[0]) / sw, (p1[1] - p0[1]) / sw, (p2[0] - p0[0]) / sh,
            (p2[1] - p0[1]) / sh, p0[0] - sx * (p1[0] - p0[0]) / sw - sy * (p2[0] - p0[0]) / sh,
            p0[1] - sx * (p1[1] - p0[1]) / sw - sy * (p2[1] - p0[1]) / sh]);
        if (!map)
        {
            return Ok;
        }
        const pixels = images.readBgra(image, 0, 0, image.width, image.height);
        const adjust = (attributesAt >>> 0) === 0 ? null : attributes(attributesAt);
        const nearest = g.state.interpolation === InterpolationModeNearestNeighbor;
        const { width, height } = image;
        const left = Math.min(sx, sx + sw);
        const right = Math.max(sx, sx + sw);
        const top = Math.min(sy, sy + sh);
        const bottom = Math.max(sy, sy + sh);
        /** @param {number} x @param {number} y */
        const texel = (x, y)=>{
            const cx = Math.max(Math.ceil(left), Math.min(Math.ceil(right) - 1, x, width - 1));
            const cy = Math.max(Math.ceil(top), Math.min(Math.ceil(bottom) - 1, y, height - 1));
            const at = (Math.max(0, cy) * width + Math.max(0, cx)) * 4;
            return [pixels[at], pixels[at + 1], pixels[at + 2], pixels[at + 3]];
        };
        /** @type {import('./raster.js').Shader} */
        const shader = (x, y)=>{
            const [u, v] = apply(map, [x, y]);
            let colour;
            if (nearest)
            {
                colour = texel(Math.floor(u), Math.floor(v));
            }
            else
            {
                const fx = u - 0.5;
                const fy = v - 0.5;
                const x0 = Math.floor(fx);
                const y0 = Math.floor(fy);
                const tx = fx - x0;
                const ty = fy - y0;
                const a = texel(x0, y0);
                const b = texel(x0 + 1, y0);
                const c = texel(x0, y0 + 1);
                const d = texel(x0 + 1, y0 + 1);
                // Weighted by alpha, so a transparent neighbour lends no colour.
                const w = [(1 - tx) * (1 - ty) * a[3], tx * (1 - ty) * b[3], (1 - tx) * ty * c[3],
                    tx * ty * d[3]];
                const alpha = w[0] + w[1] + w[2] + w[3];
                colour = alpha === 0 ? [0, 0, 0, 0] : [0, 1, 2].map(k=>Math.round((a[k] * w[0]
                    + b[k] * w[1] + c[k] * w[2] + d[k] * w[3]) / alpha));
                if (alpha !== 0)
                {
                    colour.push(Math.round(alpha));
                }
            }
            return adjust ? adjust(colour) : colour;
        };
        return lay(g, [[p0, p1, p3, p2]], FillModeAlternate, shader, false);
    };

    /**
     * The destination of a DrawImage at a point: the image at its physical
     * size, its resolution against the graphics'.
     *
     * @param {Graphics} g @param {number} imageAt @param {number} x @param {number} y
     * @returns {[number, number][] | null}
     */
    const naturalCorners = (g, imageAt, x, y)=>{
        const image = images.get(imageAt);
        if (!image)
        {
            return null;
        }
        const s = pageFactor(g);
        const w = image.width * g.dpiX / image.dpiX / s;
        const h = image.height * g.dpiY / image.dpiY / s;
        return [[x, y], [x + w, y], [x, y + h]];
    };

    /**
     * Whether the pixel a world point falls in is on the surface and inside the clip.
     *
     * @param {Graphics} g @param {number} x @param {number} y @param {number} out
     */
    const isVisiblePoint = (g, x, y, out)=>{
        if ((out >>> 0) === 0)
        {
            return InvalidParameter;
        }
        const [dx, dy] = apply(deviceOf(g), [x, y]);
        const b = g.target.bounds();
        const px = Math.floor(dx);
        const py = Math.floor(dy);
        kit.putBool(out, px >= b.left && px < b.right && py >= b.top && py < b.bottom
            && contains(effectiveClip(g), px + 0.5, py + 0.5));
        return Ok;
    };

    /** @param {number} at @param {number} count @param {boolean} integers */
    const cornersAt = (at, count, integers)=>kit.points(at, count, integers);

    /**
     * Saves the state on the stack, its token to `out`.
     *
     * @param {Graphics} g @param {number} out @param {boolean} container
     */
    const push = (g, out, container)=>{
        const token = nextToken++;
        g.stack.push({ token, container, state: copyState(g.state) });
        kit.putU32(out, token);
        return token;
    };
    /**
     * Restores a state of the kind given: that one and every one above it
     * are gone. A token of the other kind, or of none, changes nothing.
     *
     * @param {Graphics} g @param {number} token @param {boolean} container
     */
    const pop = (g, token, container)=>{
        const at = g.stack.findIndex(entry=>entry.token === (token >>> 0));
        if (at < 0 || g.stack[at].container !== container)
        {
            return Ok;
        }
        g.state = g.stack[at].state;
        g.stack.length = at;
        return Ok;
    };

    /**
     * Begins a container: the state saved, the transform so far its base,
     * the clip so far its own, and the world, page and clip begun anew.
     *
     * @param {Graphics} g @param {number} out @param {import('./matrix.js').Elements} inner
     */
    const beginContainer = (g, out, inner)=>{
        if ((out >>> 0) === 0)
        {
            return InvalidParameter;
        }
        push(g, out, true);
        const outer = deviceOf(g);
        g.state.baseClip = effectiveClip(g);
        g.state.base = multiply(inner, outer);
        g.state.world = [...IDENTITY];
        g.state.pageUnit = Unit.Display;
        g.state.pageScale = 1;
        g.state.clip = infinite();
        return Ok;
    };

    /**
     * A container's map of a source rectangle in `unit` onto a destination
     * rectangle in the world outside.
     *
     * @param {Graphics} g @param {number[]} dest @param {number[]} source @param {number} unit
     * @returns {import('./matrix.js').Elements | null}
     */
    const containerMap = (g, dest, source, unit)=>{
        const s = unit === Unit.World || unit === Unit.Display ? 1
            : pixelsPer(unit, g.dpiX) / pageFactor(g);
        const [sx, sy, sw, sh] = source.map(v=>v * s);
        const [dx, dy, dw, dh] = dest;
        if (sw === 0 || sh === 0)
        {
            return null;
        }
        return [dw / sw, 0, 0, dh / sh, dx - sx * dw / sw, dy - sy * dh / sh];
    };

    /** A setter of a hint in [low, high]. @param {keyof State} key @param {number} low @param {number} high @param {(v: number) => number} [map] */
    const setter = (key, low, high, map = v=>v)=>fn(8, onGraphics((g, [value])=>{
        if ((value | 0) < low || (value | 0) > high)
        {
            return InvalidParameter;
        }
        /** @type {any} */ (g.state)[key] = map(value | 0);
        return Ok;
    }));
    /** @param {keyof State} key */
    const getter = key=>fn(8, onGraphics((g, [out])=>{
        if ((out >>> 0) === 0)
        {
            return InvalidParameter;
        }
        kit.putU32(out, /** @type {number} */ (g.state[key]));
        return Ok;
    }));

    /**
     * Fills rectangles, REALs or INTs, each a shape of its own.
     *
     * @param {boolean} integers
     */
    const fillRects = integers=>fn(16, onGraphics((g, [brushAt, rects, count])=>{
        const brush = brushes.get(brushAt);
        if (!brush || (rects >>> 0) === 0 || (count | 0) <= 0)
        {
            return InvalidParameter;
        }
        const values = integers ? kit.i32s(rects, (count | 0) * 4) : kit.f32s(rects,
            (count | 0) * 4);
        const path = emptyPath();
        for (let i = 0; i < (count | 0); i++)
        {
            const [x, y, w, h] = values.slice(i * 4, i * 4 + 4);
            path.points.push([x, y], [x + w, y], [x + w, y + h], [x, y + h]);
            path.types.push(0, 1, 1, 1 | PathPointTypeCloseSubpath);
        }
        return fillPath(g, brush, path, integers ? 'GdipFillRectanglesI' : 'GdipFillRectangles');
    }));

    /**
     * Transforms points between coordinate spaces, REALs or INTs (rounded).
     *
     * @param {boolean} integers
     */
    const transformPoints = integers=>fn(20, onGraphics((g, [destSpace, sourceSpace, at, count])=>{
        if ((at >>> 0) === 0 || (count | 0) <= 0 || (destSpace >>> 0) > 2
            || (sourceSpace >>> 0) > 2)
        {
            return InvalidParameter;
        }
        const inverse = invert(toDevice(g, destSpace >>> 0));
        if (!inverse)
        {
            return InvalidParameter;
        }
        const m = multiply(toDevice(g, sourceSpace >>> 0), inverse);
        const moved = kit.points(at, count | 0, integers).map(p=>{
            const [x, y] = [p[0] * m[0] + p[1] * m[2] + m[4], p[0] * m[1] + p[1] * m[3] + m[5]];
            return /** @type {[number, number]} */ (integers ? [Math.floor(x + 0.5),
                Math.floor(y + 0.5)] : [x, y]);
        });
        kit.putPoints(at, moved, integers);
        return Ok;
    }));

    /**
     * A world transform operation, the matrix it multiplies by in order.
     *
     * @param {(args: number[]) => import('./matrix.js').Elements | null} matrixOf
     * @param {number} argBytes
     */
    const worldOp = (argBytes, matrixOf)=>fn(argBytes, onGraphics((g, args)=>{
        const order = args[args.length - 1] >>> 0;
        const m = matrixOf(args);
        if (!m || order > MatrixOrderAppend)
        {
            return InvalidParameter;
        }
        g.state.world = combine(g.state.world, m, order);
        return Ok;
    }));

    const functions = {
        /** Status GdipCreateFromHDC(HDC hdc, GpGraphics **graphics) */
        GdipCreateFromHDC: fn(8, ([hdc, out])=>{
            if ((hdc >>> 0) === 0)
            {
                return OutOfMemory;
            }
            if ((out >>> 0) === 0)
            {
                return InvalidParameter;
            }
            return create(dcTarget(hdc >>> 0), out);
        }),
        /** Status GdipCreateFromHDC2(HDC hdc, HANDLE device, GpGraphics **graphics) */
        GdipCreateFromHDC2: fn(12, ([hdc, , out])=>functions.GdipCreateFromHDC.handler([hdc,
            out])),
        /**
         * Status GdipCreateFromHWND(HWND hwnd, GpGraphics **graphics)
         *
         * A window's graphics draws on its DC, taken now and given back when
         * the graphics goes: what WinForms makes for a control
         * (Control.CreateGraphics), NULL being the screen's.
         */
        GdipCreateFromHWND: fn(8, ([hwnd, out])=>{
            if ((out >>> 0) === 0)
            {
                return InvalidParameter;
            }
            const hdc = host.user32 ? host.user32('GetDC', [hwnd]) >>> 0 : 0;
            if (hdc === 0)
            {
                return OutOfMemory;
            }
            return create(dcTarget(hdc), out, 96, 96, hwnd >>> 0 || -1);
        }),
        /** Status GdipCreateFromHWNDICM(HWND hwnd, GpGraphics **graphics) */
        GdipCreateFromHWNDICM: fn(8, ([hwnd, out])=>functions.GdipCreateFromHWND.handler([hwnd,
            out])),
        /**
         * Status GdipGetImageGraphicsContext(GpImage *image, GpGraphics **graphics)
         *
         * A bitmap's graphics at its resolution; an indexed bitmap has none.
         */
        GdipGetImageGraphicsContext: fn(8, ([at, out])=>{
            const image = images.get(at);
            if (!image || (out >>> 0) === 0)
            {
                return InvalidParameter;
            }
            if ((image.format & 0x10000) !== 0)
            {
                return OutOfMemory;
            }
            return create(imageTarget(at >>> 0), out, image.dpiX, image.dpiY);
        }),
        /**
         * Status GdipCreateBitmapFromGraphics(INT width, INT height, GpGraphics *graphics,
         *   GpBitmap **bitmap): 32bpp PARGB at the graphics' resolution.
         */
        GdipCreateBitmapFromGraphics: fn(16, ([width, height, at, out])=>{
            const g = get(at);
            if (!g || (out >>> 0) === 0 || (width | 0) <= 0 || (height | 0) <= 0)
            {
                return InvalidParameter;
            }
            const made = images.create(width | 0, height | 0, 0xe200b, g.dpiX, g.dpiY);
            if (made === 0)
            {
                return OutOfMemory;
            }
            kit.putPointer(out, made);
            return Ok;
        }),
        /** Status GdipDeleteGraphics(GpGraphics *graphics) */
        GdipDeleteGraphics: fn(4, ([at])=>{
            const g = get(at);
            if (!g)
            {
                return InvalidParameter;
            }
            if (g.heldDc !== 0)
            {
                return ObjectBusy;
            }
            if (g.window !== 0 && host.user32)
            {
                host.user32('ReleaseDC', [g.window === -1 ? 0 : g.window, g.target.hdc]);
            }
            kit.remove(at, 'graphics');
            return Ok;
        }),
        /**
         * Status GdipGetDC(GpGraphics *graphics, HDC *hdc)
         *
         * A DC's graphics hands its DC; a bitmap's, a memory DC filled with a
         * key colour, as GDI+'s is - the bitmap's pixels are not read - and
         * on ReleaseDC every pixel GDI drew, the key's aside, goes into it.
         */
        GdipGetDC: fn(8, onGraphics((g, [out])=>{
            if ((out >>> 0) === 0)
            {
                return InvalidParameter;
            }
            if (g.target.hdc !== 0)
            {
                g.heldDc = g.target.hdc;
                g.release = null;
                kit.putU32(out, g.heldDc);
                return Ok;
            }
            const image = images.get(g.target.image);
            if (!image || !gdi32)
            {
                return GenericError;
            }
            const info = host.allocate(48);
            if (info === 0)
            {
                return OutOfMemory;
            }
            const header = new DataView(new ArrayBuffer(40));
            header.setUint32(0, 40, true);
            header.setInt32(4, image.width, true);
            header.setInt32(8, -image.height, true);
            header.setUint16(12, 1, true);
            header.setUint16(14, 32, true);
            kit.write(info, new Uint8Array(header.buffer));
            const memory = gdi32('CreateCompatibleDC', [0]);
            const section = gdi32('CreateDIBSection', [memory, info, 0, info + 40, 0, 0]);
            const bits = kit.u32(info + 40);
            host.free(info);
            if (memory === 0 || section === 0)
            {
                return GenericError;
            }
            const old = gdi32('SelectObject', [memory, section]);
            const count = image.width * image.height;
            kit.write(bits, new Uint8Array(new Uint32Array(count).fill(DC_KEY).buffer));
            g.heldDc = memory;
            g.release = ()=>{
                const drawn = new Uint32Array(kit.read(bits, count * 4).buffer);
                // Only what GDI drew goes back, opaque: the key marks the rest.
                for (let i = 0; i < count; i++)
                {
                    if ((drawn[i] & 0xffffff) !== DC_KEY)
                    {
                        const v = drawn[i];
                        images.writeBgra(image, i % image.width, Math.floor(i / image.width), 1, 1,
                            Uint8Array.of(v & 0xff, v >>> 8 & 0xff, v >>> 16 & 0xff, 255));
                    }
                }
                gdi32('SelectObject', [memory, old]);
                gdi32('DeleteObject', [section]);
                gdi32('DeleteDC', [memory]);
            };
            kit.putU32(out, memory);
            return Ok;
        })),
        /** Status GdipReleaseDC(GpGraphics *graphics, HDC hdc) */
        GdipReleaseDC: fn(8, ([at, hdc])=>{
            const g = get(at);
            if (!g || g.heldDc === 0 || (hdc >>> 0) !== g.heldDc)
            {
                return InvalidParameter;
            }
            g.release?.();
            g.release = null;
            g.heldDc = 0;
            return Ok;
        }),
        /**
         * Status GdipComment(GpGraphics *graphics, UINT size, const BYTE *data): a
         * comment is a metafile's, and nothing here records one.
         */
        GdipComment: fn(12, onGraphics((_g, [, data])=>((data >>> 0) === 0 ? InvalidParameter
            : Ok))),
        /**
         * Status GdipCreateCachedBitmap(GpBitmap *bitmap, GpGraphics *graphics,
         *   GpCachedBitmap **cached): a copy of the bitmap, drawn as it is.
         */
        GdipCreateCachedBitmap: fn(12, ([at, graphicsAt, out])=>{
            if (!images.get(at) || !get(graphicsAt) || (out >>> 0) === 0)
            {
                return InvalidParameter;
            }
            const copy = images.clone(at);
            if (copy === 0)
            {
                return OutOfMemory;
            }
            kit.add('cached', { image: copy }, out);
            return Ok;
        }),
        /** Status GdipDeleteCachedBitmap(GpCachedBitmap *cached) */
        GdipDeleteCachedBitmap: fn(4, ([at])=>{
            const cached = kit.get(at, 'cached');
            if (!cached)
            {
                return InvalidParameter;
            }
            images.functions.GdipDisposeImage.handler([cached.image]);
            kit.remove(at, 'cached');
            return Ok;
        }),
        /**
         * Status GdipDrawCachedBitmap(GpGraphics *graphics, GpCachedBitmap *cached, INT x,
         *   INT y): its pixels one to one at the device point the world point lands on.
         */
        GdipDrawCachedBitmap: fn(16, onGraphics((g, [at, x, y])=>{
            const cached = kit.get(at, 'cached');
            const image = cached && images.get(cached.image);
            if (!image)
            {
                return InvalidParameter;
            }
            const inverse = invert(deviceOf(g)) ?? [...IDENTITY];
            const [dx, dy] = apply(deviceOf(g), [x | 0, y | 0]);
            const corners = /** @type {[number, number][]} */ ([[dx, dy], [dx + image.width, dy],
                [dx, dy + image.height]]).map(p=>apply(inverse, p));
            return drawImage(g, cached.image, corners, [0, 0, image.width, image.height],
                Unit.Pixel, 0);
        })),
        /** Status GdipFlush(GpGraphics *graphics, FlushIntention intention): drawn already. */
        GdipFlush: fn(8, onGraphics(()=>Ok)),
        /** Status GdipGraphicsSetAbort(GpGraphics *graphics, GdiplusAbort *abort) */
        GdipGraphicsSetAbort: fn(8, onGraphics(()=>Ok)),
        /** Status GdipSetPageUnit(GpGraphics *graphics, GpUnit unit): World is not a page unit. */
        GdipSetPageUnit: fn(8, onGraphics((g, [unit])=>{
            if ((unit >>> 0) === Unit.World || (unit >>> 0) > Unit.Millimeter)
            {
                return InvalidParameter;
            }
            g.state.pageUnit = unit >>> 0;
            return Ok;
        })),
        /** Status GdipGetPageUnit(GpGraphics *graphics, GpUnit *unit) */
        GdipGetPageUnit: getter('pageUnit'),
        /** Status GdipSetPageScale(GpGraphics *graphics, REAL scale) */
        GdipSetPageScale: fn(8, onGraphics((g, [scale])=>{
            const value = kit.real(scale);
            if (!(value > 0) || value > 1000000032)
            {
                return InvalidParameter;
            }
            g.state.pageScale = value;
            return Ok;
        })),
        /** Status GdipGetPageScale(GpGraphics *graphics, REAL *scale) */
        GdipGetPageScale: fn(8, onGraphics((g, [out])=>{
            if ((out >>> 0) === 0)
            {
                return InvalidParameter;
            }
            kit.putF32(out, g.state.pageScale);
            return Ok;
        })),
        /** Status GdipResetPageTransform(GpGraphics *graphics) */
        GdipResetPageTransform: fn(4, onGraphics(g=>{
            g.state.pageUnit = Unit.Display;
            g.state.pageScale = 1;
            return Ok;
        })),
        /** Status GdipSetWorldTransform(GpGraphics *graphics, GpMatrix *matrix) */
        GdipSetWorldTransform: fn(8, onGraphics((g, [matrix])=>{
            const m = matrices.elements(matrix);
            if (!m || !invert(m))
            {
                return InvalidParameter;
            }
            g.state.world = [...m];
            return Ok;
        })),
        /** Status GdipGetWorldTransform(GpGraphics *graphics, GpMatrix *matrix) */
        GdipGetWorldTransform: fn(8, onGraphics((g, [matrix])=>(matrices.set(matrix,
            [...g.state.world]) ? Ok : InvalidParameter))),
        /** Status GdipResetWorldTransform(GpGraphics *graphics) */
        GdipResetWorldTransform: fn(4, onGraphics(g=>{
            g.state.world = [...IDENTITY];
            return Ok;
        })),
        /** Status GdipMultiplyWorldTransform(GpGraphics *, const GpMatrix *, MatrixOrder) */
        GdipMultiplyWorldTransform: worldOp(12, ([matrix])=>{
            const m = matrices.elements(matrix);
            return m && invert(m) ? m : null;
        }),
        /** Status GdipTranslateWorldTransform(GpGraphics *, REAL dx, REAL dy, MatrixOrder) */
        GdipTranslateWorldTransform: worldOp(16, ([dx, dy])=>[1, 0, 0, 1, kit.real(dx),
            kit.real(dy)]),
        /** Status GdipScaleWorldTransform(GpGraphics *, REAL sx, REAL sy, MatrixOrder) */
        GdipScaleWorldTransform: worldOp(16, ([sx, sy])=>{
            const [x, y] = [kit.real(sx), kit.real(sy)];
            return x === 0 || y === 0 ? null : [x, 0, 0, y, 0, 0];
        }),
        /** Status GdipRotateWorldTransform(GpGraphics *, REAL angle, MatrixOrder) */
        GdipRotateWorldTransform: worldOp(12, ([angle])=>rotation(kit.real(angle))),
        /**
         * Status GdipTransformPoints(GpGraphics *graphics, GpCoordinateSpace dest,
         *   GpCoordinateSpace source, GpPointF *points, INT count)
         */
        GdipTransformPoints: transformPoints(false),
        /** Status GdipTransformPointsI(GpGraphics *, GpCoordinateSpace, GpCoordinateSpace, GpPoint *, INT) */
        GdipTransformPointsI: transformPoints(true),
        /**
         * Status GdipSetSmoothingMode(GpGraphics *graphics, SmoothingMode mode)
         *
         * Default and HighSpeed are None, HighQuality AntiAlias, as GDI+
         * reports them back.
         */
        GdipSetSmoothingMode: setter('smoothing', 0, SmoothingModeAntiAlias8x8, v=>(v === 0
            || v === 1 ? SmoothingModeNone : v === 2 ? SmoothingModeAntiAlias : v)),
        /** Status GdipGetSmoothingMode(GpGraphics *graphics, SmoothingMode *mode) */
        GdipGetSmoothingMode: getter('smoothing'),
        /** Status GdipSetCompositingMode(GpGraphics *graphics, CompositingMode mode) */
        GdipSetCompositingMode: setter('compositing', 0, 1),
        /** Status GdipGetCompositingMode(GpGraphics *graphics, CompositingMode *mode) */
        GdipGetCompositingMode: getter('compositing'),
        /** Status GdipSetCompositingQuality(GpGraphics *graphics, CompositingQuality quality) */
        GdipSetCompositingQuality: setter('quality', 0, 4),
        /** Status GdipGetCompositingQuality(GpGraphics *graphics, CompositingQuality *quality) */
        GdipGetCompositingQuality: getter('quality'),
        /**
         * Status GdipSetInterpolationMode(GpGraphics *graphics, InterpolationMode mode)
         *
         * Default and LowQuality are Bilinear, HighQuality HighQualityBicubic.
         */
        GdipSetInterpolationMode: setter('interpolation', 0, InterpolationModeHighQualityBicubic,
            v=>(v === 0 || v === 1 ? InterpolationModeBilinear : v === 2
                ? InterpolationModeHighQualityBicubic : v)),
        /** Status GdipGetInterpolationMode(GpGraphics *graphics, InterpolationMode *mode) */
        GdipGetInterpolationMode: getter('interpolation'),
        /** Status GdipSetPixelOffsetMode(GpGraphics *graphics, PixelOffsetMode mode) */
        GdipSetPixelOffsetMode: setter('pixelOffset', 0, 4),
        /** Status GdipGetPixelOffsetMode(GpGraphics *graphics, PixelOffsetMode *mode) */
        GdipGetPixelOffsetMode: getter('pixelOffset'),
        /** Status GdipSetTextRenderingHint(GpGraphics *graphics, TextRenderingHint hint) */
        GdipSetTextRenderingHint: setter('textHint', 0, 5),
        /** Status GdipGetTextRenderingHint(GpGraphics *graphics, TextRenderingHint *hint) */
        GdipGetTextRenderingHint: getter('textHint'),
        /** Status GdipSetTextContrast(GpGraphics *graphics, UINT contrast): 0 to 12. */
        GdipSetTextContrast: setter('textContrast', 0, 12),
        /** Status GdipGetTextContrast(GpGraphics *graphics, UINT *contrast) */
        GdipGetTextContrast: getter('textContrast'),
        /** Status GdipSetRenderingOrigin(GpGraphics *graphics, INT x, INT y) */
        GdipSetRenderingOrigin: fn(12, onGraphics((g, [x, y])=>{
            g.state.origin = [x | 0, y | 0];
            return Ok;
        })),
        /** Status GdipGetRenderingOrigin(GpGraphics *graphics, INT *x, INT *y) */
        GdipGetRenderingOrigin: fn(12, onGraphics((g, [x, y])=>{
            if ((x >>> 0) === 0 || (y >>> 0) === 0)
            {
                return InvalidParameter;
            }
            kit.putI32(x, g.state.origin[0]);
            kit.putI32(y, g.state.origin[1]);
            return Ok;
        })),
        /** Status GdipGetDpiX(GpGraphics *graphics, REAL *dpi) */
        GdipGetDpiX: fn(8, onGraphics((g, [out])=>{
            if ((out >>> 0) === 0)
            {
                return InvalidParameter;
            }
            kit.putF32(out, g.dpiX);
            return Ok;
        })),
        /** Status GdipGetDpiY(GpGraphics *graphics, REAL *dpi) */
        GdipGetDpiY: fn(8, onGraphics((g, [out])=>{
            if ((out >>> 0) === 0)
            {
                return InvalidParameter;
            }
            kit.putF32(out, g.dpiY);
            return Ok;
        })),
        /**
         * Status GdipGetNearestColor(GpGraphics *graphics, ARGB *color): every
         * surface here is 32 bits, so each colour is its own nearest.
         */
        GdipGetNearestColor: fn(8, onGraphics((_g, [colour])=>((colour >>> 0) === 0
            ? InvalidParameter : Ok))),
        /** Status GdipSaveGraphics(GpGraphics *graphics, GraphicsState *state) */
        GdipSaveGraphics: fn(8, onGraphics((g, [out])=>{
            if ((out >>> 0) === 0)
            {
                return InvalidParameter;
            }
            push(g, out, false);
            return Ok;
        })),
        /** Status GdipRestoreGraphics(GpGraphics *graphics, GraphicsState state) */
        GdipRestoreGraphics: fn(8, onGraphics((g, [token])=>pop(g, token, false))),
        /** Status GdipBeginContainer2(GpGraphics *graphics, GraphicsContainer *state) */
        GdipBeginContainer2: fn(8, onGraphics((g, [out])=>beginContainer(g, out,
            [...IDENTITY]))),
        /**
         * Status GdipBeginContainer(GpGraphics *graphics, const GpRectF *dest,
         *   const GpRectF *source, GpUnit unit, GraphicsContainer *state)
         */
        GdipBeginContainer: fn(20, onGraphics((g, [dest, source, unit, out])=>{
            if ((dest >>> 0) === 0 || (source >>> 0) === 0 || (unit >>> 0) > Unit.Millimeter)
            {
                return InvalidParameter;
            }
            const inner = containerMap(g, kit.f32s(dest, 4), kit.f32s(source, 4), unit >>> 0);
            return inner ? beginContainer(g, out, inner) : InvalidParameter;
        })),
        /** Status GdipBeginContainerI(GpGraphics *, const GpRect *, const GpRect *, GpUnit, ...) */
        GdipBeginContainerI: fn(20, onGraphics((g, [dest, source, unit, out])=>{
            if ((dest >>> 0) === 0 || (source >>> 0) === 0 || (unit >>> 0) > Unit.Millimeter)
            {
                return InvalidParameter;
            }
            const inner = containerMap(g, kit.i32s(dest, 4), kit.i32s(source, 4), unit >>> 0);
            return inner ? beginContainer(g, out, inner) : InvalidParameter;
        })),
        /** Status GdipEndContainer(GpGraphics *graphics, GraphicsContainer state) */
        GdipEndContainer: fn(8, onGraphics((g, [token])=>pop(g, token, true))),
        /** Status GdipSetClipRect(GpGraphics *, REAL x, REAL y, REAL w, REAL h, CombineMode) */
        GdipSetClipRect: fn(24, onGraphics((g, [x, y, w, h, mode])=>clipWith(g,
            rectNode([x, y, w, h].map(kit.real)), mode))),
        /** Status GdipSetClipRectI(GpGraphics *, INT x, INT y, INT w, INT h, CombineMode) */
        GdipSetClipRectI: fn(24, onGraphics((g, [x, y, w, h, mode])=>clipWith(g,
            rectNode([x, y, w, h].map(v=>v | 0)), mode))),
        /** Status GdipSetClipPath(GpGraphics *graphics, GpPath *path, CombineMode mode) */
        GdipSetClipPath: fn(12, onGraphics((g, [at, mode])=>{
            const path = paths.get(at);
            return path ? clipWith(g, pathNode(path), mode) : InvalidParameter;
        })),
        /** Status GdipSetClipRegion(GpGraphics *graphics, GpRegion *region, CombineMode mode) */
        GdipSetClipRegion: fn(12, onGraphics((g, [at, mode])=>{
            const node = regions.node(at);
            return node ? clipWith(g, node, mode) : InvalidParameter;
        })),
        /**
         * Status GdipSetClipHrgn(GpGraphics *graphics, HRGN hrgn, CombineMode mode)
         *
         * The HRGN is in device pixels; NULL is infinite.
         */
        GdipSetClipHrgn: fn(12, onGraphics((g, [hrgn, mode])=>{
            if ((hrgn >>> 0) === 0)
            {
                return clipWith(g, infinite(), mode, true);
            }
            const rects = regions.hrgnRects(hrgn);
            if (!rects)
            {
                return InvalidParameter;
            }
            /** @type {import('./region.js').Node} */
            let node = { type: 'empty' };
            for (const [l, t, r, b] of rects)
            {
                node = combineRegion(node, rectNode([l, t, r - l, b - t]), CombineMode.Union);
            }
            return clipWith(g, node, mode, true);
        })),
        /** Status GdipSetClipGraphics(GpGraphics *graphics, GpGraphics *other, CombineMode) */
        GdipSetClipGraphics: fn(12, onGraphics((g, [at, mode])=>{
            const other = get(at);
            return other ? clipWith(g, other.state.clip, mode, true) : InvalidParameter;
        })),
        /** Status GdipResetClip(GpGraphics *graphics) */
        GdipResetClip: fn(4, onGraphics(g=>{
            g.state.clip = infinite();
            return Ok;
        })),
        /** Status GdipTranslateClip(GpGraphics *graphics, REAL dx, REAL dy): in world units. */
        GdipTranslateClip: fn(12, onGraphics((g, [dx, dy])=>{
            const m = deviceOf(g);
            const [x, y] = [kit.real(dx), kit.real(dy)];
            g.state.clip = transformNode(g.state.clip, [1, 0, 0, 1, x * m[0] + y * m[2],
                x * m[1] + y * m[3]]);
            return Ok;
        })),
        /** Status GdipTranslateClipI(GpGraphics *graphics, INT dx, INT dy) */
        GdipTranslateClipI: fn(12, onGraphics((g, [dx, dy])=>{
            const m = deviceOf(g);
            g.state.clip = transformNode(g.state.clip, [1, 0, 0, 1,
                (dx | 0) * m[0] + (dy | 0) * m[2], (dx | 0) * m[1] + (dy | 0) * m[3]]);
            return Ok;
        })),
        /** Status GdipGetClip(GpGraphics *graphics, GpRegion *region): in world space. */
        GdipGetClip: fn(8, onGraphics((g, [at])=>(regions.set(at, worldClip(g)) ? Ok
            : InvalidParameter))),
        /** Status GdipGetClipBounds(GpGraphics *graphics, GpRectF *rect) */
        GdipGetClipBounds: fn(8, onGraphics((g, [out])=>{
            if ((out >>> 0) === 0)
            {
                return InvalidParameter;
            }
            kit.putF32s(out, boundsOfNode(worldClip(g)) ?? [0, 0, 0, 0]);
            return Ok;
        })),
        /** Status GdipGetClipBoundsI(GpGraphics *graphics, GpRect *rect) */
        GdipGetClipBoundsI: fn(8, onGraphics((g, [out])=>{
            if ((out >>> 0) === 0)
            {
                return InvalidParameter;
            }
            kit.putI32s(out, (boundsOfNode(worldClip(g)) ?? [0, 0, 0, 0]).map(v=>Math.round(v)));
            return Ok;
        })),
        /** Status GdipGetVisibleClipBounds(GpGraphics *graphics, GpRectF *rect) */
        GdipGetVisibleClipBounds: fn(8, onGraphics((g, [out])=>{
            if ((out >>> 0) === 0)
            {
                return InvalidParameter;
            }
            kit.putF32s(out, worldBounds(g, visibleArea(g)));
            return Ok;
        })),
        /** Status GdipGetVisibleClipBoundsI(GpGraphics *graphics, GpRect *rect) */
        GdipGetVisibleClipBoundsI: fn(8, onGraphics((g, [out])=>{
            if ((out >>> 0) === 0)
            {
                return InvalidParameter;
            }
            kit.putI32s(out, worldBounds(g, visibleArea(g)).map(v=>Math.round(v)));
            return Ok;
        })),
        /** Status GdipIsClipEmpty(GpGraphics *graphics, BOOL *result) */
        GdipIsClipEmpty: fn(8, onGraphics((g, [out])=>{
            if ((out >>> 0) === 0)
            {
                return InvalidParameter;
            }
            kit.putBool(out, areaOf(g.state.clip).length === 0);
            return Ok;
        })),
        /** Status GdipIsVisibleClipEmpty(GpGraphics *graphics, BOOL *result) */
        GdipIsVisibleClipEmpty: fn(8, onGraphics((g, [out])=>{
            if ((out >>> 0) === 0)
            {
                return InvalidParameter;
            }
            kit.putBool(out, visibleArea(g).length === 0);
            return Ok;
        })),
        /** Status GdipIsVisiblePoint(GpGraphics *graphics, REAL x, REAL y, BOOL *result) */
        GdipIsVisiblePoint: fn(16, onGraphics((g, [x, y, out])=>isVisiblePoint(g, kit.real(x),
            kit.real(y), out))),
        /** Status GdipIsVisiblePointI(GpGraphics *graphics, INT x, INT y, BOOL *result) */
        GdipIsVisiblePointI: fn(16, onGraphics((g, [x, y, out])=>isVisiblePoint(g, x | 0, y | 0,
            out))),
        /** Status GdipIsVisibleRect(GpGraphics *, REAL x, REAL y, REAL w, REAL h, BOOL *) */
        GdipIsVisibleRect: fn(24, onGraphics((g, [x, y, w, h, out])=>{
            if ((out >>> 0) === 0)
            {
                return InvalidParameter;
            }
            const shape = transformNode(rectNode([x, y, w, h].map(kit.real)), deviceOf(g));
            kit.putBool(out, (combineAreas(visibleArea(g), areaOf(shape), 1) ?? []).length > 0);
            return Ok;
        })),
        /** Status GdipIsVisibleRectI(GpGraphics *, INT x, INT y, INT w, INT h, BOOL *) */
        GdipIsVisibleRectI: fn(24, onGraphics((g, [x, y, w, h, out])=>{
            if ((out >>> 0) === 0)
            {
                return InvalidParameter;
            }
            const shape = transformNode(rectNode([x, y, w, h].map(v=>v | 0)), deviceOf(g));
            kit.putBool(out, (combineAreas(visibleArea(g), areaOf(shape), 1) ?? []).length > 0);
            return Ok;
        })),
        /**
         * Status GdipGraphicsClear(GpGraphics *graphics, ARGB color)
         *
         * Every pixel inside the clip becomes the colour, as SourceCopy lays it.
         */
        GdipGraphicsClear: fn(8, onGraphics((g, [colour])=>{
            const b = g.target.bounds();
            if (b.right <= b.left || b.bottom <= b.top)
            {
                return Ok;
            }
            const value = [colour & 0xff, colour >>> 8 & 0xff, colour >>> 16 & 0xff,
                colour >>> 24];
            const mode = g.state.compositing;
            g.state.compositing = CompositingModeSourceCopy;
            lay(g, [[[b.left, b.top], [b.right, b.top], [b.right, b.bottom], [b.left, b.bottom]]],
                FillModeAlternate, ()=>value, false);
            g.state.compositing = mode;
            return Ok;
        })),
        /** Status GdipDrawLine(GpGraphics *, GpPen *, REAL x1, REAL y1, REAL x2, REAL y2) */
        GdipDrawLine: draw(24, 'GdipAddPathLine', 'GdipDrawLine'),
        /** Status GdipDrawLineI(GpGraphics *, GpPen *, INT x1, INT y1, INT x2, INT y2) */
        GdipDrawLineI: draw(24, 'GdipAddPathLineI', 'GdipDrawLineI'),
        /** Status GdipDrawLines(GpGraphics *, GpPen *, const GpPointF *, INT count) */
        GdipDrawLines: draw(16, 'GdipAddPathLine2', 'GdipDrawLines'),
        /** Status GdipDrawLinesI(GpGraphics *, GpPen *, const GpPoint *, INT count) */
        GdipDrawLinesI: draw(16, 'GdipAddPathLine2I', 'GdipDrawLinesI'),
        /** Status GdipDrawArc(GpGraphics *, GpPen *, REAL x, y, w, h, start, sweep) */
        GdipDrawArc: draw(32, 'GdipAddPathArc', 'GdipDrawArc'),
        /** Status GdipDrawArcI(GpGraphics *, GpPen *, INT x, y, w, h, REAL start, sweep) */
        GdipDrawArcI: draw(32, 'GdipAddPathArcI', 'GdipDrawArcI'),
        /** Status GdipDrawBezier(GpGraphics *, GpPen *, REAL x1 .. y4) */
        GdipDrawBezier: draw(40, 'GdipAddPathBezier', 'GdipDrawBezier'),
        /** Status GdipDrawBezierI(GpGraphics *, GpPen *, INT x1 .. y4) */
        GdipDrawBezierI: draw(40, 'GdipAddPathBezierI', 'GdipDrawBezierI'),
        /** Status GdipDrawBeziers(GpGraphics *, GpPen *, const GpPointF *, INT count) */
        GdipDrawBeziers: draw(16, 'GdipAddPathBeziers', 'GdipDrawBeziers'),
        /** Status GdipDrawBeziersI(GpGraphics *, GpPen *, const GpPoint *, INT count) */
        GdipDrawBeziersI: draw(16, 'GdipAddPathBeziersI', 'GdipDrawBeziersI'),
        /** Status GdipDrawCurve(GpGraphics *, GpPen *, const GpPointF *, INT count) */
        GdipDrawCurve: draw(16, 'GdipAddPathCurve', 'GdipDrawCurve'),
        /** Status GdipDrawCurveI(GpGraphics *, GpPen *, const GpPoint *, INT count) */
        GdipDrawCurveI: draw(16, 'GdipAddPathCurveI', 'GdipDrawCurveI'),
        /** Status GdipDrawCurve2(GpGraphics *, GpPen *, const GpPointF *, INT, REAL tension) */
        GdipDrawCurve2: draw(20, 'GdipAddPathCurve2', 'GdipDrawCurve2'),
        /** Status GdipDrawCurve2I(GpGraphics *, GpPen *, const GpPoint *, INT, REAL tension) */
        GdipDrawCurve2I: draw(20, 'GdipAddPathCurve2I', 'GdipDrawCurve2I'),
        /** Status GdipDrawCurve3(GpGraphics *, GpPen *, points, count, offset, segments, tension) */
        GdipDrawCurve3: draw(28, 'GdipAddPathCurve3', 'GdipDrawCurve3'),
        /** Status GdipDrawCurve3I(GpGraphics *, GpPen *, points, count, offset, segments, tension) */
        GdipDrawCurve3I: draw(28, 'GdipAddPathCurve3I', 'GdipDrawCurve3I'),
        /** Status GdipDrawClosedCurve(GpGraphics *, GpPen *, const GpPointF *, INT count) */
        GdipDrawClosedCurve: draw(16, 'GdipAddPathClosedCurve', 'GdipDrawClosedCurve'),
        /** Status GdipDrawClosedCurveI(GpGraphics *, GpPen *, const GpPoint *, INT count) */
        GdipDrawClosedCurveI: draw(16, 'GdipAddPathClosedCurveI', 'GdipDrawClosedCurveI'),
        /** Status GdipDrawClosedCurve2(GpGraphics *, GpPen *, points, count, REAL tension) */
        GdipDrawClosedCurve2: draw(20, 'GdipAddPathClosedCurve2', 'GdipDrawClosedCurve2'),
        /** Status GdipDrawClosedCurve2I(GpGraphics *, GpPen *, points, count, REAL tension) */
        GdipDrawClosedCurve2I: draw(20, 'GdipAddPathClosedCurve2I', 'GdipDrawClosedCurve2I'),
        /** Status GdipDrawEllipse(GpGraphics *, GpPen *, REAL x, y, w, h) */
        GdipDrawEllipse: draw(24, 'GdipAddPathEllipse', 'GdipDrawEllipse'),
        /** Status GdipDrawEllipseI(GpGraphics *, GpPen *, INT x, y, w, h) */
        GdipDrawEllipseI: draw(24, 'GdipAddPathEllipseI', 'GdipDrawEllipseI'),
        /** Status GdipDrawPie(GpGraphics *, GpPen *, REAL x, y, w, h, start, sweep) */
        GdipDrawPie: draw(32, 'GdipAddPathPie', 'GdipDrawPie'),
        /** Status GdipDrawPieI(GpGraphics *, GpPen *, INT x, y, w, h, REAL start, sweep) */
        GdipDrawPieI: draw(32, 'GdipAddPathPieI', 'GdipDrawPieI'),
        /** Status GdipDrawPolygon(GpGraphics *, GpPen *, const GpPointF *, INT count) */
        GdipDrawPolygon: draw(16, 'GdipAddPathPolygon', 'GdipDrawPolygon'),
        /** Status GdipDrawPolygonI(GpGraphics *, GpPen *, const GpPoint *, INT count) */
        GdipDrawPolygonI: draw(16, 'GdipAddPathPolygonI', 'GdipDrawPolygonI'),
        /** Status GdipDrawRectangle(GpGraphics *, GpPen *, REAL x, y, w, h) */
        GdipDrawRectangle: draw(24, 'GdipAddPathRectangle', 'GdipDrawRectangle'),
        /** Status GdipDrawRectangleI(GpGraphics *, GpPen *, INT x, y, w, h) */
        GdipDrawRectangleI: draw(24, 'GdipAddPathRectangleI', 'GdipDrawRectangleI'),
        /** Status GdipDrawRectangles(GpGraphics *, GpPen *, const GpRectF *, INT count) */
        GdipDrawRectangles: draw(16, 'GdipAddPathRectangles', 'GdipDrawRectangles'),
        /** Status GdipDrawRectanglesI(GpGraphics *, GpPen *, const GpRect *, INT count) */
        GdipDrawRectanglesI: draw(16, 'GdipAddPathRectanglesI', 'GdipDrawRectanglesI'),
        /** Status GdipDrawPath(GpGraphics *graphics, GpPen *pen, GpPath *path) */
        GdipDrawPath: fn(12, onGraphics((g, [penAt, at])=>{
            const pen = pens.get(penAt);
            const path = paths.get(at);
            return pen && path ? strokePath(g, pen, path, 'GdipDrawPath') : InvalidParameter;
        })),
        /** Status GdipFillPath(GpGraphics *graphics, GpBrush *brush, GpPath *path) */
        GdipFillPath: fn(12, onGraphics((g, [brushAt, at])=>{
            const brush = brushes.get(brushAt);
            const path = paths.get(at);
            return brush && path ? fillPath(g, brush, path, 'GdipFillPath') : InvalidParameter;
        })),
        /** Status GdipFillRectangle(GpGraphics *, GpBrush *, REAL x, y, w, h) */
        GdipFillRectangle: fillShape(24, 'GdipAddPathRectangle', 'GdipFillRectangle'),
        /** Status GdipFillRectangleI(GpGraphics *, GpBrush *, INT x, y, w, h) */
        GdipFillRectangleI: fillShape(24, 'GdipAddPathRectangleI', 'GdipFillRectangleI'),
        /** Status GdipFillRectangles(GpGraphics *, GpBrush *, const GpRectF *, INT count) */
        GdipFillRectangles: fillRects(false),
        /** Status GdipFillRectanglesI(GpGraphics *, GpBrush *, const GpRect *, INT count) */
        GdipFillRectanglesI: fillRects(true),
        /** Status GdipFillEllipse(GpGraphics *, GpBrush *, REAL x, y, w, h) */
        GdipFillEllipse: fillShape(24, 'GdipAddPathEllipse', 'GdipFillEllipse'),
        /** Status GdipFillEllipseI(GpGraphics *, GpBrush *, INT x, y, w, h) */
        GdipFillEllipseI: fillShape(24, 'GdipAddPathEllipseI', 'GdipFillEllipseI'),
        /** Status GdipFillPie(GpGraphics *, GpBrush *, REAL x, y, w, h, start, sweep) */
        GdipFillPie: fillShape(32, 'GdipAddPathPie', 'GdipFillPie'),
        /** Status GdipFillPieI(GpGraphics *, GpBrush *, INT x, y, w, h, REAL start, sweep) */
        GdipFillPieI: fillShape(32, 'GdipAddPathPieI', 'GdipFillPieI'),
        /** Status GdipFillPolygon(GpGraphics *, GpBrush *, const GpPointF *, INT, GpFillMode) */
        GdipFillPolygon: fillShape(20, 'GdipAddPathPolygon', 'GdipFillPolygon',
            args=>args[args.length - 1] >>> 0),
        /** Status GdipFillPolygonI(GpGraphics *, GpBrush *, const GpPoint *, INT, GpFillMode) */
        GdipFillPolygonI: fillShape(20, 'GdipAddPathPolygonI', 'GdipFillPolygonI',
            args=>args[args.length - 1] >>> 0),
        /** Status GdipFillPolygon2(GpGraphics *, GpBrush *, const GpPointF *, INT count) */
        GdipFillPolygon2: fillShape(16, 'GdipAddPathPolygon', 'GdipFillPolygon2'),
        /** Status GdipFillPolygon2I(GpGraphics *, GpBrush *, const GpPoint *, INT count) */
        GdipFillPolygon2I: fillShape(16, 'GdipAddPathPolygonI', 'GdipFillPolygon2I'),
        /** Status GdipFillClosedCurve(GpGraphics *, GpBrush *, const GpPointF *, INT count) */
        GdipFillClosedCurve: fillShape(16, 'GdipAddPathClosedCurve', 'GdipFillClosedCurve'),
        /** Status GdipFillClosedCurveI(GpGraphics *, GpBrush *, const GpPoint *, INT count) */
        GdipFillClosedCurveI: fillShape(16, 'GdipAddPathClosedCurveI', 'GdipFillClosedCurveI'),
        /**
         * Status GdipFillClosedCurve2(GpGraphics *, GpBrush *, const GpPointF *, INT count,
         *   REAL tension, GpFillMode fill)
         */
        GdipFillClosedCurve2: fillShape(24, 'GdipAddPathClosedCurve2', 'GdipFillClosedCurve2',
            args=>args[args.length - 1] >>> 0),
        /** Status GdipFillClosedCurve2I(GpGraphics *, GpBrush *, const GpPoint *, INT, REAL, GpFillMode) */
        GdipFillClosedCurve2I: fillShape(24, 'GdipAddPathClosedCurve2I', 'GdipFillClosedCurve2I',
            args=>args[args.length - 1] >>> 0),
        /** Status GdipFillRegion(GpGraphics *graphics, GpBrush *brush, GpRegion *region) */
        GdipFillRegion: fn(12, onGraphics((g, [brushAt, at])=>{
            const brush = brushes.get(brushAt);
            const node = regions.node(at);
            if (!brush || !node)
            {
                return InvalidParameter;
            }
            const shader = shaderOf(brush, deviceOf(g), sources(g));
            if (!shader)
            {
                diverge('GdipFillRegion', `a brush of type ${brush.type} that could not be laid`,
                    'loss');
                return Ok;
            }
            const polygons = regionPolygons(g, node);
            return polygons.length === 0 ? Ok : lay(g, polygons, FillModeWinding, shader, false);
        })),
        /** Status GdipDrawImage(GpGraphics *graphics, GpImage *image, REAL x, REAL y) */
        GdipDrawImage: fn(16, onGraphics((g, [at, x, y])=>{
            const corners = naturalCorners(g, at, kit.real(x), kit.real(y));
            const image = images.get(at);
            return corners && image ? drawImage(g, at, corners, [0, 0, image.width, image.height],
                Unit.Pixel, 0) : InvalidParameter;
        })),
        /** Status GdipDrawImageI(GpGraphics *graphics, GpImage *image, INT x, INT y) */
        GdipDrawImageI: fn(16, onGraphics((g, [at, x, y])=>{
            const corners = naturalCorners(g, at, x | 0, y | 0);
            const image = images.get(at);
            return corners && image ? drawImage(g, at, corners, [0, 0, image.width, image.height],
                Unit.Pixel, 0) : InvalidParameter;
        })),
        /** Status GdipDrawImageRect(GpGraphics *, GpImage *, REAL x, y, w, h) */
        GdipDrawImageRect: fn(24, onGraphics((g, [at, ...rect])=>{
            const image = images.get(at);
            const [x, y, w, h] = rect.map(kit.real);
            return image ? drawImage(g, at, [[x, y], [x + w, y], [x, y + h]],
                [0, 0, image.width, image.height], Unit.Pixel, 0)
                : InvalidParameter;
        })),
        /** Status GdipDrawImageRectI(GpGraphics *, GpImage *, INT x, y, w, h) */
        GdipDrawImageRectI: fn(24, onGraphics((g, [at, ...rect])=>{
            const image = images.get(at);
            const [x, y, w, h] = rect.map(v=>v | 0);
            return image ? drawImage(g, at, [[x, y], [x + w, y], [x, y + h]],
                [0, 0, image.width, image.height], Unit.Pixel, 0)
                : InvalidParameter;
        })),
        /** Status GdipDrawImagePoints(GpGraphics *, GpImage *, const GpPointF *, INT count) */
        GdipDrawImagePoints: fn(16, onGraphics((g, [at, points, count])=>{
            const image = images.get(at);
            if (!image || (points >>> 0) === 0 || (count | 0) !== 3)
            {
                return (count | 0) === 4 ? NotImplemented : InvalidParameter;
            }
            return drawImage(g, at, cornersAt(points, 3, false), [0, 0, image.width,
                image.height], Unit.Pixel, 0);
        })),
        /** Status GdipDrawImagePointsI(GpGraphics *, GpImage *, const GpPoint *, INT count) */
        GdipDrawImagePointsI: fn(16, onGraphics((g, [at, points, count])=>{
            const image = images.get(at);
            if (!image || (points >>> 0) === 0 || (count | 0) !== 3)
            {
                return (count | 0) === 4 ? NotImplemented : InvalidParameter;
            }
            return drawImage(g, at, cornersAt(points, 3, true), [0, 0, image.width,
                image.height], Unit.Pixel, 0);
        })),
        /**
         * Status GdipDrawImagePointRect(GpGraphics *, GpImage *, REAL x, REAL y,
         *   REAL srcx, srcy, srcwidth, srcheight, GpUnit unit): the part at its size.
         */
        GdipDrawImagePointRect: fn(36, onGraphics((g, [at, x, y, ...rest])=>{
            const source = rest.slice(0, 4).map(kit.real);
            const [px, py] = [kit.real(x), kit.real(y)];
            return drawImage(g, at, [[px, py], [px + source[2], py], [px, py + source[3]]],
                source, rest[4] >>> 0, 0);
        })),
        /** Status GdipDrawImagePointRectI(GpGraphics *, GpImage *, INT x, INT y, INT src.., GpUnit) */
        GdipDrawImagePointRectI: fn(36, onGraphics((g, [at, x, y, ...rest])=>{
            const source = rest.slice(0, 4).map(v=>v | 0);
            return drawImage(g, at, [[x | 0, y | 0], [(x | 0) + source[2], y | 0],
                [x | 0, (y | 0) + source[3]]], source, rest[4] >>> 0, 0);
        })),
        /**
         * Status GdipDrawImageRectRect(GpGraphics *, GpImage *, REAL dstx, dsty, dstwidth,
         *   dstheight, srcx, srcy, srcwidth, srcheight, GpUnit unit,
         *   const GpImageAttributes *attributes, DrawImageAbort callback, VOID *data)
         */
        GdipDrawImageRectRect: fn(56, onGraphics((g, [at, ...rest])=>{
            const [x, y, w, h, ...source] = rest.slice(0, 8).map(kit.real);
            return drawImage(g, at, [[x, y], [x + w, y], [x, y + h]], source, rest[8] >>> 0,
                rest[9]);
        })),
        /** Status GdipDrawImageRectRectI(GpGraphics *, GpImage *, INT dst.., INT src.., ...) */
        GdipDrawImageRectRectI: fn(56, onGraphics((g, [at, ...rest])=>{
            const [x, y, w, h, ...source] = rest.slice(0, 8).map(v=>v | 0);
            return drawImage(g, at, [[x, y], [x + w, y], [x, y + h]], source, rest[8] >>> 0,
                rest[9]);
        })),
        /**
         * Status GdipDrawImagePointsRect(GpGraphics *, GpImage *, const GpPointF *points,
         *   INT count, REAL srcx, srcy, srcwidth, srcheight, GpUnit unit,
         *   const GpImageAttributes *, DrawImageAbort, VOID *)
         */
        GdipDrawImagePointsRect: fn(48, onGraphics((g, [at, points, count, ...rest])=>{
            if ((points >>> 0) === 0 || (count | 0) !== 3)
            {
                return (count | 0) === 4 ? NotImplemented : InvalidParameter;
            }
            return drawImage(g, at, cornersAt(points, 3, false), rest.slice(0, 4).map(kit.real),
                rest[4] >>> 0, rest[5]);
        })),
        /** Status GdipDrawImagePointsRectI(GpGraphics *, GpImage *, const GpPoint *, INT, INT src.., ...) */
        GdipDrawImagePointsRectI: fn(48, onGraphics((g, [at, points, count, ...rest])=>{
            if ((points >>> 0) === 0 || (count | 0) !== 3)
            {
                return (count | 0) === 4 ? NotImplemented : InvalidParameter;
            }
            return drawImage(g, at, cornersAt(points, 3, true), rest.slice(0, 4).map(v=>v | 0),
                rest[4] >>> 0, rest[5]);
        })),
        /**
         * Status GdipDrawImageFX(GpGraphics *, GpImage *, GpRectF *source, GpMatrix *xform,
         *   CGpEffect *effect, GpImageAttributes *attributes, GpUnit unit)
         *
         * The image's source rectangle (all of it with none) through the
         * matrix; an effect is not applied.
         */
        GdipDrawImageFX: fn(28, onGraphics((g, [at, source, xform, effect, attributesAt, unit])=>{
            const image = images.get(at);
            if (!image)
            {
                return InvalidParameter;
            }
            if ((effect >>> 0) !== 0)
            {
                diverge('GdipDrawImageFX', 'an effect is not applied');
            }
            const rect = (source >>> 0) === 0 ? [0, 0, image.width, image.height]
                : kit.f32s(source, 4);
            const m = (xform >>> 0) === 0 ? [...IDENTITY] : matrices.elements(xform);
            if (!m)
            {
                return InvalidParameter;
            }
            const [x, y, w, h] = rect;
            const corners = /** @type {[number, number][]} */ ([[x, y], [x + w, y], [x, y + h]])
                .map(p=>apply(/** @type {import('./matrix.js').Elements} */ (m), p));
            return drawImage(g, at, corners, rect, unit >>> 0, attributesAt);
        })),
    };

    return {
        functions,
        get,
        isGraphics: (/** @type {number} */ at)=>Boolean(get(at)),
        /** The world to device transform of a graphics. @param {number} at */
        device: at=>{
            const g = get(at);
            return g ? deviceOf(g) : null;
        },
        /**
         * Lays coverage of device pixels with a brush, for text: the box and
         * its coverage, laid as a fill is.
         *
         * @param {number} at @param {import('./brush.js').Brush} brush
         * @param {Box} box @param {Float32Array} cover
         */
        layCoverage: (at, brush, box, cover)=>{
            const g = get(at);
            if (!g)
            {
                return InvalidParameter;
            }
            const shader = shaderOf(brush, deviceOf(g), sources(g));
            if (!shader)
            {
                diverge('GdipDrawString', `a brush of type ${brush.type} that could not be laid`,
                    'loss');
                return Ok;
            }
            const b = g.target.bounds();
            const clipped = { left: Math.max(b.left, box.left), top: Math.max(b.top, box.top),
                right: Math.min(b.right, box.right), bottom: Math.min(b.bottom, box.bottom) };
            if (clipped.right <= clipped.left || clipped.bottom <= clipped.top)
            {
                return Ok;
            }
            const width = clipped.right - clipped.left;
            const sub = new Float32Array(width * (clipped.bottom - clipped.top));
            for (let y = clipped.top; y < clipped.bottom; y++)
            {
                for (let x = clipped.left; x < clipped.right; x++)
                {
                    sub[(y - clipped.top) * width + x - clipped.left] = cover[(y - box.top)
                        * (box.right - box.left) + x - box.left];
                }
            }
            const mask = clipMask(g, clipped);
            const offset = offsetOf(g);
            g.target.modify(clipped, pixels=>paint(pixels, sub, mask, clipped, shader,
                g.state.compositing === CompositingModeSourceCopy, g.target.opaque, offset));
            return Ok;
        },
        dpi: (/** @type {number} */ at)=>get(at)?.dpiY ?? 96,
        /** The DC of a graphics, 0 for a bitmap's. @param {number} at */
        hdcOf: at=>get(at)?.target.hdc ?? 0,
        pageFactor: (/** @type {number} */ at)=>{
            const g = get(at);
            return g ? pageFactor(g) : 1;
        },
        busy: (/** @type {number} */ at)=>(get(at)?.heldDc ?? 0) !== 0,
    };
}
