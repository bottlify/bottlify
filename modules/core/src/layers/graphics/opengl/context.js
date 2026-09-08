/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The GL context as a program observes it between draws.
 *
 * **Nothing here draws.** What it models is everything a program can find out
 * about a context without a single pixel changing: what a state reads back as,
 * what a failed call reports, what a name refers to, and what was submitted.
 * All of it is checked on startup and between frames by code that never looks
 * at the screen, and all of it is wrong in a way that surfaces much later if
 * it is guessed at.
 *
 * Four conventions run through the file:
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
 */

import { GL } from './constants.js';
import {
    createMatrixStacks, frustum, identity, multiply, ortho, rotation, scaling, transform,
    translation,
} from './matrix.js';
import { createShareGroup, createTextureObject, isTextureComplete } from './objects.js';
import { createDefaultState, readState } from './state.js';
import { createFramebuffer, fillBox, fillTriangle, toByte, wholeOf } from './raster.js';

/** What this implementation answers glGetString with, absent a real backend. */
const STRINGS = Object.freeze({
    [GL.VENDOR]: 'Bottlify Project',
    [GL.RENDERER]: 'Bottlify OpenGL',
    [GL.VERSION]: '2.1',
});

/**
 * The calls that stay legal between glBegin and glEnd. Everything else is
 * GL_INVALID_OPERATION there -- and programs do violate this, which is exactly
 * why the rule has to be enforced rather than assumed.
 */
const ALLOWED_IN_BEGIN = new Set([
    'glVertex2f', 'glVertex3f', 'glVertex4f', 'glColor3f', 'glColor4f', 'glColor3ub',
    'glColor4ub', 'glNormal3f', 'glTexCoord2f', 'glTexCoord3f', 'glTexCoord4f', 'glEdgeFlag',
    'glCallList', 'glEnd',
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
    'glGetTexParameteriv', 'glIsEnabled', 'glIsTexture', 'glIsList', 'glGenTextures',
    'glGenLists', 'glDeleteTextures', 'glDeleteLists', 'glNewList', 'glEndList',
    'glPixelStorei', 'glFlush', 'glFinish',
]);

/**
 * The primitive modes glBegin accepts. Anything else is GL_INVALID_ENUM.
 *
 * @type {Set<number>}
 */
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

/** Which query reads which stack's current matrix, and which its depth. */
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
const COMPARE_FUNCTIONS = new Set([
    GL.NEVER, GL.LESS, GL.EQUAL, GL.LEQUAL, GL.GREATER, GL.NOTEQUAL, GL.GEQUAL, GL.ALWAYS,
]);

/** @type {Set<number>} */
const BLEND_FACTORS = new Set([
    GL.ZERO, GL.ONE, GL.SRC_COLOR, GL.ONE_MINUS_SRC_COLOR, GL.SRC_ALPHA, GL.ONE_MINUS_SRC_ALPHA,
    GL.DST_ALPHA, GL.ONE_MINUS_DST_ALPHA, GL.DST_COLOR, GL.ONE_MINUS_DST_COLOR,
    GL.SRC_ALPHA_SATURATE,
]);

/**
 * The base internal formats, plus the four component counts GL 1.0 took.
 *
 * @type {Set<number>}
 */
const INTERNAL_FORMATS = new Set([
    1, 2, 3, 4, GL.ALPHA, GL.LUMINANCE, GL.LUMINANCE_ALPHA, GL.RGB, GL.RGBA,
    GL.DEPTH_COMPONENT,
]);

/** @type {Set<number>} */
const PIXEL_FORMATS_2D = new Set([
    GL.COLOR_INDEX, GL.STENCIL_INDEX, GL.DEPTH_COMPONENT, GL.RED, GL.GREEN, GL.BLUE, GL.ALPHA,
    GL.RGB, GL.RGBA, GL.BGR, GL.BGRA, GL.LUMINANCE, GL.LUMINANCE_ALPHA,
]);

/** @type {Set<number>} */
const PIXEL_TYPES = new Set([
    GL.BYTE, GL.UNSIGNED_BYTE, GL.SHORT, GL.UNSIGNED_SHORT, GL.INT, GL.UNSIGNED_INT, GL.FLOAT,
    GL.BITMAP, GL.UNSIGNED_BYTE_3_3_2, GL.UNSIGNED_SHORT_4_4_4_4, GL.UNSIGNED_SHORT_5_5_5_1,
    GL.UNSIGNED_INT_8_8_8_8, GL.UNSIGNED_INT_10_10_10_2, GL.UNSIGNED_SHORT_5_6_5,
]);

/**
 * Packed types, and the formats whose component count they can carry.
 *
 * @type {Map<number, number[]>}
 */
const PACKED_TYPE_FORMATS = new Map([
    [GL.UNSIGNED_BYTE_3_3_2, [GL.RGB]],
    [GL.UNSIGNED_SHORT_5_6_5, [GL.RGB]],
    [GL.UNSIGNED_SHORT_4_4_4_4, [GL.RGBA, GL.BGRA]],
    [GL.UNSIGNED_SHORT_5_5_5_1, [GL.RGBA, GL.BGRA]],
    [GL.UNSIGNED_INT_8_8_8_8, [GL.RGBA, GL.BGRA]],
    [GL.UNSIGNED_INT_10_10_10_2, [GL.RGBA, GL.BGRA]],
]);

/** Which query reports the binding of which texture target. */
const TEXTURE_BINDING_QUERY = Object.freeze({
    [GL.TEXTURE_1D]: GL.TEXTURE_BINDING_1D,
    [GL.TEXTURE_2D]: GL.TEXTURE_BINDING_2D,
});

/**
 * @typedef {Object} Drawable
 * @property {number} width
 * @property {number} height
 * @property {boolean} doubleBuffered
 */

/**
 * @typedef {Object} GlContextOptions
 * @property {ReturnType<typeof createShareGroup>} [shareGroup]
 * @property {readonly string[]} [extensions]  what glGetString(GL_EXTENSIONS) reports
 */

/**
 * @param {GlContextOptions} [options]
 */
export function createGlContext(options = {}){
    let shareGroup = options.shareGroup ?? createShareGroup();
    shareGroup.contexts++;
    const extensions = [...(options.extensions ?? [])];

    /** The drawable's geometry, unknown until the context is first attached. */
    let attached = false;
    let state = createDefaultState({ width: 0, height: 0, doubleBuffered: false });
    /** Nothing can be drawn before there is a drawable to draw into. */
    let framebuffer = createFramebuffer(0, 0);

    /** @type {number} */
    let error = GL.NO_ERROR;
    let destroyed = false;

    const stacks = createMatrixStacks();
    /** @type {number} */
    let matrixMode = GL.MODELVIEW;

    /** @type {Map<number, number>} target -> bound texture name, zero being the default */
    const bindings = new Map([[GL.TEXTURE_1D, 0], [GL.TEXTURE_2D, 0]]);
    /** @type {Map<number, import('./objects.js').TextureObject>} the per-target default objects */
    const defaultTextures = new Map([
        [GL.TEXTURE_1D, createTextureObject(0, GL.TEXTURE_1D)],
        [GL.TEXTURE_2D, createTextureObject(0, GL.TEXTURE_2D)],
    ]);

    /** @type {import('./objects.js').DisplayList | null} */
    let compiling = null;
    /** @type {number} */
    let compileMode = GL.COMPILE;

    /** @type {{ mode: number, vertices: any[] } | null} */
    let primitive = null;
    /** @type {{ mode: number, vertices: any[] }[]} */
    const submitted = [];

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
            compiling.commands.push({ call: name, args });
            return compileMode === GL.COMPILE_AND_EXECUTE;
        }
        return true;
    };

    const context = {
        get shareGroup(){
            return shareGroup;
        },
        get destroyed(){
            return destroyed;
        },
        /** What glBegin/glEnd accumulated. Nothing was drawn; this is the record. */
        get submittedPrimitives(){
            return submitted;
        },
        get currentPrimitive(){
            return primitive;
        },
        /** The colour buffer as it stands. BGRX, row zero at the top. */
        get framebuffer(){
            return framebuffer;
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
            framebuffer = createFramebuffer(drawable.width, drawable.height);
        },

        /**
         * Joins another context's share group. Only wglShareLists calls this.
         *
         * @param {ReturnType<typeof createShareGroup>} group
         */
        adoptShareGroup(group){
            shareGroup.contexts--;
            shareGroup = group;
            shareGroup.contexts++;
        },

        destroy(){
            destroyed = true;
            shareGroup.contexts--;
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
            if (!enter('glEnable', [cap]))
            {
                return;
            }
            const entry = state.get(cap);
            if (!entry || entry.kind !== 'bool')
            {
                setError(GL.INVALID_ENUM);
                return;
            }
            entry.values = [1];
        },

        /** @param {number} cap */
        glDisable(cap){
            if (!enter('glDisable', [cap]))
            {
                return;
            }
            const entry = state.get(cap);
            if (!entry || entry.kind !== 'bool')
            {
                setError(GL.INVALID_ENUM);
                return;
            }
            entry.values = [0];
        },

        /** @param {number} cap @returns {number} GL_TRUE or GL_FALSE */
        glIsEnabled(cap){
            if (!enter('glIsEnabled', [cap]))
            {
                return GL.FALSE;
            }
            const entry = state.get(cap);
            if (!entry || entry.kind !== 'bool')
            {
                setError(GL.INVALID_ENUM);
                return GL.FALSE;
            }
            return entry.values[0] !== 0 ? GL.TRUE : GL.FALSE;
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
                return readState({ kind: 'float', values: [...stacks[matrix].current] }, as);
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
            return readState(entry, as);
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
            const value = /** @type {any} */ (STRINGS)[name];
            if (value === undefined)
            {
                setError(GL.INVALID_ENUM);
                return null;
            }
            return value;
        },

        // --- the state a program sets before it draws ---

        /**
         * @param {number} red
         * @param {number} green
         * @param {number} blue
         * @param {number} alpha
         */
        glClearColor(red, green, blue, alpha){
            if (!enter('glClearColor', [red, green, blue, alpha]))
            {
                return;
            }
            setState(GL.COLOR_CLEAR_VALUE, [red, green, blue, alpha]);
        },

        /** @param {number} depth */
        glClearDepth(depth){
            if (!enter('glClearDepth', [depth]))
            {
                return;
            }
            setState(GL.DEPTH_CLEAR_VALUE, [Math.min(1, Math.max(0, depth))]);
        },

        /** @param {number} value */
        glClearStencil(value){
            if (!enter('glClearStencil', [value]))
            {
                return;
            }
            setState(GL.STENCIL_CLEAR_VALUE, [value | 0]);
        },

        /**
         * Only the colour buffer is written: this context has no depth,
         * stencil or accumulation storage yet, so naming those bits is
         * accepted and does nothing. A bit outside the four is GL_INVALID_VALUE
         * -- not GL_INVALID_ENUM, because the argument is a mask.
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
            if ((mask & GL.COLOR_BUFFER_BIT) === 0)
            {
                return;
            }
            fillBox(framebuffer, record(GL.COLOR_CLEAR_VALUE).values.map(toByte), scissorBox());
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
        },

        /** @param {number} func */
        glDepthFunc(func){
            if (!enter('glDepthFunc', [func]))
            {
                return;
            }
            if (!COMPARE_FUNCTIONS.has(func))
            {
                setError(GL.INVALID_ENUM);
                return;
            }
            setState(GL.DEPTH_FUNC, [func]);
        },

        /** @param {number} flag */
        glDepthMask(flag){
            if (!enter('glDepthMask', [flag]))
            {
                return;
            }
            setState(GL.DEPTH_WRITEMASK, [flag ? 1 : 0]);
        },

        /**
         * @param {number} red
         * @param {number} green
         * @param {number} blue
         * @param {number} alpha
         */
        glColorMask(red, green, blue, alpha){
            if (!enter('glColorMask', [red, green, blue, alpha]))
            {
                return;
            }
            setState(GL.COLOR_WRITEMASK,
                [red ? 1 : 0, green ? 1 : 0, blue ? 1 : 0, alpha ? 1 : 0]);
        },

        /** @param {number} mode */
        glCullFace(mode){
            if (!enter('glCullFace', [mode]))
            {
                return;
            }
            if (mode !== GL.FRONT && mode !== GL.BACK && mode !== GL.FRONT_AND_BACK)
            {
                setError(GL.INVALID_ENUM);
                return;
            }
            setState(GL.CULL_FACE_MODE, [mode]);
        },

        /** @param {number} mode */
        glFrontFace(mode){
            if (!enter('glFrontFace', [mode]))
            {
                return;
            }
            if (mode !== GL.CW && mode !== GL.CCW)
            {
                setError(GL.INVALID_ENUM);
                return;
            }
            setState(GL.FRONT_FACE, [mode]);
        },

        /** @param {number} mode */
        glShadeModel(mode){
            if (!enter('glShadeModel', [mode]))
            {
                return;
            }
            if (mode !== GL.FLAT && mode !== GL.SMOOTH)
            {
                setError(GL.INVALID_ENUM);
                return;
            }
            setState(GL.SHADE_MODEL, [mode]);
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
            setState(GL.ALPHA_TEST_REF, [Math.min(1, Math.max(0, ref))]);
        },

        /**
         * @param {number} parameter
         * @param {number} value
         */
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
            if (!enter('glViewport', [x, y, width, height]))
            {
                return;
            }
            if (width < 0 || height < 0)
            {
                setError(GL.INVALID_VALUE);
                return;
            }
            setState(GL.VIEWPORT, [x, y, width, height]);
        },

        /**
         * @param {number} x
         * @param {number} y
         * @param {number} width
         * @param {number} height
         */
        glScissor(x, y, width, height){
            if (!enter('glScissor', [x, y, width, height]))
            {
                return;
            }
            if (width < 0 || height < 0)
            {
                setError(GL.INVALID_VALUE);
                return;
            }
            setState(GL.SCISSOR_BOX, [x, y, width, height]);
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
            stack.saved.push(new Float64Array(stack.current));
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
            if (!enter('glLoadIdentity', []))
            {
                return;
            }
            currentStack().current = identity();
        },

        /** @param {ArrayLike<number>} m 16 elements, column major */
        glLoadMatrixf(m){
            if (!enter('glLoadMatrixf', [m]))
            {
                return;
            }
            currentStack().current = Float64Array.from(m);
        },

        /** @param {ArrayLike<number>} m */
        glMultMatrixf(m){
            if (!enter('glMultMatrixf', [m]))
            {
                return;
            }
            const stack = currentStack();
            stack.current = multiply(stack.current, m);
        },

        /** @param {number} x @param {number} y @param {number} z */
        glTranslatef(x, y, z){
            if (!enter('glTranslatef', [x, y, z]))
            {
                return;
            }
            const stack = currentStack();
            stack.current = multiply(stack.current, translation(x, y, z));
        },

        /**
         * @param {number} angle
         * @param {number} x
         * @param {number} y
         * @param {number} z
         */
        glRotatef(angle, x, y, z){
            if (!enter('glRotatef', [angle, x, y, z]))
            {
                return;
            }
            const stack = currentStack();
            stack.current = multiply(stack.current, rotation(angle, x, y, z));
        },

        /** @param {number} x @param {number} y @param {number} z */
        glScalef(x, y, z){
            if (!enter('glScalef', [x, y, z]))
            {
                return;
            }
            const stack = currentStack();
            stack.current = multiply(stack.current, scaling(x, y, z));
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
            if (!enter('glOrtho', [left, right, bottom, top, near, far]))
            {
                return;
            }
            const m = ortho(left, right, bottom, top, near, far);
            if (!m)
            {
                setError(GL.INVALID_VALUE);
                return;
            }
            const stack = currentStack();
            stack.current = multiply(stack.current, m);
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
            if (!enter('glFrustum', [left, right, bottom, top, near, far]))
            {
                return;
            }
            const m = frustum(left, right, bottom, top, near, far);
            if (!m)
            {
                setError(GL.INVALID_VALUE);
                return;
            }
            const stack = currentStack();
            stack.current = multiply(stack.current, m);
        },

        // --- texture objects ---

        /** @param {number} count @returns {number[]} */
        glGenTextures(count){
            if (!enter('glGenTextures', [count]))
            {
                return [];
            }
            if (count < 0)
            {
                setError(GL.INVALID_VALUE);
                return [];
            }
            return shareGroup.textures.reserve(count);
        },

        /** @param {number} target @param {number} name */
        glBindTexture(target, name){
            if (!enter('glBindTexture', [target, name]))
            {
                return;
            }
            if (!bindings.has(target))
            {
                setError(GL.INVALID_ENUM);
                return;
            }
            if (name === 0)
            {
                bindings.set(target, 0);
                setState(/** @type {any} */ (TEXTURE_BINDING_QUERY)[target], [0]);
                return;
            }
            const existing = shareGroup.textures.objects.get(name);
            if (existing && existing.target !== target)
            {
                // A name belongs to the target it was first bound to, for life.
                setError(GL.INVALID_OPERATION);
                return;
            }
            if (!existing)
            {
                shareGroup.textures.define(name, createTextureObject(name, target));
                shareGroup.used = true;
            }
            bindings.set(target, name);
            setState(/** @type {any} */ (TEXTURE_BINDING_QUERY)[target], [name]);
        },

        /** @param {number[]} names */
        glDeleteTextures(names){
            if (!enter('glDeleteTextures', [names]))
            {
                return;
            }
            for (const name of names)
            {
                if (name === 0)
                {
                    // Silently ignored, not an error: programs delete arrays
                    // they only partly filled.
                    continue;
                }
                const texture = shareGroup.textures.objects.get(name);
                shareGroup.textures.remove(name);
                if (texture && bindings.get(texture.target) === name)
                {
                    // Deleting a bound texture rebinds the default object.
                    bindings.set(texture.target, 0);
                    setState(/** @type {any} */ (TEXTURE_BINDING_QUERY)[texture.target], [0]);
                }
            }
        },

        /** @param {number} name @returns {number} */
        glIsTexture(name){
            if (!enter('glIsTexture', [name]))
            {
                return GL.FALSE;
            }
            // A generated name is not a texture until it has been bound, and
            // asking about a name that was never generated is not an error.
            return shareGroup.textures.objects.has(name) ? GL.TRUE : GL.FALSE;
        },

        /**
         * @param {number} target
         * @param {number} parameter
         * @param {number} value
         */
        glTexParameteri(target, parameter, value){
            if (!enter('glTexParameteri', [target, parameter, value]))
            {
                return;
            }
            const texture = textureFor(target);
            if (!texture)
            {
                setError(GL.INVALID_ENUM);
                return;
            }
            if (!texture.parameters.has(parameter))
            {
                setError(GL.INVALID_ENUM);
                return;
            }
            texture.parameters.set(parameter, value);
        },

        /**
         * @param {number} target
         * @param {number} parameter
         * @returns {number[] | null}
         */
        glGetTexParameteriv(target, parameter){
            if (!enter('glGetTexParameteriv', [target, parameter]))
            {
                return null;
            }
            const texture = textureFor(target);
            if (!texture || !texture.parameters.has(parameter))
            {
                setError(GL.INVALID_ENUM);
                return null;
            }
            const value = /** @type {number} */ (texture.parameters.get(parameter));
            return [value];
        },

        /**
         * @param {number} target
         * @param {number} level
         * @param {number} internalFormat
         * @param {number} width
         * @param {number} height
         * @param {number} border
         * @param {number} format
         * @param {number} type
         */
        glTexImage2D(target, level, internalFormat, width, height, border, format, type){
            const args = [target, level, internalFormat, width, height, border, format, type];
            if (!enter('glTexImage2D', args))
            {
                return;
            }
            if (target !== GL.TEXTURE_2D)
            {
                setError(GL.INVALID_ENUM);
                return;
            }
            if (!PIXEL_FORMATS_2D.has(format) || !PIXEL_TYPES.has(type))
            {
                setError(GL.INVALID_ENUM);
                return;
            }
            if ((type === GL.BITMAP) !== (format === GL.COLOR_INDEX))
            {
                setError(GL.INVALID_ENUM);
                return;
            }
            const packed = PACKED_TYPE_FORMATS.get(type);
            if (packed && !packed.includes(format))
            {
                setError(GL.INVALID_OPERATION);
                return;
            }
            if (!INTERNAL_FORMATS.has(internalFormat))
            {
                setError(GL.INVALID_VALUE);
                return;
            }
            const maxSize = record(GL.MAX_TEXTURE_SIZE).values[0];
            if (level < 0 || border < 0 || border > 1
                || width < 0 || height < 0 || width > maxSize || height > maxSize)
            {
                setError(GL.INVALID_VALUE);
                return;
            }
            const texture = textureFor(target);
            if (!texture)
            {
                setError(GL.INVALID_ENUM);
                return;
            }
            texture.levels.set(level, { width, height, internalFormat, border });
        },

        /** @param {number} target @returns {boolean} */
        isTextureComplete(target){
            const texture = textureFor(target);
            return !!texture && isTextureComplete(texture);
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
            if (!enter('glCallList', [name]))
            {
                return;
            }
            const list = shareGroup.lists.objects.get(name);
            if (!list)
            {
                // Calling a name that is not a list is defined to be ignored,
                // not to fail: programs call a range they only partly built.
                return;
            }
            for (const command of list.commands)
            {
                /** @type {any} */ (context)[command.call](...command.args);
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
            if (!enter('glListBase', [base]))
            {
                return;
            }
            setState(GL.LIST_BASE, [base]);
        },

        // --- immediate mode, recorded and not drawn ---

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
            submitted.push(primitive);
            draw(primitive);
            primitive = null;
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
            primitive.vertices.push({
                position: [x, y, z, w],
                color: [...record(GL.CURRENT_COLOR).values],
                normal: [...record(GL.CURRENT_NORMAL).values],
                texCoord: [...record(GL.CURRENT_TEXTURE_COORDS).values],
            });
        },

        /**
         * @param {number} red
         * @param {number} green
         * @param {number} blue
         * @param {number} alpha
         */
        glColor4f(red, green, blue, alpha){
            if (!enter('glColor4f', [red, green, blue, alpha]))
            {
                return;
            }
            setState(GL.CURRENT_COLOR, [red, green, blue, alpha]);
        },

        /** @param {number} red @param {number} green @param {number} blue */
        glColor3f(red, green, blue){
            if (!enter('glColor3f', [red, green, blue]))
            {
                return;
            }
            setState(GL.CURRENT_COLOR, [red, green, blue, 1]);
        },

        /** @param {number} x @param {number} y @param {number} z */
        glNormal3f(x, y, z){
            if (!enter('glNormal3f', [x, y, z]))
            {
                return;
            }
            setState(GL.CURRENT_NORMAL, [x, y, z]);
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
            if (!enter('glColor4ub', [red, green, blue, alpha]))
            {
                return;
            }
            setState(GL.CURRENT_COLOR,
                [red / 255, green / 255, blue / 255, alpha / 255]);
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
            if (!enter('glTexCoord4f', [s, t, r, q]))
            {
                return;
            }
            setState(GL.CURRENT_TEXTURE_COORDS, [s, t, r, q]);
        },

        /**
         * Recorded and otherwise ignored: an edge flag decides which edges of
         * a polygon are drawn in GL_LINE polygon mode, and this rasteriser
         * fills.
         *
         * @param {number} flag
         */
        glEdgeFlag(flag){
            enter('glEdgeFlag', [flag]);
        },
    };

    /**
     * What the scissor test leaves of the framebuffer.
     *
     * @returns {import('./raster.js').Box}
     */
    function scissorBox(){
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

    /**
     * Which vertices make which triangles, by index.
     *
     * ponytail: points and lines are collected and not drawn. They need a
     * different rule from the one in `raster.js` -- a line has width and no
     * area -- rather than a different set of indices.
     *
     * @param {number} mode
     * @param {number} count
     * @returns {number[][]}
     */
    function trianglesOf(mode, count){
        /** @type {number[][]} */
        const triangles = [];
        if (mode === GL.TRIANGLES)
        {
            for (let i = 0; i + 2 < count; i += 3)
            {
                triangles.push([i, i + 1, i + 2]);
            }
        }
        else if (mode === GL.TRIANGLE_STRIP)
        {
            for (let i = 0; i + 2 < count; i++)
            {
                // Every second triangle in a strip is wound the other way
                // round, and two of its indices are swapped to put it back --
                // otherwise a strip alternates facing and culling eats half
                // of it.
                triangles.push(i % 2 === 0 ? [i, i + 1, i + 2] : [i + 1, i, i + 2]);
            }
        }
        else if (mode === GL.TRIANGLE_FAN || mode === GL.POLYGON)
        {
            for (let i = 1; i + 1 < count; i++)
            {
                triangles.push([0, i, i + 1]);
            }
        }
        else if (mode === GL.QUADS)
        {
            for (let i = 0; i + 3 < count; i += 4)
            {
                triangles.push([i, i + 1, i + 2], [i, i + 2, i + 3]);
            }
        }
        else if (mode === GL.QUAD_STRIP)
        {
            for (let i = 0; i + 3 < count; i += 2)
            {
                triangles.push([i, i + 1, i + 3], [i, i + 3, i + 2]);
            }
        }
        return triangles;
    }

    /**
     * @param {readonly import('./raster.js').RasterVertex[]} triangle
     * @returns {boolean}
     */
    function culled(triangle){
        if (record(GL.CULL_FACE).values[0] === 0)
        {
            return false;
        }
        const mode = record(GL.CULL_FACE_MODE).values[0];
        if (mode === GL.FRONT_AND_BACK)
        {
            return true;
        }
        const [a, b, c] = triangle;
        const area = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
        if (area === 0)
        {
            return true;
        }
        // Counter-clockwise in GL's window coordinates is clockwise in the
        // framebuffer's, because y grows the other way.
        const isFront = (record(GL.FRONT_FACE).values[0] === GL.CCW) === (area > 0);
        return isFront === (mode === GL.FRONT);
    }

    /**
     * A finished primitive, transformed and filled.
     *
     * The matrices are read once here rather than at each glVertex: they
     * cannot change between a glBegin and a glEnd, so the two are equivalent
     * and this one is a matrix product per primitive instead of per vertex.
     *
     * @param {{ mode: number, vertices: any[] }} assembled
     */
    function draw(assembled){
        const [vx, vy, vw, vh] = record(GL.VIEWPORT).values;
        const mvp = multiply(stacks.projection.current, stacks.modelview.current);
        /** @type {(import('./raster.js').RasterVertex | null)[]} */
        const points = assembled.vertices.map(vertex=>{
            const clip = transform(mvp, vertex.position);
            const w = clip[3];
            if (w === 0)
            {
                // Nothing can be divided by it, and a vertex on the eye plane
                // has no window position. The triangles using it are dropped.
                return null;
            }
            return {
                x: (clip[0] / w * 0.5 + 0.5) * vw + vx,
                y: framebuffer.height - ((clip[1] / w * 0.5 + 0.5) * vh + vy),
                colour: vertex.color.map(toByte),
            };
        });
        const flat = record(GL.SHADE_MODEL).values[0] === GL.FLAT;
        const box = scissorBox();
        for (const [i, j, k] of trianglesOf(assembled.mode, points.length))
        {
            const a = points[i];
            const b = points[j];
            const c = points[k];
            if (!a || !b || !c || culled([a, b, c]))
            {
                continue;
            }
            // Flat shading takes the colour of the triangle's last vertex,
            // which is the provoking one for every mode here.
            const triangle = flat
                ? [a, b, c].map(point=>({ ...point, colour: c.colour }))
                : [a, b, c];
            fillTriangle(framebuffer, triangle, box);
        }
    }

    /** @returns {import('./matrix.js').MatrixStack} */
    function currentStack(){
        return stacks[/** @type {any} */ (MATRIX_STACK_OF)[matrixMode]];
    }

    /**
     * @param {number} target
     * @returns {import('./objects.js').TextureObject | null}
     */
    function textureFor(target){
        if (!bindings.has(target))
        {
            return null;
        }
        const name = bindings.get(target) ?? 0;
        if (name === 0)
        {
            return /** @type {any} */ (defaultTextures.get(target));
        }
        return shareGroup.textures.objects.get(name) ?? null;
    }

    return context;
}

/**
 * The GL entry points this implementation exports directly.
 *
 * Derived from the context rather than written out beside it, because the two
 * would drift and the consequence of drift is silent: wglGetProcAddress must
 * return null for every one of these, and a name that leaked out of this set
 * would be answered with a pointer that programs then use to decide an
 * extension is present.
 */
export const CORE_FUNCTIONS = Object.freeze(new Set(
    Object.keys(createGlContext()).filter(name=>name.startsWith('gl'))));

/**
 * The parameters glPixelStorei accepts. Anything else is an enum error.
 *
 * @type {Set<number>}
 */
const PIXEL_STORE_PARAMETERS = new Set([
    GL.UNPACK_ALIGNMENT, GL.UNPACK_ROW_LENGTH, GL.UNPACK_SKIP_ROWS, GL.UNPACK_SKIP_PIXELS,
    GL.UNPACK_SWAP_BYTES, GL.UNPACK_LSB_FIRST, GL.PACK_ALIGNMENT, GL.PACK_ROW_LENGTH,
    GL.PACK_SKIP_ROWS, GL.PACK_SKIP_PIXELS, GL.PACK_SWAP_BYTES, GL.PACK_LSB_FIRST,
]);
