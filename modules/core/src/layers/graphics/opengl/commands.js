/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The OpenGL calls a context's command ring carries (`../d3d8/commands.js`
 * for the record and the runner), made on the context in the order the
 * program made them.
 *
 * Every call here returns nothing and reads nothing of the program's memory
 * but what is copied into the record -- a vector of fixed size, a buffer's
 * data: state, bindings, the pointers an array is drawn from (kept, not
 * read), immediate-mode vertices, what a buffer object holds.
 * An error one raises is the context's error flag, which `glGetError` -- a
 * call into the host, which plays the ring first -- reads in order, so a
 * deferred call answers exactly what one made at once would. A call that
 * reads the program's memory (a draw from client arrays, an upload) or
 * answers something stays with the host.
 *
 * A record's arguments are the program's own dwords, decoded here as the
 * entry point's handler decodes them: an unsigned or signed integer, a
 * float's bits, a GLboolean's low byte, a double's two words.
 */

import { commandSet } from '../d3d8/commands.js';
import { GL } from './constants.js';

const bits = new DataView(new ArrayBuffer(8));

/** @param {number} word */
const asFloat = word=>{
    bits.setUint32(0, word >>> 0, true);
    return bits.getFloat32(0, true);
};
/** @param {number} low @param {number} high */
const asDouble = (low, high)=>{
    bits.setUint32(0, low >>> 0, true);
    bits.setUint32(4, high >>> 0, true);
    return bits.getFloat64(0, true);
};
/** @param {number} word */
const asBoolean = word=>((word & 0xff) !== 0 ? 1 : 0);
/** A signed integer a colour parameter is given as, onto 0..1. @param {number} word */
const normaliseInt = word=>(2 * (word | 0) + 1) / 4294967295;

/**
 * How one argument is decoded: `u` an unsigned integer, `i` a signed one,
 * `f` a float, `b` a GLboolean, `d` a double (two words), `n` an unsigned
 * byte onto 0..1.
 *
 * @typedef {'u' | 'i' | 'f' | 'b' | 'd' | 'n'} Kind
 */

/** @param {string} kinds @returns {number} the dwords they take */
const wordsOf = kinds=>[...kinds].reduce((sum, kind)=>sum + (kind === 'd' ? 2 : 1), 0);

/**
 * The arguments of a record as `kinds` decodes them.
 *
 * @param {import('../d3d8/commands.js').CommandArgs} c @param {string} kinds
 * @returns {number[]}
 */
const decode = (c, kinds)=>{
    /** @type {number[]} */
    const out = [];
    let word = 0;
    for (const kind of kinds)
    {
        const value = c.arg(word++);
        switch (kind)
        {
            case 'u': out.push(value >>> 0); break;
            case 'i': out.push(value | 0); break;
            case 'f': out.push(asFloat(value)); break;
            case 'b': out.push(asBoolean(value)); break;
            case 'n': out.push((value & 0xff) / 255); break;
            default: out.push(asDouble(value, c.arg(word++)));
        }
    }
    return out;
};

/** How each one-word kind is decoded. @type {Record<string, (word: number) => number>} */
const DECODERS = {
    u: word=>word >>> 0,
    i: word=>word | 0,
    f: asFloat,
    b: asBoolean,
    n: word=>(word & 0xff) / 255,
};

/**
 * A call whose arguments go to the context method of the same name, decoded.
 * Up to four one-word arguments are passed one by one: an array and a spread
 * per call cost more than most of the calls do.
 *
 * @param {string} kinds @param {string} method
 * @returns {import('../d3d8/commands.js').CommandEntry}
 */
const same = (kinds, method)=>{
    const args = wordsOf(kinds);
    const [a, b, c, d] = [...kinds].map(kind=>DECODERS[kind]);
    if (args !== kinds.length || args > 4)
    {
        return { args, make: (context, call)=>context[method](...decode(call, kinds)) };
    }
    /** @type {((context: any, call: import('../d3d8/commands.js').CommandArgs) => any)[]} */
    const byCount = [
        context=>context[method](),
        (context, call)=>context[method](a(call.arg(0))),
        (context, call)=>context[method](a(call.arg(0)), b(call.arg(1))),
        (context, call)=>context[method](a(call.arg(0)), b(call.arg(1)), c(call.arg(2))),
        (context, call)=>context[method](a(call.arg(0)), b(call.arg(1)), c(call.arg(2)),
            d(call.arg(3))),
    ];
    return { args, make: byCount[args] };
};

/**
 * One of a typed family -- `glColor3f`, `glVertex2f` -- made as the four-
 * component call the family comes down to, the missing components its
 * defaults.
 *
 * @param {string} kinds @param {string} method @param {readonly number[]} defaults
 * @returns {import('../d3d8/commands.js').CommandEntry}
 */
const widened = (kinds, method, defaults)=>{
    const [a, b, c = ()=>defaults[2], d = ()=>defaults[3]] = [...kinds].map(kind=>DECODERS[kind]);
    return {
        args: kinds.length,
        make: (context, call)=>context[method](a(call.arg(0)), b(call.arg(1)), c(call.arg(2)),
            d(call.arg(3))),
    };
};

/**
 * The vector form of a typed family: `count` floats copied from the pointer.
 *
 * @param {number} count @param {string} method @param {readonly number[]} defaults
 * @returns {import('../d3d8/commands.js').CommandEntry}
 */
const vectored = (count, method, defaults)=>{
    /** @param {Float32Array} f @param {number} i */
    const at = (f, i)=>(i < count ? f[i] : defaults[i]);
    return {
        args: 1, pointer: 0, bytes: count * 4,
        make: defaults.length === 3
            ? (context, c)=>context[method](at(c.floats, 0), at(c.floats, 1), at(c.floats, 2))
            : (context, c)=>context[method](at(c.floats, 0), at(c.floats, 1), at(c.floats, 2),
                at(c.floats, 3)),
    };
};

/**
 * A parameter call's scalar form, made as the vector form with one value;
 * an integer form normalises a colour parameter, as the entry point does.
 *
 * @param {number} leading  the enums before the value
 * @param {'f' | 'i'} type @param {string} method @param {ReadonlySet<number>} colours
 * @returns {import('../d3d8/commands.js').CommandEntry}
 */
const parameter = (leading, type, method, colours)=>({
    args: leading + 1,
    make: (context, c)=>{
        const head = leading === 1 ? [c.arg(0) >>> 0] : [c.arg(0) >>> 0, c.arg(1) >>> 0];
        const word = c.arg(leading);
        const value = type === 'f' ? asFloat(word)
            : colours.has(head[leading - 1]) ? normaliseInt(word) : word | 0;
        return context[method](...head, [value]);
    },
});

/**
 * A parameter call's float vector form, as many values copied as its
 * parameter takes: four for the ones named, one for the rest.
 *
 * @param {string} method @param {readonly number[]} fours
 * @returns {import('../d3d8/commands.js').CommandEntry}
 */
const parameterVector = (method, fours)=>({
    args: 3, pointer: 2, choose: { arg: 1, cases: fours.map(name=>[name, 16]), otherwise: 4 },
    make: (context, c)=>context[method](c.arg(0) >>> 0, c.arg(1) >>> 0,
        [...c.floats.subarray(0, fours.includes(c.arg(1) >>> 0) ? 4 : 1)]),
});

/**
 * The vector and the matrix a call is given, made once: the context copies
 * what it keeps of either, as it must of the program's own memory, and a
 * typed array made per call is an allocation outside the heap.
 */
const VECTOR = new Float32Array(4);
const MATRIX = new Float32Array(16);

/** @param {Float32Array} to @param {Float32Array} from */
const filled = (to, from)=>{
    for (let i = 0; i < to.length; i++)
    {
        to[i] = from[i];
    }
    return to;
};

/** @param {string} method @returns {import('../d3d8/commands.js').CommandEntry} */
const programParameterVector = method=>({
    args: 3, pointer: 2, bytes: 16,
    make: (context, c)=>context[method](c.arg(0) >>> 0, c.arg(1) >>> 0, filled(VECTOR, c.floats)),
});

/** @param {string} method @returns {import('../d3d8/commands.js').CommandEntry} */
const matrix = method=>({
    args: 1, pointer: 0, bytes: 64,
    make: (context, c)=>context[method](filled(MATRIX, c.floats)),
});

/**
 * The most a buffer's data copies into a record; past it the host reads the
 * program's memory itself, as it does without a ring.
 */
const BUFFER_BYTES = 16 * 1024;

const NONE = new Set();
const VERTEX = [0, 0, 0, 1];
const COLOUR = [0, 0, 0, 1];

/** @type {Record<string, import('../d3d8/commands.js').CommandEntry>} */
const TABLE = {
    // --- capabilities, bindings, selectors ---
    glEnable: same('u', 'glEnable'),
    glDisable: same('u', 'glDisable'),
    glEnableClientState: same('u', 'glEnableClientState'),
    glDisableClientState: same('u', 'glDisableClientState'),
    glBindTexture: same('uu', 'glBindTexture'),
    glActiveTextureARB: same('u', 'glActiveTextureARB'),
    glClientActiveTextureARB: same('u', 'glClientActiveTextureARB'),
    glBindBufferARB: same('uu', 'glBindBufferARB'),
    glBindProgramARB: same('uu', 'glBindProgramARB'),
    glMatrixMode: same('u', 'glMatrixMode'),
    glEnableVertexAttribArrayARB: same('u', 'glEnableVertexAttribArrayARB'),
    glDisableVertexAttribArrayARB: same('u', 'glDisableVertexAttribArrayARB'),
    glActiveStencilFaceEXT: same('u', 'glActiveStencilFaceEXT'),
    // --- fixed state ---
    glCullFace: same('u', 'glCullFace'),
    glFrontFace: same('u', 'glFrontFace'),
    glDepthFunc: same('u', 'glDepthFunc'),
    glDepthMask: same('b', 'glDepthMask'),
    glColorMask: same('bbbb', 'glColorMask'),
    glBlendFunc: same('uu', 'glBlendFunc'),
    glAlphaFunc: same('uf', 'glAlphaFunc'),
    glStencilOp: same('uuu', 'glStencilOp'),
    glStencilFunc: same('uiu', 'glStencilFunc'),
    glStencilMask: same('u', 'glStencilMask'),
    glClearStencil: same('i', 'glClearStencil'),
    glClearColor: same('ffff', 'glClearColor'),
    glClearDepth: same('d', 'glClearDepth'),
    glDepthRange: same('dd', 'glDepthRange'),
    glPolygonMode: same('uu', 'glPolygonMode'),
    glPolygonOffset: same('ff', 'glPolygonOffset'),
    glShadeModel: same('u', 'glShadeModel'),
    glScissor: same('iiii', 'glScissor'),
    glViewport: same('iiii', 'glViewport'),
    glDrawBuffer: same('u', 'glDrawBuffer'),
    glReadBuffer: same('u', 'glReadBuffer'),
    glLineWidth: same('f', 'glLineWidth'),
    glPointSize: same('f', 'glPointSize'),
    glClear: same('u', 'glClear'),
    // --- where arrays are drawn from: the pointer is kept, not read ---
    glVertexPointer: same('iuiu', 'glVertexPointer'),
    glTexCoordPointer: same('iuiu', 'glTexCoordPointer'),
    glColorPointer: same('iuiu', 'glColorPointer'),
    glNormalPointer: same('uiu', 'glNormalPointer'),
    glVertexAttribPointerARB: same('uiubiu', 'glVertexAttribPointerARB'),
    // --- buffer data: the bytes copied, up to what a record holds ---
    glBufferDataARB: { args: 4, pointer: 2, nullable: 'any', kept: true,
        count: { arg: 1, shift: 0, most: BUFFER_BYTES },
        make: (context, c)=>context.glBufferDataARB(c.arg(0) >>> 0, c.arg(1) | 0,
            c.arg(2) === 0 ? null : c.view(c.arg(1)), c.arg(3) >>> 0) },
    glBufferSubDataARB: { args: 4, pointer: 3, kept: true,
        count: { arg: 2, shift: 0, most: BUFFER_BYTES },
        make: (context, c)=>context.glBufferSubDataARB(c.arg(0) >>> 0, c.arg(1) | 0,
            c.arg(2) | 0, c.view(c.arg(2))) },
    // --- matrices ---
    glLoadIdentity: same('', 'glLoadIdentity'),
    glPushMatrix: same('', 'glPushMatrix'),
    glPopMatrix: same('', 'glPopMatrix'),
    glLoadMatrixf: matrix('glLoadMatrixf'),
    glMultMatrixf: matrix('glMultMatrixf'),
    glTranslatef: same('fff', 'glTranslatef'),
    glRotatef: same('ffff', 'glRotatef'),
    glScalef: same('fff', 'glScalef'),
    glOrtho: same('dddddd', 'glOrtho'),
    glFrustum: same('dddddd', 'glFrustum'),
    // --- program parameters ---
    glProgramEnvParameter4fvARB: programParameterVector('glProgramEnvParameter4fARB'),
    glProgramLocalParameter4fvARB: programParameterVector('glProgramLocalParameter4fARB'),
    glProgramEnvParameter4fARB: { args: 6,
        make: (context, c)=>context.glProgramEnvParameter4fARB(c.arg(0) >>> 0, c.arg(1) >>> 0,
            Float32Array.of(asFloat(c.arg(2)), asFloat(c.arg(3)), asFloat(c.arg(4)),
                asFloat(c.arg(5)))) },
    glProgramLocalParameter4fARB: { args: 6,
        make: (context, c)=>context.glProgramLocalParameter4fARB(c.arg(0) >>> 0, c.arg(1) >>> 0,
            Float32Array.of(asFloat(c.arg(2)), asFloat(c.arg(3)), asFloat(c.arg(4)),
                asFloat(c.arg(5)))) },
    // --- texture environment, generation and parameters ---
    glTexEnvf: parameter(2, 'f', 'glTexEnvfv', new Set([GL.TEXTURE_ENV_COLOR])),
    glTexEnvi: parameter(2, 'i', 'glTexEnvfv', new Set([GL.TEXTURE_ENV_COLOR])),
    glTexEnvfv: parameterVector('glTexEnvfv', [GL.TEXTURE_ENV_COLOR]),
    glTexGenf: parameter(2, 'f', 'glTexGenfv', NONE),
    glTexGeni: parameter(2, 'i', 'glTexGenfv', NONE),
    glTexParameterf: parameter(2, 'f', 'glTexParameterfv', new Set([GL.TEXTURE_BORDER_COLOR])),
    glTexParameteri: parameter(2, 'i', 'glTexParameterfv', new Set([GL.TEXTURE_BORDER_COLOR])),
    // --- immediate mode: the values themselves, a draw at glEnd ---
    glBegin: same('u', 'glBegin'),
    glEnd: same('', 'glEnd'),
    glVertex2f: widened('ff', 'glVertex4f', VERTEX),
    glVertex3f: widened('fff', 'glVertex4f', VERTEX),
    glVertex2fv: vectored(2, 'glVertex4f', VERTEX),
    glVertex3fv: vectored(3, 'glVertex4f', VERTEX),
    glColor3f: widened('fff', 'glColor4f', COLOUR),
    glColor4f: widened('ffff', 'glColor4f', COLOUR),
    glColor3ub: widened('nnn', 'glColor4f', COLOUR),
    glColor4ub: widened('nnnn', 'glColor4f', COLOUR),
    glColor3fv: vectored(3, 'glColor4f', COLOUR),
    glColor4fv: vectored(4, 'glColor4f', COLOUR),
    glTexCoord2f: widened('ff', 'glTexCoord4f', VERTEX),
    glTexCoord2fv: vectored(2, 'glTexCoord4f', VERTEX),
    glNormal3f: same('fff', 'glNormal3f'),
    glNormal3fv: vectored(3, 'glNormal3f', [0, 0, 0]),
};

/**
 * The texture generation parameters whose vector form takes one value; every
 * other takes four.
 */
TABLE.glTexGenfv = {
    args: 3, pointer: 2, choose: { arg: 1, cases: [[GL.TEXTURE_GEN_MODE, 4]], otherwise: 16 },
    make: (context, c)=>context.glTexGenfv(c.arg(0) >>> 0, c.arg(1) >>> 0,
        [...c.floats.subarray(0, (c.arg(1) >>> 0) === GL.TEXTURE_GEN_MODE ? 1 : 4)]),
};

/** The calls, numbered as the ring records them: their order here. */
const NAMES = /** @type {[string, number][]} */ (Object.keys(TABLE).map(name=>[name, 0]));

export const GL_COMMANDS = commandSet(NAMES, TABLE);
