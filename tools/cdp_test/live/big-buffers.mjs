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
 *   node tools/cdp_test/live/big-buffers.mjs [minMB=8] [worker]
 *
 * The snapshot is parsed in memory and not kept: it runs to hundreds of MB.
 */
import { connect } from './connect.mjs';

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
// The snapshot's text is kept as bytes, chunk by chunk: the engine worker's
// runs past the half gigabyte a string may hold in Node.
/** @type {Buffer[]} */
const chunks = [];
cdp.on('HeapProfiler.addHeapSnapshotChunk', (/** @type {any} */ params)=>{
    chunks.push(Buffer.from(params.chunk, 'utf8'));
});
await cdp.send('HeapProfiler.enable', {}, worker.sessionId);
// Minutes for a worker whose heap runs to gigabytes, not CDP's usual 30 s.
await cdp.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false }, worker.sessionId,
    15 * 60 * 1000);
const snapshot = parseSnapshot(Buffer.concat(chunks));
chunks.length = 0;

/**
 * A heap snapshot read without one string of it whole: the header and the
 * strings as JSON, the node and edge arrays -- most of it -- as numbers
 * straight out of the bytes.
 *
 * @param {Buffer} bytes
 */
function parseSnapshot(bytes){
    /** @param {string} key */
    const find = key=>{
        const at = bytes.indexOf(`"${key}":[`);
        if (at < 0)
        {
            throw new Error(`the snapshot has no ${key}`);
        }
        return at + key.length + 4;
    };
    /** @param {number} from @returns {{ values: Float64Array, end: number }} */
    const numbers = from=>{
        let values = new Float64Array(1 << 20);
        let length = 0;
        let value = 0;
        let inNumber = false;
        let at = from;
        for (; at < bytes.length; at++)
        {
            const c = bytes[at];
            if (c >= 48 && c <= 57)
            {
                value = value * 10 + (c - 48);
                inNumber = true;
                continue;
            }
            if (inNumber)
            {
                if (length === values.length)
                {
                    const grown = new Float64Array(values.length * 2);
                    grown.set(values);
                    values = grown;
                }
                values[length++] = value;
                value = 0;
                inNumber = false;
            }
            if (c === 93)
            {
                break;
            }
        }
        return { values: values.subarray(0, length), end: at };
    };
    const nodesAt = find('nodes');
    const header = JSON.parse(`${bytes.subarray(0, bytes.indexOf('"nodes":[')).toString('utf8')
        .replace(/,\s*$/, '')}}`);
    const nodes = numbers(nodesAt).values;
    const edges = numbers(find('edges')).values;
    const stringsAt = find('strings') - 1;
    const stringsEnd = bytes.lastIndexOf(']');
    const strings = JSON.parse(bytes.subarray(stringsAt, stringsEnd + 1).toString('utf8'));
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

/** @type {[number, string][][]} */
const retainers = Array.from({ length: count }, ()=>[]);
for (let node = 0, edge = 0; node < count; node++)
{
    const end = edge + nodes[node * nodeFields + EDGES] * edgeFields;
    for (; edge < end; edge += edgeFields)
    {
        const type = edgeTypes[edges[edge + EDGE_TYPE]];
        if (type === 'weak')
        {
            continue;
        }
        const name = type === 'element' || type === 'hidden'
            ? String(edges[edge + EDGE_NAME]) : strings[edges[edge + EDGE_NAME]];
        retainers[edges[edge + EDGE_TO] / nodeFields].push([node, name]);
    }
}
/** @param {number} node */
const label = node=>`${nodeTypes[nodes[node * nodeFields + TYPE]]}:`
    + `${strings[nodes[node * nodeFields + NAME]].slice(0, 50)}`;
/** @param {number} node */
const pathOf = node=>{
    const steps = [];
    const seen = new Set();
    for (let depth = 0; depth < 14; depth++)
    {
        const next = retainers[node].find(([holder])=>!seen.has(holder));
        if (!next)
        {
            break;
        }
        seen.add(next[0]);
        steps.push(`${next[1]} <- ${label(next[0])}`);
        node = next[0];
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
/** @type {Map<string, number>} */
const byKind = new Map();
let all = 0;
for (let node = 0; node < count; node++)
{
    const size = nodes[node * nodeFields + SIZE];
    all += size;
    const kind = `${nodeTypes[nodes[node * nodeFields + TYPE]]}:${
        String(strings[nodes[node * nodeFields + NAME]]).slice(0, 48)}`;
    byKind.set(kind, (byKind.get(kind) ?? 0) + size);
}
console.log(`the heap: ${Math.round(all / 1048576)} MB in ${count} nodes; by kind:`);
for (const [kind, size] of [...byKind].sort((a, b)=>b[1] - a[1]).slice(0, 20))
{
    console.log(`${(size / 1048576).toFixed(1).padStart(8)} MB  ${kind}`);
}

big.sort((a, b)=>b[1] - a[1]);
const total = big.reduce((sum, [, size])=>sum + size, 0);
console.log(`${big.length} stores of ${minBytes / 1048576} MB or more, `
    + `${Math.round(total / 1048576)} MB together`);
for (const [node, size] of big.slice(0, 30))
{
    console.log(`${Math.round(size / 1048576)} MB ${label(node)}\n   ${pathOf(node)}`);
}
process.exit(0);
