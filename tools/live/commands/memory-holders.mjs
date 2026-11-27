/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A heap snapshot of a live worker -- the engine's, or the first whose script
 * URL matches `worker` (`graphics`, `executor`, `translator`) -- every backing store of 8 MB or
 * more -- guest memories, file contents, textures -- with a path of what holds
 * it, so memory kept past the process that made it names its holder.
 *
 *   node tools/live/live.mjs memory holders [minMB=8] [worker]
 *
 * The snapshot goes to a file in the system's temporary folder as it comes and
 * is read back once, its node and edge arrays as 32-bit numbers and each node
 * with one retainer, not all: an engine worker holding 600 MB of objects made
 * a snapshot that a parse keeping two copies of its bytes, 64-bit numbers and
 * every retainer of every node could not fit in 6.5 GB.
 */
import { closeSync, openSync, readSync, rmSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from '../../lib/connect.mjs';

const minBytes = Number(process.argv[2] ?? 8) * 1048576;
const wanted = process.argv[3];
const { cdp, engineWorker, workers } = await connect();
const worker = wanted
    ? (await workers()).find(one=>one.url.includes(wanted)) ?? null
    : await engineWorker();
if (!worker)
{
    console.log('the page has no worker');
    process.exit(1);
}
// The snapshot's text goes to a file chunk by chunk: the engine worker's runs
// past the half gigabyte a string may hold in Node, and past what two copies
// of it in memory leave room for.
const file = join(tmpdir(), `bottlify-heap-${process.pid}.heapsnapshot`);
const out = openSync(file, 'w');
cdp.on('HeapProfiler.addHeapSnapshotChunk', (/** @type {any} */ params)=>{
    writeSync(out, params.chunk);
});
await cdp.send('HeapProfiler.enable', {}, worker.sessionId);
// Minutes for a worker whose heap runs to gigabytes, not CDP's usual 30 s.
await cdp.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false }, worker.sessionId,
    15 * 60 * 1000);
closeSync(out);
const snapshot = parseSnapshot(file);
rmSync(file, { force: true });

/**
 * A heap snapshot read from its file in pieces, never whole: a busy engine
 * worker's runs past the 2 GiB one read may take. The header as JSON, the node
 * and edge arrays - most of it - as numbers straight out of the bytes, and the
 * strings one by one.
 *
 * @param {string} path
 */
function parseSnapshot(path){
    const fd = openSync(path, 'r');
    const piece = Buffer.alloc(64 << 20);
    let length = 0;
    let at = 0;
    let offset = 0;
    /** The next byte, or -1 at the end. */
    const next = ()=>{
        if (at === length)
        {
            length = readSync(fd, piece, 0, piece.length, offset);
            offset += length;
            at = 0;
            if (length === 0)
            {
                return -1;
            }
        }
        return piece[at++];
    };
    /** Reads up to and past `text`, answering what came before it. @param {string} text */
    const until = text=>{
        const bytes = [];
        let matched = 0;
        for (let c = next(); c >= 0; c = next())
        {
            bytes.push(c);
            matched = c === text.charCodeAt(matched) ? matched + 1
                : c === text.charCodeAt(0) ? 1 : 0;
            if (matched === text.length)
            {
                return Buffer.from(bytes.slice(0, bytes.length - text.length)).toString('utf8');
            }
        }
        throw new Error(`the snapshot has no ${text}`);
    };
    /** The numbers of an array whose opening bracket was read, to its close. */
    const numbers = ()=>{
        let values = new Uint32Array(1 << 20);
        let count = 0;
        let value = 0;
        let inNumber = false;
        for (let c = next(); c >= 0; c = next())
        {
            if (c >= 48 && c <= 57)
            {
                value = value * 10 + (c - 48);
                inNumber = true;
                continue;
            }
            if (inNumber)
            {
                if (count === values.length)
                {
                    const grown = new Uint32Array(Math.ceil(values.length * 1.5));
                    grown.set(values);
                    values = grown;
                }
                values[count++] = value;
                value = 0;
                inNumber = false;
            }
            if (c === 93)
            {
                break;
            }
        }
        return values.subarray(0, count);
    };
    /** The strings of an array whose opening bracket was read, to its close. */
    const stringList = ()=>{
        /** @type {string[]} */
        const list = [];
        for (let c = next(); c >= 0 && c !== 93; c = next())
        {
            if (c !== 34)
            {
                continue;
            }
            const bytes = [34];
            for (let d = next(); d >= 0; d = next())
            {
                bytes.push(d);
                if (d === 92)
                {
                    bytes.push(next());
                    continue;
                }
                if (d === 34)
                {
                    break;
                }
            }
            list.push(JSON.parse(Buffer.from(bytes).toString('utf8')));
        }
        return list;
    };
    const header = JSON.parse(`${until('"nodes":[').replace(/,\s*$/, '')}}`);
    const nodes = numbers();
    until('"edges":[');
    const edges = numbers();
    until('"strings":[');
    const strings = stringList();
    closeSync(fd);
    return { ...header, nodes, edges, strings };
}

const meta = snapshot.snapshot.meta;
const nodeFields = meta.node_fields.length;
const edgeFields = meta.edge_fields.length;
const { nodes, edges, strings } = snapshot;
const nodeTypes = meta.node_types[0];
const edgeTypes = meta.edge_types[0];
const TYPE = meta.node_fields.indexOf('type');
const NAME = meta.node_fields.indexOf('name');
const SIZE = meta.node_fields.indexOf('self_size');
const EDGES = meta.node_fields.indexOf('edge_count');
const EDGE_TYPE = meta.edge_fields.indexOf('type');
const EDGE_NAME = meta.edge_fields.indexOf('name_or_index');
const EDGE_TO = meta.edge_fields.indexOf('to_node');
const count = nodes.length / nodeFields;

// One retainer a node, on its shortest path from the snapshot's root (node 0,
// the GC roots under it): a breadth-first walk over the edges that are not
// weak, as DevTools' retainers view orders them. `retainedVia` is the edge's
// own index, so its name is read when a path is printed. A node no strong
// path reaches keeps -1 and its path ends there.
const retainedBy = new Int32Array(count).fill(-1);
const retainedVia = new Int32Array(count).fill(-1);
const WEAK = edgeTypes.indexOf('weak');
// A WeakMap's value reached through its table ("part of key ... -> value ...
// pair") is held only while its key is: walked as a strong edge it makes every
// value of a module-level WeakMap look held by the module, whoever holds the key.
const INTERNAL = edgeTypes.indexOf('internal');
/** @param {number} edge */
const ephemeron = edge=>edges[edge + EDGE_TYPE] === INTERNAL
    && String(strings[edges[edge + EDGE_NAME]]).includes('part of key');
const firstEdge = new Uint32Array(count + 1);
for (let node = 0; node < count; node++)
{
    firstEdge[node + 1] = firstEdge[node] + nodes[node * nodeFields + EDGES] * edgeFields;
}
{
    const queue = new Int32Array(count);
    let head = 0;
    let tail = 0;
    queue[tail++] = 0;
    retainedBy[0] = 0;
    while (head < tail)
    {
        const node = queue[head++];
        for (let edge = firstEdge[node]; edge < firstEdge[node + 1]; edge += edgeFields)
        {
            const to = edges[edge + EDGE_TO] / nodeFields;
            if (edges[edge + EDGE_TYPE] !== WEAK && retainedBy[to] < 0 && !ephemeron(edge))
            {
                retainedBy[to] = node;
                retainedVia[to] = edge;
                queue[tail++] = to;
            }
        }
    }
    retainedBy[0] = -1;
}
/** @param {number} edge */
const edgeName = edge=>{
    const type = edgeTypes[edges[edge + EDGE_TYPE]];
    return type === 'element' || type === 'hidden'
        ? String(edges[edge + EDGE_NAME]) : strings[edges[edge + EDGE_NAME]];
};
/** @param {number} node */
const label = node=>`${nodeTypes[nodes[node * nodeFields + TYPE]]}:`
    + `${strings[nodes[node * nodeFields + NAME]].slice(0, 50)}`;
/** @param {number} node */
const pathOf = node=>{
    const steps = [];
    const seen = new Set();
    for (let depth = 0; depth < Number(process.env.HOLDERS_DEPTH ?? 14); depth++)
    {
        const holder = retainedBy[node];
        if (holder < 0 || seen.has(holder))
        {
            break;
        }
        seen.add(holder);
        steps.push(`${edgeName(retainedVia[node])} <- ${label(holder)}`);
        node = holder;
    }
    return steps.join(' | ');
};

const big = [];
for (let node = 0; node < count; node++)
{
    const size = nodes[node * nodeFields + SIZE];
    if (size >= minBytes)
    {
        big.push([node, size]);
    }
}
/** Every node's own size, by its type and name: a heap whose weight is many small things. */
// Keyed by the name's string index and the type, not a string made per node:
// a heap of tens of millions of nodes.
/** @type {Map<number, number>} */
const byKind = new Map();
let all = 0;
for (let node = 0; node < count; node++)
{
    const size = nodes[node * nodeFields + SIZE];
    all += size;
    const key = nodes[node * nodeFields + NAME] * 16 + nodes[node * nodeFields + TYPE];
    byKind.set(key, (byKind.get(key) ?? 0) + size);
}
console.log(`the heap: ${Math.round(all / 1048576)} MB in ${count} nodes; by kind:`);
for (const [key, size] of [...byKind].sort((a, b)=>b[1] - a[1]).slice(0, 20))
{
    const kind = `${nodeTypes[key % 16]}:${String(strings[Math.floor(key / 16)]).slice(0, 48)}`;
    console.log(`${(size / 1048576).toFixed(1).padStart(8)} MB  ${kind}`);
}

big.sort((a, b)=>b[1] - a[1]);
const total = big.reduce((sum, [, size])=>sum + size, 0);
console.log(`${big.length} stores of ${minBytes / 1048576} MB or more, `
    + `${Math.round(total / 1048576)} MB together`);
for (const [node, size] of big.slice(0, 120))
{
    console.log(`${Math.round(size / 1048576)} MB ${label(node)}\n   ${pathOf(node)}`);
}
process.exit(0);
