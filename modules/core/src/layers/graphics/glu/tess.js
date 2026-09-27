/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * GLU's polygon tessellator, for contours that do not cross one another.
 *
 * A program hands over contours, each a loop of vertices with a pointer of
 * its own beside each; the tessellator answers with triangles (or, under
 * GLU_TESS_BOUNDARY_ONLY, the loops that bound the filled region) through the
 * program's callbacks, naming each vertex by its pointer. Which regions are
 * filled is the winding rule's: a region's winding number is the sum of the
 * orientations of the contours around it.
 *
 * What is done here: contours are projected onto the plane of the normal the
 * program gave (or the one Newell's method finds), nested by containment, and
 * each filled region -- its contour and the contours directly inside it as
 * holes -- is cut into triangles by clipping ears, the holes first joined to
 * the outside by bridges. Triangles are counter-clockwise about the normal, as
 * the specification promises, and an edge flag is true exactly for an edge on
 * a contour the program drew.
 *
 * What is not: contours that cross or touch themselves or each other. The
 * specification has the tessellator make a new vertex at each crossing and
 * ask the program's combine callback for its data; that is not done here.
 * Such input is found before anything is drawn and answered with
 * GLU_TESS_NEED_COMBINE_CALLBACK where the program has no combine callback,
 * as GLU answers it, and with nothing drawn and a divergence where it has one.
 */

export const TESS = Object.freeze({
    BEGIN: 100100,
    VERTEX: 100101,
    END: 100102,
    ERROR: 100103,
    EDGE_FLAG: 100104,
    COMBINE: 100105,
    BEGIN_DATA: 100106,
    VERTEX_DATA: 100107,
    END_DATA: 100108,
    ERROR_DATA: 100109,
    EDGE_FLAG_DATA: 100110,
    COMBINE_DATA: 100111,
    WINDING_ODD: 100130,
    WINDING_NONZERO: 100131,
    WINDING_POSITIVE: 100132,
    WINDING_NEGATIVE: 100133,
    WINDING_ABS_GEQ_TWO: 100134,
    WINDING_RULE: 100140,
    BOUNDARY_ONLY: 100141,
    TOLERANCE: 100142,
    MISSING_BEGIN_POLYGON: 100151,
    MISSING_BEGIN_CONTOUR: 100152,
    MISSING_END_POLYGON: 100153,
    MISSING_END_CONTOUR: 100154,
    COORD_TOO_LARGE: 100155,
    NEED_COMBINE_CALLBACK: 100156,
    MAX_COORD: 1.0e150,
});

/**
 * @typedef {Object} TessVertex
 * @property {number} x @property {number} y @property {number} z
 * @property {number} data  The pointer the program passed with it.
 */

/**
 * @typedef {Object} Corner  A vertex in the plane.
 * @property {number} u @property {number} v
 * @property {TessVertex} vertex
 * @property {boolean} [edge]  Whether the edge from it to the next is one the program drew.
 */

/** @param {number} rule @param {number} winding */
export function inside(rule, winding){
    switch (rule)
    {
        case TESS.WINDING_ODD: return (winding & 1) !== 0;
        case TESS.WINDING_NONZERO: return winding !== 0;
        case TESS.WINDING_POSITIVE: return winding > 0;
        case TESS.WINDING_NEGATIVE: return winding < 0;
        case TESS.WINDING_ABS_GEQ_TWO: return Math.abs(winding) >= 2;
        default: return false;
    }
}

/** @param {Corner[]} ring */
const area = ring=>{
    let sum = 0;
    for (let i = 0; i < ring.length; i++)
    {
        const a = ring[i];
        const b = ring[(i + 1) % ring.length];
        sum += a.u * b.v - b.u * a.v;
    }
    return sum / 2;
};

/** @param {Corner} a @param {Corner} b @param {Corner} c  Twice the signed area of abc. */
const cross = (a, b, c)=>(b.u - a.u) * (c.v - a.v) - (b.v - a.v) * (c.u - a.u);

/** Whether p is inside the ring, by the crossings of a ray to +u. @param {Corner} p @param {Corner[]} ring */
const contains = (p, ring)=>{
    let odd = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++)
    {
        const a = ring[i];
        const b = ring[j];
        if ((a.v > p.v) !== (b.v > p.v)
            && p.u < (b.u - a.u) * (p.v - a.v) / (b.v - a.v) + a.u)
        {
            odd = !odd;
        }
    }
    return odd;
};

/** Whether segments ab and cd cross at a point inside both. @param {Corner} a @param {Corner} b @param {Corner} c @param {Corner} d */
const crosses = (a, b, c, d)=>{
    const d1 = cross(c, d, a);
    const d2 = cross(c, d, b);
    const d3 = cross(a, b, c);
    const d4 = cross(a, b, d);
    return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
};

/**
 * The plane the contours are drawn in: the normal given, or Newell's normal
 * of them all, and the projection onto the two axes the normal is least
 * along, turned so that a counter-clockwise turn about the normal is one in
 * the plane. Null for contours with no area at all.
 *
 * @param {TessVertex[][]} contours @param {number[]} given
 * @returns {((p: TessVertex) => { u: number, v: number }) | null}
 */
export function projection(contours, given){
    let [nx, ny, nz] = given;
    if (nx === 0 && ny === 0 && nz === 0)
    {
        for (const contour of contours)
        {
            for (let i = 0; i < contour.length; i++)
            {
                const a = contour[i];
                const b = contour[(i + 1) % contour.length];
                nx += (a.y - b.y) * (a.z + b.z);
                ny += (a.z - b.z) * (a.x + b.x);
                nz += (a.x - b.x) * (a.y + b.y);
            }
        }
    }
    if (nx === 0 && ny === 0 && nz === 0)
    {
        // Contours whose areas cancel -- a figure eight -- have no Newell
        // normal; the widest triangle of their vertices still has a plane.
        const all = contours.flat();
        const [o] = all;
        const far = all.reduce((best, p)=>(o && Math.hypot(p.x - o.x, p.y - o.y, p.z - o.z)
            > Math.hypot(best.x - o.x, best.y - o.y, best.z - o.z) ? p : best),
        o ?? { x: 0, y: 0, z: 0 });
        let widest = 0;
        for (const p of o ? all : [])
        {
            const u = [far.x - o.x, far.y - o.y, far.z - o.z];
            const v = [p.x - o.x, p.y - o.y, p.z - o.z];
            const c = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2],
                u[0] * v[1] - u[1] * v[0]];
            const size = Math.hypot(c[0], c[1], c[2]);
            if (size > widest)
            {
                widest = size;
                [nx, ny, nz] = c;
            }
        }
    }
    const ax = Math.abs(nx);
    const ay = Math.abs(ny);
    const az = Math.abs(nz);
    if (ax === 0 && ay === 0 && az === 0)
    {
        return null;
    }
    if (az >= ax && az >= ay)
    {
        return nz > 0 ? p=>({ u: p.x, v: p.y }) : p=>({ u: p.x, v: -p.y });
    }
    if (ax >= ay)
    {
        return nx > 0 ? p=>({ u: p.y, v: p.z }) : p=>({ u: p.y, v: -p.z });
    }
    return ny > 0 ? p=>({ u: p.z, v: p.x }) : p=>({ u: p.z, v: -p.x });
}

/**
 * The holes joined to the outer ring by bridges -- each from the hole's
 * rightmost vertex to a vertex of the ring it can see -- so that one ring
 * with no holes remains. A bridge is walked both ways and draws no edge.
 *
 * @param {Corner[]} outer  counter-clockwise @param {Corner[][]} holes  clockwise
 * @returns {Corner[]}
 */
function bridge(outer, holes){
    let ring = outer.slice();
    const rightmost = (/** @type {Corner[]} */ hole)=>hole.reduce((best, c, i)=>(
        c.u > hole[best].u ? i : best), 0);
    const ordered = holes.slice().sort((a, b)=>b[rightmost(b)].u - a[rightmost(a)].u);
    for (const hole of ordered)
    {
        const at = rightmost(hole);
        const m = hole[at];
        // The nearest edge a ray from m to +u meets, and the end of it
        // further along the ray.
        let best = -1;
        let nearest = Infinity;
        for (let i = 0; i < ring.length; i++)
        {
            const a = ring[i];
            const b = ring[(i + 1) % ring.length];
            if (a.v === b.v || Math.min(a.v, b.v) > m.v || Math.max(a.v, b.v) < m.v)
            {
                continue;
            }
            const u = a.u + (m.v - a.v) * (b.u - a.u) / (b.v - a.v);
            if (u >= m.u && u < nearest)
            {
                nearest = u;
                best = a.u > b.u ? i : (i + 1) % ring.length;
            }
        }
        if (best < 0)
        {
            best = ring.reduce((pick, c, i)=>(c.u >= m.u ? i : pick), 0);
        }
        // A vertex of the ring inside the triangle m, hit, candidate hides
        // the candidate: the one closest in angle to the ray is seen.
        const p = ring[best];
        const hit = { u: nearest === Infinity ? p.u : nearest, v: m.v, vertex: m.vertex };
        let angle = Infinity;
        const straight = hit.u === p.u && hit.v === p.v;
        for (let i = 0; i < (straight ? 0 : ring.length); i++)
        {
            const c = ring[i];
            if (c === p || c.u < m.u)
            {
                continue;
            }
            const within = cross(m, hit, c) * cross(m, hit, p) >= 0
                && cross(hit, p, c) * cross(hit, p, m) >= 0
                && cross(p, m, c) * cross(p, m, hit) >= 0;
            if (!within)
            {
                continue;
            }
            const theta = Math.abs(Math.atan2(c.v - m.v, c.u - m.u));
            if (theta < angle)
            {
                angle = theta;
                best = i;
            }
        }
        const into = ring[best];
        const spliced = [
            ...hole.slice(at), ...hole.slice(0, at + 1),
        ].map((c, i, all)=>(i === all.length - 1 ? { ...c, edge: false } : c));
        ring = [
            ...ring.slice(0, best),
            { ...into, edge: false },
            ...spliced,
            ...ring.slice(best),
        ];
    }
    return ring;
}

/**
 * Triangles of one ring, counter-clockwise, by clipping ears. Each corner
 * says whether the edge from it is a drawn one; the triangles carry the same
 * for their three edges.
 *
 * @param {Corner[]} ring
 * @returns {{ corners: Corner[], edges: boolean[] }[]}
 */
function clipEars(ring){
    /** @type {{ corners: Corner[], edges: boolean[] }[]} */
    const out = [];
    const left = ring.map(c=>({ ...c, edge: c.edge !== false }));
    let guard = left.length * left.length + 8;
    while (left.length > 3 && guard-- > 0)
    {
        let clipped = false;
        for (let i = 0; i < left.length; i++)
        {
            const a = left[(i + left.length - 1) % left.length];
            const b = left[i];
            const c = left[(i + 1) % left.length];
            if (cross(a, b, c) <= 0)
            {
                continue;
            }
            const blocked = left.some(p=>p !== a && p !== b && p !== c
                && !(p.u === a.u && p.v === a.v) && !(p.u === b.u && p.v === b.v)
                && !(p.u === c.u && p.v === c.v)
                && cross(a, b, p) >= 0 && cross(b, c, p) >= 0 && cross(c, a, p) >= 0);
            if (blocked)
            {
                continue;
            }
            out.push({ corners: [a, b, c], edges: [a.edge, b.edge, false] });
            a.edge = false;
            left.splice(i, 1);
            clipped = true;
            break;
        }
        if (!clipped)
        {
            // Nothing is an ear by these tests -- a ring degenerate in
            // places, collinear runs, a bridge's doubled vertices: the
            // flattest corner goes, so the rest still gets drawn.
            let flattest = 0;
            let least = Infinity;
            left.forEach((b, i)=>{
                const a = left[(i + left.length - 1) % left.length];
                const c = left[(i + 1) % left.length];
                const turn = Math.abs(cross(a, b, c));
                if (turn < least)
                {
                    least = turn;
                    flattest = i;
                }
            });
            const a = left[(flattest + left.length - 1) % left.length];
            a.edge = false;
            left.splice(flattest, 1);
        }
    }
    if (left.length === 3 && cross(left[0], left[1], left[2]) > 0)
    {
        out.push({ corners: left, edges: left.map(c=>c.edge) });
    }
    return out;
}

/**
 * @typedef {{ kind: 'triangles', triangles: { vertices: TessVertex[], edges: boolean[] }[] }
 *     | { kind: 'boundary', loops: TessVertex[][] }
 *     | { kind: 'crossing' }} Tessellation
 */

/**
 * @param {TessVertex[][]} contours
 * @param {{ normal: number[], rule: number, boundaryOnly: boolean }} options
 * @returns {Tessellation}
 */
export function tessellate(contours, { normal, rule, boundaryOnly }){
    const project = projection(contours, normal);
    if (!project)
    {
        return boundaryOnly ? { kind: 'boundary', loops: [] }
            : { kind: 'triangles', triangles: [] };
    }
    /** @type {Corner[][]} */
    const rings = [];
    for (const contour of contours)
    {
        /** @type {Corner[]} */
        const ring = [];
        for (const vertex of contour)
        {
            const { u, v } = project(vertex);
            const last = ring[ring.length - 1];
            if (!last || last.u !== u || last.v !== v)
            {
                ring.push({ u, v, vertex });
            }
        }
        while (ring.length > 1 && ring[0].u === ring[ring.length - 1].u
            && ring[0].v === ring[ring.length - 1].v)
        {
            ring.pop();
        }
        if (ring.length >= 3)
        {
            rings.push(ring);
        }
    }
    const edges = rings.flatMap((ring, r)=>ring.map((a, i)=>({ r, i, a,
        b: ring[(i + 1) % ring.length] })));
    for (let x = 0; x < edges.length; x++)
    {
        for (let y = x + 1; y < edges.length; y++)
        {
            const e = edges[x];
            const f = edges[y];
            if (crosses(e.a, e.b, f.a, f.b))
            {
                return { kind: 'crossing' };
            }
        }
    }
    // A ring that encloses nothing -- collinear, or folded back on itself
    // without crossing -- bounds no region.
    for (let i = rings.length - 1; i >= 0; i--)
    {
        if (area(rings[i]) === 0)
        {
            rings.splice(i, 1);
        }
    }
    const areas = rings.map(area);
    const orientation = areas.map(a=>Math.sign(a));
    const parent = rings.map((ring, i)=>{
        let best = -1;
        rings.forEach((other, j)=>{
            if (j !== i && Math.abs(areas[j]) > Math.abs(areas[i]) && contains(ring[0], other)
                && (best < 0 || Math.abs(areas[j]) < Math.abs(areas[best])))
            {
                best = j;
            }
        });
        return best;
    });
    /** @param {number} i @returns {number} */
    const windingOf = i=>(i < 0 ? 0 : orientation[i] + windingOf(parent[i]));
    const winding = rings.map((_, i)=>windingOf(i));
    const filled = winding.map(w=>inside(rule, w));
    /** @param {Corner[]} ring @param {boolean} ccw */
    const oriented = (ring, ccw)=>((area(ring) > 0) === ccw ? ring.slice()
        : ring.slice().reverse());

    if (boundaryOnly)
    {
        const loops = rings.flatMap((ring, i)=>{
            const outside = parent[i] < 0 ? false : filled[parent[i]];
            return filled[i] === outside ? [] : [oriented(ring, filled[i]).map(c=>c.vertex)];
        });
        return { kind: 'boundary', loops };
    }
    /** @type {{ vertices: TessVertex[], edges: boolean[] }[]} */
    const triangles = [];
    rings.forEach((ring, i)=>{
        if (!filled[i])
        {
            return;
        }
        const holes = rings.filter((_, j)=>parent[j] === i).map(hole=>oriented(hole, false));
        for (const triangle of clipEars(bridge(oriented(ring, true), holes)))
        {
            triangles.push({ vertices: triangle.corners.map(c=>c.vertex), edges: triangle.edges });
        }
    });
    return { kind: 'triangles', triangles };
}
