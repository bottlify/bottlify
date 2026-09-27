/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * GLU32.dll: the OpenGL utility library, as a program on Windows links it.
 *
 * Every export of Windows' GLU32 is here, with the stack each takes -- they
 * are stdcall, and a name bound with the wrong count loses the caller's stack
 * -- and so are the GLU 1.3 additions a program may import beside them
 * (gluCheckExtension, gluUnProject4, gluBuild*MipmapLevels, gluBuild3DMipmaps).
 *
 * Where the work is arithmetic it is the guest's own code (`inguest.js`,
 * compiled, and the routines in `code.js`): the projections and the camera
 * compute their matrix on the x87 and hand it to OPENGL32's glMultMatrixd,
 * glTranslated, glScaled or glOrtho, as GLU does, and gluProject,
 * gluUnProject, gluUnProject4 and gluCheckExtension answer without leaving the
 * guest. The handlers beside them are the same arithmetic in JavaScript, the
 * reference the x86 is tested against, and what a build that cannot place the
 * code (no OPENGL32 to call) answers with.
 *
 * The rest is the host's: the quadrics emit their vertices through the current
 * context (`quadric.js`), the image calls resample on this side (`images.js`),
 * and the tessellator cuts contours into triangles here (`tess.js`) and calls
 * the program's callbacks with them. None of those is a path a frame takes
 * often enough to matter, and each is a loop of many GL calls or a callback
 * per vertex, which the host makes as easily as the guest.
 *
 * NURBS are declared and accepted, and draw nothing: a divergence says so.
 */

import { GL } from '../opengl/constants.js';
import { guestEntry, guestMemory } from '../../win32/msvcrt/guest-code.js';
import * as inGuest from './inguest.js';
import { COMPILED } from './inguest.x86.js';
import {
    lookAtCode, ortho2DCode, perspectiveCode, pickMatrixCode, unProject4Code, unProjectCode,
} from './code.js';
import { GLU, cylinder, newQuadric, partialDisk, sphere } from './quadric.js';
import { TESS, tessellate } from './tess.js';
import { createImages } from './images.js';

/**
 * Every export, by the bytes of stack it takes: a GLdouble is eight.
 *
 * @type {Readonly<Record<string, number>>}
 */
export const GLU_ARGUMENT_BYTES = Object.freeze({
    gluBeginCurve: 4, gluBeginPolygon: 4, gluBeginSurface: 4, gluBeginTrim: 4,
    gluBuild1DMipmaps: 24, gluBuild2DMipmaps: 28, gluBuild3DMipmaps: 32,
    gluBuild1DMipmapLevels: 36, gluBuild2DMipmapLevels: 40, gluBuild3DMipmapLevels: 44,
    gluCheckExtension: 8, gluCylinder: 36, gluDeleteNurbsRenderer: 4, gluDeleteQuadric: 4,
    gluDeleteTess: 4, gluDisk: 28, gluEndCurve: 4, gluEndPolygon: 4, gluEndSurface: 4,
    gluEndTrim: 4, gluErrorString: 4, gluErrorUnicodeStringEXT: 4, gluGetNurbsProperty: 12,
    gluGetString: 4, gluGetTessProperty: 12, gluLoadSamplingMatrices: 16, gluLookAt: 72,
    gluNewNurbsRenderer: 0, gluNewQuadric: 0, gluNewTess: 0, gluNextContour: 8,
    gluNurbsCallback: 12, gluNurbsCallbackData: 8, gluNurbsCallbackDataEXT: 8,
    gluNurbsCurve: 28, gluNurbsProperty: 12, gluNurbsSurface: 44, gluOrtho2D: 32,
    gluPartialDisk: 44, gluPerspective: 32, gluPickMatrix: 36, gluProject: 48,
    gluPwlCurve: 20, gluQuadricCallback: 12, gluQuadricDrawStyle: 8, gluQuadricNormals: 8,
    gluQuadricOrientation: 8, gluQuadricTexture: 8, gluScaleImage: 36, gluSphere: 20,
    gluTessBeginContour: 4, gluTessBeginPolygon: 8, gluTessCallback: 12,
    gluTessEndContour: 4, gluTessEndPolygon: 4, gluTessNormal: 28, gluTessProperty: 16,
    gluTessVertex: 12, gluUnProject: 48, gluUnProject4: 76,
});

/** What gluErrorString answers, by code. */
const ERROR_STRINGS = new Map([
    [GL.NO_ERROR, 'no error'],
    [GL.INVALID_ENUM, 'invalid enumerant'],
    [GL.INVALID_VALUE, 'invalid value'],
    [GL.INVALID_OPERATION, 'invalid operation'],
    [GL.STACK_OVERFLOW, 'stack overflow'],
    [GL.STACK_UNDERFLOW, 'stack underflow'],
    [GL.OUT_OF_MEMORY, 'out of memory'],
    [0x8031, 'table too large'],
    [GLU.INVALID_ENUM, 'invalid enumerant'],
    [GLU.INVALID_VALUE, 'invalid value'],
    [GLU.OUT_OF_MEMORY, 'out of memory'],
    [GLU.INCOMPATIBLE_GL_VERSION, 'incompatible gl version'],
    [GLU.INVALID_OPERATION, 'invalid operation'],
    [TESS.MISSING_BEGIN_POLYGON, 'gluTessBeginPolygon() must precede a gluTessEndPolygon()'],
    [TESS.MISSING_BEGIN_CONTOUR, 'gluTessBeginContour() must precede a gluTessEndContour()'],
    [TESS.MISSING_END_POLYGON, 'gluTessEndPolygon() must follow a gluTessBeginPolygon()'],
    [TESS.MISSING_END_CONTOUR, 'gluTessEndContour() must follow a gluTessBeginContour()'],
    [TESS.COORD_TOO_LARGE, 'a coordinate is too large'],
    [TESS.NEED_COMBINE_CALLBACK, 'need combine callback'],
    // The NURBS errors, which GLU numbers from 100251: a program prints
    // these, it does not compare them.
    ...Array.from({ length: 37 }, (_, i)=>/** @type {[number, string]} */ (
        [100251 + i, `NURBS error ${i + 1}`])),
]);

/** Where the handlers' own scratch appears to be, to the arithmetic they share with the x86. */
const LOCAL = 0xffff0000;

/**
 * @typedef {Object} GluDeps
 * @property {{ readMemory: (address: number, length: number) => Uint8Array,
 *     writeMemory: (address: number, bytes: Uint8Array) => void }} memory
 * @property {(name: string) => number} [exportAddress]  Where one of OPENGL32's
 *     exports is placed; 0 for one that is not (yet).
 * @property {<T>(body: (context: any) => T) => T | null} withContext  Runs `body`
 *     with the calling thread's current context, or answers null without one.
 * @property {(bytes: number) => number} [allocate]  Guest memory for an object's
 *     handle and for a string handed out.
 * @property {(address: number) => void} [free]
 * @property {(call: { entry: number, args: number[], thread?: any }) => Promise<number>
 *     } [callGuest]  How a program's callback is called.
 * @property {() => any} [currentThread]
 * @property {(api: string, detail: string) => void} [divergence]
 */

/**
 * @param {GluDeps} deps
 * @returns {Record<string, any>}
 */
export function createGlu(deps){
    const { memory, withContext } = deps;
    const local = new Uint8Array(0x400);
    /** The guest's memory, with the handlers' scratch at LOCAL. */
    const routed = guestMemory({
        readMemory: (address, length)=>(address >= LOCAL
            ? local.subarray(address - LOCAL, address - LOCAL + length)
            : memory.readMemory(address, length)),
        writeMemory: (address, bytes)=>{
            if (address >= LOCAL)
            {
                local.set(bytes, address - LOCAL);
            }
            else
            {
                memory.writeMemory(address, bytes);
            }
        },
    });
    const view = new DataView(local.buffer);
    /** @param {number} at @param {number} count */
    const localDoubles = (at, count)=>Float64Array.from({ length: count },
        (_, i)=>view.getFloat64(at - LOCAL + i * 8, true));
    const words = new DataView(new ArrayBuffer(8));
    /** @param {number[]} args @param {number} at  A double from two stack slots. */
    const double = (args, at)=>{
        words.setUint32(0, args[at] >>> 0, true);
        words.setUint32(4, args[at + 1] >>> 0, true);
        return words.getFloat64(0, true);
    };
    const reported = new Set();
    /** @param {string} detail */
    const diverge = detail=>{
        if (!reported.has(detail))
        {
            reported.add(detail);
            deps.divergence?.('GLU32', detail);
        }
    };

    /**
     * An export that is guest code where OPENGL32's entry points it calls
     * are placed, and a jump to its handler's trap where they are not.
     *
     * @param {number} argBytes
     * @param {(args: number[]) => number} handler
     * @param {(gl: import('./code.js').GlEntries) => Uint8Array} make
     */
    const calling = (argBytes, handler, make)=>({
        argBytes,
        lastError: false,
        handler,
        /** @param {import('../../win32/msvcrt/guest-code.js').CodeBuilder} [builder] */
        code: builder=>{
            const at = (/** @type {string} */ name)=>deps.exportAddress?.(name) ?? 0;
            const gl = { glMultMatrixd: at('glMultMatrixd'), glTranslated: at('glTranslated'),
                glScaled: at('glScaled'), glOrtho: at('glOrtho') };
            if (Object.values(gl).every(address=>address !== 0))
            {
                return make(gl);
            }
            if (!builder)
            {
                throw new Error('glu: a routine with no OPENGL32 to call is bound with a builder');
            }
            builder.jump(1, builder.register({ convention: 'stdcall', argBytes, handler }));
            return Uint8Array.of(0xe9, 0, 0, 0, 0);
        },
    });

    // --- objects: a handle is guest memory of its own, so it is a pointer no
    // other object has ---

    let fakeHandle = 0x0f000000;
    /** @param {number} bytes */
    const handle = bytes=>{
        if (deps.allocate)
        {
            return deps.allocate(bytes);
        }
        fakeHandle += 16;
        return fakeHandle;
    };
    /** @param {number} address */
    const release = address=>{
        if (deps.allocate && deps.free && address !== 0)
        {
            deps.free(address);
        }
    };

    /**
     * The program's callbacks, called in order, each once the one before it
     * returned; then the handler's answer. With no way into the guest, none
     * is called.
     *
     * @param {{ entry: number, args: number[] }[]} calls
     * @returns {number | Promise<number>}
     */
    const callBack = calls=>{
        const live = calls.filter(call=>call.entry !== 0);
        if (live.length === 0 || !deps.callGuest)
        {
            return 0;
        }
        const call = deps.callGuest;
        const thread = deps.currentThread?.();
        return (async()=>{
            for (const { entry, args } of live)
            {
                await call({ entry, args: args.map(arg=>arg >>> 0), thread });
            }
            return 0;
        })();
    };

    // --- quadrics ---

    /** @type {Map<number, ReturnType<typeof newQuadric> & { error: number }>} */
    const quadrics = new Map();
    /** @param {number} q @param {number} code */
    const quadricError = (q, code)=>callBack(
        [{ entry: quadrics.get(q)?.error ?? 0, args: [code] }]);
    /**
     * @param {number} q @param {(emit: import('./quadric.js').Emit,
     *     state: ReturnType<typeof newQuadric>) => void} draw
     * @param {boolean} valid
     */
    const drawQuadric = (q, draw, valid)=>{
        const state = quadrics.get(q >>> 0);
        if (!state)
        {
            return 0;
        }
        if (!valid)
        {
            return quadricError(q >>> 0, GLU.INVALID_VALUE);
        }
        withContext(context=>draw({
            begin: mode=>context.glBegin(mode),
            end: ()=>context.glEnd(),
            normal: (x, y, z)=>context.glNormal3f(x, y, z),
            texCoord: (s, t)=>context.glTexCoord2f(s, t),
            vertex: (x, y, z)=>context.glVertex3f(x, y, z),
        }, state));
        return 0;
    };
    /**
     * @param {'drawStyle' | 'normals' | 'orientation'} field
     * @param {number[]} allowed
     */
    const quadricSetting = (field, allowed)=>({
        argBytes: 8,
        lastError: false,
        /** @param {number[]} args */
        handler: ([q, value])=>{
            const state = quadrics.get(q >>> 0);
            if (!state)
            {
                return 0;
            }
            if (!allowed.includes(value >>> 0))
            {
                return quadricError(q >>> 0, GLU.INVALID_ENUM);
            }
            state[field] = value >>> 0;
            return 0;
        },
    });

    // --- the tessellator ---

    /**
     * @typedef {Object} Tess
     * @property {Map<number, number>} callbacks
     * @property {number} rule
     * @property {boolean} boundaryOnly
     * @property {number} tolerance
     * @property {number[]} normal
     * @property {'dormant' | 'polygon' | 'contour'} state
     * @property {import('./tess.js').TessVertex[][]} contours
     * @property {number} data  The polygon's pointer, which the _DATA callbacks take.
     */
    /** @type {Map<number, Tess>} */
    const tessellators = new Map();
    /**
     * A callback's call, the _DATA form preferred and handed the polygon's
     * pointer after the rest.
     *
     * @param {Tess} tess @param {number} plain @param {number} withData @param {number[]} args
     */
    const tessCall = (tess, plain, withData, args)=>{
        const data = tess.callbacks.get(withData);
        if (data)
        {
            return { entry: data, args: [...args, tess.data] };
        }
        return { entry: tess.callbacks.get(plain) ?? 0, args };
    };
    /** @param {Tess} tess @param {number} code */
    const tessError = (tess, code)=>tessCall(tess, TESS.ERROR, TESS.ERROR_DATA, [code]);
    /**
     * The calls that bring the state to `want` from wherever it is, each
     * missing step reported as GLU reports it and then taken.
     *
     * @param {Tess} tess @param {'polygon' | 'contour'} want
     * @param {{ entry: number, args: number[] }[]} calls
     */
    const reach = (tess, want, calls)=>{
        if (tess.state === 'dormant')
        {
            calls.push(tessError(tess, TESS.MISSING_BEGIN_POLYGON));
            tess.state = 'polygon';
            tess.contours = [];
            tess.data = 0;
        }
        if (want === 'contour' && tess.state === 'polygon')
        {
            calls.push(tessError(tess, TESS.MISSING_BEGIN_CONTOUR));
            tess.state = 'contour';
            tess.contours.push([]);
        }
        if (want === 'polygon' && tess.state === 'contour')
        {
            calls.push(tessError(tess, TESS.MISSING_END_CONTOUR));
            tess.state = 'polygon';
        }
    };
    /** @param {number} t @param {(tess: Tess, calls: { entry: number, args: number[] }[]) => void} body */
    const withTess = (t, body)=>{
        const tess = tessellators.get(t >>> 0);
        if (!tess)
        {
            return 0;
        }
        /** @type {{ entry: number, args: number[] }[]} */
        const calls = [];
        body(tess, calls);
        return callBack(calls);
    };
    /** @param {Tess} tess @param {{ entry: number, args: number[] }[]} calls */
    const beginPolygon = (tess, calls, /** @type {number} */ data)=>{
        if (tess.state !== 'dormant')
        {
            calls.push(tessError(tess, TESS.MISSING_END_POLYGON));
        }
        tess.state = 'polygon';
        tess.contours = [];
        tess.data = data >>> 0;
    };
    /** @param {Tess} tess @param {{ entry: number, args: number[] }[]} calls */
    const beginContour = (tess, calls)=>{
        reach(tess, 'polygon', calls);
        tess.state = 'contour';
        tess.contours.push([]);
    };
    /** @param {Tess} tess @param {{ entry: number, args: number[] }[]} calls */
    const endContour = (tess, calls)=>{
        reach(tess, 'contour', calls);
        tess.state = 'polygon';
    };
    /** @param {Tess} tess @param {{ entry: number, args: number[] }[]} calls */
    const endPolygon = (tess, calls)=>{
        reach(tess, 'polygon', calls);
        tess.state = 'dormant';
        const result = tessellate(tess.contours, { normal: tess.normal, rule: tess.rule,
            boundaryOnly: tess.boundaryOnly });
        tess.contours = [];
        const begin = (/** @type {number} */ mode)=>tessCall(tess, TESS.BEGIN, TESS.BEGIN_DATA, [mode]);
        const end = ()=>tessCall(tess, TESS.END, TESS.END_DATA, []);
        const vertex = (/** @type {number} */ data)=>
            tessCall(tess, TESS.VERTEX, TESS.VERTEX_DATA, [data]);
        if (result.kind === 'crossing')
        {
            if (!tess.callbacks.get(TESS.COMBINE) && !tess.callbacks.get(TESS.COMBINE_DATA))
            {
                calls.push(tessError(tess, TESS.NEED_COMBINE_CALLBACK));
                return;
            }
            diverge('gluTessEndPolygon: contours that cross are not split at the crossings;'
                + ' such a polygon is drawn as nothing');
            return;
        }
        if (result.kind === 'boundary')
        {
            for (const loop of result.loops)
            {
                calls.push(begin(GL.LINE_LOOP));
                calls.push(...loop.map(v=>vertex(v.data)));
                calls.push(end());
            }
            return;
        }
        if (result.triangles.length === 0)
        {
            return;
        }
        const flags = tess.callbacks.has(TESS.EDGE_FLAG) || tess.callbacks.has(TESS.EDGE_FLAG_DATA);
        calls.push(begin(GL.TRIANGLES));
        let flag = -1;
        for (const triangle of result.triangles)
        {
            triangle.vertices.forEach((v, i)=>{
                const edge = triangle.edges[i] ? 1 : 0;
                if (flags && edge !== flag)
                {
                    calls.push(tessCall(tess, TESS.EDGE_FLAG, TESS.EDGE_FLAG_DATA, [edge]));
                    flag = edge;
                }
                calls.push(vertex(v.data));
            });
        }
        calls.push(end());
    };

    // --- strings ---

    /** @type {Map<string, number>} */
    const strings = new Map();
    /** @param {string} text @param {boolean} wide */
    const guestString = (text, wide)=>{
        const key = `${wide ? 'W' : 'A'}${text}`;
        const known = strings.get(key);
        if (known !== undefined)
        {
            return known;
        }
        const bytes = wide
            ? new Uint8Array(Uint16Array.from([...text, '\0'].map(c=>c.charCodeAt(0))).buffer)
            : new TextEncoder().encode(`${text}\0`);
        const address = deps.allocate?.(bytes.length) ?? 0;
        if (address === 0)
        {
            return 0;
        }
        memory.writeMemory(address, bytes);
        strings.set(key, address);
        return address;
    };

    const images = createImages(memory);
    const guestHost = { readMemory: memory.readMemory, writeMemory: memory.writeMemory };
    const nurbs = (/** @type {string} */ name)=>({
        argBytes: GLU_ARGUMENT_BYTES[name],
        lastError: false,
        handler: ()=>{
            diverge(`${name}: NURBS are not tessellated; nothing is drawn`);
            return 0;
        },
    });

    /** @type {Record<string, any>} */
    const table = {
        // --- the matrices: guest code that calls OPENGL32 ---

        gluPerspective: calling(32, args=>{
            if (inGuest.gluPerspectiveMatrix(routed, LOCAL, double(args, 0), double(args, 2),
                double(args, 4), double(args, 6)) !== 0)
            {
                const m = localDoubles(LOCAL, 16);
                withContext(context=>context.glMultMatrixf(m));
            }
            return 0;
        }, perspectiveCode),

        gluLookAt: calling(72, args=>{
            const d = Array.from({ length: 9 }, (_, i)=>double(args, i * 2));
            inGuest.gluLookAtMatrix(routed, LOCAL, d[0], d[1], d[2], d[3], d[4], d[5], d[6], d[7],
                d[8]);
            const m = localDoubles(LOCAL, 19);
            withContext(context=>{
                context.glMultMatrixf(m.subarray(0, 16));
                context.glTranslatef(m[16], m[17], m[18]);
            });
            return 0;
        }, lookAtCode),

        gluOrtho2D: calling(32, args=>{
            withContext(context=>context.glOrtho(double(args, 0), double(args, 2),
                double(args, 4), double(args, 6), -1, 1));
            return 0;
        }, ortho2DCode),

        gluPickMatrix: calling(36, args=>{
            if (inGuest.gluPickMatrixArgs(routed, LOCAL, double(args, 0), double(args, 2),
                double(args, 4), double(args, 6), args[8] >>> 0) !== 0)
            {
                const m = localDoubles(LOCAL, 6);
                withContext(context=>{
                    context.glTranslatef(m[0], m[1], m[2]);
                    context.glScalef(m[3], m[4], m[5]);
                });
            }
            return 0;
        }, pickMatrixCode),

        // --- the arithmetic that answers in the guest ---

        gluProject: { ...guestEntry(inGuest.gluProject, COMPILED.gluProject, guestHost),
            lastError: false },
        gluCheckExtension: { ...guestEntry(inGuest.gluCheckExtension, COMPILED.gluCheckExtension,
            guestHost), lastError: false },

        gluUnProject: {
            argBytes: 48,
            lastError: false,
            /** @param {number[]} args */
            handler: args=>(inGuest.gluUnProjectPoint(routed, LOCAL, args[6] >>> 0,
                args[7] >>> 0, args[8] >>> 0, double(args, 0), double(args, 2), double(args, 4),
                1, 0, 1) === 0
                ? 0
                : inGuest.gluUnProjectDivide(routed, LOCAL, args[9] >>> 0, args[10] >>> 0,
                    args[11] >>> 0)),
            code: unProjectCode,
        },

        gluUnProject4: {
            argBytes: 76,
            lastError: false,
            /** @param {number[]} args */
            handler: args=>(inGuest.gluUnProjectPoint(routed, LOCAL, args[8] >>> 0,
                args[9] >>> 0, args[10] >>> 0, double(args, 0), double(args, 2), double(args, 4),
                double(args, 6), double(args, 11), double(args, 13)) === 0
                ? 0
                : inGuest.gluUnProjectStore(routed, LOCAL, args[15] >>> 0, args[16] >>> 0,
                    args[17] >>> 0, args[18] >>> 0)),
            code: unProject4Code,
        },

        // --- strings ---

        gluErrorString: {
            argBytes: 4,
            lastError: false,
            /** @param {number[]} args */
            handler: ([code])=>{
                const text = ERROR_STRINGS.get(code >>> 0);
                return text === undefined ? 0 : guestString(text, false);
            },
        },
        gluErrorUnicodeStringEXT: {
            argBytes: 4,
            lastError: false,
            /** @param {number[]} args */
            handler: ([code])=>{
                const text = ERROR_STRINGS.get(code >>> 0);
                return text === undefined ? 0 : guestString(text, true);
            },
        },
        gluGetString: {
            argBytes: 4,
            lastError: false,
            /** @param {number[]} args */
            handler: ([name])=>((name >>> 0) === GLU.VERSION ? guestString('1.3', false)
                : (name >>> 0) === GLU.EXTENSIONS ? guestString('GL_EXT_bgra', false) : 0),
        },

        // --- quadrics ---

        gluNewQuadric: {
            argBytes: 0,
            lastError: false,
            handler: ()=>{
                const q = handle(16);
                if (q !== 0)
                {
                    quadrics.set(q, { ...newQuadric(), error: 0 });
                }
                return q;
            },
        },
        gluDeleteQuadric: {
            argBytes: 4,
            lastError: false,
            /** @param {number[]} args */
            handler: ([q])=>{
                if (quadrics.delete(q >>> 0))
                {
                    release(q >>> 0);
                }
                return 0;
            },
        },
        gluQuadricDrawStyle: quadricSetting('drawStyle',
            [GLU.POINT, GLU.LINE, GLU.FILL, GLU.SILHOUETTE]),
        gluQuadricNormals: quadricSetting('normals', [GLU.SMOOTH, GLU.FLAT, GLU.NONE]),
        gluQuadricOrientation: quadricSetting('orientation', [GLU.OUTSIDE, GLU.INSIDE]),
        gluQuadricTexture: {
            argBytes: 8,
            lastError: false,
            /** @param {number[]} args */
            handler: ([q, on])=>{
                const state = quadrics.get(q >>> 0);
                if (state)
                {
                    // A GLboolean: the byte, whatever the word above it holds.
                    state.texture = (on & 0xff) !== 0;
                }
                return 0;
            },
        },
        gluQuadricCallback: {
            argBytes: 12,
            lastError: false,
            /** @param {number[]} args */
            handler: ([q, which, fn])=>{
                const state = quadrics.get(q >>> 0);
                if (!state)
                {
                    return 0;
                }
                if ((which >>> 0) !== GLU.ERROR)
                {
                    return quadricError(q >>> 0, GLU.INVALID_ENUM);
                }
                state.error = fn >>> 0;
                return 0;
            },
        },
        gluCylinder: {
            argBytes: 36,
            lastError: false,
            /** @param {number[]} args */
            handler: args=>{
                const [base, top, height] = [double(args, 1), double(args, 3), double(args, 5)];
                const slices = args[7] | 0;
                const stacks = args[8] | 0;
                return drawQuadric(args[0], (emit, q)=>cylinder(emit, q, base, top, height,
                    slices, stacks),
                slices >= 2 && stacks >= 1 && base >= 0 && top >= 0 && height >= 0);
            },
        },
        gluSphere: {
            argBytes: 20,
            lastError: false,
            /** @param {number[]} args */
            handler: args=>{
                const radius = double(args, 1);
                const slices = args[3] | 0;
                const stacks = args[4] | 0;
                return drawQuadric(args[0], (emit, q)=>sphere(emit, q, radius, slices, stacks),
                    slices >= 2 && stacks >= 1 && radius >= 0);
            },
        },
        gluDisk: {
            argBytes: 28,
            lastError: false,
            /** @param {number[]} args */
            handler: args=>{
                const [inner, outer] = [double(args, 1), double(args, 3)];
                const slices = args[5] | 0;
                const loops = args[6] | 0;
                return drawQuadric(args[0], (emit, q)=>partialDisk(emit, q, inner, outer, slices,
                    loops, 0, 360), slices >= 2 && loops >= 1 && outer > 0 && inner >= 0
                    && inner <= outer);
            },
        },
        gluPartialDisk: {
            argBytes: 44,
            lastError: false,
            /** @param {number[]} args */
            handler: args=>{
                const [inner, outer] = [double(args, 1), double(args, 3)];
                const slices = args[5] | 0;
                const loops = args[6] | 0;
                const [start, sweep] = [double(args, 7), double(args, 9)];
                return drawQuadric(args[0], (emit, q)=>partialDisk(emit, q, inner, outer, slices,
                    loops, start, sweep), slices >= 2 && loops >= 1 && outer > 0 && inner >= 0
                    && inner <= outer);
            },
        },

        // --- images ---

        gluScaleImage: {
            argBytes: 36,
            lastError: false,
            /** @param {number[]} args */
            handler: args=>{
                const answer = withContext(context=>images.scale(context, args));
                return answer ?? images.scale(null, args);
            },
        },
        gluBuild1DMipmaps: {
            argBytes: 24,
            lastError: false,
            /** @param {number[]} a */
            handler: a=>withContext(context=>images.build(context, a[0] >>> 0, a[1] | 0,
                a[2] | 0, 1, a[3] >>> 0, a[4] >>> 0, a[5] >>> 0, true)) ?? 0,
        },
        gluBuild2DMipmaps: {
            argBytes: 28,
            lastError: false,
            /** @param {number[]} a */
            handler: a=>withContext(context=>images.build(context, a[0] >>> 0, a[1] | 0,
                a[2] | 0, a[3] | 0, a[4] >>> 0, a[5] >>> 0, a[6] >>> 0, false)) ?? 0,
        },
        gluBuild1DMipmapLevels: {
            argBytes: 36,
            lastError: false,
            /** @param {number[]} a */
            handler: a=>withContext(context=>images.buildLevels(context, a[0] >>> 0, a[1] | 0,
                a[2] | 0, 1, a[3] >>> 0, a[4] >>> 0, a[5] | 0, a[6] | 0, a[7] | 0, a[8] >>> 0,
                true)) ?? 0,
        },
        gluBuild2DMipmapLevels: {
            argBytes: 40,
            lastError: false,
            /** @param {number[]} a */
            handler: a=>withContext(context=>images.buildLevels(context, a[0] >>> 0, a[1] | 0,
                a[2] | 0, a[3] | 0, a[4] >>> 0, a[5] >>> 0, a[6] | 0, a[7] | 0, a[8] | 0,
                a[9] >>> 0, false)) ?? 0,
        },
        // OPENGL32 has no three-dimensional textures to build levels of.
        gluBuild3DMipmaps: { argBytes: 32, lastError: false, handler: ()=>GLU.INVALID_ENUM },
        gluBuild3DMipmapLevels: { argBytes: 44, lastError: false, handler: ()=>GLU.INVALID_ENUM },

        // --- the tessellator ---

        gluNewTess: {
            argBytes: 0,
            lastError: false,
            handler: ()=>{
                const t = handle(16);
                if (t !== 0)
                {
                    tessellators.set(t, {
                        callbacks: new Map(), rule: TESS.WINDING_ODD, boundaryOnly: false,
                        tolerance: 0, normal: [0, 0, 0], state: 'dormant', contours: [], data: 0,
                    });
                }
                return t;
            },
        },
        gluDeleteTess: {
            argBytes: 4,
            lastError: false,
            /** @param {number[]} args */
            handler: ([t])=>{
                if (tessellators.delete(t >>> 0))
                {
                    release(t >>> 0);
                }
                return 0;
            },
        },
        gluTessCallback: {
            argBytes: 12,
            lastError: false,
            /** @param {number[]} args */
            handler: ([t, which, fn])=>withTess(t, (tess, calls)=>{
                if ((which >>> 0) < TESS.BEGIN || (which >>> 0) > TESS.COMBINE_DATA)
                {
                    calls.push(tessError(tess, GLU.INVALID_ENUM));
                    return;
                }
                tess.callbacks.set(which >>> 0, fn >>> 0);
            }),
        },
        gluTessProperty: {
            argBytes: 16,
            lastError: false,
            /** @param {number[]} args */
            handler: args=>withTess(args[0], (tess, calls)=>{
                const value = double(args, 2);
                switch (args[1] >>> 0)
                {
                    case TESS.WINDING_RULE:
                        if (value >= TESS.WINDING_ODD && value <= TESS.WINDING_ABS_GEQ_TWO
                            && Number.isInteger(value))
                        {
                            tess.rule = value;
                            return;
                        }
                        calls.push(tessError(tess, GLU.INVALID_VALUE));
                        return;
                    case TESS.BOUNDARY_ONLY:
                        tess.boundaryOnly = value !== 0;
                        return;
                    case TESS.TOLERANCE:
                        if (value >= 0 && value <= 1)
                        {
                            tess.tolerance = value;
                            return;
                        }
                        calls.push(tessError(tess, GLU.INVALID_VALUE));
                        return;
                    default:
                        calls.push(tessError(tess, GLU.INVALID_ENUM));
                }
            }),
        },
        gluGetTessProperty: {
            argBytes: 12,
            lastError: false,
            /** @param {number[]} args */
            handler: ([t, which, out])=>withTess(t, (tess, calls)=>{
                const value = (which >>> 0) === TESS.WINDING_RULE ? tess.rule
                    : (which >>> 0) === TESS.BOUNDARY_ONLY ? (tess.boundaryOnly ? 1 : 0)
                        : (which >>> 0) === TESS.TOLERANCE ? tess.tolerance : null;
                if (value === null)
                {
                    calls.push(tessError(tess, GLU.INVALID_ENUM));
                }
                if ((out >>> 0) !== 0)
                {
                    routed.setF64(out >>> 0, value ?? 0);
                }
            }),
        },
        gluTessNormal: {
            argBytes: 28,
            lastError: false,
            /** @param {number[]} args */
            handler: args=>withTess(args[0], tess=>{
                tess.normal = [double(args, 1), double(args, 3), double(args, 5)];
            }),
        },
        gluTessBeginPolygon: {
            argBytes: 8,
            lastError: false,
            /** @param {number[]} args */
            handler: ([t, data])=>withTess(t, (tess, calls)=>beginPolygon(tess, calls, data)),
        },
        gluTessBeginContour: {
            argBytes: 4,
            lastError: false,
            /** @param {number[]} args */
            handler: ([t])=>withTess(t, beginContour),
        },
        gluTessVertex: {
            argBytes: 12,
            lastError: false,
            /** @param {number[]} args */
            handler: ([t, location, data])=>withTess(t, (tess, calls)=>{
                reach(tess, 'contour', calls);
                const at = location >>> 0;
                const xyz = [routed.f64(at), routed.f64(at + 8), routed.f64(at + 16)];
                if (xyz.some(c=>Math.abs(c) > TESS.MAX_COORD))
                {
                    calls.push(tessError(tess, TESS.COORD_TOO_LARGE));
                }
                const [x, y, z] = xyz.map(c=>
                    Math.max(-TESS.MAX_COORD, Math.min(TESS.MAX_COORD, c)));
                tess.contours[tess.contours.length - 1].push({ x, y, z, data: data >>> 0 });
            }),
        },
        gluTessEndContour: {
            argBytes: 4,
            lastError: false,
            /** @param {number[]} args */
            handler: ([t])=>withTess(t, endContour),
        },
        gluTessEndPolygon: {
            argBytes: 4,
            lastError: false,
            /** @param {number[]} args */
            handler: ([t])=>withTess(t, endPolygon),
        },
        // The first GLU's spelling of the same calls.
        gluBeginPolygon: {
            argBytes: 4,
            lastError: false,
            /** @param {number[]} args */
            handler: ([t])=>withTess(t, (tess, calls)=>{
                beginPolygon(tess, calls, 0);
                beginContour(tess, calls);
            }),
        },
        gluNextContour: {
            argBytes: 8,
            lastError: false,
            /** @param {number[]} args */
            handler: ([t])=>withTess(t, (tess, calls)=>{
                endContour(tess, calls);
                beginContour(tess, calls);
            }),
        },
        gluEndPolygon: {
            argBytes: 4,
            lastError: false,
            /** @param {number[]} args */
            handler: ([t])=>withTess(t, (tess, calls)=>{
                endContour(tess, calls);
                endPolygon(tess, calls);
            }),
        },

        // --- NURBS ---

        gluNewNurbsRenderer: {
            argBytes: 0,
            lastError: false,
            handler: ()=>handle(16),
        },
        gluDeleteNurbsRenderer: {
            argBytes: 4,
            lastError: false,
            /** @param {number[]} args */
            handler: ([n])=>{
                release(n >>> 0);
                return 0;
            },
        },
        gluGetNurbsProperty: {
            argBytes: 12,
            lastError: false,
            /** @param {number[]} args */
            handler: ([, , out])=>{
                if ((out >>> 0) !== 0)
                {
                    routed.setF32(out >>> 0, 0);
                }
                return 0;
            },
        },
        ...Object.fromEntries(['gluBeginCurve', 'gluBeginSurface', 'gluBeginTrim',
            'gluEndCurve', 'gluEndSurface', 'gluEndTrim', 'gluLoadSamplingMatrices',
            'gluNurbsCallback', 'gluNurbsCallbackData', 'gluNurbsCallbackDataEXT',
            'gluNurbsCurve', 'gluNurbsProperty', 'gluNurbsSurface', 'gluPwlCurve']
            .map(name=>[name, nurbs(name)])),
    };
    for (const [name, bytes] of Object.entries(GLU_ARGUMENT_BYTES))
    {
        if (!table[name] || table[name].argBytes !== bytes)
        {
            throw new Error(`glu: ${name} is not bound with ${bytes} bytes of arguments`);
        }
    }
    return table;
}
