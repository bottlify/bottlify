/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A mesh's topology as D3DX describes it, over plain arrays: adjacency
 * (three DWORDs a face, each the face across that edge -- the edge from the
 * face's corner k to corner k + 1 -- or 0xFFFFFFFF), point representatives
 * (each vertex's lowest-numbered vertex at the same point), and the faces
 * sorted by attribute with the attribute table that describes them.
 */

export const NO_FACE = 0xffffffff;

/**
 * A union of vertices that are one point, each set named by its lowest member.
 *
 * @param {number} count
 */
function unions(count){
    const parent = Uint32Array.from({ length: count }, (_, i)=>i);
    /** @param {number} v */
    const find = v=>{
        let root = v;
        while (parent[root] !== root)
        {
            root = parent[root];
        }
        while (parent[v] !== root)
        {
            const next = parent[v];
            parent[v] = root;
            v = next;
        }
        return root;
    };
    return {
        find,
        /** @param {number} a @param {number} b */
        join: (a, b)=>{
            const [x, y] = [find(a), find(b)];
            if (x !== y)
            {
                parent[Math.max(x, y)] = Math.min(x, y);
            }
        },
        reps: ()=>Array.from({ length: count }, (_, i)=>find(i)),
    };
}

/**
 * The point representatives an adjacency implies: across every edge two
 * faces share, the vertices at each end are one point.
 *
 * @param {number[]} indices  Three a face. @param {number[]} adjacency
 * @param {number} vertices
 * @returns {number[]}
 */
export function pointRepsFromAdjacency(indices, adjacency, vertices){
    const set = unions(vertices);
    const faces = Math.floor(indices.length / 3);
    for (let face = 0; face < faces; face++)
    {
        for (let edge = 0; edge < 3; edge++)
        {
            const other = adjacency[face * 3 + edge];
            if (other === NO_FACE || other >= faces)
            {
                continue;
            }
            const back = [0, 1, 2].find(k=>adjacency[other * 3 + k] === face);
            if (back === undefined)
            {
                continue;
            }
            // The shared edge runs the other way round in the neighbour.
            const a = indices[face * 3 + edge];
            const b = indices[face * 3 + (edge + 1) % 3];
            set.join(a, indices[other * 3 + (back + 1) % 3]);
            set.join(b, indices[other * 3 + back]);
        }
    }
    return set.reps();
}

/**
 * The adjacency point representatives imply: two faces are adjacent across
 * an edge whose ends are the same two points, the other way round; the
 * first such face, where more than two share it.
 *
 * @param {number[]} indices @param {number[]} reps
 * @returns {number[]}
 */
export function adjacencyFromPointReps(indices, reps){
    const faces = Math.floor(indices.length / 3);
    /** Each directed edge's faces, by its two points. @type {Map<string, number[]>} */
    const edges = new Map();
    /** @param {number} face @param {number} edge */
    const ends = (face, edge)=>[reps[indices[face * 3 + edge]],
        reps[indices[face * 3 + (edge + 1) % 3]]];
    for (let face = 0; face < faces; face++)
    {
        for (let edge = 0; edge < 3; edge++)
        {
            const key = ends(face, edge).join(',');
            const list = edges.get(key) ?? [];
            list.push(face);
            edges.set(key, list);
        }
    }
    const adjacency = new Array(faces * 3).fill(NO_FACE);
    for (let face = 0; face < faces; face++)
    {
        for (let edge = 0; edge < 3; edge++)
        {
            const [a, b] = ends(face, edge);
            if (a === b)
            {
                continue;
            }
            const other = edges.get(`${b},${a}`)?.find(f=>f !== face);
            if (other !== undefined)
            {
                adjacency[face * 3 + edge] = other;
            }
        }
    }
    return adjacency;
}

/**
 * Point representatives by position: vertices within `epsilon` of each
 * other on every axis are one point.
 *
 * @param {number[][]} positions @param {number} epsilon
 * @returns {number[]}
 */
export function pointRepsFromPositions(positions, epsilon){
    const set = unions(positions.length);
    const order = positions.map((_, i)=>i).sort((a, b)=>positions[a][0] - positions[b][0]
        || a - b);
    for (let i = 0; i < order.length; i++)
    {
        const p = positions[order[i]];
        for (let j = i + 1; j < order.length && positions[order[j]][0] - p[0] <= epsilon; j++)
        {
            const q = positions[order[j]];
            if (Math.abs(q[1] - p[1]) <= epsilon && Math.abs(q[2] - p[2]) <= epsilon)
            {
                set.join(order[i], order[j]);
            }
        }
    }
    return set.reps();
}

/**
 * @typedef {Object} AttributeRange  D3DXATTRIBUTERANGE.
 * @property {number} id
 * @property {number} faceStart
 * @property {number} faceCount
 * @property {number} vertexStart
 * @property {number} vertexCount
 */

/**
 * The faces in attribute order, each attribute's faces in the order they
 * were: the new order as old face numbers.
 *
 * @param {number[]} attributes
 * @returns {number[]}
 */
export function attributeOrder(attributes){
    return attributes.map((_, i)=>i).sort((a, b)=>attributes[a] - attributes[b] || a - b);
}

/**
 * The attribute table of faces sorted by attribute: a range for each run of
 * one attribute, with the span of vertices its faces use.
 *
 * @param {number[]} attributes  In face order, sorted. @param {number[]} indices
 * @returns {AttributeRange[]}
 */
export function attributeTable(attributes, indices){
    /** @type {AttributeRange[]} */
    const table = [];
    for (let face = 0; face < attributes.length; face++)
    {
        const corners = indices.slice(face * 3, face * 3 + 3);
        const low = Math.min(...corners);
        const high = Math.max(...corners);
        const last = table.at(-1);
        if (last && last.id === attributes[face])
        {
            last.faceCount++;
            const end = Math.max(last.vertexStart + last.vertexCount, high + 1);
            last.vertexStart = Math.min(last.vertexStart, low);
            last.vertexCount = end - last.vertexStart;
        }
        else
        {
            table.push({ id: attributes[face], faceStart: face, faceCount: 1, vertexStart: low,
                vertexCount: high - low + 1 });
        }
    }
    return table;
}

/**
 * What is wrong with an adjacency, as D3DXValidMesh reports it: a
 * neighbour that is no face, a face that is its own neighbour, and a
 * neighbour that does not name the face back.
 *
 * @param {number[]} adjacency @param {number} faces
 * @returns {string[]}
 */
export function adjacencyErrors(adjacency, faces){
    /** @type {string[]} */
    const errors = [];
    for (let face = 0; face < faces; face++)
    {
        for (let edge = 0; edge < 3; edge++)
        {
            const other = adjacency[face * 3 + edge];
            if (other === NO_FACE)
            {
                continue;
            }
            if (other >= faces)
            {
                errors.push(`face ${face}'s neighbour ${other} is no face of the mesh`);
            }
            else if (other === face)
            {
                errors.push(`face ${face} is its own neighbour`);
            }
            else if (![0, 1, 2].some(k=>adjacency[other * 3 + k] === face))
            {
                errors.push(`face ${face} names face ${other} as a neighbour, which does not `
                    + 'name it back');
            }
        }
    }
    return errors;
}
