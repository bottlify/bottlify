/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The GL context: the state a program observes, and the draw that reads it.
 *
 * Four conventions run through this file and the files that extend it
 * (`context-*.js`, one per area of the API, each installing its entry points
 * on the same object through the same kernel):
 *
 * - **A call that fails sets an error and does nothing else.** No half-applied
 *   state, no output written. Programs poll `glGetError` in a loop and expect
 *   the state they read afterwards to be the state before the failed call.
 * - **Only one error is remembered.** The second error while one is pending is
 *   dropped, not queued; reading the flag clears it. So a program that polls
 *   after every call sees every error, and one that polls once a frame sees
 *   the first.
 * - **Everything that can be compiled into a display list goes through
 *   `enter`.** That one function decides three things at once: whether the
 *   call is legal between glBegin and glEnd, whether it is being recorded
 *   rather than run, and whether a recording call also runs. Scattering that
 *   decision across the entry points is how the two halves drift apart.
 * - **Objects live in the share group, state lives here.** Which texture is
 *   bound is this context's business; the texture itself is not.
 *
 * What a program passes as a pointer is read through the memory the context
 * was given, at the moment of the call -- never earlier, because a program
 * fills its arrays after setting the pointers, and never later, because a
 * display list keeps what the pointer held when it was compiled.
 */

import { GL } from './constants.js';
import { EXTENSION_FUNCTIONS } from './extensions.js';
import {
    copyOf, createMatrixStacks, frustum, identity, multiply, ortho, rotation, scaling,
    translation,
} from './matrix.js';
import { createShareGroup } from './objects.js';
import { createDefaultState, readState } from './state.js';
import { createFramebuffer, fillBox, fillDepth, toByte, wholeOf } from './raster.js';
import { CLIENT_BITS, SERVER_BITS, queriesSavedBy } from './attributes.js';
import { compare } from './pipeline.js';
import { installTextureCalls } from './context-textures.js';
import { installLightingCalls } from './context-lighting.js';
import { installArrayCalls } from './context-arrays.js';
import { installPixelCalls } from './context-pixels.js';
import { installProgramCalls } from './context-programs.js';
import { SHADER_CALLS_NOT_COMPILED, installShaderCalls } from './context-glsl.js';
import { FRAMEBUFFER_CALLS_NOT_COMPILED, installFramebufferCalls } from './context-framebuffers.js';
import { BLEND_FACTORS, CORE_CALLS_NOT_COMPILED, installCoreCalls } from './context-core.js';
import { createSceneBuilder } from './context-scene.js';
import { VIDEO_ADAPTER_NAME } from '../../win32/devices.js';
import { GL_COMMANDS } from './commands.js';

/** What this implementation answers glGetString with. */
const STRINGS = Object.freeze({
    [GL.VENDOR]: 'Bottlify Project',
    [GL.RENDERER]: VIDEO_ADAPTER_NAME,
    // The version is what the core entry points implement, every one of
    // them through wglGetProcAddress past 1.1; everything past it is
    // reported as an extension.
    [GL.VERSION]: '2.1',
    [GL.SHADING_LANGUAGE_VERSION]: '1.20',
});

/**
 * The calls that stay legal between glBegin and glEnd. Everything else is
 * GL_INVALID_OPERATION there -- and programs do violate this, which is exactly
 * why the rule has to be enforced rather than assumed.
 */
const ALLOWED_IN_BEGIN = new Set([
    'glVertex2f', 'glVertex3f', 'glVertex4f', 'glColor3f', 'glColor4f', 'glColor3ub',
    'glColor4ub', 'glNormal3f', 'glTexCoord2f', 'glTexCoord3f', 'glTexCoord4f', 'glEdgeFlag',
    'glIndexi', 'glMultiTexCoord4fARB', 'glSecondaryColor3fEXT', 'glFogCoordfEXT',
    'glVertexAttrib4fARB', 'glMaterialfv', 'glMaterialf', 'glCallList', 'glCallLists', 'glEnd',
]);

/** The bits glClear takes. Anything else in the mask is GL_INVALID_VALUE. */
const CLEAR_BITS = GL.COLOR_BUFFER_BIT | GL.DEPTH_BUFFER_BIT | GL.STENCIL_BUFFER_BIT
    | GL.ACCUM_BUFFER_BIT;

/**
 * The calls a display list never records. They are executed as they are
 * reached even while a list is open, because their answer is needed now and
 * would be meaningless later.
 */
const NOT_COMPILABLE = new Set([
    'glGetError', 'glGetBooleanv', 'glGetIntegerv', 'glGetFloatv', 'glGetString',
    'glGetPointerv', 'glGetTexParameteriv', 'glGetTexParameterfv', 'glGetTexLevelParameteriv',
    'glGetTexEnviv', 'glGetTexEnvfv', 'glGetTexGenfv', 'glGetTexImage', 'glGetLightfv',
    'glGetMaterialfv', 'glGetClipPlane', 'glIsEnabled', 'glIsTexture', 'glIsList',
    'glGenTextures', 'glGenLists', 'glDeleteTextures', 'glDeleteLists', 'glNewList',
    'glEndList', 'glPixelStorei', 'glFlush', 'glFinish', 'glReadPixels', 'glRenderMode',
    'glAreTexturesResident', 'glVertexPointer', 'glNormalPointer', 'glColorPointer',
    'glTexCoordPointer', 'glIndexPointer', 'glEdgeFlagPointer', 'glSecondaryColorPointerEXT',
    'glFogCoordPointerEXT', 'glInterleavedArrays', 'glEnableClientState',
    'glDisableClientState', 'glClientActiveTextureARB', 'glPushClientAttrib',
    'glPopClientAttrib', 'glGenBuffersARB', 'glBindBufferARB', 'glDeleteBuffersARB',
    'glIsBufferARB', 'glBufferDataARB', 'glBufferSubDataARB', 'glGetBufferSubDataARB',
    'glMapBufferARB', 'glUnmapBufferARB', 'glGetBufferParameterivARB',
    'glGetBufferPointervARB', 'glLockArraysEXT', 'glUnlockArraysEXT',
    'glGetCompressedTexImageARB',
    'glGenProgramsARB', 'glDeleteProgramsARB', 'glIsProgramARB', 'glBindProgramARB',
    'glProgramStringARB', 'glGetProgramivARB', 'glGetProgramStringARB',
    'glGetProgramEnvParameterfvARB', 'glGetProgramLocalParameterfvARB',
    'glVertexAttribPointerARB', 'glEnableVertexAttribArrayARB',
    'glDisableVertexAttribArrayARB', 'glGetVertexAttribfvARB', 'glGetVertexAttribPointervARB',
    ...SHADER_CALLS_NOT_COMPILED, ...FRAMEBUFFER_CALLS_NOT_COMPILED, ...CORE_CALLS_NOT_COMPILED,
]);

/** @type {Set<number>} */
const PRIMITIVE_MODES = new Set([
    GL.POINTS, GL.LINES, GL.LINE_LOOP, GL.LINE_STRIP, GL.TRIANGLES, GL.TRIANGLE_STRIP,
    GL.TRIANGLE_FAN, GL.QUADS, GL.QUAD_STRIP, GL.POLYGON,
]);

/** The matrix mode enumerants, and the stack each one names. */
const MATRIX_STACK_OF = Object.freeze({
    [GL.MODELVIEW]: 'modelview',
    [GL.PROJECTION]: 'projection',
    [GL.TEXTURE]: 'texture',
});

const MATRIX_QUERIES = Object.freeze({
    [GL.MODELVIEW_MATRIX]: 'modelview',
    [GL.PROJECTION_MATRIX]: 'projection',
    [GL.TEXTURE_MATRIX]: 'texture',
});
const STACK_DEPTH_QUERIES = Object.freeze({
    [GL.MODELVIEW_STACK_DEPTH]: 'modelview',
    [GL.PROJECTION_STACK_DEPTH]: 'projection',
    [GL.TEXTURE_STACK_DEPTH]: 'texture',
});

/** @type {Set<number>} */
export const COMPARE_FUNCTIONS = new Set([
    GL.NEVER, GL.LESS, GL.EQUAL, GL.LEQUAL, GL.GREATER, GL.NOTEQUAL, GL.GEQUAL, GL.ALWAYS,
]);

/** @type {Set<number>} */
const LOGIC_OPS = new Set([
    GL.CLEAR, GL.AND, GL.AND_REVERSE, GL.COPY, GL.AND_INVERTED, GL.NOOP, GL.XOR, GL.OR, GL.NOR,
    GL.EQUIV, GL.INVERT, GL.OR_REVERSE, GL.COPY_INVERTED, GL.OR_INVERTED, GL.NAND, GL.SET,
]);

/** @type {Set<number>} */
const STENCIL_OPS = new Set([
    GL.KEEP, GL.ZERO, GL.REPLACE, GL.INCR, GL.DECR, GL.INVERT, GL.INCR_WRAP, GL.DECR_WRAP,
]);

/**
 * GL_EXT_stencil_two_side: the extension defines no `BACK_*` tokens of its
 * own, so an unsuffixed query answers whichever face `glActiveStencilFaceEXT`
 * has selected, and this layer's own `GL_STENCIL_BACK_*` storage is where
 * that answer lives when the selection is `GL_BACK`.
 *
 * @type {Map<number, number>}
 */
const STENCIL_FACE_QUERIES = new Map([
    [GL.STENCIL_FUNC, GL.STENCIL_BACK_FUNC],
    [GL.STENCIL_REF, GL.STENCIL_BACK_REF],
    [GL.STENCIL_VALUE_MASK, GL.STENCIL_BACK_VALUE_MASK],
    [GL.STENCIL_FAIL, GL.STENCIL_BACK_FAIL],
    [GL.STENCIL_PASS_DEPTH_FAIL, GL.STENCIL_BACK_PASS_DEPTH_FAIL],
    [GL.STENCIL_PASS_DEPTH_PASS, GL.STENCIL_BACK_PASS_DEPTH_PASS],
    [GL.STENCIL_WRITEMASK, GL.STENCIL_BACK_WRITEMASK],
]);

/** @type {Set<number>} */
const HINTS = new Set([
    GL.PERSPECTIVE_CORRECTION_HINT, GL.POINT_SMOOTH_HINT, GL.LINE_SMOOTH_HINT,
    GL.POLYGON_SMOOTH_HINT, GL.FOG_HINT, GL.GENERATE_MIPMAP_HINT, GL.TEXTURE_COMPRESSION_HINT,
    GL.FRAGMENT_SHADER_DERIVATIVE_HINT,
]);

/** @type {Set<number>} */
const HINT_MODES = new Set([GL.DONT_CARE, GL.FASTEST, GL.NICEST]);

/** @type {Set<number>} */
const FACES = new Set([GL.FRONT, GL.BACK, GL.FRONT_AND_BACK]);

/** @type {Set<number>} */
const POLYGON_MODES = new Set([GL.POINT, GL.LINE, GL.FILL]);

/** @type {Set<number>} */
const RENDER_MODES = new Set([GL.RENDER, GL.SELECT, GL.FEEDBACK]);

/** @type {Set<number>} */
const BUFFERS = new Set([
    GL.NONE, GL.FRONT_LEFT, GL.FRONT_RIGHT, GL.BACK_LEFT, GL.BACK_RIGHT, GL.FRONT, GL.BACK,
    GL.LEFT, GL.RIGHT, GL.FRONT_AND_BACK, GL.AUX0,
]);

/** @type {Set<number>} */
const PIXEL_STORE_PARAMETERS = new Set([
    GL.UNPACK_ALIGNMENT, GL.UNPACK_ROW_LENGTH, GL.UNPACK_SKIP_ROWS, GL.UNPACK_SKIP_PIXELS,
    GL.UNPACK_SWAP_BYTES, GL.UNPACK_LSB_FIRST, GL.PACK_ALIGNMENT, GL.PACK_ROW_LENGTH,
    GL.PACK_SKIP_ROWS, GL.PACK_SKIP_PIXELS, GL.PACK_SWAP_BYTES, GL.PACK_LSB_FIRST,
]);

/** How many pushes the attribute stacks take. */
const ATTRIB_STACK_LIMIT = 16;

/** What `submittedPrimitives` answers for a context that keeps none. */
const NOTHING_KEPT = Object.freeze(/** @type {{ mode: number, vertices: any[] }[]} */ ([]));

/**
 * @typedef {Object} Drawable
 * @property {number} width
 * @property {number} height
 * @property {boolean} doubleBuffered
 * @property {number} [depthBits]
 */

/** @typedef {import('./kernel.js').ContextMemory} ContextMemory */

/**
 * @typedef {Object} GlContextOptions
 * @property {ReturnType<typeof createShareGroup>} [shareGroup]
 * @property {readonly string[]} [extensions]  what glGetString(GL_EXTENSIONS) reports
 * @property {ContextMemory} [memory]
 * @property {(detail: string) => void} [divergence]
 *           Told, once per distinct message, when a call was accepted but
 *           its effect is not what the real API would have had.
 * @property {ReturnType<typeof import('./gpu.js').createGpuRenderer>} [gpu]
 *           A renderer that draws on a device. With one, the processor
 *           pipeline is not run and the framebuffer here holds nothing;
 *           without one, every draw lands in `framebuffer`.
 * @property {boolean} [raster]
 *           `false` leaves a primitive drawn on the processor unrasterised:
 *           every call still does its state work and a draw still reads its
 *           scene, but nothing reaches `framebuffer`. A diagnostic for a run
 *           without a device that measures something other than the
 *           rasteriser; a context with a `gpu` never rasterises either way.
 * @property {boolean} [keepTexels]
 *           `false` keeps no texels and no compressed blocks of a texture's
 *           levels, only their shapes: a context whose twin elsewhere draws
 *           has the data sent there with each call and never reads it again.
 *           Such a context reads a level back (glGetTexImage) as black.
 * @property {boolean} [keepPrimitives]
 *           Every primitive drawn is kept, with its vertices, for
 *           `submittedPrimitives` to answer -- what a test reads back to see
 *           what was assembled. Off unless asked for: nothing else reads it,
 *           and kept, it grows by every draw's vertices for as long as the
 *           program runs, where otherwise they are garbage once drawn.
 */

/** @typedef {import('./kernel.js').ContextKernel} ContextKernel */

/**
 * @param {GlContextOptions} [options]
 */
export function createGlContext(options = {}){
    let shareGroup = options.shareGroup ?? createShareGroup();
    shareGroup.contexts++;
    const extensions = [...(options.extensions ?? [])];
    const memory = options.memory ?? null;
    const gpu = options.gpu ?? null;
    const raster = options.raster !== false;

    let attached = false;
    let state = createDefaultState({ width: 0, height: 0, doubleBuffered: false });
    let framebuffer = createFramebuffer(0, 0);

    /** @type {number} */
    let error = GL.NO_ERROR;
    let destroyed = false;

    const stacks = createMatrixStacks();
    /** @type {number} */
    let matrixMode = GL.MODELVIEW;

    /** @type {import('./objects.js').DisplayList | null} */
    let compiling = null;
    /** @type {number} */
    let compileMode = GL.COMPILE;
    let listNesting = 0;

    /** @type {{ mode: number, vertices: any[] } | null} */
    let primitive = null;
    /** @type {{ mode: number, vertices: any[] }[] | null} */
    const kept = options.keepPrimitives ? [] : null;

    /** @type {any[]} */
    const attribStack = [];
    /** @type {any[]} */
    const clientAttribStack = [];

    /** @type {Set<string>} */
    const diverged = new Set();

    /** @param {number} code */
    const setError = code=>{
        if (error === GL.NO_ERROR)
        {
            error = code;
        }
    };

    /** @param {number} query @returns {import('./state.js').StateRecord} */
    const record = query=>{
        return /** @type {any} */ (state.get(query));
    };

    /** @param {number} query @param {number[]} values */
    const setState = (query, values)=>{
        record(query).values = values;
    };

    /** @param {string} detail */
    const diverge = detail=>{
        if (!diverged.has(detail))
        {
            diverged.add(detail);
            options.divergence?.(detail);
        }
    };

    /**
     * The one place that decides whether a call runs, is recorded, or is
     * refused outright.
     *
     * @param {string} name
     * @param {any[]} args
     * @returns {boolean} whether the caller should do its work
     */
    const enter = (name, args)=>{
        if (primitive && !ALLOWED_IN_BEGIN.has(name))
        {
            setError(GL.INVALID_OPERATION);
            return false;
        }
        if (compiling && !NOT_COMPILABLE.has(name))
        {
            // A list replays these arguments later, once the call that
            // supplied them has long since moved on to the next one -- a
            // caller that hands over a scratch it reuses on its next call
            // (the fixed-count vector readers do, for a program parameter or
            // a matrix) must not have this call's copy overwritten by that
            // one before the list is ever played back.
            compiling.commands.push({
                call: name,
                args: args.map(/** @param {any} arg */ arg=>(
                    arg instanceof Float32Array || arg instanceof Float64Array)
                    ? arg.slice() : arg),
            });
            return compileMode === GL.COMPILE_AND_EXECUTE;
        }
        return true;
    };

    /** @type {ContextKernel} */
    const kernel = {
        enter,
        setError,
        record,
        setState,
        diverge,
        shareGroup: ()=>shareGroup,
        memory: ()=>memory,
        framebuffer: ()=>framebuffer,
        inPrimitive: ()=>primitive !== null,
        scissorBox,
        stacks,
        drawVertices,
        // A draw by arrays reaches the device unless it is being compiled
        // into a list -- a list holds vertices, not pointers -- or refused by
        // the renderer for a shape it cannot bind. A lit one too: the
        // device's vertex stage lights it (`wgsl.js` lightingFunction), where
        // assembling and lighting each vertex here held the program's thread
        // on every draw.
        drawArrays: gpu
            ? request=>(compiling || !attached
                ? false
                : gpu.drawArrays(context, request, scenes.scene))
            : null,
        generateMipmap: gpu
            ? texture=>{
                if (attached)
                {
                    gpu.generateMipmap?.(context, texture);
                }
            }
            : null,
        blit: gpu
            ? request=>{
                if (attached)
                {
                    gpu.blit?.(context, request, scenes.scene());
                }
            }
            : null,
        copyToTexture: gpu
            ? (texture, level, face, xoffset, yoffset, x, y, width, height)=>
                gpu.copyToTexture(context, texture, level, face, xoffset, yoffset, x, y,
                    width, height, kernel.side.readFramebuffer?.() ?? null)
            : null,
        bufferDeleted: gpu ? buffer=>gpu.releaseBuffer(buffer) : null,
        gpuBacked: ()=>gpu !== null && attached,
        keepTexels: options.keepTexels !== false,
        currentVertex,
        currentAttributes,
        side: {},
    };

    const context = {
        get shareGroup(){
            return shareGroup;
        },
        get destroyed(){
            return destroyed;
        },
        /**
         * Every primitive drawn, in order, as glBegin/glEnd or an array draw
         * assembled it -- under `keepPrimitives`; without it, nothing.
         */
        get submittedPrimitives(){
            return kept ?? NOTHING_KEPT;
        },
        get currentPrimitive(){
            return primitive;
        },
        /** The colour buffer as it stands. BGRX, row zero at the top. */
        get framebuffer(){
            return framebuffer;
        },
        /** For the installers' tests: the kernel's side state. */
        get side(){
            return kernel.side;
        },

        /**
         * Binds the context to a drawable. The viewport and scissor box are
         * the drawable's dimensions **at the first attachment** and are not
         * touched by a later one -- a program that makes a context current on
         * a second, differently sized window keeps the viewport it had.
         *
         * @param {Drawable} drawable
         */
        attach(drawable){
            if (attached)
            {
                return;
            }
            attached = true;
            state = createDefaultState(drawable);
            if (gpu)
            {
                gpu.attach(context, drawable);
                // The size without the pixels: the scissor and the viewport
                // are measured against it, and the pixels are on the device.
                framebuffer = { ...createFramebuffer(0, 0), width: drawable.width,
                    height: drawable.height };
                return;
            }
            framebuffer = createFramebuffer(drawable.width, drawable.height,
                { depth: (drawable.depthBits ?? 0) > 0 });
        },

        /** @param {ReturnType<typeof createShareGroup>} group */
        adoptShareGroup(group){
            shareGroup.contexts--;
            shareGroup = group;
            shareGroup.contexts++;
        },

        /**
         * Shares the objects of another context's group from here on: the
         * group is named by the context that holds it, so that a recorded
         * call carries a context rather than the group's every object.
         *
         * @param {{ shareGroup: ReturnType<typeof createShareGroup> }} source
         */
        shareLists(source){
            context.adoptShareGroup(source.shareGroup);
        },

        destroy(){
            destroyed = true;
            shareGroup.contexts--;
        },

        /**
         * The calls a run of the command ring carried, made in order
         * (`commands.js`). None of them answers anything, so only a record
         * the routines could not have written is worth saying.
         *
         * @param {Uint8Array} records
         * @returns {number} how many calls were made
         */
        commands(records){
            return GL_COMMANDS.runCommands(context, records, [], name=>{
                if (name === 'commands')
                {
                    options.divergence?.('a command ring held a record its routines could not'
                        + ' have written');
                }
            });
        },

        // --- the error flag ---

        glGetError(){
            const code = error;
            error = GL.NO_ERROR;
            return code;
        },

        // --- capabilities ---

        /** @param {number} cap */
        glEnable(cap){
            setEnabled('glEnable', cap, 1);
        },

        /** @param {number} cap */
        glDisable(cap){
            setEnabled('glDisable', cap, 0);
        },

        /** @param {number} cap @returns {number} GL_TRUE or GL_FALSE */
        glIsEnabled(cap){
            if (!enter('glIsEnabled', [cap]))
            {
                return GL.FALSE;
            }
            const values = kernel.side.unitValue(cap) ?? state.get(cap)?.values;
            if (!values || state.get(cap)?.kind !== 'bool')
            {
                setError(GL.INVALID_ENUM);
                return GL.FALSE;
            }
            return values[0] !== 0 ? GL.TRUE : GL.FALSE;
        },

        // --- typed queries ---

        /** @param {number} query @returns {number[] | null} */
        glGetBooleanv(query){
            return context.getTyped(query, 'bool');
        },

        /** @param {number} query @returns {number[] | null} */
        glGetIntegerv(query){
            return context.getTyped(query, 'int');
        },

        /** @param {number} query @returns {number[] | null} */
        glGetFloatv(query){
            return context.getTyped(query, 'float');
        },

        /**
         * @param {number} query
         * @param {'bool' | 'int' | 'float'} as
         * @returns {number[] | null} null when the query is not one, and then
         *          the caller's buffer stays untouched
         */
        getTyped(query, as){
            if (!enter('glGetIntegerv', [query]))
            {
                return null;
            }
            const matrix = /** @type {any} */ (MATRIX_QUERIES)[query];
            if (matrix)
            {
                // Copied by index: spreading a typed array walks its iterator,
                // several times the cost of the sixteen loads.
                const current = stacks[matrix].current;
                /** @type {number[]} */
                const values = new Array(current.length);
                for (let i = 0; i < current.length; i++)
                {
                    values[i] = current[i];
                }
                return readState({ kind: 'float', values }, as);
            }
            const depth = /** @type {any} */ (STACK_DEPTH_QUERIES)[query];
            if (depth)
            {
                return readState({ kind: 'int', values: [stacks[depth].saved.length + 1] }, as);
            }
            const entry = state.get(query);
            if (!entry)
            {
                setError(GL.INVALID_ENUM);
                return null;
            }
            const perUnit = kernel.side.unitValue(query);
            if (perUnit)
            {
                return readState({ ...entry, values: perUnit }, as);
            }
            const backQuery = STENCIL_FACE_QUERIES.get(query);
            const active = backQuery && record(GL.ACTIVE_STENCIL_FACE_EXT).values[0] === GL.BACK
                ? record(backQuery) : entry;
            return readState(active, as);
        },

        /** @param {number} name @returns {string | null} */
        glGetString(name){
            if (!enter('glGetString', [name]))
            {
                return null;
            }
            if (name === GL.EXTENSIONS)
            {
                return extensions.join(' ');
            }
            if (name === GL.PROGRAM_ERROR_STRING_ARB)
            {
                return kernel.side.programErrorString();
            }
            const value = /** @type {any} */ (STRINGS)[name];
            if (value === undefined)
            {
                setError(GL.INVALID_ENUM);
                return null;
            }
            return value;
        },

        /** @param {number} target @param {number} mode */
        glHint(target, mode){
            if (!enter('glHint', [target, mode]))
            {
                return;
            }
            if (!HINTS.has(target) || !HINT_MODES.has(mode))
            {
                setError(GL.INVALID_ENUM);
                return;
            }
            setState(target, [mode]);
        },

        // --- the state a program sets before it draws ---

        /**
         * @param {number} red
         * @param {number} green
         * @param {number} blue
         * @param {number} alpha
         */
        glClearColor(red, green, blue, alpha){
            if (enter('glClearColor', [red, green, blue, alpha]))
            {
                setState(GL.COLOR_CLEAR_VALUE, [red, green, blue, alpha].map(clamp01));
            }
        },

        /** @param {number} depth */
        glClearDepth(depth){
            if (enter('glClearDepth', [depth]))
            {
                setState(GL.DEPTH_CLEAR_VALUE, [clamp01(depth)]);
            }
        },

        /** @param {number} value */
        glClearStencil(value){
            if (enter('glClearStencil', [value]))
            {
                setState(GL.STENCIL_CLEAR_VALUE, [value | 0]);
            }
        },

        /**
         * @param {number} red
         * @param {number} green
         * @param {number} blue
         * @param {number} alpha
         */
        glClearAccum(red, green, blue, alpha){
            if (enter('glClearAccum', [red, green, blue, alpha]))
            {
                setState(GL.ACCUM_CLEAR_VALUE, [red, green, blue, alpha].map(clamp01));
            }
        },

        /**
         * The colour and depth buffers are cleared; there is no stencil or
         * accumulation storage, so naming those bits is accepted and does
         * nothing. A bit outside the four is GL_INVALID_VALUE -- not
         * GL_INVALID_ENUM, because the argument is a mask.
         *
         * @param {number} mask
         */
        glClear(mask){
            if (!enter('glClear', [mask]))
            {
                return;
            }
            if ((mask & ~CLEAR_BITS) !== 0)
            {
                setError(GL.INVALID_VALUE);
                return;
            }
            if (!kernel.side.drawComplete())
            {
                setError(GL.INVALID_FRAMEBUFFER_OPERATION);
                return;
            }
            const box = scissorBox();
            if (gpu && attached)
            {
                gpu.clear(context, {
                    target: kernel.side.drawTarget(),
                    mask,
                    colour: record(GL.COLOR_CLEAR_VALUE).values,
                    depth: record(GL.DEPTH_CLEAR_VALUE).values[0],
                    stencil: record(GL.STENCIL_CLEAR_VALUE).values[0],
                    colourMask: record(GL.COLOR_WRITEMASK).values.map(value=>value !== 0),
                    depthMask: record(GL.DEPTH_WRITEMASK).values[0] !== 0,
                    stencilMask: record(GL.STENCIL_WRITEMASK).values[0],
                    scissor: box,
                });
                return;
            }
            if (mask & GL.COLOR_BUFFER_BIT)
            {
                fillBox(framebuffer, record(GL.COLOR_CLEAR_VALUE).values.map(toByte), box,
                    record(GL.COLOR_WRITEMASK).values.map(value=>value !== 0));
            }
            if ((mask & GL.DEPTH_BUFFER_BIT) && record(GL.DEPTH_WRITEMASK).values[0] !== 0)
            {
                fillDepth(framebuffer, record(GL.DEPTH_CLEAR_VALUE).values[0], box);
            }
        },

        /**
         * Nothing is deferred here, so both are already true when they are
         * called. They stay entry points because a program calls them to make
         * a frame appear and would otherwise reach a stub.
         */
        glFlush(){
            enter('glFlush', []);
        },

        glFinish(){
            enter('glFinish', []);
        },

        /** @param {number} source @param {number} destination */
        glBlendFunc(source, destination){
            if (!enter('glBlendFunc', [source, destination]))
            {
                return;
            }
            // GL_SRC_ALPHA_SATURATE is a source factor only; as a destination
            // it is not a factor at all, which is an enum error rather than a
            // silently ignored one.
            if (!BLEND_FACTORS.has(source) || !BLEND_FACTORS.has(destination)
                || destination === GL.SRC_ALPHA_SATURATE)
            {
                setError(GL.INVALID_ENUM);
                return;
            }
            setState(GL.BLEND_SRC, [source]);
            setState(GL.BLEND_DST, [destination]);
            setState(GL.BLEND_SRC_RGB, [source]);
            setState(GL.BLEND_DST_RGB, [destination]);
            setState(GL.BLEND_SRC_ALPHA, [source]);
            setState(GL.BLEND_DST_ALPHA, [destination]);
        },

        /** @param {number} func */
        glDepthFunc(func){
            setEnum('glDepthFunc', GL.DEPTH_FUNC, func, COMPARE_FUNCTIONS);
        },

        /** @param {number} flag */
        glDepthMask(flag){
            if (enter('glDepthMask', [flag]))
            {
                setState(GL.DEPTH_WRITEMASK, [flag ? 1 : 0]);
            }
        },

        /** @param {number} near @param {number} far */
        glDepthRange(near, far){
            if (enter('glDepthRange', [near, far]))
            {
                setState(GL.DEPTH_RANGE, [clamp01(near), clamp01(far)]);
            }
        },

        /**
         * @param {number} red
         * @param {number} green
         * @param {number} blue
         * @param {number} alpha
         */
        glColorMask(red, green, blue, alpha){
            if (enter('glColorMask', [red, green, blue, alpha]))
            {
                setState(GL.COLOR_WRITEMASK,
                    [red ? 1 : 0, green ? 1 : 0, blue ? 1 : 0, alpha ? 1 : 0]);
            }
        },

        /** @param {number} mode */
        glCullFace(mode){
            setEnum('glCullFace', GL.CULL_FACE_MODE, mode, FACES);
        },

        /** @param {number} mode */
        glFrontFace(mode){
            setEnum('glFrontFace', GL.FRONT_FACE, mode, new Set([GL.CW, GL.CCW]));
        },

        /** @param {number} mode */
        glShadeModel(mode){
            setEnum('glShadeModel', GL.SHADE_MODEL, mode, new Set([GL.FLAT, GL.SMOOTH]));
        },

        /** @param {number} opcode */
        glLogicOp(opcode){
            setEnum('glLogicOp', GL.LOGIC_OP_MODE, opcode, LOGIC_OPS);
        },

        /** @param {number} func @param {number} ref */
        glAlphaFunc(func, ref){
            if (!enter('glAlphaFunc', [func, ref]))
            {
                return;
            }
            if (!COMPARE_FUNCTIONS.has(func))
            {
                setError(GL.INVALID_ENUM);
                return;
            }
            setState(GL.ALPHA_TEST_FUNC, [func]);
            setState(GL.ALPHA_TEST_REF, [clamp01(ref)]);
        },

        /** @param {number} func @param {number} ref @param {number} mask */
        glStencilFunc(func, ref, mask){
            if (!enter('glStencilFunc', [func, ref, mask]))
            {
                return;
            }
            if (!COMPARE_FUNCTIONS.has(func))
            {
                setError(GL.INVALID_ENUM);
                return;
            }
            setStencilFace(GL.STENCIL_FUNC, GL.STENCIL_BACK_FUNC, [func]);
            setStencilFace(GL.STENCIL_REF, GL.STENCIL_BACK_REF, [ref | 0]);
            setStencilFace(GL.STENCIL_VALUE_MASK, GL.STENCIL_BACK_VALUE_MASK, [mask >>> 0]);
        },

        /** @param {number} fail @param {number} zfail @param {number} zpass */
        glStencilOp(fail, zfail, zpass){
            if (!enter('glStencilOp', [fail, zfail, zpass]))
            {
                return;
            }
            if (!STENCIL_OPS.has(fail) || !STENCIL_OPS.has(zfail) || !STENCIL_OPS.has(zpass))
            {
                setError(GL.INVALID_ENUM);
                return;
            }
            setStencilFace(GL.STENCIL_FAIL, GL.STENCIL_BACK_FAIL, [fail]);
            setStencilFace(GL.STENCIL_PASS_DEPTH_FAIL, GL.STENCIL_BACK_PASS_DEPTH_FAIL, [zfail]);
            setStencilFace(GL.STENCIL_PASS_DEPTH_PASS, GL.STENCIL_BACK_PASS_DEPTH_PASS, [zpass]);
        },

        /** @param {number} mask */
        glStencilMask(mask){
            if (enter('glStencilMask', [mask]))
            {
                setStencilFace(GL.STENCIL_WRITEMASK, GL.STENCIL_BACK_WRITEMASK, [mask >>> 0]);
            }
        },

        /**
         * GL_EXT_stencil_two_side: which face `glStencilFunc`/`glStencilOp`/
         * `glStencilMask` write to while GL_STENCIL_TEST_TWO_SIDE_EXT is on.
         *
         * @param {number} face
         */
        glActiveStencilFaceEXT(face){
            if (!enter('glActiveStencilFaceEXT', [face]))
            {
                return;
            }
            if (face !== GL.FRONT && face !== GL.BACK)
            {
                setError(GL.INVALID_ENUM);
                return;
            }
            setState(GL.ACTIVE_STENCIL_FACE_EXT, [face]);
        },

        /** @param {number} face @param {number} mode */
        glPolygonMode(face, mode){
            if (!enter('glPolygonMode', [face, mode]))
            {
                return;
            }
            if (!FACES.has(face) || !POLYGON_MODES.has(mode))
            {
                setError(GL.INVALID_ENUM);
                return;
            }
            const [front, back] = record(GL.POLYGON_MODE).values;
            setState(GL.POLYGON_MODE, [
                face === GL.BACK ? front : mode,
                face === GL.FRONT ? back : mode,
            ]);
        },

        /** @param {number} factor @param {number} units */
        glPolygonOffset(factor, units){
            if (enter('glPolygonOffset', [factor, units]))
            {
                setState(GL.POLYGON_OFFSET_FACTOR, [factor]);
                setState(GL.POLYGON_OFFSET_UNITS, [units]);
            }
        },

        /** @param {number} width */
        glLineWidth(width){
            setPositive('glLineWidth', GL.LINE_WIDTH, width);
        },

        /** @param {number} size */
        glPointSize(size){
            setPositive('glPointSize', GL.POINT_SIZE, size);
        },

        /** @param {number} factor @param {number} pattern */
        glLineStipple(factor, pattern){
            if (enter('glLineStipple', [factor, pattern]))
            {
                setState(GL.LINE_STIPPLE_REPEAT, [Math.min(256, Math.max(1, factor | 0))]);
                setState(GL.LINE_STIPPLE_PATTERN, [pattern & 0xffff]);
            }
        },

        /** @param {number} parameter @param {number} value */
        glPixelStorei(parameter, value){
            if (!enter('glPixelStorei', [parameter, value]))
            {
                return;
            }
            const entry = state.get(parameter);
            if (!entry || !PIXEL_STORE_PARAMETERS.has(parameter))
            {
                setError(GL.INVALID_ENUM);
                return;
            }
            if (parameter === GL.UNPACK_ALIGNMENT || parameter === GL.PACK_ALIGNMENT)
            {
                if (![1, 2, 4, 8].includes(value))
                {
                    setError(GL.INVALID_VALUE);
                    return;
                }
            }
            else if (entry.kind === 'int' && value < 0)
            {
                setError(GL.INVALID_VALUE);
                return;
            }
            entry.values = [entry.kind === 'bool' ? (value ? 1 : 0) : value];
        },

        /**
         * @param {number} x
         * @param {number} y
         * @param {number} width
         * @param {number} height
         */
        glViewport(x, y, width, height){
            setBox('glViewport', GL.VIEWPORT, x, y, width, height);
        },

        /**
         * @param {number} x
         * @param {number} y
         * @param {number} width
         * @param {number} height
         */
        glScissor(x, y, width, height){
            setBox('glScissor', GL.SCISSOR_BOX, x, y, width, height);
        },

        /** @param {number} mode */
        glDrawBuffer(mode){
            if (kernel.side.drawTarget())
            {
                if (enter('glDrawBuffer', [mode]))
                {
                    kernel.side.setDrawBuffers([mode]);
                }
                return;
            }
            if (setBuffer('glDrawBuffer', GL.DRAW_BUFFER, mode))
            {
                kernel.side.setDrawBuffers([mode]);
            }
        },

        /** @param {number} mode */
        glReadBuffer(mode){
            if (kernel.side.readFramebuffer())
            {
                if (enter('glReadBuffer', [mode]))
                {
                    kernel.side.setReadBuffer(mode);
                }
                return;
            }
            setBuffer('glReadBuffer', GL.READ_BUFFER, mode);
        },

        /**
         * Selection and feedback are accepted as state and never entered:
         * neither has a buffer here to write into.
         *
         * @param {number} mode
         * @returns {number}
         */
        glRenderMode(mode){
            if (!enter('glRenderMode', [mode]))
            {
                return 0;
            }
            if (!RENDER_MODES.has(mode))
            {
                setError(GL.INVALID_ENUM);
                return 0;
            }
            if (mode !== GL.RENDER)
            {
                diverge('selection and feedback modes are accepted and record nothing:'
                    + ' a program that picks objects with them finds no hits');
            }
            setState(GL.RENDER_MODE, [mode]);
            return 0;
        },

        // --- the matrix stacks ---

        /** @param {number} mode */
        glMatrixMode(mode){
            if (!enter('glMatrixMode', [mode]))
            {
                return;
            }
            if (!(/** @type {any} */ (MATRIX_STACK_OF)[mode]))
            {
                setError(GL.INVALID_ENUM);
                return;
            }
            matrixMode = mode;
            setState(GL.MATRIX_MODE, [mode]);
        },

        glPushMatrix(){
            if (!enter('glPushMatrix', []))
            {
                return;
            }
            const stack = currentStack();
            if (stack.saved.length + 1 >= stack.limit)
            {
                setError(GL.STACK_OVERFLOW);
                return;
            }
            stack.saved.push(copyOf(stack.current));
        },

        glPopMatrix(){
            if (!enter('glPopMatrix', []))
            {
                return;
            }
            const stack = currentStack();
            const previous = stack.saved.pop();
            if (!previous)
            {
                setError(GL.STACK_UNDERFLOW);
                return;
            }
            stack.current = previous;
        },

        glLoadIdentity(){
            if (enter('glLoadIdentity', []))
            {
                currentStack().current = identity();
            }
        },

        /** @param {ArrayLike<number>} m 16 elements, column major */
        glLoadMatrixf(m){
            if (enter('glLoadMatrixf', [m]))
            {
                currentStack().current = copyOf(m);
            }
        },

        /** @param {ArrayLike<number>} m */
        glMultMatrixf(m){
            if (enter('glMultMatrixf', [m]))
            {
                const stack = currentStack();
                stack.current = multiply(stack.current, m);
            }
        },

        /** @param {number} x @param {number} y @param {number} z */
        glTranslatef(x, y, z){
            if (enter('glTranslatef', [x, y, z]))
            {
                const stack = currentStack();
                stack.current = multiply(stack.current, translation(x, y, z));
            }
        },

        /**
         * @param {number} angle
         * @param {number} x
         * @param {number} y
         * @param {number} z
         */
        glRotatef(angle, x, y, z){
            if (enter('glRotatef', [angle, x, y, z]))
            {
                const stack = currentStack();
                stack.current = multiply(stack.current, rotation(angle, x, y, z));
            }
        },

        /** @param {number} x @param {number} y @param {number} z */
        glScalef(x, y, z){
            if (enter('glScalef', [x, y, z]))
            {
                const stack = currentStack();
                stack.current = multiply(stack.current, scaling(x, y, z));
            }
        },

        /**
         * @param {number} left
         * @param {number} right
         * @param {number} bottom
         * @param {number} top
         * @param {number} near
         * @param {number} far
         */
        glOrtho(left, right, bottom, top, near, far){
            multiplyBy('glOrtho', [left, right, bottom, top, near, far],
                ortho(left, right, bottom, top, near, far));
        },

        /**
         * @param {number} left
         * @param {number} right
         * @param {number} bottom
         * @param {number} top
         * @param {number} near
         * @param {number} far
         */
        glFrustum(left, right, bottom, top, near, far){
            multiplyBy('glFrustum', [left, right, bottom, top, near, far],
                frustum(left, right, bottom, top, near, far));
        },

        // --- display lists ---

        /** @param {number} count @returns {number} the first name, or zero */
        glGenLists(count){
            if (!enter('glGenLists', [count]))
            {
                return 0;
            }
            if (count < 0)
            {
                setError(GL.INVALID_VALUE);
                return 0;
            }
            if (count === 0)
            {
                return 0;
            }
            const first = shareGroup.lists.reserveRange(count);
            for (let i = 0; i < count; i++)
            {
                shareGroup.lists.define(first + i, { name: first + i, commands: [] });
            }
            shareGroup.used = true;
            return first;
        },

        /** @param {number} name @param {number} mode */
        glNewList(name, mode){
            if (!enter('glNewList', [name, mode]))
            {
                return;
            }
            if (compiling)
            {
                setError(GL.INVALID_OPERATION);
                return;
            }
            if (name === 0)
            {
                setError(GL.INVALID_VALUE);
                return;
            }
            if (mode !== GL.COMPILE && mode !== GL.COMPILE_AND_EXECUTE)
            {
                setError(GL.INVALID_ENUM);
                return;
            }
            compiling = { name, commands: [] };
            compileMode = mode;
            shareGroup.used = true;
            setState(GL.LIST_INDEX, [name]);
            setState(GL.LIST_MODE, [mode]);
        },

        glEndList(){
            if (!enter('glEndList', []))
            {
                return;
            }
            if (!compiling)
            {
                setError(GL.INVALID_OPERATION);
                return;
            }
            shareGroup.lists.define(compiling.name, compiling);
            compiling = null;
            setState(GL.LIST_INDEX, [0]);
            setState(GL.LIST_MODE, [0]);
        },

        /** @param {number} name */
        glCallList(name){
            if (enter('glCallList', [name]))
            {
                callList(name);
            }
        },

        /**
         * @param {number} count
         * @param {readonly number[]} offsets  already read as the type given
         */
        glCallLists(count, offsets){
            if (!enter('glCallLists', [count, offsets]))
            {
                return;
            }
            if (count < 0)
            {
                setError(GL.INVALID_VALUE);
                return;
            }
            const base = record(GL.LIST_BASE).values[0];
            for (const offset of offsets)
            {
                callList(base + offset);
            }
        },

        /** @param {number} first @param {number} count */
        glDeleteLists(first, count){
            if (!enter('glDeleteLists', [first, count]))
            {
                return;
            }
            if (count < 0)
            {
                setError(GL.INVALID_VALUE);
                return;
            }
            for (let i = 0; i < count; i++)
            {
                shareGroup.lists.remove(first + i);
            }
        },

        /** @param {number} name @returns {number} */
        glIsList(name){
            if (!enter('glIsList', [name]))
            {
                return GL.FALSE;
            }
            return shareGroup.lists.objects.has(name) ? GL.TRUE : GL.FALSE;
        },

        /** @param {number} base */
        glListBase(base){
            if (enter('glListBase', [base]))
            {
                setState(GL.LIST_BASE, [base]);
            }
        },

        // --- immediate mode ---

        /** @param {number} mode */
        glBegin(mode){
            // Checked before `enter`, which would refuse the call outright:
            // glBegin is the one entry point whose illegality between a
            // glBegin and a glEnd has to be reported by glBegin itself.
            if (primitive)
            {
                setError(GL.INVALID_OPERATION);
                return;
            }
            if (!enter('glBegin', [mode]))
            {
                return;
            }
            if (!PRIMITIVE_MODES.has(mode))
            {
                setError(GL.INVALID_ENUM);
                return;
            }
            primitive = { mode, vertices: [] };
        },

        glEnd(){
            if (!enter('glEnd', []))
            {
                return;
            }
            if (!primitive)
            {
                setError(GL.INVALID_OPERATION);
                return;
            }
            const finished = primitive;
            primitive = null;
            kept?.push(finished);
            draw(finished.mode, finished.vertices);
        },

        /** @param {number} x @param {number} y */
        glVertex2f(x, y){
            context.glVertex4f(x, y, 0, 1);
        },

        /** @param {number} x @param {number} y @param {number} z */
        glVertex3f(x, y, z){
            context.glVertex4f(x, y, z, 1);
        },

        /**
         * @param {number} x
         * @param {number} y
         * @param {number} z
         * @param {number} w
         */
        glVertex4f(x, y, z, w){
            if (!enter('glVertex4f', [x, y, z, w]))
            {
                return;
            }
            if (!primitive)
            {
                // Outside a primitive the call has no effect and is not an
                // error, which is what lets a program guard its own loop badly
                // and still run.
                return;
            }
            primitive.vertices.push(immediateVertex(x, y, z, w));
        },

        /**
         * @param {number} red
         * @param {number} green
         * @param {number} blue
         * @param {number} alpha
         */
        glColor4f(red, green, blue, alpha){
            if (enter('glColor4f', [red, green, blue, alpha]))
            {
                setState(GL.CURRENT_COLOR, [red, green, blue, alpha]);
            }
        },

        /** @param {number} red @param {number} green @param {number} blue */
        glColor3f(red, green, blue){
            if (enter('glColor3f', [red, green, blue]))
            {
                setState(GL.CURRENT_COLOR, [red, green, blue, 1]);
            }
        },

        /**
         * The byte-valued colour entry points, which take 0..255 where the
         * float ones take 0..1. The state is kept normalised, so the mapping
         * happens here rather than at every reader of GL_CURRENT_COLOR.
         *
         * @param {number} red @param {number} green @param {number} blue
         */
        glColor3ub(red, green, blue){
            context.glColor4ub(red, green, blue, 255);
        },

        /**
         * @param {number} red
         * @param {number} green
         * @param {number} blue
         * @param {number} alpha
         */
        glColor4ub(red, green, blue, alpha){
            if (enter('glColor4ub', [red, green, blue, alpha]))
            {
                setState(GL.CURRENT_COLOR, [red / 255, green / 255, blue / 255, alpha / 255]);
            }
        },

        /** @param {number} index */
        glIndexi(index){
            if (enter('glIndexi', [index]))
            {
                setState(GL.CURRENT_INDEX, [index]);
            }
        },

        /** @param {number} x @param {number} y @param {number} z */
        glNormal3f(x, y, z){
            if (enter('glNormal3f', [x, y, z]))
            {
                setState(GL.CURRENT_NORMAL, [x, y, z]);
            }
        },

        /** @param {number} s @param {number} t */
        glTexCoord2f(s, t){
            context.glTexCoord4f(s, t, 0, 1);
        },

        /** @param {number} s @param {number} t @param {number} r */
        glTexCoord3f(s, t, r){
            context.glTexCoord4f(s, t, r, 1);
        },

        /**
         * @param {number} s
         * @param {number} t
         * @param {number} r
         * @param {number} q
         */
        glTexCoord4f(s, t, r, q){
            if (enter('glTexCoord4f', [s, t, r, q]))
            {
                kernel.side.texCoords[0] = [s, t, r, q];
            }
        },

        /**
         * Recorded and otherwise ignored: an edge flag decides which edges of
         * a polygon are drawn in GL_LINE polygon mode, and this pipeline draws
         * them all.
         *
         * @param {number} flag
         */
        glEdgeFlag(flag){
            enter('glEdgeFlag', [flag]);
        },

        /**
         * @param {number} x1
         * @param {number} y1
         * @param {number} x2
         * @param {number} y2
         */
        glRectf(x1, y1, x2, y2){
            if (!enter('glRectf', [x1, y1, x2, y2]))
            {
                return;
            }
            context.glBegin(GL.POLYGON);
            context.glVertex2f(x1, y1);
            context.glVertex2f(x2, y1);
            context.glVertex2f(x2, y2);
            context.glVertex2f(x1, y2);
            context.glEnd();
        },

        // --- the attribute stacks ---

        /** @param {number} mask */
        glPushAttrib(mask){
            if (!enter('glPushAttrib', [mask]))
            {
                return;
            }
            if (attribStack.length >= ATTRIB_STACK_LIMIT)
            {
                setError(GL.STACK_OVERFLOW);
                return;
            }
            attribStack.push({
                mask,
                values: snapshot(queriesSavedBy(SERVER_BITS, mask)),
                textures: kernel.side.saveServerTextures(mask),
                lighting: kernel.side.saveServerLighting(mask),
                programs: kernel.side.saveServerPrograms(mask),
            });
            setState(GL.ATTRIB_STACK_DEPTH, [attribStack.length]);
        },

        glPopAttrib(){
            if (!enter('glPopAttrib', []))
            {
                return;
            }
            const saved = attribStack.pop();
            if (!saved)
            {
                setError(GL.STACK_UNDERFLOW);
                return;
            }
            restore(saved.values);
            kernel.side.restoreServerTextures(saved.mask, saved.textures);
            kernel.side.restoreServerLighting(saved.lighting);
            kernel.side.restoreServerPrograms(saved.programs);
            setState(GL.ATTRIB_STACK_DEPTH, [attribStack.length]);
        },

        /** @param {number} mask */
        glPushClientAttrib(mask){
            if (!enter('glPushClientAttrib', [mask]))
            {
                return;
            }
            if (clientAttribStack.length >= ATTRIB_STACK_LIMIT)
            {
                setError(GL.STACK_OVERFLOW);
                return;
            }
            clientAttribStack.push({
                mask,
                values: snapshot(queriesSavedBy(CLIENT_BITS, mask)),
                arrays: kernel.side.saveClient(mask),
                programs: kernel.side.saveClientPrograms(mask),
            });
            setState(GL.CLIENT_ATTRIB_STACK_DEPTH, [clientAttribStack.length]);
        },

        glPopClientAttrib(){
            if (!enter('glPopClientAttrib', []))
            {
                return;
            }
            const saved = clientAttribStack.pop();
            if (!saved)
            {
                setError(GL.STACK_UNDERFLOW);
                return;
            }
            restore(saved.values);
            kernel.side.restoreClient(saved.mask, saved.arrays);
            kernel.side.restoreClientPrograms(saved.programs);
            setState(GL.CLIENT_ATTRIB_STACK_DEPTH, [clientAttribStack.length]);
        },

        // Exposed for the drawing tests, which set up a scene and want to
        // know what the depth test and the compare functions decided.
        compare,
    };

    installTextureCalls(context, kernel);
    installLightingCalls(context, kernel);
    installArrayCalls(context, kernel);
    installPixelCalls(context, kernel);
    installProgramCalls(context, kernel);
    installShaderCalls(context, kernel);
    installFramebufferCalls(context, kernel);
    installCoreCalls(context, kernel);
    const scenes = createSceneBuilder(kernel);
    kernel.side.scene = ()=>scenes.scene();

    // The texture stack the queries read is the active unit's.
    Object.defineProperty(stacks, 'texture', { get: ()=>kernel.side.textureStack() });

    /** @param {number} value @returns {number} */
    function clamp01(value){
        return value < 0 ? 0 : value > 1 ? 1 : value;
    }

    /**
     * @param {string} name
     * @param {number} cap
     * @param {number} value
     */
    function setEnabled(name, cap, value){
        if (!enter(name, [cap]))
        {
            return;
        }
        if (kernel.side.setUnitEnable(cap, value))
        {
            return;
        }
        const entry = state.get(cap);
        // A client array is a client state and is not this call's to set;
        // the specification makes that an enum error, and programs rely on
        // glEnable(GL_VERTEX_ARRAY) failing loudly rather than working.
        if (!entry || entry.kind !== 'bool' || CLIENT_BITS.has(cap))
        {
            setError(GL.INVALID_ENUM);
            return;
        }
        // On the device path every drawable's depth attachment carries a real
        // stencil plane (`gpu.js` `DEPTH_FORMAT`, `depth24plus-stencil8`) and
        // stencil ops are translated to it (`wgsl.js`); only the processor
        // rasteriser has no stencil buffer to test against.
        if (value && cap === GL.STENCIL_TEST && !gpu)
        {
            diverge('the stencil test was enabled and there is no stencil buffer: every'
                + ' fragment passes it, and a program that masks with stencil draws unmasked');
        }
        entry.values = [value];
    }

    /**
     * @param {string} name
     * @param {number} query
     * @param {number} value
     * @param {Set<number>} allowed
     */
    function setEnum(name, query, value, allowed){
        if (!enter(name, [value]))
        {
            return;
        }
        if (!allowed.has(value))
        {
            setError(GL.INVALID_ENUM);
            return;
        }
        setState(query, [value]);
    }

    /**
     * `glStencilFunc`/`glStencilOp`/`glStencilMask` write only the active
     * face's record. `glActiveStencilFaceEXT` is a selector, like
     * `glActiveTextureARB`, with no dependence on whether two-sided testing
     * is enabled -- the enable only decides which set the stencil *test*
     * consults. The active face defaults to `GL_FRONT`, so a title that
     * never calls the selector keeps writing the single record it always
     * had.
     *
     * @param {number} frontQuery
     * @param {number} backQuery
     * @param {number[]} values
     */
    function setStencilFace(frontQuery, backQuery, values){
        if (record(GL.ACTIVE_STENCIL_FACE_EXT).values[0] === GL.BACK)
        {
            setState(backQuery, values);
            // The extension's back face, which a draw reads only while
            // two-sided testing is on.
            kernel.side.stencilBackFromSelector = true;
            return;
        }
        setState(frontQuery, values);
        // OpenGL 2.0: the one-face calls set both faces, unless two-sided
        // testing is on and the extension's selector speaks for each.
        if (record(GL.STENCIL_TEST_TWO_SIDE_EXT).values[0] === 0)
        {
            setState(backQuery, [...values]);
            kernel.side.stencilBackFromSelector = false;
        }
    }

    /** @param {string} name @param {number} query @param {number} value */
    function setPositive(name, query, value){
        if (!enter(name, [value]))
        {
            return;
        }
        if (!(value > 0))
        {
            setError(GL.INVALID_VALUE);
            return;
        }
        setState(query, [value]);
    }

    /**
     * @param {string} name
     * @param {number} query
     * @param {number} x
     * @param {number} y
     * @param {number} width
     * @param {number} height
     */
    function setBox(name, query, x, y, width, height){
        if (!enter(name, [x, y, width, height]))
        {
            return;
        }
        if (width < 0 || height < 0)
        {
            setError(GL.INVALID_VALUE);
            return;
        }
        setState(query, [x, y, width, height]);
    }

    /**
     * @param {string} name @param {number} query @param {number} mode
     * @returns {boolean} whether the mode was taken
     */
    function setBuffer(name, query, mode){
        if (!enter(name, [mode]))
        {
            return false;
        }
        if (!BUFFERS.has(mode))
        {
            setError(GL.INVALID_ENUM);
            return false;
        }
        const doubleBuffered = record(GL.DOUBLEBUFFER).values[0] !== 0;
        if ((mode === GL.BACK || mode === GL.BACK_LEFT) && !doubleBuffered
            || mode === GL.AUX0 || mode === GL.FRONT_RIGHT || mode === GL.BACK_RIGHT
            || mode === GL.RIGHT)
        {
            // Naming a buffer the format does not have is an operation error.
            setError(GL.INVALID_OPERATION);
            return false;
        }
        setState(query, [mode]);
        return true;
    }

    /**
     * @param {string} name
     * @param {number[]} args
     * @param {Float64Array | null} m
     */
    function multiplyBy(name, args, m){
        if (!enter(name, args))
        {
            return;
        }
        if (!m)
        {
            setError(GL.INVALID_VALUE);
            return;
        }
        const stack = currentStack();
        stack.current = multiply(stack.current, m);
    }

    /** @param {number} name */
    function callList(name){
        const list = shareGroup.lists.objects.get(name);
        if (!list || listNesting >= 64)
        {
            // Calling a name that is not a list is defined to be ignored, not
            // to fail: programs call a range they only partly built. A list
            // that calls itself is cut at the nesting limit.
            return;
        }
        listNesting++;
        for (const command of list.commands)
        {
            /** @type {any} */ (context)[command.call](...command.args);
        }
        listNesting--;
    }

    /** @returns {import('./raster.js').Box} what the scissor test leaves */
    function scissorBox(){
        const target = kernel.side.drawTarget?.();
        if (target)
        {
            // A framebuffer object's rows run up from its first, as GL's
            // window coordinates do: the box is taken as it stands.
            if (record(GL.SCISSOR_TEST).values[0] === 0)
            {
                return { x0: 0, y0: 0, x1: target.width, y1: target.height };
            }
            const [x, y, width, height] = record(GL.SCISSOR_BOX).values;
            return { x0: x, y0: y, x1: x + width, y1: y + height };
        }
        if (record(GL.SCISSOR_TEST).values[0] === 0)
        {
            return wholeOf(framebuffer);
        }
        // GL measures the box from the bottom-left corner of the drawable and
        // the framebuffer's row zero is its top one, so the two y bounds swap
        // as well as move.
        const [x, y, width, height] = record(GL.SCISSOR_BOX).values;
        return {
            x0: x,
            y0: framebuffer.height - (y + height),
            x1: x + width,
            y1: framebuffer.height - y,
        };
    }

    /** @returns {any} the current attributes, as a vertex with no position */
    function currentVertex(){
        const side = kernel.side;
        return {
            position: [0, 0, 0, 1],
            color: [...record(GL.CURRENT_COLOR).values],
            secondary: [...record(GL.CURRENT_SECONDARY_COLOR).values],
            normal: [...record(GL.CURRENT_NORMAL).values],
            texCoord: [...side.texCoords[0]],
            texCoords: side.texCoords.map((/** @type {number[]} */ coords)=>[...coords]),
            fogCoord: record(GL.CURRENT_FOG_COORDINATE).values[0],
        };
    }

    /**
     * A vertex glVertex makes: its position, and the current attributes by
     * reference -- each record's values and each unit's coordinates are
     * replaced whole on a change, never written in place (`currentAttributes`),
     * so the vertex keeps what they were. Only the list of units is copied,
     * since a unit's entry in it is replaced on its own. Copying every array
     * of every vertex was a dozen allocations a vertex in immediate mode.
     *
     * @param {number} x @param {number} y @param {number} z @param {number} w
     */
    function immediateVertex(x, y, z, w){
        const side = kernel.side;
        return {
            position: [x, y, z, w],
            color: record(GL.CURRENT_COLOR).values,
            secondary: record(GL.CURRENT_SECONDARY_COLOR).values,
            normal: record(GL.CURRENT_NORMAL).values,
            texCoord: side.texCoords[0],
            texCoords: side.texCoords.slice(),
            fogCoord: record(GL.CURRENT_FOG_COORDINATE).values[0],
        };
    }

    /**
     * The current attributes for a draw's state, read where they are kept:
     * each record's values and each unit's coordinates are replaced whole on
     * a change and never written in place, so a reader may keep what it is
     * handed. A vertex to fill in is `currentVertex`'s, which is a copy.
     *
     * @returns {{ color: readonly number[], secondary: readonly number[],
     *     normal: readonly number[], texCoords: readonly (readonly number[])[],
     *     fogCoord: number }}
     */
    function currentAttributes(){
        return {
            color: record(GL.CURRENT_COLOR).values,
            secondary: record(GL.CURRENT_SECONDARY_COLOR).values,
            normal: record(GL.CURRENT_NORMAL).values,
            texCoords: kernel.side.texCoords.slice(),
            fogCoord: record(GL.CURRENT_FOG_COORDINATE).values[0],
        };
    }

    /**
     * A primitive assembled by a draw call rather than glBegin. Recorded
     * into a list with its vertices already dereferenced, which is what the
     * specification says a compiled glDrawArrays holds.
     *
     * @param {number} mode
     * @param {any[]} vertices
     */
    /**
     * @param {number} mode @param {any[]} vertices
     * @param {string} [assembled]  why the vertices were assembled here rather
     *     than handed over as arrays: what the renderer counts
     *     (`noteAssembled`), so a program whose draws all take this road shows
     */
    function drawVertices(mode, vertices, assembled = 'immediate'){
        if (enter('drawVertices', [mode, vertices]))
        {
            kept?.push({ mode, vertices });
            draw(mode, vertices, assembled);
        }
    }

    /**
     * A draw of vertices assembled here. On a device they go as they are, with
     * their own colours and normals: the device's vertex stage lights them, as
     * it lights a draw by arrays (`wgsl.js` lightingFunction).
     *
     * @param {number} mode
     * @param {any[]} vertices
     * @param {string} [assembled]  why they were assembled here (`drawVertices`)
     */
    function draw(mode, vertices, assembled = 'immediate'){
        if (vertices.length === 0)
        {
            return;
        }
        if (!kernel.side.drawComplete())
        {
            setError(GL.INVALID_FRAMEBUFFER_OPERATION);
            return;
        }
        if (gpu)
        {
            if (attached)
            {
                gpu.noteAssembled?.(assembled, vertices.length);
                gpu.draw(context, scenes.scene, mode, vertices);
            }
            return;
        }
        if (framebuffer.width === 0)
        {
            return;
        }
        if (kernel.side.drawTarget())
        {
            diverge('a draw into a framebuffer object went to the window: the processor'
                + ' path draws only there');
        }
        if (programActive())
        {
            // The processor rasteriser is the fixed pipeline; a program stage
            // exists only as a shader, so there is nothing here to run it.
            diverge('a program was enabled and bound, and the processor path draws nothing'
                + ' under it: the program stages run only on a device');
            return;
        }
        if (!raster)
        {
            // The scene is what a device draw reads too, so a run without the
            // rasteriser still pays for the state a draw depends on.
            scenes.scene();
            return;
        }
        scenes.draw(mode, vertices);
    }

    /**
     * Whether a loaded program is enabled and bound, which is when a draw
     * belongs to the program pipeline rather than the fixed one.
     */
    function programActive(){
        if (kernel.side.glslExecutable())
        {
            return true;
        }
        const programs = kernel.side.programs;
        if (!programs)
        {
            return false;
        }
        const active = (/** @type {number} */ target)=>
            record(target).values[0] !== 0 && programs.boundProgram(target)?.parsed != null;
        return active(GL.VERTEX_PROGRAM_ARB) || active(GL.FRAGMENT_PROGRAM_ARB);
    }

    /** @returns {import('./matrix.js').MatrixStack} */
    function currentStack(){
        // The two a program selects nearly always, without a lookup by name.
        if (matrixMode === GL.MODELVIEW)
        {
            return stacks.modelview;
        }
        if (matrixMode === GL.PROJECTION)
        {
            return stacks.projection;
        }
        return stacks[/** @type {any} */ (MATRIX_STACK_OF)[matrixMode]];
    }

    /**
     * @param {number[]} queries
     * @returns {Map<number, number[]>}
     */
    function snapshot(queries){
        return new Map(queries.map(query=>[query, [...record(query).values]]));
    }

    /** @param {Map<number, number[]>} values */
    function restore(values){
        for (const [query, saved] of values)
        {
            record(query).values = [...saved];
        }
        matrixMode = record(GL.MATRIX_MODE).values[0];
    }

    // A list replays a drawVertices as a call on the context.
    /** @type {any} */ (context).drawVertices = drawVertices;

    return context;
}

/**
 * The GL entry points this implementation exports directly: everything on
 * the context that a program links against rather than obtains through
 * wglGetProcAddress.
 *
 * Derived from the context rather than written out beside it, because the two
 * would drift and the consequence of drift is silent: wglGetProcAddress must
 * return null for every one of these, and a name that leaked out of this set
 * would be answered with a pointer that programs then use to decide an
 * extension is present.
 */
export const CORE_FUNCTIONS = Object.freeze(new Set(
    Object.keys(createGlContext())
        .filter(name=>name.startsWith('gl') && !EXTENSION_FUNCTIONS.has(name))));
