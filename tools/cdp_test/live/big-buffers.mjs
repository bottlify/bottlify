/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A heap snapshot of the live engine worker: every backing store of 8 MB or
 * more -- guest memories, file contents, textures -- with a path of what holds
 * it, so memory kept past the process that made it names its holder.
 *
 *   node tools/cdp_test/live/big-buffers.mjs [minMB=8]
 *
 * The snapshot is parsed in memory and not kept: it runs to hundreds of MB.
 */
import { connect } from './connect.mjs';

const minBytes = Number(process.argv[2] ?? 8) * 1048576;
const { cdp, engineWorker } = await connect();
const worker = await engineWorker();
if (!worker)
{
    console.log('the page has no worker');
    process.exit(1);
}
let text = '';
cdp.on('HeapProfiler.addHeapSnapshotChunk', (/** @type {any} */ params)=>{
    text += params.chunk;
});
await cdp.send('HeapProfiler.enable', {}, worker.sessionId);
await cdp.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false }, worker.sessionId);
const snapshot = JSON.parse(text);
text = '';

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
big.sort((a, b)=>b[1] - a[1]);
const total = big.reduce((sum, [, size])=>sum + size, 0);
console.log(`${big.length} stores of ${minBytes / 1048576} MB or more, `
    + `${Math.round(total / 1048576)} MB together`);
for (const [node, size] of big.slice(0, 30))
{
    console.log(`${Math.round(size / 1048576)} MB ${label(node)}\n   ${pathOf(node)}`);
}
process.exit(0);
