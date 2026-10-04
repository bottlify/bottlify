/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * OPENGL32.dll: the entry points, and how a guest dword becomes an argument.
 *
 * **Every export is declared, whether or not it does anything.** These are
 * stdcall functions and the callee cleans the stack, so a name we do not
 * declare is bound to a stub that pops nothing and returns the caller's stack
 * pointer several words short. The program does not fail there: it fails much
 * later, somewhere with nothing to say about the cause. A stub that pops the
 * right number of bytes is a call that did nothing; a stub that pops the wrong
 * number is a process that is already lost. That is why `ARGUMENT_WORDS` below
 * lists the whole of OpenGL 1.1, all of WGL and every extension function this
 * implementation answers, and why the number beside each group is the
 * specification rather than a guess.
 *
 * Two things about that count are easy to get wrong and are the reason it is
 * written out per function rather than derived from anything:
 *
 * - **A GLdouble is two words.** `glVertex3d` takes six, not three, and
 *   `glOrtho` takes twelve. Deriving the count from a JavaScript function's
 *   parameter list gets every one of these wrong.
 * - **The argument list is the C one, not ours.** `SetPixelFormat` takes a
 *   descriptor pointer it never reads, and `glGenTextures` takes a count and
 *   an out-pointer where the implementation here answers with an array.
 *
 * Arguments arrive as raw dwords. A GLfloat is the bits of one, a GLdouble the
 * bits of two, and a pointer is an address in guest memory -- so the handlers
 * below decode rather than take what they were handed, and a handler that
 * forgets is a call that reads an integer as a colour. The typed variants of
 * one call (`glColor3ub`, `glColor4iv`, ...) all decode into the one form the
 * context implements, with the integer types mapped onto 0..1 where the
 * specification says a colour or a normal is normalised and left alone where
 * it says a coordinate is not.
 *
 * ponytail: what is not implemented is answered with zero and counted, not
 * refused. Zero reads as failure under every convention a GL entry point uses
 * at once, and the count is what says which of them a program actually wanted.
 */

import { GL, WGL } from './constants.js';
import { EXTENSION_WORDS, GL_EXTENSIONS, WGL_EXTENSIONS } from './extensions.js';
import {
    choosePixelFormat, decodePixelFormat, encodePixelFormat, PIXEL_FORMATS,
    PIXELFORMATDESCRIPTOR,
} from './pixelformat.js';
import { createWgl } from './wgl.js';
import { createOpenglRoot } from './root.js';
import { compressedDigest, imageDigests, imageTimes, keptImages } from './context-textures.js';
import { imageBytes, unpackImage } from './texture.js';
import { packImage } from './context-pixels.js';
import { PFD } from './constants.js';
import {
    COMMAND_RING_BYTES, TEB_GL_CONTEXT, createCommandReader, placeCommandRing,
} from '../seam/shadow.js';

/** A page: the block and the ring each take pages of their own. */
const RING_PAGE = 4096;

/**
 * Every core export of OPENGL32.dll, grouped by how many stack words it
 * takes.
 *
 * Grouping rather than listing `name: count` pairs is deliberate: a
 * transcription slip inside a group is a name in the wrong group, which reads
 * as odd, where a slip in a pair reads as an ordinary number.
 *
 * @type {Readonly<Record<number, readonly string[]>>}
 */
const CORE_WORDS = Object.freeze({
    0: [
        'glEnd', 'glEndList', 'glFinish', 'glFlush', 'glGetError', 'glInitNames',
        'glLoadIdentity', 'glPopAttrib', 'glPopClientAttrib', 'glPopMatrix', 'glPopName',
        'glPushMatrix', 'wglGetCurrentContext', 'wglGetCurrentDC',
    ],
    1: [
        'glArrayElement', 'glBegin', 'glCallList', 'glClear', 'glClearIndex', 'glClearStencil',
        'glColor3bv', 'glColor3dv', 'glColor3fv', 'glColor3iv', 'glColor3sv', 'glColor3ubv',
        'glColor3uiv', 'glColor3usv', 'glColor4bv', 'glColor4dv', 'glColor4fv', 'glColor4iv',
        'glColor4sv', 'glColor4ubv', 'glColor4uiv', 'glColor4usv', 'glCullFace', 'glDepthFunc',
        'glDepthMask', 'glDisable', 'glDisableClientState', 'glDrawBuffer', 'glEdgeFlag',
        'glEdgeFlagv', 'glEnable', 'glEnableClientState', 'glEvalCoord1dv', 'glEvalCoord1f',
        'glEvalCoord1fv', 'glEvalCoord2dv', 'glEvalCoord2fv', 'glEvalPoint1', 'glFrontFace',
        'glGenLists', 'glGetPolygonStipple', 'glGetString', 'glIndexMask', 'glIndexdv',
        'glIndexf', 'glIndexfv', 'glIndexi', 'glIndexiv', 'glIndexs', 'glIndexsv', 'glIndexub',
        'glIndexubv', 'glIsEnabled', 'glIsList', 'glIsTexture', 'glLineWidth', 'glListBase',
        'glLoadMatrixd', 'glLoadMatrixf', 'glLoadName', 'glLogicOp', 'glMatrixMode',
        'glMultMatrixd', 'glMultMatrixf', 'glNormal3bv', 'glNormal3dv', 'glNormal3fv',
        'glNormal3iv', 'glNormal3sv', 'glPassThrough', 'glPointSize', 'glPolygonStipple',
        'glPushAttrib', 'glPushClientAttrib', 'glPushName', 'glRasterPos2dv', 'glRasterPos2fv',
        'glRasterPos2iv', 'glRasterPos2sv', 'glRasterPos3dv', 'glRasterPos3fv', 'glRasterPos3iv',
        'glRasterPos3sv', 'glRasterPos4dv', 'glRasterPos4fv', 'glRasterPos4iv', 'glRasterPos4sv',
        'glReadBuffer', 'glRenderMode', 'glShadeModel', 'glStencilMask', 'glTexCoord1dv',
        'glTexCoord1f', 'glTexCoord1fv', 'glTexCoord1i', 'glTexCoord1iv', 'glTexCoord1s',
        'glTexCoord1sv', 'glTexCoord2dv', 'glTexCoord2fv', 'glTexCoord2iv', 'glTexCoord2sv',
        'glTexCoord3dv', 'glTexCoord3fv', 'glTexCoord3iv', 'glTexCoord3sv', 'glTexCoord4dv',
        'glTexCoord4fv', 'glTexCoord4iv', 'glTexCoord4sv', 'glVertex2dv', 'glVertex2fv',
        'glVertex2iv', 'glVertex2sv', 'glVertex3dv', 'glVertex3fv', 'glVertex3iv', 'glVertex3sv',
        'glVertex4dv', 'glVertex4fv', 'glVertex4iv', 'glVertex4sv', 'wglCreateContext',
        'wglDeleteContext', 'wglGetPixelFormat', 'wglGetProcAddress', 'wglSwapBuffers',
    ],
    2: [
        'glAccum', 'glAlphaFunc', 'glBindTexture', 'glBlendFunc', 'glClearDepth', 'glClipPlane',
        'glColorMaterial', 'glDeleteLists', 'glDeleteTextures', 'glEdgeFlagPointer',
        'glEvalCoord1d', 'glEvalCoord2f', 'glEvalPoint2', 'glFogf', 'glFogfv', 'glFogi',
        'glFogiv', 'glGenTextures', 'glGetBooleanv', 'glGetClipPlane', 'glGetDoublev',
        'glGetFloatv', 'glGetIntegerv', 'glGetPixelMapfv', 'glGetPixelMapuiv',
        'glGetPixelMapusv', 'glGetPointerv', 'glHint', 'glIndexd', 'glLightModelf',
        'glLightModelfv', 'glLightModeli', 'glLightModeliv', 'glLineStipple', 'glNewList',
        'glPixelStoref', 'glPixelStorei', 'glPixelTransferf', 'glPixelTransferi', 'glPixelZoom',
        'glPolygonMode', 'glPolygonOffset', 'glRasterPos2f', 'glRasterPos2i', 'glRasterPos2s',
        'glRectdv', 'glRectfv', 'glRectiv', 'glRectsv', 'glSelectBuffer', 'glTexCoord1d',
        'glTexCoord2f', 'glTexCoord2i', 'glTexCoord2s', 'glVertex2f', 'glVertex2i', 'glVertex2s',
        'wglChoosePixelFormat', 'wglCreateLayerContext', 'wglMakeCurrent', 'wglShareLists',
        'wglSwapLayerBuffers', 'wglSwapMultipleBuffers',
    ],
    3: [
        'glAreTexturesResident', 'glCallLists', 'glColor3b', 'glColor3f', 'glColor3i',
        'glColor3s', 'glColor3ub', 'glColor3ui', 'glColor3us', 'glDrawArrays', 'glEvalMesh1',
        'glFeedbackBuffer', 'glGetLightfv', 'glGetLightiv', 'glGetMapdv', 'glGetMapfv',
        'glGetMapiv', 'glGetMaterialfv', 'glGetMaterialiv', 'glGetTexEnvfv', 'glGetTexEnviv',
        'glGetTexGendv', 'glGetTexGenfv', 'glGetTexGeniv', 'glGetTexParameterfv',
        'glGetTexParameteriv', 'glIndexPointer', 'glInterleavedArrays', 'glLightf', 'glLightfv',
        'glLighti', 'glLightiv', 'glMapGrid1f', 'glMaterialf', 'glMaterialfv', 'glMateriali',
        'glMaterialiv', 'glNormal3b', 'glNormal3f', 'glNormal3i', 'glNormal3s',
        'glNormalPointer', 'glPixelMapfv', 'glPixelMapuiv', 'glPixelMapusv',
        'glPrioritizeTextures', 'glRasterPos3f', 'glRasterPos3i', 'glRasterPos3s', 'glScalef',
        'glStencilFunc', 'glStencilOp', 'glTexCoord3f', 'glTexCoord3i', 'glTexCoord3s',
        'glTexEnvf', 'glTexEnvfv', 'glTexEnvi', 'glTexEnviv', 'glTexGendv', 'glTexGenf',
        'glTexGenfv', 'glTexGeni', 'glTexGeniv', 'glTexParameterf', 'glTexParameterfv',
        'glTexParameteri', 'glTexParameteriv', 'glTranslatef', 'glVertex3f', 'glVertex3i',
        'glVertex3s', 'wglCopyContext', 'wglRealizeLayerPalette', 'wglSetPixelFormat',
    ],
    4: [
        'glClearAccum', 'glClearColor', 'glColor4b', 'glColor4f', 'glColor4i', 'glColor4s',
        'glColor4ub', 'glColor4ui', 'glColor4us', 'glColorMask', 'glColorPointer',
        'glDepthRange', 'glDrawElements', 'glEvalCoord2d', 'glGetTexLevelParameterfv',
        'glGetTexLevelParameteriv', 'glRasterPos2d', 'glRasterPos4f', 'glRasterPos4i',
        'glRasterPos4s', 'glRectf', 'glRecti', 'glRects', 'glRotatef', 'glScissor',
        'glTexCoord2d', 'glTexCoord4f', 'glTexCoord4i', 'glTexCoord4s', 'glTexCoordPointer',
        'glTexGend', 'glVertex2d', 'glVertex4f', 'glVertex4i', 'glVertex4s', 'glVertexPointer',
        'glViewport', 'wglDescribePixelFormat', 'wglUseFontBitmapsA', 'wglUseFontBitmapsW',
    ],
    5: [
        'glCopyPixels', 'glDrawPixels', 'glEvalMesh2', 'glGetTexImage', 'glMapGrid1d',
        'wglDescribeLayerPlane', 'wglGetLayerPaletteEntries', 'wglSetLayerPaletteEntries',
    ],
    6: [
        'glColor3d', 'glCopyTexSubImage1D', 'glMap1f', 'glMapGrid2f', 'glNormal3d',
        'glRasterPos3d', 'glScaled', 'glTexCoord3d', 'glTranslated', 'glVertex3d',
    ],
    7: ['glBitmap', 'glCopyTexImage1D', 'glReadPixels', 'glTexSubImage1D'],
    8: [
        'glColor4d', 'glCopyTexImage2D', 'glCopyTexSubImage2D', 'glMap1d', 'glRasterPos4d',
        'glRectd', 'glRotated', 'glTexCoord4d', 'glTexImage1D', 'glVertex4d',
        'wglUseFontOutlinesA', 'wglUseFontOutlinesW',
    ],
    9: ['glTexImage2D', 'glTexSubImage2D'],
    10: ['glMap2f', 'glMapGrid2d'],
    12: ['glFrustum', 'glOrtho'],
    14: ['glMap2d'],
});

/**
 * The whole export table: the core above and the extension functions, which
 * a program reaches through wglGetProcAddress but which live in the same
 * module because a module is the only thing with addresses.
 *
 * @type {Readonly<Record<number, readonly string[]>>}
 */
export const ARGUMENT_WORDS = Object.freeze(Object.fromEntries(
    [...new Set([...Object.keys(CORE_WORDS), ...Object.keys(EXTENSION_WORDS)])]
        .map(words=>[words, [
            ...(CORE_WORDS[Number(words)] ?? []),
            ...(EXTENSION_WORDS[Number(words)] ?? []),
        ]])));

/** Where the handles this layer hands out start. Nothing else mints these. */
const HANDLE_BASE = 0x0e000000;

/** Scratch for reinterpreting words as the floating-point values they carry. */
const bits = new DataView(new ArrayBuffer(8));

/**
 * A GLboolean argument: one byte on the stack, whatever the caller pushed
 * beside it. A compiler passes the result of a comparison in a byte register
 * and pushes the whole register, so the word above the byte is what happened
 * to be there -- 0x100 arrives for FALSE, and reading the word says TRUE.
 *
 * @param {number} word
 * @returns {number} 0 or 1
 */
function asBoolean(word){
    return (word & 0xff) !== 0 ? 1 : 0;
}

/** @param {number} word @returns {number} */
function asFloat(word){
    bits.setUint32(0, word >>> 0, true);
    return bits.getFloat32(0, true);
}

/** @param {number} low @param {number} high @returns {number} */
function asDouble(low, high){
    bits.setUint32(0, low >>> 0, true);
    bits.setUint32(4, high >>> 0, true);
    return bits.getFloat64(0, true);
}

/**
 * How each GL type's word decodes: to a number as it stands, and to the
 * normalised 0..1 form a colour or a normal takes.
 *
 * @type {Record<string, { words: number, bytes: number,
 *        read: (view: DataView, at: number) => number,
 *        normalise: (value: number) => number }>}
 */
const TYPES = {
    f: { words: 1, bytes: 4, read: (v, at)=>v.getFloat32(at, true), normalise: x=>x },
    d: { words: 2, bytes: 8, read: (v, at)=>v.getFloat64(at, true), normalise: x=>x },
    b: { words: 1, bytes: 1, read: (v, at)=>v.getInt8(at), normalise: x=>(2 * x + 1) / 255 },
    ub: { words: 1, bytes: 1, read: (v, at)=>v.getUint8(at), normalise: x=>x / 255 },
    s: { words: 1, bytes: 2, read: (v, at)=>v.getInt16(at, true),
        normalise: x=>(2 * x + 1) / 65535 },
    us: { words: 1, bytes: 2, read: (v, at)=>v.getUint16(at, true), normalise: x=>x / 65535 },
    i: { words: 1, bytes: 4, read: (v, at)=>v.getInt32(at, true),
        normalise: x=>(2 * x + 1) / 4294967295 },
    ui: { words: 1, bytes: 4, read: (v, at)=>v.getUint32(at, true),
        normalise: x=>x / 4294967295 },
};

/**
 * The value an immediate argument of each type carries, read from the words
 * at `at`. A word argument is reinterpreted as the type's width and
 * signedness; a double is two words. An entry point picks its decoder when it
 * is bound, so a call decodes without asking which type it is.
 *
 * @type {Record<string, (words: number[], at: number) => number>}
 */
const DECODE = {
    f: (words, at)=>asFloat(words[at]),
    d: (words, at)=>asDouble(words[at], words[at + 1]),
    b: (words, at)=>(words[at] << 24) >> 24,
    ub: (words, at)=>words[at] & 0xff,
    s: (words, at)=>(words[at] << 16) >> 16,
    us: (words, at)=>words[at] & 0xffff,
    i: (words, at)=>words[at] | 0,
    ui: (words, at)=>words[at] >>> 0,
};

/** @param {number} x @returns {number} */
const unchanged = x=>x;

/**
 * The pixel types glCallLists can index with, and their width.
 *
 * @type {Map<number, string>}
 */
const LIST_TYPES = new Map([
    [GL.BYTE, 'b'], [GL.UNSIGNED_BYTE, 'ub'], [GL.SHORT, 's'], [GL.UNSIGNED_SHORT, 'us'],
    [GL.INT, 'i'], [GL.UNSIGNED_INT, 'ui'], [GL.FLOAT, 'f'],
]);

/**
 * @typedef {Object} OpenglServices
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, length: number) => Uint8Array} [windowMemory]
 *           The bytes themselves rather than a copy, valid only until the
 *           guest runs again: for the `*v` arguments a draw reads and
 *           consumes before its handler returns. Falls back to `readMemory`
 *           where absent.
 * @property {(address: number, count: number, into: Float32Array | number[]) => void}
 *           [readF32sInto]
 *           `count` floats decoded straight into `into`, with nothing else
 *           allocated: for the fixed-count vector arguments (a program
 *           parameter, a matrix) a hot handler reads into its own reused
 *           scratch, and any other float array is read into the array it
 *           answers with. Absent in a build with no such path -- a test that
 *           does not wire one -- and then these are read through a window and
 *           a `DataView` instead.
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {() => { width: number, height: number }} [screen]
 *           How big a drawable is, when nothing better can be asked.
 * @property {(hdc: number) => import('./wgl.js').DrawableInfo | null} [describeDrawable]
 *           What a device context names. Absent in a build with no GDI behind
 *           it, and then every non-null handle is its own drawable the size of
 *           the screen -- which is right for the one window a program of this
 *           era opens and wrong as soon as it opens two.
 * @property {() => number} [currentThread]
 * @property {() => number} [currentTeb]
 *           The calling thread's TEB, where the routines of the command ring
 *           find the block of the context current on it. Absent, every call
 *           is a trap.
 * @property {(code: number) => void} [setLastError]
 * @property {{ allocate: (bytes: number) => number }} [scratch]
 *           Guest memory, for what must live there: the strings glGetString
 *           answers with, the frame SwapBuffers presents, a mapped buffer.
 * @property {(surface: any) => void} [present]
 *           Told when a frame has been swapped, with the colour buffer copied
 *           into guest memory for it to read.
 * @property {(name: string) => number} [exportAddress]
 *           The guest address of one of this library's own exports. It is
 *           what wglGetProcAddress answers with, and without it no extension
 *           is advertised: a name in the extension string whose entry point
 *           cannot be handed out is a crash a program cannot see coming.
 * @property {(api: string, detail: string) => void} [divergence]
 *           Where a call that was accepted but not honoured is reported.
 * @property {() => any} [backend]
 *           The rendering backend, reached when the first context is made.
 *           With one, every context draws on the device; without, on the
 *           processor -- which is what a headless build does.
 * @property {(descriptor: any) => any} [createSampler]
 *           What the device samples textures with; needed alongside `backend`.
 * @property {() => { claim: (buffer: number, show: () => void) => void } | null} [presenter]
 *           Where a picture the device drew is claimed by its address, so a
 *           present of that address shows the texture and reads no memory.
 * @property {import('../webgpu/internal/latency.js').FrameQueued} [frameQueued]
 *           Told of every frame a swap queues on the device; what it answers
 *           is what the swap waits on before it answers the program. Absent,
 *           a swap never waits.
 * @property {boolean} [dumpDraws]
 *           Describe every draw of the last frame in the diagnostics: a
 *           per-draw account is a thing only the assembling caller decides it
 *           wants, and it costs a line and a uniform print per draw.
 * @property {number} [maxDraws]
 *           Stop each frame after this many draws, for bisecting which one
 *           painted a region.
 * @property {string | null} [skipTexture]
 *           Comma-separated texture ids whose draws are dropped, so two runs
 *           differ by those draws and nothing else.
 * @property {string | null} [probeTexture]
 *           A texture id whose draws are read around: the colour target
 *           before and after each one, on that draw's dump line.
 * @property {number[]} [keepImages]
 *           Indices of uncompressed uploads whose texels the diagnostics carry.
 * @property {boolean} [compressedTextures]
 *           The device has `texture-compression-bc`: an S3TC texture whose
 *           every level kept its blocks uploads them as blocks instead of
 *           the four-to-eight-times-larger texels the context decoded.
 * @property {boolean} [raster]
 *           `false` leaves primitives drawn on the processor unrasterised, so a
 *           run without a device measures everything but the rasteriser.
 * @property {(factory: typeof createOpenglRoot,
 *             services: import('./root.js').OpenglRootServices) => any} [remote]
 *           Makes the root elsewhere: its contexts keep their state here and
 *           draw in the graphics worker, whose frames come back to be shown.
 */

/** A context handle that names none. */
const ERROR_INVALID_HANDLE = 6;

/**
 * @param {OpenglServices} services
 */
export function createOpengl(services){
    for (const index of services.keepImages ?? [])
    {
        keptImages.at.add(index);
    }
    const screen = services.screen ?? (()=>({ width: 640, height: 480 }));
    const describeDrawable = services.describeDrawable ?? (
        /** @param {number} hdc */
        hdc=>((hdc >>> 0) === 0
            ? null
            : { key: `hdc:${hdc >>> 0}`, width: screen().width, height: screen().height }));
    const exportAddress = services.exportAddress ?? null;

    /** @type {import('./root.js').OpenglRootServices} */
    const rootServices = {
        readMemory: services.readMemory,
        windowMemory: services.windowMemory,
        writeMemory: services.writeMemory,
        allocate: services.scratch?.allocate,
        backend: services.backend,
        createSampler: services.createSampler,
        frameQueued: services.frameQueued,
        divergence: detail=>services.divergence?.('OpenGL', detail),
        raster: services.raster,
        compressedTextures: services.compressedTextures,
        dumpDraws: services.dumpDraws,
        maxDraws: services.maxDraws,
        skipTexture: services.skipTexture,
        probeTexture: services.probeTexture,
    };
    // A context draws on a device -- here or in the graphics worker -- when
    // there is one, and on the processor otherwise.
    const onDevice = services.remote !== undefined
        || (services.backend !== undefined && services.createSampler !== undefined);
    const root = services.remote
        ? services.remote(createOpenglRoot, rootServices)
        : createOpenglRoot(rootServices);
    /** Whether a context was made, and with it the renderer. */
    let madeContext = false;

    const wgl = createWgl({
        gdi: { describeDrawable },
        currentThread: services.currentThread ?? (()=>0),
        setLastError: services.setLastError,
        memory: {
            readMemory: services.readMemory,
            windowMemory: services.windowMemory,
            writeMemory: services.writeMemory,
            allocate: services.scratch?.allocate,
        },
        // No way to hand out an address, no extension: the string and the
        // lookup are one promise, and both are kept or neither is.
        extensions: exportAddress ? { ...GL_EXTENSIONS, ...WGL_EXTENSIONS } : {},
        divergence: detail=>services.divergence?.('OpenGL', detail),
        createContext: options=>{
            madeContext = true;
            return root.CreateContext(options);
        },
    });

    /** @type {Map<number, any>} guest handle -> the context it names */
    const contexts = new Map();
    /** @type {Map<any, number>} and back, so the same context keeps one handle */
    const handles = new Map();
    let nextHandle = HANDLE_BASE;

    /** @type {Map<string, number>} a GL string -> where it was put in guest memory */
    const strings = new Map();
    /** Where a swapped frame is copied to, allocated when one first is. */
    let frameAddress = 0;
    let frameBytes = 0;
    let swapInterval = 1;

    /** @type {Map<string, number>} what a program called that is not implemented */
    const unimplemented = new Map();

    /** @type {Set<number>} the handles whose pictures the presenter has been told are the device's */
    const claimed = new Set();

    /** @param {any} context @returns {number} */
    const handleFor = context=>{
        const existing = handles.get(context);
        if (existing !== undefined)
        {
            return existing;
        }
        const handle = nextHandle;
        nextHandle += 4;
        handles.set(context, handle);
        contexts.set(handle, context);
        return handle;
    };

    /** @returns {any | null} the calling thread's context */
    const current = ()=>wgl.wglGetCurrentContext();

    /**
     * Each context's command ring (`commands.js`): a block whose address the
     * routines read out of the TEB of the thread it is current on, and the
     * host's reader of what they wrote. Made when the context is first made
     * current; none where there is no guest memory to make one in.
     *
     * @type {WeakMap<any, { block: number, reader: ReturnType<typeof createCommandReader> }>}
     */
    const rings = new WeakMap();
    /** Calls the rings carried past the bridge, every context's. */
    let ringCalls = 0;
    /** The TEB each context's block was written into, while it is current. @type {Map<any, number>} */
    const tebsOf = new Map();
    /** @param {any} context */
    const ringOf = context=>{
        const made = rings.get(context);
        if (made || !services.scratch || !services.currentTeb)
        {
            return made ?? null;
        }
        const span = services.scratch.allocate(COMMAND_RING_BYTES + 3 * RING_PAGE);
        if (span === 0)
        {
            return null;
        }
        // Pages of their own: the routines write them on every call.
        const block = (span + RING_PAGE - 1) & ~(RING_PAGE - 1);
        const ring = block + RING_PAGE;
        services.writeMemory(block, new Uint8Array(RING_PAGE));
        placeCommandRing(block, ring, services.writeMemory);
        /** @param {number} address @param {number} words */
        const readWords = (address, words)=>{
            const bytes = windowMemory(address >>> 0, words * 4);
            return new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >>> 2);
        };
        const reader = createCommandReader({
            block, ring, readWords,
            readWord: address=>readWords(address, 1)[0],
            writeMemory: services.writeMemory,
            take: records=>{
                const calls = context.commands(records);
                ringCalls += calls;
                return calls;
            },
            refuse: detail=>services.divergence?.('OpenGL', detail),
        });
        const entry = { block, reader };
        rings.set(context, entry);
        return entry;
    };
    /**
     * Makes the calls the calling thread's context has waiting in its ring,
     * before any other call reaches it: every entry point that is not a
     * routine, a swap, and whoever draws through the context directly.
     */
    const drain = ()=>{
        const context = current();
        if (context)
        {
            rings.get(context)?.reader.take();
        }
    };
    /**
     * Tells the calling thread's routines which block to write: the one of
     * the context now current on it, or none.
     *
     * @param {any} context
     */
    const pointRoutines = context=>{
        const teb = services.currentTeb?.() ?? 0;
        if (teb === 0)
        {
            return;
        }
        for (const [other, at] of tebsOf)
        {
            if (at === teb)
            {
                tebsOf.delete(other);
            }
        }
        const ring = context ? ringOf(context) : null;
        writeWord(teb + TEB_GL_CONTEXT, ring?.block ?? 0);
        if (context && ring)
        {
            tebsOf.set(context, teb);
        }
    };
    /** @param {number} address @param {number} value */
    const writeWord = (address, value)=>services.writeMemory(address >>> 0,
        new Uint8Array(new Uint32Array([value >>> 0]).buffer));

    /** The window over guest memory when the host offers one, a copy otherwise. */
    const windowMemory = services.windowMemory ?? services.readMemory;

    /**
     * `count` values of one type, read from guest memory: a window rather
     * than a copy, because every one of these is consumed before the handler
     * returns, and floats straight into the array through the memory layer's
     * reader where there is one. The result is always a fresh array -- a
     * caller that keeps it (`glDeleteBuffersARB(readU32s(...))`) still gets
     * one nothing else writes.
     *
     * @param {string} type
     * @param {number} address
     * @param {number} count
     * @returns {number[]}
     */
    const readTyped = (type, address, count)=>{
        if (type === 'f' && count > 0 && services.readF32sInto)
        {
            /** @type {number[]} */
            const values = new Array(count);
            services.readF32sInto(address >>> 0, count, values);
            return values;
        }
        const spec = TYPES[type];
        const bytes = windowMemory(address >>> 0, count * spec.bytes);
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const values = new Array(count);
        for (let index = 0; index < count; index++)
        {
            values[index] = spec.read(view, index * spec.bytes);
        }
        return values;
    };

    /**
     * Where an answer's words are encoded before they are copied out. Asking
     * a small typed array for its buffer, as a `DataView` over it does, moves
     * its elements out of V8's heap into a store of their own -- several
     * times what the encoding costs -- so the words are encoded once here and
     * the copy the guest is handed is a plain slice.
     */
    let answerBytes = new Uint8Array(128);
    let answerDataView = new DataView(answerBytes.buffer);
    /** @param {number} length @returns {DataView} a view of at least `length` bytes */
    const answerView = length=>{
        if (length > answerBytes.length)
        {
            answerBytes = new Uint8Array(length);
            answerDataView = new DataView(answerBytes.buffer);
        }
        return answerDataView;
    };

    /** @param {number} address @param {readonly number[]} values */
    const writeU32s = (address, values)=>{
        const view = answerView(values.length * 4);
        for (let index = 0; index < values.length; index++)
        {
            view.setUint32(index * 4, values[index] >>> 0, true);
        }
        services.writeMemory(address >>> 0, answerBytes.slice(0, values.length * 4));
    };

    /** @param {number} address @param {number} count @returns {number[]} */
    const readU32s = (address, count)=>readTyped('ui', address, count);
    /** @param {number} address @param {number} count @returns {number[]} */
    const readF32s = (address, count)=>readTyped('f', address, count);
    /** @param {number} address @param {number} count @returns {number[]} */
    const readF64s = (address, count)=>readTyped('d', address, count);
    /** @param {number} address @param {number} count @returns {number[]} */
    const readI32s = (address, count)=>readTyped('i', address, count);

    /** Reused decode targets for the two fixed-count float vectors below. */
    const floatScratch4 = new Float32Array(4);
    const floatScratch16 = new Float32Array(16);

    /**
     * A fixed-count float vector -- a program parameter (4) or a matrix (16)
     * -- decoded into the scratch it is always asked for, reused on every
     * call: no window, no copy, no per-call array, through the memory
     * layer's own span-checked reader. The context copies what it needs
     * (`env.set`, the matrix stack's `copyOf`) before the next call overwrites it;
     * `enter`'s display-list capture snapshots it too, for a call recorded
     * rather than run now. A build with no `readF32sInto` (a test that does
     * not wire one) falls back to `readTyped`, which is always a fresh copy.
     *
     * @param {number} address
     * @param {Float32Array} scratch
     * @returns {Float32Array}
     */
    const readF32Vector = (address, scratch)=>{
        if (services.readF32sInto)
        {
            services.readF32sInto(address >>> 0, scratch.length, scratch);
        }
        else
        {
            scratch.set(readTyped('f', address, scratch.length));
        }
        return scratch;
    };

    /** Where the `*v` forms below decode their one to four components. */
    const vectorFloats = new Float32Array(4);
    const vectorValues = new Float64Array(4);
    const vectorBytes = new Uint8Array(32);
    const vectorView = new DataView(vectorBytes.buffer);

    /**
     * The reader of one type's `*v` form -- `glColor4ubv`, `glVertex3fv` --
     * chosen when the entry point is bound: up to four components decoded
     * into a scratch reused on every call, which the caller consumes before
     * it returns, handing the context scalars rather than the scratch. A
     * float vector goes through the memory layer's own reader where there is
     * one; the rest are copied out of a window into scratch bytes, so no call
     * makes a view or an array of its own.
     *
     * @param {string} type
     * @returns {(address: number, count: number) => ArrayLike<number>}
     */
    const vectorReader = type=>{
        const readF32sInto = services.readF32sInto;
        if (type === 'f' && readF32sInto)
        {
            return (address, count)=>{
                readF32sInto(address >>> 0, count, vectorFloats);
                return vectorFloats;
            };
        }
        const spec = TYPES[type];
        return (address, count)=>{
            const bytes = windowMemory(address >>> 0, count * spec.bytes);
            if (bytes.length < count * spec.bytes)
            {
                // Short of what was asked -- a memory already given back --
                // fails as the view over it always has.
                return readTyped(type, address, count);
            }
            vectorBytes.set(bytes);
            for (let index = 0; index < count; index++)
            {
                vectorValues[index] = spec.read(vectorView, index * spec.bytes);
            }
            return vectorValues;
        };
    };

    /** @param {number} address @returns {string} */
    const readCString = address=>{
        const bytes = services.readMemory(address >>> 0, 256);
        const end = bytes.indexOf(0);
        return new TextDecoder().decode(bytes.subarray(0, end < 0 ? bytes.length : end));
    };

    /**
     * Writes a typed query's answer where the caller asked for it. A query the
     * context does not know answers null, and then the buffer is left alone --
     * which is what the specification says and what a program that probes for
     * an extension's limit depends on.
     *
     * @param {number} address
     * @param {number[] | null} values
     * @param {'byte' | 'word' | 'float' | 'double'} as
     */
    const writeQuery = (address, values, as)=>{
        if (!values || (address >>> 0) === 0)
        {
            return;
        }
        const count = values.length;
        if (as === 'byte')
        {
            const bytes = new Uint8Array(count);
            for (let index = 0; index < count; index++)
            {
                bytes[index] = values[index] !== 0 ? 1 : 0;
            }
            services.writeMemory(address >>> 0, bytes);
            return;
        }
        const length = count * (as === 'double' ? 8 : 4);
        const view = answerView(length);
        for (let index = 0; index < count; index++)
        {
            if (as === 'word')
            {
                view.setInt32(index * 4, values[index] | 0, true);
            }
            else if (as === 'float')
            {
                view.setFloat32(index * 4, values[index], true);
            }
            else
            {
                view.setFloat64(index * 8, values[index], true);
            }
        }
        services.writeMemory(address >>> 0, answerBytes.slice(0, length));
    };

    /**
     * A string that has to stay valid for the life of the context, put into
     * guest memory once and kept.
     *
     * @param {string | null | undefined} value
     * @returns {number}
     */
    const guestString = value=>{
        if (value == null || !services.scratch)
        {
            return 0;
        }
        const existing = strings.get(value);
        if (existing !== undefined)
        {
            return existing;
        }
        const encoded = new TextEncoder().encode(`${value}\0`);
        const address = services.scratch.allocate(encoded.length);
        if (address === 0)
        {
            return 0;
        }
        services.writeMemory(address, encoded);
        strings.set(value, address);
        return address;
    };

    /**
     * A frame, copied into guest memory and shown.
     *
     * The presenter reads what it shows out of guest memory -- that is what
     * makes a DirectDraw surface a program wrote into showable -- so a colour
     * buffer that lives on this side has to be put there. One copy per swap,
     * which is the price of not having drawn on the GPU in the first place.
     *
     * ponytail: the whole buffer travels every time. A damage rectangle would
     * cut it, and is worth doing once the rasteriser tracks one.
     *
     * @returns {Promise<void> | null} what a swap on the device waits on
     *     before it answers, or null
     */
    const presentCurrentFrame = ()=>{
        const context = current();
        if (!context || !services.present)
        {
            return null;
        }
        if (onDevice)
        {
            const shown = root.Swap(context);
            const handle = handles.get(context) ?? 0;
            // Counted once its replay is on the queue, whether or not a
            // handle names its picture for the presenter.
            const held = shown ? root.Present() : null;
            if (!shown || handle === 0)
            {
                return held;
            }
            // The handle stands in for a surface address: the presenter is
            // told the device owns the picture there, and a present of it
            // shows the frame the renderer just replayed rather than reading
            // guest memory that holds nothing.
            if (!claimed.has(handle))
            {
                claimed.add(handle);
                services.presenter?.()?.claim(handle, ()=>{});
            }
            services.present({
                buffer: handle,
                width: shown.width,
                height: shown.height,
                pitch: shown.width * 4,
                bitCount: 32,
                palette: null,
            });
            return held;
        }
        if (!services.scratch)
        {
            return null;
        }
        const frame = context.framebuffer;
        if (frame.bytes.length === 0)
        {
            return null;
        }
        if (frameBytes < frame.bytes.length)
        {
            frameAddress = services.scratch.allocate(frame.bytes.length);
            frameBytes = frameAddress === 0 ? 0 : frame.bytes.length;
        }
        if (frameAddress === 0)
        {
            return null;
        }
        services.writeMemory(frameAddress, frame.bytes);
        services.present({
            buffer: frameAddress,
            width: frame.width,
            height: frame.height,
            pitch: frame.width * 4,
            bitCount: 32,
            palette: null,
        });
        return null;
    };

    /**
     * A call that needs a current context. Without one it does nothing and
     * answers zero: GL leaves this undefined, and a program that gets here has
     * already lost track of its own context, so the useful behaviour is the
     * quiet one rather than a fault.
     *
     * @param {(context: any) => any} body
     * @returns {number}
     */
    function call(body){
        const context = current();
        if (!context)
        {
            return 0;
        }
        const result = body(context);
        return typeof result === 'number' ? result : 0;
    }

    /**
     * A context method's answer as the guest takes it: a number, or zero for
     * nothing -- and nothing when there is no current context, whose method
     * is then not called at all (`current()?.`), without a closure made for
     * every call.
     *
     * @param {any} result
     * @returns {number}
     */
    const answer = result=>(typeof result === 'number' ? result : 0);

    /** @type {Record<string, (args: number[]) => number>} */
    const implemented = {};

    /**
     * The typed families: `glVertex3f`, `glVertex3fv`, `glVertex3d`, ... all
     * decode into one call on the context.
     *
     * Everything a form's name decides -- its decoder, its reader, whether it
     * normalises, how many components it has -- is decided here, once, so a
     * call decodes its components straight into the context's arguments and
     * allocates nothing.
     *
     * @param {string} stem  'glVertex'
     * @param {readonly number[]} counts  the component counts the family comes in
     * @param {readonly string[]} types
     * @param {boolean} normalised  whether the integer forms map onto 0..1
     * @param {readonly number[]} defaults  what a form short of four
     *        components passes for each one it lacks
     * @param {(context: any, x: number, y: number, z: number, w: number) => void} apply
     * @param {string} [suffix]  an extension suffix, after the type letter
     */
    function family(stem, counts, types, normalised, defaults, apply, suffix = ''){
        const [, d1, d2, d3] = defaults;
        for (const count of counts)
        {
            for (const type of types)
            {
                const spec = TYPES[type];
                const decode = DECODE[type];
                const step = spec.words;
                const convert = normalised ? spec.normalise : unchanged;
                const read = vectorReader(type);
                implemented[`${stem}${count}${type}${suffix}`] = args=>{
                    const context = current();
                    if (context)
                    {
                        apply(context, convert(decode(args, 0)),
                            count > 1 ? convert(decode(args, step)) : d1,
                            count > 2 ? convert(decode(args, 2 * step)) : d2,
                            count > 3 ? convert(decode(args, 3 * step)) : d3);
                    }
                    return 0;
                };
                implemented[`${stem}${count}${type}v${suffix}`] = ([address])=>{
                    const context = current();
                    if (context)
                    {
                        const v = read(address, count);
                        apply(context, convert(v[0]),
                            count > 1 ? convert(v[1]) : d1,
                            count > 2 ? convert(v[2]) : d2,
                            count > 3 ? convert(v[3]) : d3);
                    }
                    return 0;
                };
            }
        }
    }

    const ALL = ['b', 'd', 'f', 'i', 's', 'ub', 'ui', 'us'];
    const SIGNED = ['d', 'f', 'i', 's'];

    family('glVertex', [2, 3, 4], SIGNED, false, [0, 0, 0, 1],
        (context, x, y, z, w)=>context.glVertex4f(x, y, z, w));
    family('glColor', [3, 4], ALL, true, [0, 0, 0, 1],
        (context, r, g, b, a)=>context.glColor4f(r, g, b, a));
    family('glNormal', [3], ['b', 'd', 'f', 'i', 's'], true, [0, 0, 0, 0],
        (context, x, y, z)=>context.glNormal3f(x, y, z));
    family('glTexCoord', [1, 2, 3, 4], SIGNED, false, [0, 0, 0, 1],
        (context, s, t, r, q)=>context.glTexCoord4f(s, t, r, q));
    family('glRasterPos', [2, 3, 4], SIGNED, false, [0, 0, 0, 1],
        (context, x, y, z, w)=>context.glRasterPos4f(x, y, z, w));
    family('glSecondaryColor', [3], ALL, true, [0, 0, 0, 0],
        (context, r, g, b)=>context.glSecondaryColor3fEXT(r, g, b), 'EXT');
    // glIndex has no component count in its name, and glRect takes four
    // scalars or two pointers: neither is the family helper's pattern.
    for (const type of ['d', 'f', 'i', 's', 'ub'])
    {
        const decode = DECODE[type];
        const read = vectorReader(type);
        implemented[`glIndex${type}`] = args=>answer(current()?.glIndexi(decode(args, 0)));
        implemented[`glIndex${type}v`] = ([address])=>answer(current()?.glIndexi(
            read(address, 1)[0]));
    }
    for (const type of SIGNED)
    {
        const decode = DECODE[type];
        const step = TYPES[type].words;
        implemented[`glRect${type}`] = args=>answer(current()?.glRectf(
            decode(args, 0), decode(args, step), decode(args, 2 * step), decode(args, 3 * step)));
        implemented[`glRect${type}v`] = ([a, b])=>answer(current()?.glRectf(
            ...readTyped(type, a, 2), ...readTyped(type, b, 2)));
    }
    /**
     * The forms whose first argument is an index the vector is not part of:
     * a texture unit, a generic attribute. A form short of four components
     * fills the rest with (0, 0, 1).
     *
     * @param {string} name  the entry point, up to its type letter
     * @param {string} type
     * @param {number} count
     * @param {string} suffix
     * @param {(context: any, index: number, x: number, y: number, z: number, w: number)
     *     => void} apply
     */
    const indexedVector = (name, type, count, suffix, apply)=>{
        const decode = DECODE[type];
        const step = TYPES[type].words;
        const read = vectorReader(type);
        implemented[`${name}${type}${suffix}`] = args=>{
            const context = current();
            if (context)
            {
                apply(context, args[0] >>> 0, decode(args, 1),
                    count > 1 ? decode(args, 1 + step) : 0,
                    count > 2 ? decode(args, 1 + 2 * step) : 0,
                    count > 3 ? decode(args, 1 + 3 * step) : 1);
            }
            return 0;
        };
        implemented[`${name}${type}v${suffix}`] = ([index, address])=>{
            const context = current();
            if (context)
            {
                const v = read(address, count);
                apply(context, index >>> 0, v[0], count > 1 ? v[1] : 0, count > 2 ? v[2] : 0,
                    count > 3 ? v[3] : 1);
            }
            return 0;
        };
    };
    // GL_ARB_multitexture: the unit comes first and is not part of the vector.
    for (const count of [1, 2, 3, 4])
    {
        for (const type of SIGNED)
        {
            indexedVector(`glMultiTexCoord${count}`, type, count, 'ARB',
                (context, unit, s, t, r, q)=>context.glMultiTexCoord4fARB(unit, s, t, r, q));
        }
    }

    // GL_ARB_vertex_program generic attributes: the index comes first, and a
    // form short of four components fills the rest with (0, 0, 1). The N
    // variants map their integers onto 0..1; the plain ones pass them through
    // as the values they are.
    for (const count of [1, 2, 3, 4])
    {
        for (const type of ['s', 'f', 'd'])
        {
            indexedVector(`glVertexAttrib${count}`, type, count, 'ARB',
                (context, index, x, y, z, w)=>context.glVertexAttrib4fARB(index, x, y, z, w));
        }
    }
    /** @type {[string, string, boolean][]} the four-component vector forms */
    const attribVectors = [
        ['4bv', 'b', false], ['4sv', 's', false], ['4iv', 'i', false],
        ['4ubv', 'ub', false], ['4usv', 'us', false], ['4uiv', 'ui', false],
        ['4fv', 'f', false], ['4dv', 'd', false],
        ['4Nbv', 'b', true], ['4Nsv', 's', true], ['4Niv', 'i', true],
        ['4Nubv', 'ub', true], ['4Nusv', 'us', true], ['4Nuiv', 'ui', true],
    ];
    for (const [suffix, type, normalised] of attribVectors)
    {
        const convert = normalised ? TYPES[type].normalise : unchanged;
        const read = vectorReader(type);
        implemented[`glVertexAttrib${suffix}ARB`] = ([index, address])=>call(context=>{
            const v = read(address, 4);
            context.glVertexAttrib4fARB(index >>> 0, convert(v[0]), convert(v[1]),
                convert(v[2]), convert(v[3]));
        });
    }

    /**
     * A parameter-setting family: `glLightf`, `glLightfv`, `glLighti`,
     * `glLightiv` and their like, where the integer forms normalise only the
     * parameters that are colours.
     *
     * @param {string} stem
     * @param {number} leading  how many enum arguments precede the value
     * @param {(parameter: number) => number} vectorSize  how many values
     *        the vector form reads for a parameter
     * @param {Set<number>} colours  the parameters whose integer form is normalised
     * @param {(context: any, head: number[], values: number[]) => void} apply
     * @param {string} [suffix]
     */
    function parameterFamily(stem, leading, vectorSize, colours, apply, suffix = ''){
        /** @param {number[]} args @returns {number[]} the enums before the value */
        const headOf = args=>(leading === 1 ? [args[0] >>> 0] : [args[0] >>> 0, args[1] >>> 0]);
        for (const type of ['f', 'i'])
        {
            const decode = DECODE[type];
            const integer = type === 'i';
            implemented[`${stem}${type}${suffix}`] = args=>{
                const context = current();
                if (context)
                {
                    const head = headOf(args);
                    const value = decode(args, leading);
                    apply(context, head, [integer && colours.has(head[leading - 1])
                        ? TYPES.i.normalise(value) : value]);
                }
                return 0;
            };
            implemented[`${stem}${type}v${suffix}`] = args=>{
                const context = current();
                if (context)
                {
                    const head = headOf(args);
                    const parameter = head[leading - 1];
                    const values = readTyped(type, args[leading], vectorSize(parameter));
                    if (integer && colours.has(parameter))
                    {
                        for (let index = 0; index < values.length; index++)
                        {
                            values[index] = TYPES.i.normalise(values[index]);
                        }
                    }
                    apply(context, head, values);
                }
                return 0;
            };
        }
    }

    /** @type {Set<number>} */
    const LIGHT_COLOURS = new Set([GL.AMBIENT, GL.DIFFUSE, GL.SPECULAR]);
    /** @param {number} parameter @returns {number} */
    const lightSize = parameter=>(LIGHT_COLOURS.has(parameter) || parameter === GL.POSITION ? 4
        : parameter === GL.SPOT_DIRECTION ? 3 : 1);
    parameterFamily('glLight', 2, lightSize, LIGHT_COLOURS,
        (context, [light, parameter], values)=>context.glLightfv(light, parameter, values));
    parameterFamily('glLightModel', 1, parameter=>(parameter === GL.LIGHT_MODEL_AMBIENT ? 4 : 1),
        new Set([GL.LIGHT_MODEL_AMBIENT]),
        (context, [parameter], values)=>context.glLightModelfv(parameter, values));
    /** @type {Set<number>} */
    const MATERIAL_COLOURS = new Set([
        GL.AMBIENT, GL.DIFFUSE, GL.SPECULAR, GL.EMISSION, GL.AMBIENT_AND_DIFFUSE,
    ]);
    parameterFamily('glMaterial', 2,
        parameter=>(MATERIAL_COLOURS.has(parameter) ? 4 : parameter === GL.COLOR_INDEXES ? 3 : 1),
        MATERIAL_COLOURS,
        (context, [face, parameter], values)=>context.glMaterialfv(face, parameter, values));
    parameterFamily('glFog', 1, parameter=>(parameter === GL.FOG_COLOR ? 4 : 1),
        new Set([GL.FOG_COLOR]),
        (context, [parameter], values)=>context.glFogfv(parameter, values));
    parameterFamily('glTexParameter', 2,
        parameter=>(parameter === GL.TEXTURE_BORDER_COLOR ? 4 : 1),
        new Set([GL.TEXTURE_BORDER_COLOR]),
        (context, [target, parameter], values)=>
            context.glTexParameterfv(target, parameter, values));
    parameterFamily('glTexEnv', 2, parameter=>(parameter === GL.TEXTURE_ENV_COLOR ? 4 : 1),
        new Set([GL.TEXTURE_ENV_COLOR]),
        (context, [target, parameter], values)=>context.glTexEnvfv(target, parameter, values));
    parameterFamily('glTexGen', 2, parameter=>(parameter === GL.TEXTURE_GEN_MODE ? 1 : 4),
        new Set(),
        (context, [coord, parameter], values)=>context.glTexGenfv(coord, parameter, values));
    implemented.glTexGend = ([coord, parameter, low, high])=>answer(
        current()?.glTexGenfv(coord >>> 0, parameter >>> 0, [asDouble(low, high)]));
    implemented.glTexGendv = ([coord, parameter, address])=>answer(
        current()?.glTexGenfv(coord >>> 0, parameter >>> 0,
            readF64s(address, (parameter >>> 0) === GL.TEXTURE_GEN_MODE ? 1 : 4)));

    /**
     * A typed getter pair: `glGetLightfv` and `glGetLightiv`, where the
     * integer form maps a normalised answer onto the integer range.
     *
     * @param {string} stem
     * @param {number} leading
     * @param {(parameter: number) => boolean} normalised
     * @param {(context: any, head: number[]) => number[] | null} query
     */
    function getterFamily(stem, leading, normalised, query){
        implemented[`${stem}fv`] = args=>call(context=>writeQuery(
            args[leading], query(context, args.slice(0, leading).map(x=>x >>> 0)), 'float'));
        implemented[`${stem}iv`] = args=>call(context=>{
            const head = args.slice(0, leading).map(x=>x >>> 0);
            const values = query(context, head);
            const mapped = values && normalised(head[leading - 1])
                ? values.map(value=>Math.round(Math.min(1, Math.max(0, value)) * 0x7fffffff))
                : values?.map(Math.round) ?? null;
            writeQuery(args[leading], mapped, 'word');
        });
    }

    getterFamily('glGetLight', 2, parameter=>LIGHT_COLOURS.has(parameter),
        (context, [light, parameter])=>context.glGetLightfv(light, parameter));
    getterFamily('glGetMaterial', 2, parameter=>MATERIAL_COLOURS.has(parameter),
        (context, [face, parameter])=>context.glGetMaterialfv(face, parameter));
    getterFamily('glGetTexParameter', 2, parameter=>parameter === GL.TEXTURE_BORDER_COLOR,
        (context, [target, parameter])=>context.glGetTexParameterfv(target, parameter));
    getterFamily('glGetTexEnv', 2, parameter=>parameter === GL.TEXTURE_ENV_COLOR,
        (context, [target, parameter])=>context.glGetTexEnvfv(target, parameter));
    getterFamily('glGetTexGen', 2, ()=>false,
        (context, [coord, parameter])=>context.glGetTexGenfv(coord, parameter));
    getterFamily('glGetTexLevelParameter', 3, ()=>false,
        (context, [target, level, parameter])=>
            context.glGetTexLevelParameteriv(target, level | 0, parameter));
    implemented.glGetTexGendv = ([coord, parameter, out])=>call(context=>
        writeQuery(out, context.glGetTexGenfv(coord >>> 0, parameter >>> 0), 'double'));

    /**
     * @param {any} context
     * @returns {import('./texture.js').UnpackState} the current unpack state
     */
    const unpackState = context=>({
        alignment: context.glGetIntegerv(GL.UNPACK_ALIGNMENT)[0],
        rowLength: context.glGetIntegerv(GL.UNPACK_ROW_LENGTH)[0],
        skipRows: context.glGetIntegerv(GL.UNPACK_SKIP_ROWS)[0],
        skipPixels: context.glGetIntegerv(GL.UNPACK_SKIP_PIXELS)[0],
        swapBytes: context.glGetIntegerv(GL.UNPACK_SWAP_BYTES)[0] !== 0,
    });

    /**
     * The one-time attribute answers WGL_ARB_pixel_format gives about a
     * format, as the descriptor's fields.
     *
     * @param {import('./pixelformat.js').PixelFormat} format
     * @param {number} attribute
     * @returns {number | null}
     */
    const formatAttribute = (format, attribute)=>{
        switch (attribute)
        {
            case WGL.NUMBER_PIXEL_FORMATS_ARB:
                return PIXEL_FORMATS.length;
            case WGL.DRAW_TO_WINDOW_ARB:
                return (format.dwFlags & PFD.DRAW_TO_WINDOW) ? 1 : 0;
            case WGL.DRAW_TO_BITMAP_ARB:
                return (format.dwFlags & PFD.DRAW_TO_BITMAP) ? 1 : 0;
            case WGL.ACCELERATION_ARB:
                return (format.dwFlags & PFD.GENERIC_ACCELERATED) ? WGL.FULL_ACCELERATION_ARB
                    : (format.dwFlags & PFD.GENERIC_FORMAT) ? WGL.NO_ACCELERATION_ARB
                        : WGL.FULL_ACCELERATION_ARB;
            case WGL.NEED_PALETTE_ARB:
            case WGL.NEED_SYSTEM_PALETTE_ARB:
            case WGL.NUMBER_OVERLAYS_ARB:
            case WGL.NUMBER_UNDERLAYS_ARB:
            case WGL.TRANSPARENT_ARB:
            case WGL.SHARE_DEPTH_ARB:
            case WGL.SHARE_STENCIL_ARB:
            case WGL.SHARE_ACCUM_ARB:
            case WGL.SAMPLE_BUFFERS_ARB:
            case WGL.SAMPLES_ARB:
                return 0;
            case WGL.SWAP_LAYER_BUFFERS_ARB:
                return (format.dwFlags & PFD.SWAP_LAYER_BUFFERS) ? 1 : 0;
            case WGL.SWAP_METHOD_ARB:
                return (format.dwFlags & PFD.SWAP_EXCHANGE) ? WGL.SWAP_EXCHANGE_ARB
                    : (format.dwFlags & PFD.SWAP_COPY) ? WGL.SWAP_COPY_ARB : WGL.SWAP_UNDEFINED_ARB;
            case WGL.SUPPORT_GDI_ARB:
                return (format.dwFlags & PFD.SUPPORT_GDI) ? 1 : 0;
            case WGL.SUPPORT_OPENGL_ARB:
                return (format.dwFlags & PFD.SUPPORT_OPENGL) ? 1 : 0;
            case WGL.DOUBLE_BUFFER_ARB:
                return (format.dwFlags & PFD.DOUBLEBUFFER) ? 1 : 0;
            case WGL.STEREO_ARB:
                return (format.dwFlags & PFD.STEREO) ? 1 : 0;
            case WGL.PIXEL_TYPE_ARB:
                return format.iPixelType === PFD.TYPE_COLORINDEX
                    ? WGL.TYPE_COLORINDEX_ARB : WGL.TYPE_RGBA_ARB;
            case WGL.COLOR_BITS_ARB:
                return format.cColorBits;
            case WGL.RED_BITS_ARB:
                return format.cRedBits;
            case WGL.RED_SHIFT_ARB:
                return format.cRedShift;
            case WGL.GREEN_BITS_ARB:
                return format.cGreenBits;
            case WGL.GREEN_SHIFT_ARB:
                return format.cGreenShift;
            case WGL.BLUE_BITS_ARB:
                return format.cBlueBits;
            case WGL.BLUE_SHIFT_ARB:
                return format.cBlueShift;
            case WGL.ALPHA_BITS_ARB:
                return format.cAlphaBits;
            case WGL.ALPHA_SHIFT_ARB:
                return format.cAlphaShift;
            case WGL.ACCUM_BITS_ARB:
                return format.cAccumBits;
            case WGL.ACCUM_RED_BITS_ARB:
                return format.cAccumRedBits;
            case WGL.ACCUM_GREEN_BITS_ARB:
                return format.cAccumGreenBits;
            case WGL.ACCUM_BLUE_BITS_ARB:
                return format.cAccumBlueBits;
            case WGL.ACCUM_ALPHA_BITS_ARB:
                return format.cAccumAlphaBits;
            case WGL.DEPTH_BITS_ARB:
                return format.cDepthBits;
            case WGL.STENCIL_BITS_ARB:
                return format.cStencilBits;
            case WGL.AUX_BUFFERS_ARB:
                return format.cAuxBuffers;
            default:
                return null;
        }
    };

    /**
     * Answers a WGL_ARB_pixel_format attribute query, in either type.
     *
     * @param {number[]} args
     * @param {'word' | 'float'} as
     * @returns {number}
     */
    const pixelFormatAttributes = ([hdc, index, plane, count, attributes, out], as)=>{
        if (!describeDrawable(hdc >>> 0) || (plane | 0) !== 0)
        {
            return 0;
        }
        const wanted = readU32s(attributes, count | 0);
        const format = PIXEL_FORMATS[(index | 0) - 1];
        const answers = wanted.map(attribute=>(attribute === WGL.NUMBER_PIXEL_FORMATS_ARB
            ? PIXEL_FORMATS.length
            : format ? formatAttribute(format, attribute) : null));
        if (answers.some(value=>value === null))
        {
            return 0;
        }
        writeQuery(out, /** @type {number[]} */ (answers), as);
        return 1;
    };

    /** @type {Record<string, (args: number[]) => number>} */
    const handlers = {
        // --- WGL ---

        wglCreateContext: ([hdc])=>{
            const context = wgl.wglCreateContext(hdc >>> 0);
            return context ? handleFor(context) : 0;
        },

        wglDeleteContext: ([handle])=>{
            const context = contexts.get(handle >>> 0);
            // A handle already deleted, or never made, is WGL's to refuse, so
            // the program reads ERROR_INVALID_HANDLE rather than nothing.
            if (!wgl.wglDeleteContext(context ?? null))
            {
                return 0;
            }
            const teb = tebsOf.get(context);
            if (teb !== undefined)
            {
                writeWord(teb + TEB_GL_CONTEXT, 0);
                tebsOf.delete(context);
            }
            // The handle is not reused: a program that deletes a context and
            // then uses the stale handle must be told it is stale, not handed
            // whatever was made next.
            contexts.delete(handle >>> 0);
            handles.delete(context);
            return 1;
        },

        wglMakeCurrent: ([hdc, handle])=>{
            const context = (handle >>> 0) === 0 ? null : contexts.get(handle >>> 0);
            if ((handle >>> 0) !== 0 && !context)
            {
                services.setLastError?.(ERROR_INVALID_HANDLE);
                return 0;
            }
            if (!wgl.wglMakeCurrent(hdc >>> 0, context ?? null))
            {
                return 0;
            }
            pointRoutines(context ?? null);
            return 1;
        },

        wglGetCurrentContext: ()=>{
            const context = current();
            return context ? handleFor(context) : 0;
        },

        wglGetCurrentDC: ()=>wgl.wglGetCurrentDC(),

        wglShareLists: ([source, destination])=>{
            const from = contexts.get(source >>> 0);
            const to = contexts.get(destination >>> 0);
            return from && to && wgl.wglShareLists(from, to) ? 1 : 0;
        },

        /**
         * The address of an extension function, and null for everything
         * else -- a core entry point, a name nobody reported, no context.
         */
        wglGetProcAddress: ([name])=>{
            if ((name >>> 0) === 0 || !exportAddress)
            {
                return 0;
            }
            const wanted = readCString(name);
            return wgl.wglGetProcAddress(wanted) ? exportAddress(wanted) : 0;
        },

        wglChoosePixelFormat: ([hdc, descriptor])=>((descriptor >>> 0) === 0
            ? 0
            : wgl.ChoosePixelFormat(hdc >>> 0, readDescriptor(descriptor))),

        wglSetPixelFormat: ([hdc, index])=>(wgl.SetPixelFormat(hdc >>> 0, index | 0) ? 1 : 0),

        wglGetPixelFormat: ([hdc])=>wgl.GetPixelFormat(hdc >>> 0),

        wglDescribePixelFormat: ([hdc, index, bytes, out])=>
            wgl.DescribePixelFormat(hdc >>> 0, index | 0, bytes >>> 0, out >>> 0),

        // --- WGL extensions ---

        wglGetExtensionsStringARB: ([hdc])=>(describeDrawable(hdc >>> 0)
            ? guestString(Object.keys(WGL_EXTENSIONS).join(' '))
            : 0),

        wglGetExtensionsStringEXT: ()=>guestString(Object.keys(WGL_EXTENSIONS).join(' ')),

        wglSwapIntervalEXT: ([interval])=>{
            // Accepted and remembered; the pace a frame is shown at is the
            // presenter's, which paces to the display already.
            if ((interval | 0) < 0)
            {
                return 0;
            }
            swapInterval = interval | 0;
            return 1;
        },

        wglGetSwapIntervalEXT: ()=>swapInterval,

        wglGetPixelFormatAttribivARB: args=>pixelFormatAttributes(args, 'word'),

        wglGetPixelFormatAttribfvARB: args=>pixelFormatAttributes(args, 'float'),

        /**
         * The extension's way of choosing: attribute pairs rather than a
         * descriptor, answered with the one best format.
         */
        wglChoosePixelFormatARB: args=>{
            const [hdc, intAttributes] = args;
            const [maxFormats, out, outCount] = args.slice(3);
            if (!describeDrawable(hdc >>> 0) || (out >>> 0) === 0 || (outCount >>> 0) === 0)
            {
                return 0;
            }
            const request = { ...PIXEL_FORMATS[0], dwFlags: 0, cDepthBits: 0, cStencilBits: 0,
                cAlphaBits: 0, cAccumBits: 0, cAuxBuffers: 0, cColorBits: 0 };
            /** @type {Record<number, number>} */
            const flagOf = {
                [WGL.DRAW_TO_WINDOW_ARB]: PFD.DRAW_TO_WINDOW,
                [WGL.DRAW_TO_BITMAP_ARB]: PFD.DRAW_TO_BITMAP,
                [WGL.SUPPORT_OPENGL_ARB]: PFD.SUPPORT_OPENGL,
                [WGL.SUPPORT_GDI_ARB]: PFD.SUPPORT_GDI,
                [WGL.DOUBLE_BUFFER_ARB]: PFD.DOUBLEBUFFER,
                [WGL.STEREO_ARB]: PFD.STEREO,
            };
            for (let at = intAttributes >>> 0; at !== 0;)
            {
                const [attribute, value] = readI32s(at, 2);
                if (attribute === 0)
                {
                    break;
                }
                at += 8;
                if (flagOf[attribute] !== undefined)
                {
                    request.dwFlags = value ? request.dwFlags | flagOf[attribute] : request.dwFlags;
                }
                else if (attribute === WGL.COLOR_BITS_ARB)
                {
                    request.cColorBits = value;
                }
                else if (attribute === WGL.DEPTH_BITS_ARB)
                {
                    request.cDepthBits = value;
                }
                else if (attribute === WGL.STENCIL_BITS_ARB)
                {
                    request.cStencilBits = value;
                }
                else if (attribute === WGL.ALPHA_BITS_ARB)
                {
                    request.cAlphaBits = value;
                }
                else if (attribute === WGL.PIXEL_TYPE_ARB)
                {
                    request.iPixelType = value === WGL.TYPE_COLORINDEX_ARB
                        ? PFD.TYPE_COLORINDEX : PFD.TYPE_RGBA;
                }
            }
            const chosen = choosePixelFormat(request);
            const found = chosen > 0 && (maxFormats >>> 0) > 0 ? [chosen] : [];
            writeU32s(out, found);
            writeU32s(outCount, [found.length]);
            return 1;
        },

        // --- the error flag and the strings ---

        // With no context current there is nothing to have no error: Windows
        // answers GL_INVALID_OPERATION (Wine's opengl32 test, before its first
        // context).
        glGetError: ()=>current()?.glGetError() ?? GL.INVALID_OPERATION,

        glGetString: ([name])=>guestString(current()?.glGetString(name >>> 0)),

        // --- capabilities and queries ---

        glEnable: ([cap])=>answer(current()?.glEnable(cap >>> 0)),
        glDisable: ([cap])=>answer(current()?.glDisable(cap >>> 0)),
        glIsEnabled: ([cap])=>current()?.glIsEnabled(cap >>> 0) ?? GL.FALSE,
        glHint: ([target, mode])=>answer(current()?.glHint(target >>> 0, mode >>> 0)),

        glGetBooleanv: ([query, out])=>
            call(context=>writeQuery(out, context.glGetBooleanv(query >>> 0), 'byte')),
        glGetIntegerv: ([query, out])=>
            call(context=>writeQuery(out, context.glGetIntegerv(query >>> 0), 'word')),
        glGetFloatv: ([query, out])=>
            call(context=>writeQuery(out, context.glGetFloatv(query >>> 0), 'float')),
        glGetDoublev: ([query, out])=>
            call(context=>writeQuery(out, context.glGetFloatv(query >>> 0), 'double')),
        glGetPointerv: ([query, out])=>
            call(context=>writeQuery(out, context.glGetPointerv(query >>> 0), 'word')),
        glGetClipPlane: ([plane, out])=>
            call(context=>writeQuery(out, context.glGetClipPlane(plane >>> 0), 'double')),

        // --- the state a program sets before it draws ---

        glClear: ([mask])=>answer(current()?.glClear(mask >>> 0)),
        glClearColor: ([r, g, b, a])=>answer(
            current()?.glClearColor(asFloat(r), asFloat(g), asFloat(b), asFloat(a))),
        glClearAccum: ([r, g, b, a])=>answer(
            current()?.glClearAccum(asFloat(r), asFloat(g), asFloat(b), asFloat(a))),
        glClearDepth: ([low, high])=>answer(current()?.glClearDepth(asDouble(low, high))),
        glClearStencil: ([value])=>answer(current()?.glClearStencil(value | 0)),
        glBlendFunc: ([source, destination])=>
            answer(current()?.glBlendFunc(source >>> 0, destination >>> 0)),
        glDepthFunc: ([func])=>answer(current()?.glDepthFunc(func >>> 0)),
        glDepthMask: ([flag])=>answer(current()?.glDepthMask(asBoolean(flag))),
        glDepthRange: ([nl, nh, fl, fh])=>
            answer(current()?.glDepthRange(asDouble(nl, nh), asDouble(fl, fh))),
        glColorMask: ([r, g, b, a])=>answer(
            current()?.glColorMask(asBoolean(r), asBoolean(g), asBoolean(b), asBoolean(a))),
        glCullFace: ([mode])=>answer(current()?.glCullFace(mode >>> 0)),
        glFrontFace: ([mode])=>answer(current()?.glFrontFace(mode >>> 0)),
        glShadeModel: ([mode])=>answer(current()?.glShadeModel(mode >>> 0)),
        glLogicOp: ([op])=>answer(current()?.glLogicOp(op >>> 0)),
        glAlphaFunc: ([func, ref])=>answer(current()?.glAlphaFunc(func >>> 0, asFloat(ref))),
        glStencilFunc: ([func, ref, mask])=>
            answer(current()?.glStencilFunc(func >>> 0, ref | 0, mask >>> 0)),
        glStencilOp: ([fail, zfail, zpass])=>
            answer(current()?.glStencilOp(fail >>> 0, zfail >>> 0, zpass >>> 0)),
        glStencilMask: ([mask])=>answer(current()?.glStencilMask(mask >>> 0)),

        // --- GL_EXT_stencil_two_side ---
        glActiveStencilFaceEXT: ([face])=>
            answer(current()?.glActiveStencilFaceEXT(face >>> 0)),
        glPolygonMode: ([face, mode])=>
            answer(current()?.glPolygonMode(face >>> 0, mode >>> 0)),
        glPolygonOffset: ([factor, units])=>
            answer(current()?.glPolygonOffset(asFloat(factor), asFloat(units))),
        glLineWidth: ([width])=>answer(current()?.glLineWidth(asFloat(width))),
        glPointSize: ([size])=>answer(current()?.glPointSize(asFloat(size))),
        glLineStipple: ([factor, pattern])=>
            answer(current()?.glLineStipple(factor | 0, pattern & 0xffff)),
        glPixelStorei: ([parameter, value])=>
            answer(current()?.glPixelStorei(parameter >>> 0, value | 0)),
        glPixelStoref: ([parameter, value])=>
            answer(current()?.glPixelStorei(parameter >>> 0, Math.round(asFloat(value)))),
        glPixelZoom: ([x, y])=>answer(current()?.glPixelZoom(asFloat(x), asFloat(y))),
        glViewport: ([x, y, width, height])=>
            answer(current()?.glViewport(x | 0, y | 0, width | 0, height | 0)),
        glScissor: ([x, y, width, height])=>
            answer(current()?.glScissor(x | 0, y | 0, width | 0, height | 0)),
        glDrawBuffer: ([mode])=>answer(current()?.glDrawBuffer(mode >>> 0)),
        glReadBuffer: ([mode])=>answer(current()?.glReadBuffer(mode >>> 0)),
        glRenderMode: ([mode])=>answer(current()?.glRenderMode(mode >>> 0)),
        glAccum: ([op, value])=>answer(current()?.glAccum(op >>> 0, asFloat(value))),
        glFlush: ()=>answer(current()?.glFlush()),
        glFinish: ()=>answer(current()?.glFinish()),
        glColorMaterial: ([face, mode])=>
            answer(current()?.glColorMaterial(face >>> 0, mode >>> 0)),
        glClipPlane: ([plane, equation])=>
            answer(current()?.glClipPlane(plane >>> 0, readF64s(equation, 4))),

        // --- the matrix stacks ---

        glMatrixMode: ([mode])=>answer(current()?.glMatrixMode(mode >>> 0)),
        glPushMatrix: ()=>answer(current()?.glPushMatrix()),
        glPopMatrix: ()=>answer(current()?.glPopMatrix()),
        glLoadIdentity: ()=>answer(current()?.glLoadIdentity()),
        glLoadMatrixf: ([m])=>answer(
            current()?.glLoadMatrixf(readF32Vector(m, floatScratch16))),
        glLoadMatrixd: ([m])=>answer(current()?.glLoadMatrixf(readF64s(m, 16))),
        glMultMatrixf: ([m])=>answer(
            current()?.glMultMatrixf(readF32Vector(m, floatScratch16))),
        glMultMatrixd: ([m])=>answer(current()?.glMultMatrixf(readF64s(m, 16))),
        glTranslatef: ([x, y, z])=>
            answer(current()?.glTranslatef(asFloat(x), asFloat(y), asFloat(z))),
        glTranslated: a=>answer(current()?.glTranslatef(
            asDouble(a[0], a[1]), asDouble(a[2], a[3]), asDouble(a[4], a[5]))),
        glScalef: ([x, y, z])=>answer(
            current()?.glScalef(asFloat(x), asFloat(y), asFloat(z))),
        glScaled: a=>answer(current()?.glScalef(
            asDouble(a[0], a[1]), asDouble(a[2], a[3]), asDouble(a[4], a[5]))),
        glRotatef: ([angle, x, y, z])=>answer(
            current()?.glRotatef(asFloat(angle), asFloat(x), asFloat(y), asFloat(z))),
        glRotated: a=>answer(current()?.glRotatef(
            asDouble(a[0], a[1]), asDouble(a[2], a[3]), asDouble(a[4], a[5]),
            asDouble(a[6], a[7]))),
        glOrtho: a=>answer(current()?.glOrtho(
            asDouble(a[0], a[1]), asDouble(a[2], a[3]), asDouble(a[4], a[5]),
            asDouble(a[6], a[7]), asDouble(a[8], a[9]), asDouble(a[10], a[11]))),
        glFrustum: a=>answer(current()?.glFrustum(
            asDouble(a[0], a[1]), asDouble(a[2], a[3]), asDouble(a[4], a[5]),
            asDouble(a[6], a[7]), asDouble(a[8], a[9]), asDouble(a[10], a[11]))),

        // --- texture objects ---

        glGenTextures: ([count, out])=>call(context=>{
            const names = context.glGenTextures(count | 0);
            if (names.length > 0 && (out >>> 0) !== 0)
            {
                writeU32s(out, names);
            }
        }),
        glDeleteTextures: ([count, list])=>answer(current()?.glDeleteTextures(
            (count | 0) > 0 && (list >>> 0) !== 0 ? readU32s(list, count | 0) : [])),
        glBindTexture: ([target, name])=>
            answer(current()?.glBindTexture(target >>> 0, name >>> 0)),
        glIsTexture: ([name])=>current()?.glIsTexture(name >>> 0) ?? GL.FALSE,
        glAreTexturesResident: ([count, list, out])=>call(context=>{
            const names = (count | 0) > 0 ? readU32s(list, count | 0) : [];
            const all = context.glAreTexturesResident(names);
            if (all === GL.TRUE && (out >>> 0) !== 0)
            {
                services.writeMemory(out >>> 0, new Uint8Array(names.length).fill(1));
            }
            return all;
        }),
        glPrioritizeTextures: ([count, list, priorities])=>answer(
            current()?.glPrioritizeTextures(
                readU32s(list, count | 0), readF32s(priorities, count | 0))),
        glTexImage2D: a=>answer(current()?.glTexImage2D(
            a[0] >>> 0, a[1] | 0, a[2] | 0, a[3] | 0, a[4] | 0, a[5] | 0, a[6] >>> 0, a[7] >>> 0,
            a[8] >>> 0)),
        glTexImage1D: a=>answer(current()?.glTexImage1D(
            a[0] >>> 0, a[1] | 0, a[2] | 0, a[3] | 0, a[4] | 0, a[5] >>> 0, a[6] >>> 0,
            a[7] >>> 0)),
        glTexSubImage2D: a=>answer(current()?.glTexSubImage2D(
            a[0] >>> 0, a[1] | 0, a[2] | 0, a[3] | 0, a[4] | 0, a[5] | 0, a[6] >>> 0, a[7] >>> 0,
            a[8] >>> 0)),
        glTexSubImage1D: a=>answer(current()?.glTexSubImage1D(
            a[0] >>> 0, a[1] | 0, a[2] | 0, a[3] | 0, a[4] >>> 0, a[5] >>> 0, a[6] >>> 0)),
        glCopyTexImage2D: a=>answer(current()?.glCopyTexImage2D(
            a[0] >>> 0, a[1] | 0, a[2] | 0, a[3] | 0, a[4] | 0, a[5] | 0, a[6] | 0, a[7] | 0)),
        glCopyTexImage1D: a=>answer(current()?.glCopyTexImage2D(
            a[0] >>> 0, a[1] | 0, a[2] | 0, a[3] | 0, a[4] | 0, a[5] | 0, 1, a[6] | 0)),
        glCopyTexSubImage2D: a=>answer(current()?.glCopyTexSubImage2D(
            a[0] >>> 0, a[1] | 0, a[2] | 0, a[3] | 0, a[4] | 0, a[5] | 0, a[6] | 0, a[7] | 0)),
        glCopyTexSubImage1D: a=>answer(current()?.glCopyTexSubImage2D(
            a[0] >>> 0, a[1] | 0, a[2] | 0, 0, a[3] | 0, a[4] | 0, a[5] | 0, 1)),
        glGetTexImage: ([target, level, format, type, out])=>call(context=>{
            const texels = context.glGetTexImage(target >>> 0, level | 0, format >>> 0, type >>> 0);
            const shape = texels && context.glGetTexLevelParameteriv(
                target >>> 0, level | 0, GL.TEXTURE_WIDTH);
            const height = texels && context.glGetTexLevelParameteriv(
                target >>> 0, level | 0, GL.TEXTURE_HEIGHT);
            if (texels && shape && height && (out >>> 0) !== 0)
            {
                const packed = packImage(texels, shape[0], height[0], format >>> 0, type >>> 0, {
                    alignment: context.glGetIntegerv(GL.PACK_ALIGNMENT)[0],
                    rowLength: context.glGetIntegerv(GL.PACK_ROW_LENGTH)[0],
                    skipRows: context.glGetIntegerv(GL.PACK_SKIP_ROWS)[0],
                    skipPixels: context.glGetIntegerv(GL.PACK_SKIP_PIXELS)[0],
                });
                if (packed)
                {
                    services.writeMemory(out >>> 0, packed);
                }
            }
        }),

        // --- GL_ARB_multitexture and the rest of the texture extensions ---

        glActiveTextureARB: ([unit])=>answer(current()?.glActiveTextureARB(unit >>> 0)),
        glClientActiveTextureARB: ([unit])=>
            answer(current()?.glClientActiveTextureARB(unit >>> 0)),
        glCompressedTexImage2DARB: a=>answer(current()?.glCompressedTexImage2DARB(
            a[0] >>> 0, a[1] | 0, a[2] >>> 0, a[3] | 0, a[4] | 0, a[5] | 0, a[6] | 0,
            a[7] >>> 0)),
        glCompressedTexSubImage2DARB: a=>answer(current()?.glCompressedTexSubImage2DARB(
            a[0] >>> 0, a[1] | 0, a[2] | 0, a[3] | 0, a[4] | 0, a[5] | 0, a[6] >>> 0, a[7] | 0,
            a[8] >>> 0)),
        glCompressedTexImage1DARB: a=>answer(current()?.glCompressedTexImage1DARB(a[0] >>> 0)),
        glCompressedTexImage3DARB: a=>answer(current()?.glCompressedTexImage3DARB(a[0] >>> 0)),
        glCompressedTexSubImage1DARB: a=>
            answer(current()?.glCompressedTexSubImage1DARB(a[0] >>> 0)),
        glCompressedTexSubImage3DARB: a=>
            answer(current()?.glCompressedTexSubImage3DARB(a[0] >>> 0)),
        glGetCompressedTexImageARB: ([target, level])=>
            answer(current()?.glGetCompressedTexImageARB(target >>> 0, level | 0)),

        // --- display lists ---

        glGenLists: ([count])=>current()?.glGenLists(count | 0) ?? 0,
        glNewList: ([name, mode])=>answer(current()?.glNewList(name >>> 0, mode >>> 0)),
        glEndList: ()=>answer(current()?.glEndList()),
        glCallList: ([name])=>answer(current()?.glCallList(name >>> 0)),
        glCallLists: ([count, type, lists])=>call(context=>{
            const letter = LIST_TYPES.get(type >>> 0);
            if (!letter)
            {
                // GL_2_BYTES and its siblings: big-endian runs of bytes.
                const width = (type >>> 0) - 0x1406;
                if (width < 1 || width > 4)
                {
                    return;
                }
                const bytes = services.readMemory(lists >>> 0, (count | 0) * width);
                const offsets = [];
                for (let i = 0; i < (count | 0); i++)
                {
                    let value = 0;
                    for (let k = 0; k < width; k++)
                    {
                        value = value * 256 + bytes[i * width + k];
                    }
                    offsets.push(value);
                }
                context.glCallLists(count | 0, offsets);
                return;
            }
            context.glCallLists(count | 0, readTyped(letter, lists, Math.max(0, count | 0)));
        }),
        glDeleteLists: ([first, count])=>
            answer(current()?.glDeleteLists(first >>> 0, count | 0)),
        glIsList: ([name])=>current()?.glIsList(name >>> 0) ?? GL.FALSE,
        glListBase: ([base])=>answer(current()?.glListBase(base >>> 0)),

        // --- immediate mode ---

        glBegin: ([mode])=>answer(current()?.glBegin(mode >>> 0)),
        glEnd: ()=>answer(current()?.glEnd()),
        glEdgeFlag: ([flag])=>answer(current()?.glEdgeFlag(asBoolean(flag))),
        glEdgeFlagv: ([address])=>
            answer(current()?.glEdgeFlag(services.readMemory(address >>> 0, 1)[0])),
        glFogCoordfEXT: ([coord])=>answer(current()?.glFogCoordfEXT(asFloat(coord))),
        glFogCoordfvEXT: ([address])=>
            answer(current()?.glFogCoordfEXT(readF32s(address, 1)[0])),
        glFogCoorddEXT: ([low, high])=>answer(current()?.glFogCoordfEXT(asDouble(low, high))),
        glFogCoorddvEXT: ([address])=>
            answer(current()?.glFogCoordfEXT(readF64s(address, 1)[0])),

        // --- vertex arrays ---

        glVertexPointer: ([size, type, stride, address])=>answer(
            current()?.glVertexPointer(size | 0, type >>> 0, stride | 0, address >>> 0)),
        glNormalPointer: ([type, stride, address])=>answer(
            current()?.glNormalPointer(type >>> 0, stride | 0, address >>> 0)),
        glColorPointer: ([size, type, stride, address])=>answer(
            current()?.glColorPointer(size | 0, type >>> 0, stride | 0, address >>> 0)),
        glIndexPointer: ([type, stride, address])=>answer(
            current()?.glIndexPointer(type >>> 0, stride | 0, address >>> 0)),
        glTexCoordPointer: ([size, type, stride, address])=>answer(
            current()?.glTexCoordPointer(size | 0, type >>> 0, stride | 0, address >>> 0)),
        glEdgeFlagPointer: ([stride, address])=>answer(
            current()?.glEdgeFlagPointer(stride | 0, address >>> 0)),
        glSecondaryColorPointerEXT: ([size, type, stride, address])=>answer(
            current()?.glSecondaryColorPointerEXT(size | 0, type >>> 0, stride | 0, address >>> 0)),
        glFogCoordPointerEXT: ([type, stride, address])=>answer(
            current()?.glFogCoordPointerEXT(type >>> 0, stride | 0, address >>> 0)),
        glEnableClientState: ([cap])=>answer(current()?.glEnableClientState(cap >>> 0)),
        glDisableClientState: ([cap])=>answer(current()?.glDisableClientState(cap >>> 0)),
        glInterleavedArrays: ([format, stride, address])=>answer(
            current()?.glInterleavedArrays(format >>> 0, stride | 0, address >>> 0)),
        glArrayElement: ([index])=>answer(current()?.glArrayElement(index | 0)),
        glDrawArrays: ([mode, first, count])=>
            answer(current()?.glDrawArrays(mode >>> 0, first | 0, count | 0)),
        glDrawElements: ([mode, count, type, indices])=>answer(
            current()?.glDrawElements(mode >>> 0, count | 0, type >>> 0, indices >>> 0)),
        glDrawRangeElementsEXT: ([mode, start, end, count, type, indices])=>answer(
            current()?.glDrawRangeElementsEXT(
                mode >>> 0, start >>> 0, end >>> 0, count | 0, type >>> 0, indices >>> 0)),
        glLockArraysEXT: ([first, count])=>
            answer(current()?.glLockArraysEXT(first | 0, count | 0)),
        glUnlockArraysEXT: ()=>answer(current()?.glUnlockArraysEXT()),

        // --- GL_ARB_vertex_buffer_object ---

        glGenBuffersARB: ([count, out])=>call(context=>{
            const names = context.glGenBuffersARB(count | 0);
            if (names.length > 0 && (out >>> 0) !== 0)
            {
                writeU32s(out, names);
            }
        }),
        glDeleteBuffersARB: ([count, list])=>answer(current()?.glDeleteBuffersARB(
            (count | 0) > 0 && (list >>> 0) !== 0 ? readU32s(list, count | 0) : [])),
        glBindBufferARB: ([target, name])=>
            answer(current()?.glBindBufferARB(target >>> 0, name >>> 0)),
        glIsBufferARB: ([name])=>current()?.glIsBufferARB(name >>> 0) ?? GL.FALSE,
        glBufferDataARB: ([target, size, data, usage])=>answer(
            current()?.glBufferDataARB(target >>> 0, size | 0, (data >>> 0) || null, usage >>> 0)),
        glBufferSubDataARB: ([target, offset, size, data])=>answer(
            current()?.glBufferSubDataARB(target >>> 0, offset | 0, size | 0, data >>> 0)),
        glGetBufferSubDataARB: ([target, offset, size, out])=>call(context=>{
            const bytes = context.glGetBufferSubDataARB(target >>> 0, offset | 0, size | 0);
            if (bytes && (out >>> 0) !== 0)
            {
                services.writeMemory(out >>> 0, bytes);
            }
        }),
        glMapBufferARB: ([target, access])=>
            answer(current()?.glMapBufferARB(target >>> 0, access >>> 0)),
        glUnmapBufferARB: ([target])=>answer(current()?.glUnmapBufferARB(target >>> 0)),
        glGetBufferParameterivARB: ([target, parameter, out])=>call(context=>writeQuery(
            out, context.glGetBufferParameterivARB(target >>> 0, parameter >>> 0), 'word')),
        glGetBufferPointervARB: ([target, parameter, out])=>call(context=>writeQuery(
            out, context.glGetBufferPointervARB(target >>> 0, parameter >>> 0), 'word')),

        // --- GL_ARB_vertex_program and GL_ARB_fragment_program ---

        glGenProgramsARB: ([count, out])=>call(context=>{
            const names = context.glGenProgramsARB(count | 0);
            if (names.length > 0 && (out >>> 0) !== 0)
            {
                writeU32s(out, names);
            }
        }),
        glDeleteProgramsARB: ([count, list])=>answer(current()?.glDeleteProgramsARB(
            (count | 0) > 0 && (list >>> 0) !== 0 ? readU32s(list, count | 0) : [])),
        glIsProgramARB: ([name])=>current()?.glIsProgramARB(name >>> 0) ?? GL.FALSE,
        glBindProgramARB: ([target, name])=>
            answer(current()?.glBindProgramARB(target >>> 0, name >>> 0)),
        glProgramStringARB: ([target, format, length, string])=>answer(
            current()?.glProgramStringARB(target >>> 0, format >>> 0, length | 0, string >>> 0)),

        glProgramEnvParameter4fARB: ([target, index, x, y, z, w])=>answer(
            current()?.glProgramEnvParameter4fARB(target >>> 0, index >>> 0,
                [asFloat(x), asFloat(y), asFloat(z), asFloat(w)])),
        glProgramEnvParameter4fvARB: ([target, index, address])=>answer(
            current()?.glProgramEnvParameter4fARB(target >>> 0, index >>> 0,
                readF32Vector(address, floatScratch4))),
        glProgramEnvParameter4dARB: a=>answer(current()?.glProgramEnvParameter4fARB(
            a[0] >>> 0, a[1] >>> 0,
            [asDouble(a[2], a[3]), asDouble(a[4], a[5]), asDouble(a[6], a[7]),
                asDouble(a[8], a[9])])),
        glProgramEnvParameter4dvARB: ([target, index, address])=>answer(
            current()?.glProgramEnvParameter4fARB(target >>> 0, index >>> 0, readF64s(address, 4))),
        glProgramLocalParameter4fARB: ([target, index, x, y, z, w])=>answer(
            current()?.glProgramLocalParameter4fARB(target >>> 0, index >>> 0,
                [asFloat(x), asFloat(y), asFloat(z), asFloat(w)])),
        glProgramLocalParameter4fvARB: ([target, index, address])=>answer(
            current()?.glProgramLocalParameter4fARB(target >>> 0, index >>> 0,
                readF32Vector(address, floatScratch4))),
        glProgramLocalParameter4dARB: a=>answer(current()?.glProgramLocalParameter4fARB(
            a[0] >>> 0, a[1] >>> 0,
            [asDouble(a[2], a[3]), asDouble(a[4], a[5]), asDouble(a[6], a[7]),
                asDouble(a[8], a[9])])),
        glProgramLocalParameter4dvARB: ([target, index, address])=>answer(
            current()?.glProgramLocalParameter4fARB(target >>> 0, index >>> 0,
                readF64s(address, 4))),

        glGetProgramEnvParameterfvARB: ([target, index, out])=>call(context=>writeQuery(
            out, context.glGetProgramEnvParameterfvARB(target >>> 0, index >>> 0), 'float')),
        glGetProgramEnvParameterdvARB: ([target, index, out])=>call(context=>writeQuery(
            out, context.glGetProgramEnvParameterfvARB(target >>> 0, index >>> 0), 'double')),
        glGetProgramLocalParameterfvARB: ([target, index, out])=>call(context=>writeQuery(
            out, context.glGetProgramLocalParameterfvARB(target >>> 0, index >>> 0), 'float')),
        glGetProgramLocalParameterdvARB: ([target, index, out])=>call(context=>writeQuery(
            out, context.glGetProgramLocalParameterfvARB(target >>> 0, index >>> 0), 'double')),
        glGetProgramivARB: ([target, pname, out])=>call(context=>writeQuery(
            out, context.glGetProgramivARB(target >>> 0, pname >>> 0), 'word')),
        glGetProgramStringARB: ([target, pname, out])=>call(context=>{
            const bytes = context.glGetProgramStringARB(target >>> 0, pname >>> 0);
            if (bytes && (out >>> 0) !== 0)
            {
                services.writeMemory(out >>> 0, bytes);
            }
        }),

        glVertexAttrib4NubARB: ([index, x, y, z, w])=>answer(
            current()?.glVertexAttrib4fARB(index >>> 0, (x & 0xff) / 255, (y & 0xff) / 255,
                (z & 0xff) / 255, (w & 0xff) / 255)),
        glVertexAttribPointerARB: ([index, size, type, normalised, stride, pointer])=>
            answer(current()?.glVertexAttribPointerARB(index >>> 0, size | 0, type >>> 0,
                asBoolean(normalised), stride | 0, pointer >>> 0)),
        glEnableVertexAttribArrayARB: ([index])=>
            answer(current()?.glEnableVertexAttribArrayARB(index >>> 0)),
        glDisableVertexAttribArrayARB: ([index])=>
            answer(current()?.glDisableVertexAttribArrayARB(index >>> 0)),
        glGetVertexAttribfvARB: ([index, pname, out])=>call(context=>writeQuery(
            out, context.glGetVertexAttribfvARB(index >>> 0, pname >>> 0), 'float')),
        glGetVertexAttribdvARB: ([index, pname, out])=>call(context=>writeQuery(
            out, context.glGetVertexAttribfvARB(index >>> 0, pname >>> 0), 'double')),
        glGetVertexAttribivARB: ([index, pname, out])=>call(context=>writeQuery(
            out, context.glGetVertexAttribfvARB(index >>> 0, pname >>> 0), 'word')),
        glGetVertexAttribPointervARB: ([index, pname, out])=>call(context=>writeQuery(
            out, context.glGetVertexAttribPointervARB(index >>> 0, pname >>> 0), 'word')),

        // --- the attribute stacks ---

        glPushAttrib: ([mask])=>answer(current()?.glPushAttrib(mask >>> 0)),
        glPopAttrib: ()=>answer(current()?.glPopAttrib()),
        glPushClientAttrib: ([mask])=>answer(current()?.glPushClientAttrib(mask >>> 0)),
        glPopClientAttrib: ()=>answer(current()?.glPopClientAttrib()),

        // --- pixels ---

        glReadPixels: ([x, y, width, height, format, type, out])=>call(context=>{
            const packed = context.glReadPixels(
                x | 0, y | 0, width | 0, height | 0, format >>> 0, type >>> 0);
            if (packed && (out >>> 0) !== 0)
            {
                services.writeMemory(out >>> 0, packed);
            }
        }),
        glDrawPixels: ([width, height, format, type, pixels])=>call(context=>{
            const unpack = unpackState(context);
            const needed = imageBytes(width | 0, height | 0, format >>> 0, type >>> 0, unpack);
            const texels = needed > 0 && (pixels >>> 0) !== 0
                ? unpackImage(services.readMemory(pixels >>> 0, needed), width | 0, height | 0,
                    format >>> 0, type >>> 0, unpack)
                : null;
            context.glDrawPixels(width | 0, height | 0, format >>> 0, type >>> 0, texels);
        }),
        glCopyPixels: ([x, y, width, height, type])=>answer(
            current()?.glCopyPixels(x | 0, y | 0, width | 0, height | 0, type >>> 0)),
        glBitmap: a=>answer(current()?.glBitmap(
            a[0] | 0, a[1] | 0, asFloat(a[2]), asFloat(a[3]), asFloat(a[4]), asFloat(a[5]))),
    };
    Object.assign(implemented, handlers);

    /**
     * The two calls here that may wait before they answer: a swap on the
     * device waits, once it is enough frames behind, for the oldest to
     * finish. Kept apart from `implemented` so that `entry` never hands one
     * out -- a caller already on this side of the boundary has no thread to
     * park.
     *
     * @type {Record<string, (args: number[]) => number | Promise<number>>}
     */
    const swaps = {
        wglSwapBuffers: ([hdc])=>{
            if (!wgl.SwapBuffers(hdc >>> 0))
            {
                return 0;
            }
            const held = presentCurrentFrame();
            return held ? held.then(()=>1) : 1;
        },

        /** The layer form, where layer bit 0 is the main plane. */
        wglSwapLayerBuffers: ([hdc, planes])=>{
            if ((planes & 1) === 0 || !wgl.SwapBuffers(hdc >>> 0))
            {
                return 0;
            }
            const held = presentCurrentFrame();
            return held ? held.then(()=>1) : 1;
        },
    };

    /** @param {number} address @returns {import('./pixelformat.js').PixelFormat} */
    function readDescriptor(address){
        return decodePixelFormat(
            services.readMemory(address >>> 0, PIXELFORMATDESCRIPTOR.SIZE));
    }

    /**
     * @type {Record<string, { argBytes: number,
     *     handler: (args: number[]) => number | Promise<number> }>}
     */
    const table = {};
    for (const [words, names] of Object.entries(ARGUMENT_WORDS))
    {
        for (const name of names)
        {
            table[name] = {
                argBytes: Number(words) * 4,
                handler: ()=>{
                    unimplemented.set(name, (unimplemented.get(name) ?? 0) + 1);
                    return 0;
                },
            };
        }
    }
    for (const [name, handler] of Object.entries({ ...implemented, ...swaps }))
    {
        if (!table[name])
        {
            // The two lists are the same specification seen twice, and a name
            // in one and not the other means the argument count was never
            // written down -- which is the failure this whole file exists to
            // prevent, so it is loud.
            throw new Error(`opengl: ${name} is implemented but its argument size is not declared`);
        }
        table[name].handler = handler;
    }
    // Every call into the host plays what the ring holds first, so that it
    // meets the context the program left.
    for (const entry of Object.values(table))
    {
        const handler = entry.handler;
        entry.handler = args=>{
            drain();
            return handler(args);
        };
    }

    return {
        table,

        /** The wgl object itself, for whoever needs it without the marshalling. */
        wgl,

        /** Which entry points do something, for the test that checks the extension promise. */
        implemented: [...Object.keys(implemented), ...Object.keys(swaps)],

        /**
         * Runs `body` with the calling thread's current context, for GLU32,
         * whose quadrics, images and matrices draw through it; null without
         * one.
         *
         * @template T
         * @param {(context: any) => T} body
         * @returns {T | null}
         */
        withContext(body){
            drain();
            const context = current();
            return context ? body(context) : null;
        },

        /**
         * A named entry point for a caller already on this side of the boundary
         * (a bundle's site kernel, through the assembling caller): the same handler
         * the trap table binds, taking the same raw dwords a guest call pushes --
         * a GLfloat as its bits, a GLdouble as two words low first, a pointer as a
         * guest address -- so a kernel that reads a pointer out of guest memory hands
         * it straight through. Null for a name this library does not implement,
         * and for the two swaps, which may wait.
         *
         * @param {string} name
         * @returns {((args: number[]) => number) | null}
         */
        entry: name=>(implemented[name]
            // The swaps, which may wait, are not among these.
            ? /** @type {(args: number[]) => number} */ (table[name].handler)
            : null),

        /**
         * Presenting a frame, for gdi32's spelling of it.
         *
         * `SwapBuffers` lives in GDI32 and `wglSwapBuffers` in OPENGL32, and
         * they are the same operation -- most programs call the GDI one. It has
         * to reach this runtime rather than a second one, or the frame it
         * presents is not the frame the program drew.
         *
         * @param {number} hdc
         * @returns {boolean | Promise<boolean>} whether it presented; a promise
         *     when the swap waits for the device before it answers
         */
        swapBuffers(hdc){
            drain();
            if (!wgl.SwapBuffers(hdc >>> 0))
            {
                return false;
            }
            const held = presentCurrentFrame();
            return held ? held.then(()=>true) : true;
        },

        /**
         * The pixel-format half of GDI, which gdi32 delegates to.
         *
         * These are opengl32's formats and gdi32's entry points: on Windows the
         * two are one negotiation, and a program that chooses through GDI and
         * creates a context through WGL has to be talking about the same list.
         */
        pixelFormat: {
            size: ()=>PIXELFORMATDESCRIPTOR.SIZE,
            count: ()=>PIXEL_FORMATS.length,
            /** @param {Uint8Array} bytes */
            choose: bytes=>choosePixelFormat(decodePixelFormat(bytes)),
            /** @param {number} index @param {number} bytes */
            describe: (index, bytes)=>{
                if (index < 1 || index > PIXEL_FORMATS.length || bytes <= 0)
                {
                    return null;
                }
                return encodePixelFormat(PIXEL_FORMATS[index - 1])
                    .subarray(0, Math.min(bytes, PIXELFORMATDESCRIPTOR.SIZE));
            },
            // The format a drawable carries is WGL's record: SetPixelFormat
            // through GDI32 and wglCreateContext through OPENGL32 read one
            // entry, so a format set through the first is found by the second.
            /** @param {number} hdc @param {number} index */
            set: (hdc, index)=>wgl.SetPixelFormat(hdc, index),
            /** @param {number} hdc */
            get: hdc=>wgl.GetPixelFormat(hdc),
        },

        diagnostics: ()=>({
            contexts: contexts.size,
            commandCalls: ringCalls,
            // What a program reached for and did not get is the most useful
            // thing this layer can say about a run that drew nothing.
            unimplemented: Object.fromEntries(unimplemented),
            gpu: onDevice && madeContext ? root.diagnostics() : null,
            compressed: `${compressedDigest.count}:${compressedDigest.bytes}:`
                + compressedDigest.hash.toString(16),
            images: imageDigests.slice(),
            imageTimes: imageTimes.slice(),
            kept: keptImages.images.map(image=>({ index: image.index, width: image.width,
                height: image.height, rgba: base64Of(image.texels) })),
        }),
    };
}

/** @param {Uint8Array} bytes @returns {string} */
function base64Of(bytes){
    let text = '';
    for (let at = 0; at < bytes.length; at += 0x8000)
    {
        text += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
    }
    return btoa(text);
}
