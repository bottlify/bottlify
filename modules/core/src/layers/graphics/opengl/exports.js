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
 * lists the whole of OpenGL 1.1 and all of WGL, and why the number beside each
 * group is the specification rather than a guess.
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
 * forgets is a call that reads an integer as a colour.
 *
 * ponytail: what is not implemented is answered with zero and counted, not
 * refused. Zero reads as failure under every convention a GL entry point uses
 * at once, and the count is what says which of them a program actually wanted.
 */

import { GL } from './constants.js';
import {
    choosePixelFormat, decodePixelFormat, encodePixelFormat, PIXEL_FORMATS,
    PIXELFORMATDESCRIPTOR,
} from './pixelformat.js';
import { createWgl } from './wgl.js';

/**
 * Every export of OPENGL32.dll, grouped by how many stack words it takes.
 *
 * Grouping rather than listing `name: count` pairs is deliberate: a
 * transcription slip inside a group is a name in the wrong group, which reads
 * as odd, where a slip in a pair reads as an ordinary number.
 *
 * @type {Readonly<Record<number, readonly string[]>>}
 */
export const ARGUMENT_WORDS = Object.freeze({
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

/** Where the handles this layer hands out start. Nothing else mints these. */
const HANDLE_BASE = 0x0e000000;

/** Scratch for reinterpreting words as the floating-point values they carry. */
const bits = new DataView(new ArrayBuffer(8));

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
 * @typedef {Object} OpenglServices
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {() => { width: number, height: number }} [screen]
 *           How big a drawable is, when nothing better can be asked.
 * @property {(hdc: number) => import('./wgl.js').DrawableInfo | null} [describeDrawable]
 *           What a device context names. Absent in a build with no GDI behind
 *           it, and then every non-null handle is its own drawable the size of
 *           the screen -- which is right for the one window a program of this
 *           era opens and wrong as soon as it opens two.
 * @property {() => number} [currentThread]
 * @property {(code: number) => void} [setLastError]
 * @property {{ allocate: (bytes: number) => number }} [scratch]
 *           Guest memory, for the two things that must live there: the strings
 *           glGetString answers with, and the frame SwapBuffers presents.
 * @property {(surface: any) => void} [present]
 *           Told when a frame has been swapped, with the colour buffer copied
 *           into guest memory for it to read.
 */

/**
 * @param {OpenglServices} services
 */
export function createOpengl(services){
    const screen = services.screen ?? (()=>({ width: 640, height: 480 }));
    const describeDrawable = services.describeDrawable ?? (
        /** @param {number} hdc */
        hdc=>((hdc >>> 0) === 0
            ? null
            : { key: `hdc:${hdc >>> 0}`, width: screen().width, height: screen().height }));

    const wgl = createWgl({
        gdi: { describeDrawable },
        currentThread: services.currentThread ?? (()=>0),
        setLastError: services.setLastError,
        memory: services,
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

    /** @type {Map<string, number>} what a program called that is not implemented */
    const unimplemented = new Map();

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

    /** @param {number} address @param {readonly number[]} values */
    const writeU32s = (address, values)=>{
        const bytes = new Uint8Array(values.length * 4);
        const view = new DataView(bytes.buffer);
        values.forEach((value, index)=>view.setUint32(index * 4, value >>> 0, true));
        services.writeMemory(address >>> 0, bytes);
    };

    /** @param {number} address @param {number} count @returns {number[]} */
    const readU32s = (address, count)=>{
        const bytes = services.readMemory(address >>> 0, count * 4);
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        return Array.from({ length: count }, (unused, index)=>view.getUint32(index * 4, true));
    };

    /** @param {number} address @param {number} count @returns {number[]} */
    const readF32s = (address, count)=>{
        const bytes = services.readMemory(address >>> 0, count * 4);
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        return Array.from({ length: count }, (unused, index)=>view.getFloat32(index * 4, true));
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
        const width = as === 'byte' ? 1 : as === 'double' ? 8 : 4;
        const bytes = new Uint8Array(values.length * width);
        const view = new DataView(bytes.buffer);
        values.forEach((value, index)=>{
            if (as === 'byte')
            {
                bytes[index] = value !== 0 ? 1 : 0;
            }
            else if (as === 'word')
            {
                view.setInt32(index * 4, value | 0, true);
            }
            else if (as === 'float')
            {
                view.setFloat32(index * 4, value, true);
            }
            else
            {
                view.setFloat64(index * 8, value, true);
            }
        });
        services.writeMemory(address >>> 0, bytes);
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
     */
    const presentCurrentFrame = ()=>{
        const context = current();
        if (!context || !services.present || !services.scratch)
        {
            return;
        }
        const frame = context.framebuffer;
        if (frame.bytes.length === 0)
        {
            return;
        }
        if (frameBytes < frame.bytes.length)
        {
            frameAddress = services.scratch.allocate(frame.bytes.length);
            frameBytes = frameAddress === 0 ? 0 : frame.bytes.length;
        }
        if (frameAddress === 0)
        {
            return;
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
    };

    /**
     * The handlers that do something. Everything else in `ARGUMENT_WORDS` gets
     * the counting stub, and a name here that is not there is a mistake in one
     * of the two lists -- which is checked rather than trusted, below.
     *
     * @type {Record<string, (args: number[]) => number>}
     */
    const implemented = {
        // --- WGL ---

        wglCreateContext: ([hdc])=>{
            const context = wgl.wglCreateContext(hdc >>> 0);
            return context ? handleFor(context) : 0;
        },

        wglDeleteContext: ([handle])=>{
            const context = contexts.get(handle >>> 0);
            if (!context || !wgl.wglDeleteContext(context))
            {
                return 0;
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
                return 0;
            }
            return wgl.wglMakeCurrent(hdc >>> 0, context ?? null) ? 1 : 0;
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

        // Null for everything, and that is the honest answer: this build
        // advertises no extensions, so there is no extension entry point to
        // hand out, and a core function must answer null here by contract.
        wglGetProcAddress: ()=>0,

        wglSwapBuffers: ([hdc])=>{
            if (!wgl.SwapBuffers(hdc >>> 0))
            {
                return 0;
            }
            presentCurrentFrame();
            return 1;
        },

        /** The layer form, where layer bit 0 is the main plane. */
        wglSwapLayerBuffers: ([hdc, planes])=>{
            if ((planes & 1) === 0 || !wgl.SwapBuffers(hdc >>> 0))
            {
                return 0;
            }
            presentCurrentFrame();
            return 1;
        },

        wglChoosePixelFormat: ([hdc, descriptor])=>((descriptor >>> 0) === 0
            ? 0
            : wgl.ChoosePixelFormat(hdc >>> 0, readDescriptor(descriptor))),

        wglSetPixelFormat: ([hdc, index])=>(wgl.SetPixelFormat(hdc >>> 0, index | 0) ? 1 : 0),

        wglGetPixelFormat: ([hdc])=>wgl.GetPixelFormat(hdc >>> 0),

        wglDescribePixelFormat: ([hdc, index, bytes, out])=>
            wgl.DescribePixelFormat(hdc >>> 0, index | 0, bytes >>> 0, out >>> 0),

        // --- the error flag and the strings ---

        glGetError: ()=>current()?.glGetError() ?? GL.NO_ERROR,

        glGetString: ([name])=>{
            const value = current()?.glGetString(name >>> 0);
            if (value == null || !services.scratch)
            {
                return 0;
            }
            const existing = strings.get(value);
            if (existing !== undefined)
            {
                return existing;
            }
            // The pointer has to stay valid for the life of the context, so
            // the string is written once and kept: a program stores what
            // glGetString gave it and parses it later.
            const encoded = new TextEncoder().encode(`${value}\0`);
            const address = services.scratch.allocate(encoded.length);
            if (address === 0)
            {
                return 0;
            }
            services.writeMemory(address, encoded);
            strings.set(value, address);
            return address;
        },

        // --- capabilities and queries ---

        glEnable: ([cap])=>call(context=>context.glEnable(cap >>> 0)),
        glDisable: ([cap])=>call(context=>context.glDisable(cap >>> 0)),
        glIsEnabled: ([cap])=>current()?.glIsEnabled(cap >>> 0) ?? GL.FALSE,

        glGetBooleanv: ([query, out])=>
            call(context=>writeQuery(out, context.glGetBooleanv(query >>> 0), 'byte')),
        glGetIntegerv: ([query, out])=>
            call(context=>writeQuery(out, context.glGetIntegerv(query >>> 0), 'word')),
        glGetFloatv: ([query, out])=>
            call(context=>writeQuery(out, context.glGetFloatv(query >>> 0), 'float')),
        glGetDoublev: ([query, out])=>
            call(context=>writeQuery(out, context.glGetFloatv(query >>> 0), 'double')),

        // --- the state a program sets before it draws ---

        glClear: ([mask])=>call(context=>context.glClear(mask >>> 0)),
        glClearColor: ([r, g, b, a])=>call(context=>
            context.glClearColor(asFloat(r), asFloat(g), asFloat(b), asFloat(a))),
        glClearDepth: ([low, high])=>call(context=>context.glClearDepth(asDouble(low, high))),
        glClearStencil: ([value])=>call(context=>context.glClearStencil(value | 0)),
        glBlendFunc: ([source, destination])=>
            call(context=>context.glBlendFunc(source >>> 0, destination >>> 0)),
        glDepthFunc: ([func])=>call(context=>context.glDepthFunc(func >>> 0)),
        glDepthMask: ([flag])=>call(context=>context.glDepthMask(flag >>> 0)),
        glColorMask: ([r, g, b, a])=>call(context=>context.glColorMask(r, g, b, a)),
        glCullFace: ([mode])=>call(context=>context.glCullFace(mode >>> 0)),
        glFrontFace: ([mode])=>call(context=>context.glFrontFace(mode >>> 0)),
        glShadeModel: ([mode])=>call(context=>context.glShadeModel(mode >>> 0)),
        glAlphaFunc: ([func, ref])=>call(context=>context.glAlphaFunc(func >>> 0, asFloat(ref))),
        glPixelStorei: ([parameter, value])=>
            call(context=>context.glPixelStorei(parameter >>> 0, value | 0)),
        glViewport: ([x, y, width, height])=>
            call(context=>context.glViewport(x | 0, y | 0, width | 0, height | 0)),
        glScissor: ([x, y, width, height])=>
            call(context=>context.glScissor(x | 0, y | 0, width | 0, height | 0)),
        glFlush: ()=>call(context=>context.glFlush()),
        glFinish: ()=>call(context=>context.glFinish()),

        // --- the matrix stacks ---

        glMatrixMode: ([mode])=>call(context=>context.glMatrixMode(mode >>> 0)),
        glPushMatrix: ()=>call(context=>context.glPushMatrix()),
        glPopMatrix: ()=>call(context=>context.glPopMatrix()),
        glLoadIdentity: ()=>call(context=>context.glLoadIdentity()),
        glLoadMatrixf: ([m])=>call(context=>context.glLoadMatrixf(readF32s(m, 16))),
        glMultMatrixf: ([m])=>call(context=>context.glMultMatrixf(readF32s(m, 16))),
        glTranslatef: ([x, y, z])=>
            call(context=>context.glTranslatef(asFloat(x), asFloat(y), asFloat(z))),
        glScalef: ([x, y, z])=>call(context=>
            context.glScalef(asFloat(x), asFloat(y), asFloat(z))),
        glRotatef: ([angle, x, y, z])=>call(context=>
            context.glRotatef(asFloat(angle), asFloat(x), asFloat(y), asFloat(z))),
        glOrtho: a=>call(context=>context.glOrtho(
            asDouble(a[0], a[1]), asDouble(a[2], a[3]), asDouble(a[4], a[5]),
            asDouble(a[6], a[7]), asDouble(a[8], a[9]), asDouble(a[10], a[11]))),
        glFrustum: a=>call(context=>context.glFrustum(
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
        glDeleteTextures: ([count, list])=>call(context=>context.glDeleteTextures(
            (count | 0) > 0 && (list >>> 0) !== 0 ? readU32s(list, count | 0) : [])),
        glBindTexture: ([target, name])=>
            call(context=>context.glBindTexture(target >>> 0, name >>> 0)),
        glIsTexture: ([name])=>current()?.glIsTexture(name >>> 0) ?? GL.FALSE,
        glTexParameteri: ([target, parameter, value])=>
            call(context=>context.glTexParameteri(target >>> 0, parameter >>> 0, value | 0)),
        glGetTexParameteriv: ([target, parameter, out])=>call(context=>writeQuery(
            out, context.glGetTexParameteriv(target >>> 0, parameter >>> 0), 'word')),
        // The pixels are the ninth argument and are not read: nothing here
        // samples a texture yet, and the level's shape is what a program reads
        // back and branches on.
        glTexImage2D: a=>call(context=>context.glTexImage2D(
            a[0] >>> 0, a[1] | 0, a[2] | 0, a[3] | 0, a[4] | 0, a[5] | 0, a[6] >>> 0, a[7] >>> 0)),

        // --- display lists ---

        glGenLists: ([count])=>current()?.glGenLists(count | 0) ?? 0,
        glNewList: ([name, mode])=>call(context=>context.glNewList(name >>> 0, mode >>> 0)),
        glEndList: ()=>call(context=>context.glEndList()),
        glCallList: ([name])=>call(context=>context.glCallList(name >>> 0)),
        glDeleteLists: ([first, count])=>
            call(context=>context.glDeleteLists(first >>> 0, count | 0)),
        glIsList: ([name])=>current()?.glIsList(name >>> 0) ?? GL.FALSE,
        glListBase: ([base])=>call(context=>context.glListBase(base >>> 0)),

        // --- immediate mode ---

        glBegin: ([mode])=>call(context=>context.glBegin(mode >>> 0)),
        glEnd: ()=>call(context=>context.glEnd()),
        glVertex2f: ([x, y])=>call(context=>context.glVertex2f(asFloat(x), asFloat(y))),
        glVertex3f: ([x, y, z])=>
            call(context=>context.glVertex3f(asFloat(x), asFloat(y), asFloat(z))),
        glVertex4f: ([x, y, z, w])=>call(context=>
            context.glVertex4f(asFloat(x), asFloat(y), asFloat(z), asFloat(w))),
        glColor3f: ([r, g, b])=>
            call(context=>context.glColor3f(asFloat(r), asFloat(g), asFloat(b))),
        glColor4f: ([r, g, b, a])=>call(context=>
            context.glColor4f(asFloat(r), asFloat(g), asFloat(b), asFloat(a))),
        glColor3ub: ([r, g, b])=>
            call(context=>context.glColor3ub(r & 0xff, g & 0xff, b & 0xff)),
        glColor4ub: ([r, g, b, a])=>
            call(context=>context.glColor4ub(r & 0xff, g & 0xff, b & 0xff, a & 0xff)),
        glNormal3f: ([x, y, z])=>
            call(context=>context.glNormal3f(asFloat(x), asFloat(y), asFloat(z))),
        glTexCoord2f: ([s, t])=>call(context=>context.glTexCoord2f(asFloat(s), asFloat(t))),
        glTexCoord3f: ([s, t, r])=>
            call(context=>context.glTexCoord3f(asFloat(s), asFloat(t), asFloat(r))),
        glTexCoord4f: ([s, t, r, q])=>call(context=>
            context.glTexCoord4f(asFloat(s), asFloat(t), asFloat(r), asFloat(q))),
        glEdgeFlag: ([flag])=>call(context=>context.glEdgeFlag(flag >>> 0)),
    };

    /**
     * A call that needs a current context. Without one it does nothing and
     * answers zero: GL leaves this undefined, and a program that gets here has
     * already lost track of its own context, so the useful behaviour is the
     * quiet one rather than a fault.
     *
     * @param {(context: any) => void} body
     * @returns {number}
     */
    function call(body){
        const context = current();
        if (!context)
        {
            return 0;
        }
        body(context);
        return 0;
    }

    /** @param {number} address @returns {import('./pixelformat.js').PixelFormat} */
    function readDescriptor(address){
        return decodePixelFormat(
            services.readMemory(address >>> 0, PIXELFORMATDESCRIPTOR.SIZE));
    }

    /** @type {Record<string, { argBytes: number, handler: (args: number[]) => number }>} */
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
    for (const [name, handler] of Object.entries(implemented))
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

    return {
        table,

        /** The wgl object itself, for whoever needs it without the marshalling. */
        wgl,

        /**
         * Presenting a frame, for gdi32's spelling of it.
         *
         * `SwapBuffers` lives in GDI32 and `wglSwapBuffers` in OPENGL32, and
         * they are the same operation -- most programs call the GDI one. It has
         * to reach this runtime rather than a second one, or the frame it
         * presents is not the frame the program drew.
         *
         * @param {number} hdc
         */
        swapBuffers(hdc){
            if (!wgl.SwapBuffers(hdc >>> 0))
            {
                return false;
            }
            presentCurrentFrame();
            return true;
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
        },

        diagnostics: ()=>({
            contexts: contexts.size,
            // What a program reached for and did not get is the most useful
            // thing this layer can say about a run that drew nothing.
            unimplemented: Object.fromEntries(unimplemented),
        }),
    };
}
