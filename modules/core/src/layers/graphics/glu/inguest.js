/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * GLU32's arithmetic as code in the guest's own GLU32, written once: each
 * `@guestCode` function here is compiled by the build
 * (`scripts/guest-code/compile.mjs`) into `inguest.x86.js`, and is itself the
 * reference its x86 is held to.
 *
 * GLU computes in doubles, on the x87, under whatever precision control the
 * program set -- it is a library in the program's process like any other --
 * and so do these. Matrices are OpenGL's: sixteen doubles, column-major,
 * `m[column * 4 + row]`, a vector a column on the matrix's right.
 *
 * The four that change the current matrix (`gluPerspective`, `gluLookAt`,
 * `gluOrtho2D`, `gluPickMatrix`) do it as GLU does, by calling OPENGL32
 * (`glMultMatrixd`, `glTranslated`, `glScaled`, `glOrtho`), so a display list
 * being compiled records the product and the matrix the program reads back is
 * the one GL multiplied. What is computed here is what those calls are
 * handed; the calls themselves are the wrappers' (`code.js`).
 */

/**
 * The guest's memory: none of these touches the x87's control or status words.
 *
 * @typedef {import('../../win32/msvcrt/guest-code.js').GuestMemory} Guest
 */
/** @typedef {import('../../win32/msvcrt/guest-code.js').u32} u32 */
/** @typedef {import('../../win32/msvcrt/guest-code.js').i32} i32 */
/** @typedef {import('../../win32/msvcrt/guest-code.js').f64} f64 */

/** Radians in a degree: π / 180, as the double nearest it. */
const DEGREES = 0.017453292519943295;

/**
 * The perspective matrix gluPerspective multiplies by, into sixteen doubles
 * at `out`: `f = cot(fovy / 2)`, f / aspect and f on the diagonal, depth
 * mapped from [-zNear, -zFar] onto [-1, 1], and w taken from -z. Answers 0
 * and writes nothing where the arguments describe no projection -- a depth
 * range of nothing, an aspect of zero, a field of view whose half-angle has
 * no cotangent -- and the call then leaves the matrix as it was.
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} out @param {f64} fovy @param {f64} aspect
 * @param {f64} zNear @param {f64} zFar
 * @returns {u32}
 */
export function gluPerspectiveMatrix({ setF64 }, out, fovy, aspect, zNear, zFar){
    const half = fovy / 2 * DEGREES;
    const depth = zFar - zNear;
    const sine = Math.sin(half);
    if (depth === 0 || sine === 0 || aspect === 0)
    {
        return 0;
    }
    const f = Math.cos(half) / sine;
    setF64(out, f / aspect);
    setF64(out + 8, 0);
    setF64(out + 16, 0);
    setF64(out + 24, 0);
    setF64(out + 32, 0);
    setF64(out + 40, f);
    setF64(out + 48, 0);
    setF64(out + 56, 0);
    setF64(out + 64, 0);
    setF64(out + 72, 0);
    setF64(out + 80, -(zFar + zNear) / depth);
    setF64(out + 88, -1);
    setF64(out + 96, 0);
    setF64(out + 104, 0);
    setF64(out + 112, -2 * zNear * zFar / depth);
    setF64(out + 120, 0);
    return 1;
}

/**
 * The rotation gluLookAt multiplies by, into sixteen doubles at `out`, and
 * the eye negated into three more after them, for the translation that
 * follows: the rows are the side, up and backward directions of a viewer at
 * the eye looking at the centre. The forward direction and the side are made
 * unit length -- a length of zero is left as it is, as a direction with none
 * cannot be scaled to one -- and up is the side crossed with forward, so the
 * rows are orthonormal whatever up the program passed.
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} out
 * @param {f64} eyeX @param {f64} eyeY @param {f64} eyeZ
 * @param {f64} centerX @param {f64} centerY @param {f64} centerZ
 * @param {f64} upX @param {f64} upY @param {f64} upZ
 */
export function gluLookAtMatrix({ setF64 }, out, eyeX, eyeY, eyeZ, centerX, centerY, centerZ,
    upX, upY, upZ)
{
    let fx = centerX - eyeX;
    let fy = centerY - eyeY;
    let fz = centerZ - eyeZ;
    const forward = Math.sqrt(fx * fx + fy * fy + fz * fz);
    if (forward !== 0)
    {
        fx = fx / forward;
        fy = fy / forward;
        fz = fz / forward;
    }
    let sx = fy * upZ - fz * upY;
    let sy = fz * upX - fx * upZ;
    let sz = fx * upY - fy * upX;
    const side = Math.sqrt(sx * sx + sy * sy + sz * sz);
    if (side !== 0)
    {
        sx = sx / side;
        sy = sy / side;
        sz = sz / side;
    }
    const ux = sy * fz - sz * fy;
    const uy = sz * fx - sx * fz;
    const uz = sx * fy - sy * fx;
    setF64(out, sx);
    setF64(out + 8, ux);
    setF64(out + 16, -fx);
    setF64(out + 24, 0);
    setF64(out + 32, sy);
    setF64(out + 40, uy);
    setF64(out + 48, -fy);
    setF64(out + 56, 0);
    setF64(out + 64, sz);
    setF64(out + 72, uz);
    setF64(out + 80, -fz);
    setF64(out + 88, 0);
    setF64(out + 96, 0);
    setF64(out + 104, 0);
    setF64(out + 112, 0);
    setF64(out + 120, 1);
    setF64(out + 128, -eyeX);
    setF64(out + 136, -eyeY);
    setF64(out + 144, -eyeZ);
}

/**
 * What gluPickMatrix translates and scales by, as six doubles at `out` --
 * the translation's three, then the scale's -- so that the region of
 * `width` by `height` pixels centred on (x, y) of the viewport fills the
 * clip volume. Answers 0 and writes nothing for a region of no size, which
 * the call then leaves the matrix alone for.
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} out @param {f64} x @param {f64} y
 * @param {f64} width @param {f64} height @param {u32} viewport
 * @returns {u32}
 */
export function gluPickMatrixArgs({ i32, setF64 }, out, x, y, width, height, viewport){
    if (width <= 0 || height <= 0)
    {
        return 0;
    }
    const left = +i32(viewport);
    const bottom = +i32(viewport + 4);
    const across = +i32(viewport + 8);
    const up = +i32(viewport + 12);
    setF64(out, (across - 2 * (x - left)) / width);
    setF64(out + 8, (up - 2 * (y - bottom)) / height);
    setF64(out + 16, 0);
    setF64(out + 24, across / width);
    setF64(out + 32, up / height);
    setF64(out + 40, 1);
    return 1;
}

/**
 * GLint gluProject(GLdouble objX, GLdouble objY, GLdouble objZ,
 *     const GLdouble *model, const GLdouble *proj, const GLint *viewport,
 *     GLdouble *winX, GLdouble *winY, GLdouble *winZ)
 *
 * The point through the modelview and projection matrices, divided by its w,
 * and mapped from [-1, 1] onto the viewport and onto [0, 1] in depth. A w of
 * zero has no window position: GL_FALSE, and the three outputs untouched.
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {f64} objX @param {f64} objY @param {f64} objZ
 * @param {u32} model @param {u32} proj @param {u32} viewport
 * @param {u32} winX @param {u32} winY @param {u32} winZ
 * @returns {i32}
 */
export function gluProject({ f64, i32, setF64 }, objX, objY, objZ, model, proj, viewport,
    winX, winY, winZ)
{
    const ex = f64(model) * objX + f64(model + 32) * objY + f64(model + 64) * objZ
        + f64(model + 96);
    const ey = f64(model + 8) * objX + f64(model + 40) * objY + f64(model + 72) * objZ
        + f64(model + 104);
    const ez = f64(model + 16) * objX + f64(model + 48) * objY + f64(model + 80) * objZ
        + f64(model + 112);
    const ew = f64(model + 24) * objX + f64(model + 56) * objY + f64(model + 88) * objZ
        + f64(model + 120);
    const cx = f64(proj) * ex + f64(proj + 32) * ey + f64(proj + 64) * ez + f64(proj + 96) * ew;
    const cy = f64(proj + 8) * ex + f64(proj + 40) * ey + f64(proj + 72) * ez
        + f64(proj + 104) * ew;
    const cz = f64(proj + 16) * ex + f64(proj + 48) * ey + f64(proj + 80) * ez
        + f64(proj + 112) * ew;
    const cw = f64(proj + 24) * ex + f64(proj + 56) * ey + f64(proj + 88) * ez
        + f64(proj + 120) * ew;
    if (cw === 0)
    {
        return 0;
    }
    const nx = cx / cw;
    const ny = cy / cw;
    const nz = cz / cw;
    setF64(winX, +i32(viewport) + (nx + 1) * +i32(viewport + 8) / 2);
    setF64(winY, +i32(viewport + 4) + (ny + 1) * +i32(viewport + 12) / 2);
    setF64(winZ, (nz + 1) / 2);
    return 1;
}

/**
 * A window position carried back through the inverse of `proj * model`, into
 * four doubles at `out`: the position mapped from the viewport onto [-1, 1]
 * and from [near, far] onto [-1, 1] in depth, with `clipW` as its w; the
 * product formed, inverted by its cofactors, and the point multiplied by the
 * inverse. Answers 0, and writes nothing, for a product with no inverse.
 * What gluUnProject (near 0, far 1, w 1) and gluUnProject4 share.
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} out @param {u32} model @param {u32} proj
 * @param {u32} viewport @param {f64} winX @param {f64} winY @param {f64} winZ
 * @param {f64} clipW @param {f64} near @param {f64} far
 * @returns {u32}
 */
export function gluUnProjectPoint({ f64, i32, setF64 }, out, model, proj, viewport, winX, winY,
    winZ, clipW, near, far)
{
    const x = 2 * (winX - +i32(viewport)) / +i32(viewport + 8) - 1;
    const y = 2 * (winY - +i32(viewport + 4)) / +i32(viewport + 12) - 1;
    const z = 2 * (winZ - near) / (far - near) - 1;
    const w = clipW;
    const p0 = f64(proj);
    const p1 = f64(proj + 8);
    const p2 = f64(proj + 16);
    const p3 = f64(proj + 24);
    const p4 = f64(proj + 32);
    const p5 = f64(proj + 40);
    const p6 = f64(proj + 48);
    const p7 = f64(proj + 56);
    const p8 = f64(proj + 64);
    const p9 = f64(proj + 72);
    const p10 = f64(proj + 80);
    const p11 = f64(proj + 88);
    const p12 = f64(proj + 96);
    const p13 = f64(proj + 104);
    const p14 = f64(proj + 112);
    const p15 = f64(proj + 120);
    // Column c of the product is proj times column c of model.
    let m0 = f64(model);
    let m1 = f64(model + 8);
    let m2 = f64(model + 16);
    let m3 = f64(model + 24);
    const e0 = p0 * m0 + p4 * m1 + p8 * m2 + p12 * m3;
    const e1 = p1 * m0 + p5 * m1 + p9 * m2 + p13 * m3;
    const e2 = p2 * m0 + p6 * m1 + p10 * m2 + p14 * m3;
    const e3 = p3 * m0 + p7 * m1 + p11 * m2 + p15 * m3;
    m0 = f64(model + 32);
    m1 = f64(model + 40);
    m2 = f64(model + 48);
    m3 = f64(model + 56);
    const e4 = p0 * m0 + p4 * m1 + p8 * m2 + p12 * m3;
    const e5 = p1 * m0 + p5 * m1 + p9 * m2 + p13 * m3;
    const e6 = p2 * m0 + p6 * m1 + p10 * m2 + p14 * m3;
    const e7 = p3 * m0 + p7 * m1 + p11 * m2 + p15 * m3;
    m0 = f64(model + 64);
    m1 = f64(model + 72);
    m2 = f64(model + 80);
    m3 = f64(model + 88);
    const e8 = p0 * m0 + p4 * m1 + p8 * m2 + p12 * m3;
    const e9 = p1 * m0 + p5 * m1 + p9 * m2 + p13 * m3;
    const e10 = p2 * m0 + p6 * m1 + p10 * m2 + p14 * m3;
    const e11 = p3 * m0 + p7 * m1 + p11 * m2 + p15 * m3;
    m0 = f64(model + 96);
    m1 = f64(model + 104);
    m2 = f64(model + 112);
    m3 = f64(model + 120);
    const e12 = p0 * m0 + p4 * m1 + p8 * m2 + p12 * m3;
    const e13 = p1 * m0 + p5 * m1 + p9 * m2 + p13 * m3;
    const e14 = p2 * m0 + p6 * m1 + p10 * m2 + p14 * m3;
    const e15 = p3 * m0 + p7 * m1 + p11 * m2 + p15 * m3;
    // The cofactors, in the product's own layout: the inverse's element i is
    // c_i over the determinant, whichever way round the layout is read.
    const c0 = e5 * e10 * e15 - e5 * e11 * e14 - e9 * e6 * e15
        + e9 * e7 * e14 + e13 * e6 * e11 - e13 * e7 * e10;
    const c1 = -e1 * e10 * e15 + e1 * e11 * e14 + e9 * e2 * e15
        - e9 * e3 * e14 - e13 * e2 * e11 + e13 * e3 * e10;
    const c2 = e1 * e6 * e15 - e1 * e7 * e14 - e5 * e2 * e15
        + e5 * e3 * e14 + e13 * e2 * e7 - e13 * e3 * e6;
    const c3 = -e1 * e6 * e11 + e1 * e7 * e10 + e5 * e2 * e11
        - e5 * e3 * e10 - e9 * e2 * e7 + e9 * e3 * e6;
    const c4 = -e4 * e10 * e15 + e4 * e11 * e14 + e8 * e6 * e15
        - e8 * e7 * e14 - e12 * e6 * e11 + e12 * e7 * e10;
    const c5 = e0 * e10 * e15 - e0 * e11 * e14 - e8 * e2 * e15
        + e8 * e3 * e14 + e12 * e2 * e11 - e12 * e3 * e10;
    const c6 = -e0 * e6 * e15 + e0 * e7 * e14 + e4 * e2 * e15
        - e4 * e3 * e14 - e12 * e2 * e7 + e12 * e3 * e6;
    const c7 = e0 * e6 * e11 - e0 * e7 * e10 - e4 * e2 * e11
        + e4 * e3 * e10 + e8 * e2 * e7 - e8 * e3 * e6;
    const c8 = e4 * e9 * e15 - e4 * e11 * e13 - e8 * e5 * e15
        + e8 * e7 * e13 + e12 * e5 * e11 - e12 * e7 * e9;
    const c9 = -e0 * e9 * e15 + e0 * e11 * e13 + e8 * e1 * e15
        - e8 * e3 * e13 - e12 * e1 * e11 + e12 * e3 * e9;
    const c10 = e0 * e5 * e15 - e0 * e7 * e13 - e4 * e1 * e15
        + e4 * e3 * e13 + e12 * e1 * e7 - e12 * e3 * e5;
    const c11 = -e0 * e5 * e11 + e0 * e7 * e9 + e4 * e1 * e11
        - e4 * e3 * e9 - e8 * e1 * e7 + e8 * e3 * e5;
    const c12 = -e4 * e9 * e14 + e4 * e10 * e13 + e8 * e5 * e14
        - e8 * e6 * e13 - e12 * e5 * e10 + e12 * e6 * e9;
    const c13 = e0 * e9 * e14 - e0 * e10 * e13 - e8 * e1 * e14
        + e8 * e2 * e13 + e12 * e1 * e10 - e12 * e2 * e9;
    const c14 = -e0 * e5 * e14 + e0 * e6 * e13 + e4 * e1 * e14
        - e4 * e2 * e13 - e12 * e1 * e6 + e12 * e2 * e5;
    const c15 = e0 * e5 * e10 - e0 * e6 * e9 - e4 * e1 * e10
        + e4 * e2 * e9 + e8 * e1 * e6 - e8 * e2 * e5;
    const det = e0 * c0 + e1 * c4 + e2 * c8 + e3 * c12;
    if (det === 0)
    {
        return 0;
    }
    setF64(out, (c0 * x + c4 * y + c8 * z + c12 * w) / det);
    setF64(out + 8, (c1 * x + c5 * y + c9 * z + c13 * w) / det);
    setF64(out + 16, (c2 * x + c6 * y + c10 * z + c14 * w) / det);
    setF64(out + 24, (c3 * x + c7 * y + c11 * z + c15 * w) / det);
    return 1;
}

/**
 * gluUnProject's last step: the point `gluUnProjectPoint` left divided by its
 * w into the three outputs, or GL_FALSE, the outputs untouched, for a w of
 * zero, which names no point.
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} point @param {u32} objX @param {u32} objY
 * @param {u32} objZ
 * @returns {i32}
 */
export function gluUnProjectDivide({ f64, setF64 }, point, objX, objY, objZ){
    const w = f64(point + 24);
    if (w === 0)
    {
        return 0;
    }
    const x = f64(point) / w;
    const y = f64(point + 8) / w;
    const z = f64(point + 16) / w;
    setF64(objX, x);
    setF64(objY, y);
    setF64(objZ, z);
    return 1;
}

/**
 * gluUnProject4's last step: the point `gluUnProjectPoint` left, as it is,
 * into the four outputs -- its bits moved, not loaded and stored.
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} point @param {u32} objX @param {u32} objY
 * @param {u32} objZ @param {u32} objW
 * @returns {i32}
 */
export function gluUnProjectStore({ u32, setU32 }, point, objX, objY, objZ, objW){
    const x0 = u32(point);
    const x1 = u32(point + 4);
    const y0 = u32(point + 8);
    const y1 = u32(point + 12);
    const z0 = u32(point + 16);
    const z1 = u32(point + 20);
    const w0 = u32(point + 24);
    const w1 = u32(point + 28);
    setU32(objX, x0);
    setU32(objX + 4, x1);
    setU32(objY, y0);
    setU32(objY + 4, y1);
    setU32(objZ, z0);
    setU32(objZ + 4, z1);
    setU32(objW, w0);
    setU32(objW + 4, w1);
    return 1;
}

/**
 * GLint gluCheckExtension(const GLubyte *extName, const GLubyte *extString)
 *
 * Whether the name is one of the space-separated words of the string, whole:
 * a word that only begins with the name is not the name. An empty name, and
 * a null pointer for either, are not found.
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} name @param {u32} string
 * @returns {u32}
 */
export function gluCheckExtension({ u8 }, name, string){
    if (name === 0 || string === 0 || u8(name) === 0)
    {
        return 0;
    }
    let at = string;
    while (u8(at) !== 0)
    {
        if (u8(at) === 32)
        {
            at++;
            continue;
        }
        let i = 0;
        while (u8(name + i) !== 0 && u8(name + i) === u8(at + i))
        {
            i++;
        }
        if (u8(name + i) === 0 && (u8(at + i) === 0 || u8(at + i) === 32))
        {
            return 1;
        }
        while (u8(at) !== 0 && u8(at) !== 32)
        {
            at++;
        }
    }
    return 0;
}
