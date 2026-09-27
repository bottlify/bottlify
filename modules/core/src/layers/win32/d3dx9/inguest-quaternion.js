/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * d3dx9's quaternions as code in the guest's own d3dx9, written once: each
 * `@guestCode` function here is compiled by the build
 * (`scripts/guest-code/compile.mjs`) into `inguest-quaternion.x86.js`, and
 * is itself the export's handler and the reference its x86 is held to.
 *
 * As in `inguest.js`: floats are read, computed on the x87 under the
 * precision control the program set, and stored rounded to nearest, every
 * input read before an output is written. A quaternion is (x, y, z, w), w
 * the real part, used as it is -- none is normalised on the way in.
 * D3DXQuaternionMultiply(a, b) is the rotation a followed by b, the
 * product b a.
 *
 * The library's forms, as Wine's conformance tests pin them: the logarithm
 * of (v, w) is (v acos(w) / sin(acos(w)), 0) for |w| below 1 and (v, 0)
 * otherwise, whatever v's length; the exponential of (v, w) is (v sin|v| /
 * |v|, cos|v|), w unused. A slerp takes the nearer of q2 and -q2 and is a
 * straight line where the two are no apart (a product of 1 or more, which
 * quaternions that are not unit ones reach). An angle reaches `fsin` and
 * `fcos` below 2^63 in magnitude, reduced by 2π with `fprem` past it.
 */

/** @typedef {import('../msvcrt/guest-code.js').Guest} Guest */
/** @typedef {import('../msvcrt/guest-code.js').u32} u32 */
/** @typedef {import('../msvcrt/guest-code.js').f32} f32 */
/** @typedef {import('../msvcrt/guest-code.js').f64} f64 */

/** Where `fsin` and `fcos` stop reducing their argument. */
const REDUCED = 2 ** 63;

/** 2π, the double nearest it. */
const TWO_PI = 6.283185307179586;

/** An angle the x87's sine and cosine take: itself below 2^63, its remainder by 2π past it. */
const turn = (/** @type {number} */ a)=>(Math.abs(a) < REDUCED ? a : a % TWO_PI);

/** The reciprocal of a length, or 0 for a length of 0: what normalising multiplies by. */
const inverseOf = (/** @type {number} */ length)=>(length === 0 ? 0 : 1 / length);

/** What the logarithm scales v by: acos(w) / sin(acos(w)) for |w| below 1, else 1. */
const lnScale = (/** @type {number} */ w)=>(Math.abs(w) < 1
    ? Math.atan2(Math.sqrt((1 - w) * (1 + w)), w) / Math.sqrt((1 - w) * (1 + w)) : 1);

/** What the exponential scales v by: sin|v| / |v|, or 1 for a v of length 0. */
const expScale = (/** @type {number} */ n)=>(n === 0 ? 1 : Math.sin(turn(n)) / n);

/**
 * D3DXQuaternionMultiply(a, b)'s four: the product b a.
 *
 * @param {number} ax @param {number} ay @param {number} az @param {number} aw
 * @param {number} bx @param {number} by @param {number} bz @param {number} bw
 */
const mulX = (ax, ay, az, aw, bx, by, bz, bw)=>bw * ax + bx * aw + by * az - bz * ay;
/** @param {number} ax @param {number} ay @param {number} az @param {number} aw
 *  @param {number} bx @param {number} by @param {number} bz @param {number} bw */
const mulY = (ax, ay, az, aw, bx, by, bz, bw)=>bw * ay - bx * az + by * aw + bz * ax;
/** @param {number} ax @param {number} ay @param {number} az @param {number} aw
 *  @param {number} bx @param {number} by @param {number} bz @param {number} bw */
const mulZ = (ax, ay, az, aw, bx, by, bz, bw)=>bw * az + bx * ay - by * ax + bz * aw;
/** @param {number} ax @param {number} ay @param {number} az @param {number} aw
 *  @param {number} bx @param {number} by @param {number} bz @param {number} bw */
const mulW = (ax, ay, az, aw, bx, by, bz, bw)=>bw * aw - bx * ax - by * ay - bz * az;

/**
 * D3DXQUATERNION *D3DXQuaternionMultiply(D3DXQUATERNION *out,
 *     const D3DXQUATERNION *a, const D3DXQUATERNION *b) -- a then b: b a.
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} out @param {u32} a @param {u32} b
 * @returns {u32}
 */
export function D3DXQuaternionMultiply({ f32, setF32 }, out, a, b){
    const ax = f32(a);
    const ay = f32(a + 4);
    const az = f32(a + 8);
    const aw = f32(a + 12);
    const bx = f32(b);
    const by = f32(b + 4);
    const bz = f32(b + 8);
    const bw = f32(b + 12);
    const rx = mulX(ax, ay, az, aw, bx, by, bz, bw);
    const ry = mulY(ax, ay, az, aw, bx, by, bz, bw);
    const rz = mulZ(ax, ay, az, aw, bx, by, bz, bw);
    const rw = mulW(ax, ay, az, aw, bx, by, bz, bw);
    setF32(out, rx);
    setF32(out + 4, ry);
    setF32(out + 8, rz);
    setF32(out + 12, rw);
    return out;
}

/**
 * D3DXQUATERNION *D3DXQuaternionNormalize(D3DXQUATERNION *out,
 *     const D3DXQUATERNION *q)
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} out @param {u32} q
 * @returns {u32}
 */
export function D3DXQuaternionNormalize({ f32, setF32 }, out, q){
    const qx = f32(q);
    const qy = f32(q + 4);
    const qz = f32(q + 8);
    const qw = f32(q + 12);
    const scale = inverseOf(Math.sqrt(qx * qx + qy * qy + qz * qz + qw * qw));
    setF32(out, qx * scale);
    setF32(out + 4, qy * scale);
    setF32(out + 8, qz * scale);
    setF32(out + 12, qw * scale);
    return out;
}

/**
 * D3DXQUATERNION *D3DXQuaternionInverse(D3DXQUATERNION *out,
 *     const D3DXQUATERNION *q) -- the conjugate over the squared length.
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} out @param {u32} q
 * @returns {u32}
 */
export function D3DXQuaternionInverse({ f32, setF32 }, out, q){
    const qx = f32(q);
    const qy = f32(q + 4);
    const qz = f32(q + 8);
    const qw = f32(q + 12);
    const norm = qx * qx + qy * qy + qz * qz + qw * qw;
    setF32(out, -qx / norm);
    setF32(out + 4, -qy / norm);
    setF32(out + 8, -qz / norm);
    setF32(out + 12, qw / norm);
    return out;
}

/**
 * D3DXQUATERNION *D3DXQuaternionLn(D3DXQUATERNION *out, const D3DXQUATERNION *q)
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} out @param {u32} q
 * @returns {u32}
 */
export function D3DXQuaternionLn({ f32, setU32, setF32 }, out, q){
    const qx = f32(q);
    const qy = f32(q + 4);
    const qz = f32(q + 8);
    const qw = f32(q + 12);
    const scale = lnScale(qw);
    setF32(out, qx * scale);
    setF32(out + 4, qy * scale);
    setF32(out + 8, qz * scale);
    setU32(out + 12, 0);
    return out;
}

/**
 * D3DXQUATERNION *D3DXQuaternionExp(D3DXQUATERNION *out, const D3DXQUATERNION *q)
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} out @param {u32} q
 * @returns {u32}
 */
export function D3DXQuaternionExp({ f32, setF32 }, out, q){
    const qx = f32(q);
    const qy = f32(q + 4);
    const qz = f32(q + 8);
    const n = Math.sqrt(qx * qx + qy * qy + qz * qz);
    const scale = expScale(n);
    const w = Math.cos(turn(n));
    setF32(out, qx * scale);
    setF32(out + 4, qy * scale);
    setF32(out + 8, qz * scale);
    setF32(out + 12, w);
    return out;
}

/**
 * D3DXQUATERNION *D3DXQuaternionRotationAxis(D3DXQUATERNION *out,
 *     const D3DXVECTOR3 *v, FLOAT angle) -- the axis normalised times the
 * sine of half the angle, and its cosine.
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} out @param {u32} v @param {f32} angle
 * @returns {u32}
 */
export function D3DXQuaternionRotationAxis({ f32, setF32 }, out, v, angle){
    const vx = f32(v);
    const vy = f32(v + 4);
    const vz = f32(v + 8);
    const scale = inverseOf(Math.sqrt(vx * vx + vy * vy + vz * vz));
    const half = turn(angle / 2);
    const s = Math.sin(half);
    const c = Math.cos(half);
    setF32(out, vx * scale * s);
    setF32(out + 4, vy * scale * s);
    setF32(out + 8, vz * scale * s);
    setF32(out + 12, c);
    return out;
}

/**
 * D3DXQUATERNION *D3DXQuaternionRotationYawPitchRoll(D3DXQUATERNION *out,
 *     FLOAT yaw, FLOAT pitch, FLOAT roll) -- the rotation
 * D3DXMatrixRotationYawPitchRoll makes, from the halves of the three.
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} out @param {f32} yaw @param {f32} pitch @param {f32} roll
 * @returns {u32}
 */
export function D3DXQuaternionRotationYawPitchRoll({ setF32 }, out, yaw, pitch, roll){
    const y = turn(yaw / 2);
    const p = turn(pitch / 2);
    const r = turn(roll / 2);
    const sy = Math.sin(y);
    const cy = Math.cos(y);
    const sp = Math.sin(p);
    const cp = Math.cos(p);
    const sr = Math.sin(r);
    const cr = Math.cos(r);
    setF32(out, cy * sp * cr + sy * cp * sr);
    setF32(out + 4, sy * cp * cr - cy * sp * sr);
    setF32(out + 8, cy * cp * sr - sy * sp * cr);
    setF32(out + 12, cy * cp * cr + sy * sp * sr);
    return out;
}

/**
 * D3DXQUATERNION *D3DXQuaternionRotationMatrix(D3DXQUATERNION *out,
 *     const D3DXMATRIX *m) -- from the upper 3x3 as it is: where the diagonal
 * sums above 0, w is half the root of the sum and 1; otherwise the largest
 * diagonal element names the component so found (the first of equals), and
 * the others follow from the sums and differences of the off-diagonal
 * pairs.
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} out @param {u32} m
 * @returns {u32}
 */
export function D3DXQuaternionRotationMatrix({ f32, setF32 }, out, m){
    const m00 = f32(m);
    const m01 = f32(m + 4);
    const m02 = f32(m + 8);
    const m10 = f32(m + 16);
    const m11 = f32(m + 20);
    const m12 = f32(m + 24);
    const m20 = f32(m + 32);
    const m21 = f32(m + 36);
    const m22 = f32(m + 40);
    if (m00 + m11 + m22 > 0)
    {
        const t = 2 * Math.sqrt(m00 + m11 + m22 + 1);
        setF32(out, (m12 - m21) / t);
        setF32(out + 4, (m20 - m02) / t);
        setF32(out + 8, (m01 - m10) / t);
        setF32(out + 12, t / 4);
    }
    else if (m00 >= m11 && m00 >= m22)
    {
        const t = 2 * Math.sqrt(1 + m00 - m11 - m22);
        setF32(out, t / 4);
        setF32(out + 4, (m01 + m10) / t);
        setF32(out + 8, (m02 + m20) / t);
        setF32(out + 12, (m12 - m21) / t);
    }
    else if (m11 >= m22)
    {
        const t = 2 * Math.sqrt(1 + m11 - m00 - m22);
        setF32(out, (m01 + m10) / t);
        setF32(out + 4, t / 4);
        setF32(out + 8, (m12 + m21) / t);
        setF32(out + 12, (m20 - m02) / t);
    }
    else
    {
        const t = 2 * Math.sqrt(1 + m22 - m00 - m11);
        setF32(out, (m02 + m20) / t);
        setF32(out + 4, (m12 + m21) / t);
        setF32(out + 8, t / 4);
        setF32(out + 12, (m01 - m10) / t);
    }
    return out;
}

/**
 * void D3DXQuaternionToAxisAngle(const D3DXQUATERNION *q, D3DXVECTOR3 *axis,
 *     FLOAT *angle) -- the axis (x, y, z) as it is, the angle twice the
 * arccosine of w; either pointer may be NULL.
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} q @param {u32} axis @param {u32} angle
 * @returns {void}
 */
export function D3DXQuaternionToAxisAngle({ f32, u32, setU32, setF32 }, q, axis, angle){
    const x = u32(q);
    const y = u32(q + 4);
    const z = u32(q + 8);
    const w = f32(q + 12);
    if (axis !== 0)
    {
        setU32(axis, x);
        setU32(axis + 4, y);
        setU32(axis + 8, z);
    }
    if (angle !== 0)
    {
        setF32(angle, 2 * Math.atan2(Math.sqrt((1 - w) * (1 + w)), w));
    }
}

/**
 * D3DXQUATERNION *D3DXQuaternionSlerp(D3DXQUATERNION *out,
 *     const D3DXQUATERNION *q1, const D3DXQUATERNION *q2, FLOAT t)
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} out @param {u32} q1 @param {u32} q2 @param {f32} t
 * @returns {u32}
 */
export function D3DXQuaternionSlerp({ f32, setF32 }, out, q1, q2, t){
    const ax = f32(q1);
    const ay = f32(q1 + 4);
    const az = f32(q1 + 8);
    const aw = f32(q1 + 12);
    const bx = f32(q2);
    const by = f32(q2 + 4);
    const bz = f32(q2 + 8);
    const bw = f32(q2 + 12);
    /** @type {f64} */
    let abDot = ax * bx + ay * by + az * bz + aw * bw;
    /** @type {f64} */
    let abSign = 1;
    if (abDot < 0)
    {
        abDot = -abDot;
        abSign = -1;
    }
    /** @type {f64} */
    let abA = 1 - t;
    /** @type {f64} */
    let abB = t;
    if (abDot < 1)
    {
        const sine = Math.sqrt((1 - abDot) * (1 + abDot));
        const theta = Math.atan2(sine, abDot);
        abA = Math.sin(turn((1 - t) * theta)) / sine;
        abB = Math.sin(turn(t * theta)) / sine;
    }
    abB = abB * abSign;
    const rx = abA * ax + abB * bx;
    const ry = abA * ay + abB * by;
    const rz = abA * az + abB * bz;
    const rw = abA * aw + abB * bw;
    setF32(out, rx);
    setF32(out + 4, ry);
    setF32(out + 8, rz);
    setF32(out + 12, rw);
    return out;
}

/**
 * D3DXQUATERNION *D3DXQuaternionSquad(D3DXQUATERNION *out,
 *     const D3DXQUATERNION *q1, const D3DXQUATERNION *a, const D3DXQUATERNION *b,
 *     const D3DXQUATERNION *c, FLOAT t) --
 * Slerp(Slerp(q1, c, t), Slerp(a, b, t), 2t(1 - t)).
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} out @param {u32} q1 @param {u32} a @param {u32} b
 * @param {u32} c @param {f32} t
 * @returns {u32}
 */
export function D3DXQuaternionSquad({ f32, setF32 }, out, q1, a, b, c, t){
    const px = f32(q1);
    const py = f32(q1 + 4);
    const pz = f32(q1 + 8);
    const pw = f32(q1 + 12);
    const ax = f32(a);
    const ay = f32(a + 4);
    const az = f32(a + 8);
    const aw = f32(a + 12);
    const bx = f32(b);
    const by = f32(b + 4);
    const bz = f32(b + 8);
    const bw = f32(b + 12);
    const cx = f32(c);
    const cy = f32(c + 4);
    const cz = f32(c + 8);
    const cw = f32(c + 12);
    /** @type {f64} */
    let pcDot = px * cx + py * cy + pz * cz + pw * cw;
    /** @type {f64} */
    let pcSign = 1;
    if (pcDot < 0)
    {
        pcDot = -pcDot;
        pcSign = -1;
    }
    /** @type {f64} */
    let pcA = 1 - t;
    /** @type {f64} */
    let pcB = t;
    if (pcDot < 1)
    {
        const sine = Math.sqrt((1 - pcDot) * (1 + pcDot));
        const theta = Math.atan2(sine, pcDot);
        pcA = Math.sin(turn((1 - t) * theta)) / sine;
        pcB = Math.sin(turn(t * theta)) / sine;
    }
    pcB = pcB * pcSign;
    const ux = pcA * px + pcB * cx;
    const uy = pcA * py + pcB * cy;
    const uz = pcA * pz + pcB * cz;
    const uw = pcA * pw + pcB * cw;
    /** @type {f64} */
    let abDot = ax * bx + ay * by + az * bz + aw * bw;
    /** @type {f64} */
    let abSign = 1;
    if (abDot < 0)
    {
        abDot = -abDot;
        abSign = -1;
    }
    /** @type {f64} */
    let abA = 1 - t;
    /** @type {f64} */
    let abB = t;
    if (abDot < 1)
    {
        const sine = Math.sqrt((1 - abDot) * (1 + abDot));
        const theta = Math.atan2(sine, abDot);
        abA = Math.sin(turn((1 - t) * theta)) / sine;
        abB = Math.sin(turn(t * theta)) / sine;
    }
    abB = abB * abSign;
    const vx = abA * ax + abB * bx;
    const vy = abA * ay + abB * by;
    const vz = abA * az + abB * bz;
    const vw = abA * aw + abB * bw;
    const s = 2 * t * (1 - t);
    /** @type {f64} */
    let uvDot = ux * vx + uy * vy + uz * vz + uw * vw;
    /** @type {f64} */
    let uvSign = 1;
    if (uvDot < 0)
    {
        uvDot = -uvDot;
        uvSign = -1;
    }
    /** @type {f64} */
    let uvA = 1 - s;
    /** @type {f64} */
    let uvB = s;
    if (uvDot < 1)
    {
        const sine = Math.sqrt((1 - uvDot) * (1 + uvDot));
        const theta = Math.atan2(sine, uvDot);
        uvA = Math.sin(turn((1 - s) * theta)) / sine;
        uvB = Math.sin(turn(s * theta)) / sine;
    }
    uvB = uvB * uvSign;
    const rx = uvA * ux + uvB * vx;
    const ry = uvA * uy + uvB * vy;
    const rz = uvA * uz + uvB * vz;
    const rw = uvA * uw + uvB * vw;
    setF32(out, rx);
    setF32(out + 4, ry);
    setF32(out + 8, rz);
    setF32(out + 12, rw);
    return out;
}

/**
 * D3DXQUATERNION *D3DXQuaternionBaryCentric(D3DXQUATERNION *out,
 *     const D3DXQUATERNION *q1, const D3DXQUATERNION *q2,
 *     const D3DXQUATERNION *q3, FLOAT f, FLOAT g) --
 * Slerp(Slerp(q1, q2, f + g), Slerp(q1, q3, f + g), g / (f + g)); q1 itself
 * where f + g is 0, the limit of the two.
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} out @param {u32} q1 @param {u32} q2 @param {u32} q3
 * @param {f32} f @param {f32} g
 * @returns {u32}
 */
export function D3DXQuaternionBaryCentric({ f32, setF32 }, out, q1, q2, q3, f, g){
    const px = f32(q1);
    const py = f32(q1 + 4);
    const pz = f32(q1 + 8);
    const pw = f32(q1 + 12);
    const ax = f32(q2);
    const ay = f32(q2 + 4);
    const az = f32(q2 + 8);
    const aw = f32(q2 + 12);
    const bx = f32(q3);
    const by = f32(q3 + 4);
    const bz = f32(q3 + 8);
    const bw = f32(q3 + 12);
    const s = f + g;
    if (s === 0)
    {
        setF32(out, px);
        setF32(out + 4, py);
        setF32(out + 8, pz);
        setF32(out + 12, pw);
        return out;
    }
    /** @type {f64} */
    let paDot = px * ax + py * ay + pz * az + pw * aw;
    /** @type {f64} */
    let paSign = 1;
    if (paDot < 0)
    {
        paDot = -paDot;
        paSign = -1;
    }
    /** @type {f64} */
    let paA = 1 - s;
    /** @type {f64} */
    let paB = s;
    if (paDot < 1)
    {
        const sine = Math.sqrt((1 - paDot) * (1 + paDot));
        const theta = Math.atan2(sine, paDot);
        paA = Math.sin(turn((1 - s) * theta)) / sine;
        paB = Math.sin(turn(s * theta)) / sine;
    }
    paB = paB * paSign;
    const ux = paA * px + paB * ax;
    const uy = paA * py + paB * ay;
    const uz = paA * pz + paB * az;
    const uw = paA * pw + paB * aw;
    /** @type {f64} */
    let pbDot = px * bx + py * by + pz * bz + pw * bw;
    /** @type {f64} */
    let pbSign = 1;
    if (pbDot < 0)
    {
        pbDot = -pbDot;
        pbSign = -1;
    }
    /** @type {f64} */
    let pbA = 1 - s;
    /** @type {f64} */
    let pbB = s;
    if (pbDot < 1)
    {
        const sine = Math.sqrt((1 - pbDot) * (1 + pbDot));
        const theta = Math.atan2(sine, pbDot);
        pbA = Math.sin(turn((1 - s) * theta)) / sine;
        pbB = Math.sin(turn(s * theta)) / sine;
    }
    pbB = pbB * pbSign;
    const vx = pbA * px + pbB * bx;
    const vy = pbA * py + pbB * by;
    const vz = pbA * pz + pbB * bz;
    const vw = pbA * pw + pbB * bw;
    const k = g / s;
    /** @type {f64} */
    let uvDot = ux * vx + uy * vy + uz * vz + uw * vw;
    /** @type {f64} */
    let uvSign = 1;
    if (uvDot < 0)
    {
        uvDot = -uvDot;
        uvSign = -1;
    }
    /** @type {f64} */
    let uvA = 1 - k;
    /** @type {f64} */
    let uvB = k;
    if (uvDot < 1)
    {
        const sine = Math.sqrt((1 - uvDot) * (1 + uvDot));
        const theta = Math.atan2(sine, uvDot);
        uvA = Math.sin(turn((1 - k) * theta)) / sine;
        uvB = Math.sin(turn(k * theta)) / sine;
    }
    uvB = uvB * uvSign;
    const rx = uvA * ux + uvB * vx;
    const ry = uvA * uy + uvB * vy;
    const rz = uvA * uz + uvB * vz;
    const rw = uvA * uw + uvB * vw;
    setF32(out, rx);
    setF32(out + 4, ry);
    setF32(out + 8, rz);
    setF32(out + 12, rw);
    return out;
}

/**
 * void D3DXQuaternionSquadSetup(D3DXQUATERNION *aOut, D3DXQUATERNION *bOut,
 *     D3DXQUATERNION *cOut, const D3DXQUATERNION *q0, const D3DXQUATERNION *q1,
 *     const D3DXQUATERNION *q2, const D3DXQUATERNION *q3)
 *
 * The control points D3DXQuaternionSquad takes between q1 and q2: q0, q2
 * and q3 each turned to the side of their predecessor (negated where
 * |p + q| < |p - q|), then A = q1 exp(-(ln(q1^-1 q2) + ln(q1^-1 q0)) / 4),
 * B = q2 exp(-(ln(q2^-1 q3) + ln(q2^-1 q1)) / 4) and C = q2, the inverses
 * true ones (the conjugate over the squared length).
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} aOut @param {u32} bOut @param {u32} cOut @param {u32} q0
 * @param {u32} q1 @param {u32} q2 @param {u32} q3
 * @returns {void}
 */
export function D3DXQuaternionSquadSetup({ f32, setF32 }, aOut, bOut, cOut, q0, q1, q2, q3){
    const px = f32(q0);
    const py = f32(q0 + 4);
    const pz = f32(q0 + 8);
    const pw = f32(q0 + 12);
    const ax = f32(q1);
    const ay = f32(q1 + 4);
    const az = f32(q1 + 8);
    const aw = f32(q1 + 12);
    const qx = f32(q2);
    const qy = f32(q2 + 4);
    const qz = f32(q2 + 8);
    const qw = f32(q2 + 12);
    const rx = f32(q3);
    const ry = f32(q3 + 4);
    const rz = f32(q3 + 8);
    const rw = f32(q3 + 12);
    const k0Sum = (px + ax) * (px + ax)
        + (py + ay) * (py + ay)
        + (pz + az) * (pz + az)
        + (pw + aw) * (pw + aw);
    const k0Difference = (px - ax) * (px - ax)
        + (py - ay) * (py - ay)
        + (pz - az) * (pz - az)
        + (pw - aw) * (pw - aw);
    const k0 = k0Sum < k0Difference ? -1 : 1;
    const k2Sum = (ax + qx) * (ax + qx)
        + (ay + qy) * (ay + qy)
        + (az + qz) * (az + qz)
        + (aw + qw) * (aw + qw);
    const k2Difference = (ax - qx) * (ax - qx)
        + (ay - qy) * (ay - qy)
        + (az - qz) * (az - qz)
        + (aw - qw) * (aw - qw);
    const k2 = k2Sum < k2Difference ? -1 : 1;
    const cx = qx * k2;
    const cy = qy * k2;
    const cz = qz * k2;
    const cw = qw * k2;
    const k3Sum = (cx + rx) * (cx + rx)
        + (cy + ry) * (cy + ry)
        + (cz + rz) * (cz + rz)
        + (cw + rw) * (cw + rw);
    const k3Difference = (cx - rx) * (cx - rx)
        + (cy - ry) * (cy - ry)
        + (cz - rz) * (cz - rz)
        + (cw - rw) * (cw - rw);
    const k3 = k3Sum < k3Difference ? -1 : 1;
    const dx = rx * k3;
    const dy = ry * k3;
    const dz = rz * k3;
    const dw = rw * k3;
    const ex = px * k0;
    const ey = py * k0;
    const ez = pz * k0;
    const ew = pw * k0;
    const aNorm = ax * ax + ay * ay + az * az + aw * aw;
    const aIx = -ax / aNorm;
    const aIy = -ay / aNorm;
    const aIz = -az / aNorm;
    const aIw = aw / aNorm;
    const aPx = mulX(aIx, aIy, aIz, aIw, cx, cy, cz, cw);
    const aPy = mulY(aIx, aIy, aIz, aIw, cx, cy, cz, cw);
    const aPz = mulZ(aIx, aIy, aIz, aIw, cx, cy, cz, cw);
    const aPw = mulW(aIx, aIy, aIz, aIw, cx, cy, cz, cw);
    const aQx = mulX(aIx, aIy, aIz, aIw, ex, ey, ez, ew);
    const aQy = mulY(aIx, aIy, aIz, aIw, ex, ey, ez, ew);
    const aQz = mulZ(aIx, aIy, aIz, aIw, ex, ey, ez, ew);
    const aQw = mulW(aIx, aIy, aIz, aIw, ex, ey, ez, ew);
    const aPf = lnScale(aPw);
    const aQf = lnScale(aQw);
    const aEx = -0.25 * (aPx * aPf + aQx * aQf);
    const aEy = -0.25 * (aPy * aPf + aQy * aQf);
    const aEz = -0.25 * (aPz * aPf + aQz * aQf);
    const aN = Math.sqrt(aEx * aEx + aEy * aEy + aEz * aEz);
    const aS = expScale(aN);
    const aKx = aEx * aS;
    const aKy = aEy * aS;
    const aKz = aEz * aS;
    const aKw = Math.cos(turn(aN));
    const ux = mulX(ax, ay, az, aw, aKx, aKy, aKz, aKw);
    const uy = mulY(ax, ay, az, aw, aKx, aKy, aKz, aKw);
    const uz = mulZ(ax, ay, az, aw, aKx, aKy, aKz, aKw);
    const uw = mulW(ax, ay, az, aw, aKx, aKy, aKz, aKw);
    const bNorm = cx * cx + cy * cy + cz * cz + cw * cw;
    const bIx = -cx / bNorm;
    const bIy = -cy / bNorm;
    const bIz = -cz / bNorm;
    const bIw = cw / bNorm;
    const bPx = mulX(bIx, bIy, bIz, bIw, dx, dy, dz, dw);
    const bPy = mulY(bIx, bIy, bIz, bIw, dx, dy, dz, dw);
    const bPz = mulZ(bIx, bIy, bIz, bIw, dx, dy, dz, dw);
    const bPw = mulW(bIx, bIy, bIz, bIw, dx, dy, dz, dw);
    const bQx = mulX(bIx, bIy, bIz, bIw, ax, ay, az, aw);
    const bQy = mulY(bIx, bIy, bIz, bIw, ax, ay, az, aw);
    const bQz = mulZ(bIx, bIy, bIz, bIw, ax, ay, az, aw);
    const bQw = mulW(bIx, bIy, bIz, bIw, ax, ay, az, aw);
    const bPf = lnScale(bPw);
    const bQf = lnScale(bQw);
    const bEx = -0.25 * (bPx * bPf + bQx * bQf);
    const bEy = -0.25 * (bPy * bPf + bQy * bQf);
    const bEz = -0.25 * (bPz * bPf + bQz * bQf);
    const bN = Math.sqrt(bEx * bEx + bEy * bEy + bEz * bEz);
    const bS = expScale(bN);
    const bKx = bEx * bS;
    const bKy = bEy * bS;
    const bKz = bEz * bS;
    const bKw = Math.cos(turn(bN));
    const vx = mulX(cx, cy, cz, cw, bKx, bKy, bKz, bKw);
    const vy = mulY(cx, cy, cz, cw, bKx, bKy, bKz, bKw);
    const vz = mulZ(cx, cy, cz, cw, bKx, bKy, bKz, bKw);
    const vw = mulW(cx, cy, cz, cw, bKx, bKy, bKz, bKw);
    setF32(aOut, ux);
    setF32(aOut + 4, uy);
    setF32(aOut + 8, uz);
    setF32(aOut + 12, uw);
    setF32(bOut, vx);
    setF32(bOut + 4, vy);
    setF32(bOut + 8, vz);
    setF32(bOut + 12, vw);
    setF32(cOut, cx);
    setF32(cOut + 4, cy);
    setF32(cOut + 8, cz);
    setF32(cOut + 12, cw);
}
