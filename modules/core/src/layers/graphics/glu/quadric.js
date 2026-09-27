/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * GLU's quadrics: a cylinder, a sphere, a disk and a partial disk, drawn as
 * the immediate-mode calls GLU makes -- glBegin, glNormal3f, glTexCoord2f,
 * glVertex3f, glEnd -- through whatever `emit` is handed, so a display list
 * being compiled records them and the shapes are testable without a context.
 *
 * The geometry is the specification's (GLU 1.3, section 6):
 *
 * - Angles around z start at +y and go towards +x: a texture's s is 0 at +y,
 *   0.25 at +x, 0.5 at -y, 0.75 at -x, and 1 back at +y. A partial disk's
 *   angles are in degrees on the same scale.
 * - A cylinder runs from z = 0 (radius `base`) to z = height (radius `top`),
 *   t from 0 to 1 along it; a sphere's t is 0 at z = -radius and 1 at
 *   +radius; a disk lies in z = 0, textured so the outer circle touches the
 *   edges of [0, 1] x [0, 1].
 * - GLU_OUTSIDE faces and normals point away from the axis or centre (+z for
 *   a disk), GLU_INSIDE towards it: normals are negated and every face's
 *   winding reversed, so front faces are the visible ones either way.
 * - GLU_FILL draws the faces, GLU_LINE every edge, GLU_SILHOUETTE the edges
 *   that do not separate two coplanar faces, GLU_POINT the vertices.
 *
 * Values are computed in doubles and handed on as floats, as the float
 * entry points GLU calls take them.
 */

import { GL } from '../opengl/constants.js';

export const GLU = Object.freeze({
    SMOOTH: 100000,
    FLAT: 100001,
    NONE: 100002,
    POINT: 100010,
    LINE: 100011,
    FILL: 100012,
    SILHOUETTE: 100013,
    OUTSIDE: 100020,
    INSIDE: 100021,
    ERROR: 100103,
    INVALID_ENUM: 100900,
    INVALID_VALUE: 100901,
    OUT_OF_MEMORY: 100902,
    INCOMPATIBLE_GL_VERSION: 100903,
    INVALID_OPERATION: 100904,
    VERSION: 100800,
    EXTENSIONS: 100801,
});

/**
 * @typedef {Object} QuadricState
 * @property {number} drawStyle
 * @property {number} normals
 * @property {number} orientation
 * @property {boolean} texture
 */

/** @returns {QuadricState} what gluNewQuadric starts with */
export const newQuadric = ()=>({
    drawStyle: GLU.FILL, normals: GLU.SMOOTH, orientation: GLU.OUTSIDE, texture: false,
});

/**
 * @typedef {Object} Emit
 * @property {(mode: number) => void} begin
 * @property {() => void} end
 * @property {(x: number, y: number, z: number) => void} normal
 * @property {(s: number, t: number) => void} texCoord
 * @property {(x: number, y: number, z: number) => void} vertex
 */

const f = Math.fround;
const TWO_PI = 2 * Math.PI;

/**
 * A vertex with its normal and texture coordinate, as the quadric's state
 * asks for them.
 *
 * @param {Emit} emit @param {QuadricState} q
 * @param {number[]} p  position @param {number[] | null} n  normal, outward
 * @param {number} s @param {number} t
 */
function put(emit, q, p, n, s, t){
    if (n && q.normals !== GLU.NONE)
    {
        const sign = q.orientation === GLU.INSIDE ? -1 : 1;
        emit.normal(f(n[0] * sign), f(n[1] * sign), f(n[2] * sign));
    }
    if (q.texture)
    {
        emit.texCoord(f(s), f(t));
    }
    emit.vertex(f(p[0]), f(p[1]), f(p[2]));
}

/**
 * A grid of `columns + 1` by `rows + 1` points -- around, then along --
 * drawn in the quadric's style: quad strips between neighbouring rows, lines
 * along both, or points. `at(i, j)` answers the point, its outward normal at
 * the vertex and at the middle of the face that starts there, and its
 * texture coordinate.
 *
 * Each strip goes row j + 1 first, then row j, a pair per column: the shapes
 * number their rows so that this winds counter-clockwise seen from outside,
 * and GLU_INSIDE takes the pair the other way round.
 *
 * @param {Emit} emit @param {QuadricState} q
 * @param {number} columns @param {number} rows @param {boolean} closed  whether
 *     the columns wrap around, so a row is a loop
 * @param {(i: number, j: number) => { p: number[], n: number[], face: number[],
 *     s: number, t: number }} at
 * @param {{ rows: number[], columns: boolean, ends?: boolean }} silhouette
 *     which rows a silhouette draws, and whether its columns
 */
function grid(emit, q, columns, rows, closed, at, silhouette){
    const inside = q.orientation === GLU.INSIDE;
    const flat = q.normals === GLU.FLAT;
    if (q.drawStyle === GLU.FILL)
    {
        for (let j = 0; j < rows; j++)
        {
            emit.begin(GL.QUAD_STRIP);
            for (let i = 0; i <= columns; i++)
            {
                const lower = at(i, j + 1);
                const upper = at(i, j);
                // A face's normal goes on the pair that closes it, the
                // vertex flat shading takes a quad strip's colour from.
                const face = flat ? at(Math.max(0, i - 1), j).face : null;
                const [first, second] = inside ? [upper, lower] : [lower, upper];
                put(emit, q, first.p, face ?? first.n, first.s, first.t);
                put(emit, q, second.p, face ?? second.n, second.s, second.t);
            }
            emit.end();
        }
        return;
    }
    if (q.drawStyle === GLU.POINT)
    {
        emit.begin(GL.POINTS);
        for (let j = 0; j <= rows; j++)
        {
            for (let i = 0; i < (closed ? columns : columns + 1); i++)
            {
                const v = at(i, j);
                put(emit, q, v.p, v.n, v.s, v.t);
            }
        }
        emit.end();
        return;
    }
    const lines = q.drawStyle === GLU.LINE;
    const drawnRows = lines ? Array.from({ length: rows + 1 }, (_, j)=>j) : silhouette.rows;
    for (const j of drawnRows)
    {
        emit.begin(closed ? GL.LINE_LOOP : GL.LINE_STRIP);
        for (let i = 0; i < (closed ? columns : columns + 1); i++)
        {
            const v = at(i, j);
            put(emit, q, v.p, v.n, v.s, v.t);
        }
        emit.end();
    }
    const every = Array.from({ length: closed ? columns : columns + 1 }, (_, i)=>i);
    const drawnColumns = lines || silhouette.columns ? every
        : silhouette.ends ? [0, columns] : [];
    for (const i of drawnColumns)
    {
        emit.begin(GL.LINE_STRIP);
        for (let j = 0; j <= rows; j++)
        {
            const v = at(i, j);
            put(emit, q, v.p, v.n, v.s, v.t);
        }
        emit.end();
    }
}

/**
 * gluCylinder: the side of a cone frustum along +z, open at both ends.
 *
 * @param {Emit} emit @param {QuadricState} q
 * @param {number} base @param {number} top @param {number} height
 * @param {number} slices @param {number} stacks
 */
export function cylinder(emit, q, base, top, height, slices, stacks){
    const slope = Math.hypot(height, base - top);
    const radial = slope === 0 ? 1 : height / slope;
    const nz = slope === 0 ? 0 : (base - top) / slope;
    /** @param {number} angle */
    const normal = angle=>[Math.sin(angle) * radial, Math.cos(angle) * radial, nz];
    grid(emit, q, slices, stacks, true, (i, j)=>{
        const angle = TWO_PI * (i % slices) / slices;
        // j runs from the top down, so the strips wind outward.
        const along = (stacks - j) / stacks;
        const radius = base + (top - base) * along;
        return {
            p: [Math.sin(angle) * radius, Math.cos(angle) * radius, height * along],
            n: normal(angle),
            face: normal(TWO_PI * (i + 0.5) / slices),
            s: i / slices,
            t: along,
        };
    }, { rows: [0, stacks], columns: true });
}

/**
 * gluSphere: a sphere about the origin, its stacks along z.
 *
 * @param {Emit} emit @param {QuadricState} q
 * @param {number} radius @param {number} slices @param {number} stacks
 */
export function sphere(emit, q, radius, slices, stacks){
    /** @param {number} angle @param {number} polar */
    const unit = (angle, polar)=>[Math.sin(angle) * Math.sin(polar),
        Math.cos(angle) * Math.sin(polar), Math.cos(polar)];
    grid(emit, q, slices, stacks, true, (i, j)=>{
        const angle = TWO_PI * (i % slices) / slices;
        const polar = Math.PI * j / stacks;
        const n = unit(angle, polar);
        return {
            p: [n[0] * radius, n[1] * radius, n[2] * radius],
            n,
            face: unit(TWO_PI * (i + 0.5) / slices, Math.PI * (j + 0.5) / stacks),
            s: i / slices,
            t: 1 - j / stacks,
        };
    }, { rows: Array.from({ length: stacks + 1 }, (_, j)=>j), columns: true });
}

/**
 * gluPartialDisk, and gluDisk as its whole: a flat annulus in z = 0 between
 * two radii, from `start` degrees through `sweep` more.
 *
 * @param {Emit} emit @param {QuadricState} q
 * @param {number} inner @param {number} outer @param {number} slices
 * @param {number} loops @param {number} start @param {number} sweep
 */
export function partialDisk(emit, q, inner, outer, slices, loops, start, sweep){
    const clamped = Math.max(-360, Math.min(360, sweep));
    const from = clamped < 0 ? start + clamped : start;
    const span = Math.abs(clamped);
    const whole = span === 360;
    const up = [0, 0, 1];
    grid(emit, q, slices, loops, whole, (i, j)=>{
        const angle = (from + span * (whole ? i % slices : i) / slices) * Math.PI / 180;
        // j runs from the inner radius out, so the strips wind towards +z.
        const radius = inner + (outer - inner) * j / loops;
        const x = Math.sin(angle) * radius;
        const y = Math.cos(angle) * radius;
        return { p: [x, y, 0], n: up, face: up, s: 0.5 + x / (2 * outer),
            t: 0.5 + y / (2 * outer) };
    }, {
        // The boundary: the outer circle, the inner one where there is a
        // hole, and the two radii a partial disk is cut along.
        rows: inner > 0 ? [0, loops] : [loops],
        columns: false,
        ends: !whole,
    });
}
