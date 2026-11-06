/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Direct3D 10's per-draw device calls as code the guest runs (`@guestCode`,
 * compiled into `d3d10-inguest.x86.js`): each writes the call into the
 * device's command ring and returns, and the host makes the ring's calls, in
 * order, on its way into any method of its own (`d3d10-ring.js`).
 *
 * Direct3D 11's immediate context is the same device under another
 * interface, its block one word past each of its pointers too: a call of
 * the two versions that means the same is the same routine and the same
 * record. Where 11's differs -- a shader set with class instances, a
 * viewport of floats, a map through the context -- a routine of its own
 * writes the record 10's would, or one of its own past the device's slots.
 *
 * This version's setters and draws are `void`: a rejected argument is the
 * debug layer's to report, and the program is told nothing. So a routine
 * answers for every call it can carry, with no state to check first; what
 * it leaves to the host is a ring with no room, a device with no ring, the
 * host's flag raised, an array past what a record holds, and a pointer to
 * an array that is not there.
 *
 * A record is the method's slot, its length in bytes, its arguments, and the
 * arrays it names copied after them (`commands.js` reads it). The device's
 * lock (`SHADOW.HELD`) is taken for the record as Direct3D 8's and 9's
 * routines take it, and the length is written last, with a locked
 * instruction, so a host on another executor reading the ring finds the
 * record whole.
 *
 * The offsets are the device block's (`shadow.js`); the test holds them to it.
 */

/**
 * The guest's memory: none of these touches the x87.
 *
 * @typedef {import('../../win32/msvcrt/guest-code.js').GuestMemory} Guest
 */
/** @typedef {import('../../win32/msvcrt/guest-code.js').u32} u32 */

/** `SHADOW.FLAGS`, `COMMANDS`, `COMMAND_BYTES`, `COMMAND_HEAD` and `HELD`. */
const COMMANDS = 4;
const COMMAND_BYTES = 8;
const COMMAND_HEAD = 12;
const HELD = 5488;
/** `FLAG_SLOW_PATH` and `HELD_GUEST`. */
const FLAG_SLOW_PATH = 1;
const HELD_GUEST = 1;
/** Where a record's arguments begin. */
const ARGS = 8;

/** The slots of ID3D10Device's methods the routines carry, counted from QueryInterface's 0. */
const VS_SET_CONSTANT_BUFFERS = 3;
const PS_SET_SHADER_RESOURCES = 4;
const PS_SET_SHADER = 5;
const PS_SET_SAMPLERS = 6;
const VS_SET_SHADER = 7;
const DRAW_INDEXED = 8;
const DRAW = 9;
const PS_SET_CONSTANT_BUFFERS = 10;
const IA_SET_INPUT_LAYOUT = 11;
const IA_SET_VERTEX_BUFFERS = 12;
const IA_SET_INDEX_BUFFER = 13;
const DRAW_INDEXED_INSTANCED = 14;
const DRAW_INSTANCED = 15;
const GS_SET_CONSTANT_BUFFERS = 16;
const GS_SET_SHADER = 17;
const IA_SET_PRIMITIVE_TOPOLOGY = 18;
const VS_SET_SHADER_RESOURCES = 19;
const VS_SET_SAMPLERS = 20;
const GS_SET_SHADER_RESOURCES = 22;
const GS_SET_SAMPLERS = 23;
const OM_SET_RENDER_TARGETS = 24;
const OM_SET_BLEND_STATE = 25;
const OM_SET_DEPTH_STENCIL_STATE = 26;
const RS_SET_STATE = 29;
const RS_SET_VIEWPORTS = 30;
const RS_SET_SCISSOR_RECTS = 31;
const CLEAR_RENDER_TARGET_VIEW = 35;
const CLEAR_DEPTH_STENCIL_VIEW = 36;
/** The ring's record of a buffer's unmap, numbered past the device's slots (`commands.js`). */
const BUFFER_UNMAP = 98;
/** Direct3D 11's viewports, six floats each: the record after the buffer's unmap. */
const RS_SET_VIEWPORTS11 = 99;

/** `BUFFER10`'s offsets (`d3d10-ring.js`): a dynamic buffer's block. */
const B_FLAGS = 0;
const B_DEVICE = 4;
const B_CURRENT = 8;
const B_LENGTH = 12;
const B_MAPPED = 16;
const B_FREE = 24;
const B_STORAGES = 28;
/** D3D10_MAP_WRITE_DISCARD and _WRITE_NO_OVERWRITE. */
const WRITE_DISCARD = 4;
const WRITE_NO_OVERWRITE = 5;

/**
 * The most elements of an array a record copies: a call past it is the
 * host's. Sixteen is every input slot, sampler and viewport there is, and
 * the shader resources a program binds at once.
 */
const MOST = 16;

/**
 * Room for a record of `length` bytes in the ring of the device whose block
 * is `block`, with the device's lock taken: its address, or 0 -- no block,
 * no ring, the host's flag, the lock held elsewhere, no room -- and then
 * nothing was taken.
 *
 * @guestCode stdcall
 * @param {Pick<Guest, 'u32' | 'compareExchange'>} guest @param {u32} block @param {u32} length
 * @returns {u32}
 */
export function reserve({ u32, compareExchange }, block, length){
    if (block === 0 || (u32(block) & FLAG_SLOW_PATH) !== 0 || u32(block + COMMANDS) === 0)
    {
        return 0;
    }
    if (compareExchange(block + HELD, 0, HELD_GUEST) !== 0)
    {
        return 0;
    }
    const head = u32(block + COMMAND_HEAD);
    if (((head + length) >>> 0) > u32(block + COMMAND_BYTES)
        || compareExchange(block + COMMAND_HEAD, head, (head + length) >>> 0) !== head)
    {
        // The lock let go: 0 whatever the word held.
        return (compareExchange(block + HELD, HELD_GUEST, 0) & 0) >>> 0;
    }
    return (u32(block + COMMANDS) + head) >>> 0;
}

/**
 * A record finished: its slot, then its length with a locked instruction,
 * and the device's lock let go the same way.
 *
 * @guestCode stdcall
 * @param {Pick<Guest, 'setU32' | 'compareExchange'>} guest
 * @param {u32} block @param {u32} record @param {u32} slot
 * @param {u32} length
 * @returns {u32}
 */
export function publish({ setU32, compareExchange }, block, record, slot, length){
    setU32(record, slot);
    const was = compareExchange(record + 4, 0, length);
    // 0 whatever the words held: a record's length is only ever written over zero.
    return ((compareExchange(block + HELD, HELD_GUEST, 0) | was) & 0) >>> 0;
}

/**
 * A record of one argument: a shader, a layout, a state, a topology.
 *
 * @guestCode stdcall
 * @param {Pick<Guest, 'u32' | 'setU32' | 'compareExchange'>} guest
 * @param {u32} self @param {u32} slot @param {u32} value
 * @returns {u32}
 */
export function one({ u32, setU32, compareExchange }, self, slot, value){
    const record = reserve({ u32, compareExchange }, u32(self + 4), ARGS + 4);
    if (record === 0)
    {
        return 1;
    }
    setU32(record + ARGS, value);
    return publish({ setU32, compareExchange }, u32(self + 4), record, slot, ARGS + 4);
}

/**
 * A stage's slots: the first, how many, and the objects, copied.
 *
 * @guestCode stdcall
 * @param {Pick<Guest, 'u32' | 'setU32' | 'compareExchange'>} guest
 * @param {u32} self @param {u32} slot @param {u32} start
 * @param {u32} count @param {u32} objects
 * @returns {u32}
 */
export function slots({ u32, setU32, compareExchange }, self, slot, start, count, objects){
    if (count > MOST || (objects === 0 && count !== 0))
    {
        return 1;
    }
    const length = (ARGS + 8 + count * 4) >>> 0;
    const record = reserve({ u32, compareExchange }, u32(self + 4), length);
    if (record === 0)
    {
        return 1;
    }
    setU32(record + ARGS, start);
    setU32(record + ARGS + 4, count);
    for (let index = 0; index < (count | 0); index++)
    {
        setU32(record + ARGS + 8 + index * 4, u32(objects + index * 4));
    }
    return publish({ setU32, compareExchange }, u32(self + 4), record, slot, length);
}

/**
 * void VSSetShader(this, ID3D10VertexShader*)
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} self @param {u32} shader
 * @returns {u32}
 */
export function VSSetShader({ u32, setU32, compareExchange, host }, self, shader){
    if (one({ u32, setU32, compareExchange }, self, VS_SET_SHADER, shader) !== 0)
    {
        return host();
    }
    return 0;
}

/**
 * void PSSetShader(this, ID3D10PixelShader*)
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} self @param {u32} shader
 * @returns {u32}
 */
export function PSSetShader({ u32, setU32, compareExchange, host }, self, shader){
    if (one({ u32, setU32, compareExchange }, self, PS_SET_SHADER, shader) !== 0)
    {
        return host();
    }
    return 0;
}

/**
 * void GSSetShader(this, ID3D10GeometryShader*)
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} self @param {u32} shader
 * @returns {u32}
 */
export function GSSetShader({ u32, setU32, compareExchange, host }, self, shader){
    if (one({ u32, setU32, compareExchange }, self, GS_SET_SHADER, shader) !== 0)
    {
        return host();
    }
    return 0;
}

/**
 * void ID3D11DeviceContext::VSSetShader(this, ID3D11VertexShader*,
 * ID3D11ClassInstance *const *, UINT count): 10's record where no class
 * instance is named.
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} self @param {u32} shader @param {u32} instances
 * @param {u32} count
 * @returns {u32}
 */
export function ContextVSSetShader({ u32, setU32, compareExchange, host }, self, shader,
    instances, count)
{
    if (count !== 0 || one({ u32, setU32, compareExchange }, self, VS_SET_SHADER, shader) !== 0)
    {
        return host();
    }
    return 0;
}

/**
 * void ID3D11DeviceContext::PSSetShader(this, ID3D11PixelShader*,
 * ID3D11ClassInstance *const *, UINT count)
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} self @param {u32} shader @param {u32} instances
 * @param {u32} count
 * @returns {u32}
 */
export function ContextPSSetShader({ u32, setU32, compareExchange, host }, self, shader,
    instances, count)
{
    if (count !== 0 || one({ u32, setU32, compareExchange }, self, PS_SET_SHADER, shader) !== 0)
    {
        return host();
    }
    return 0;
}

/**
 * void ID3D11DeviceContext::GSSetShader(this, ID3D11GeometryShader*,
 * ID3D11ClassInstance *const *, UINT count)
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} self @param {u32} shader @param {u32} instances
 * @param {u32} count
 * @returns {u32}
 */
export function ContextGSSetShader({ u32, setU32, compareExchange, host }, self, shader,
    instances, count)
{
    if (count !== 0 || one({ u32, setU32, compareExchange }, self, GS_SET_SHADER, shader) !== 0)
    {
        return host();
    }
    return 0;
}

/**
 * void IASetInputLayout(this, ID3D10InputLayout*)
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} self @param {u32} layout
 * @returns {u32}
 */
export function IASetInputLayout({ u32, setU32, compareExchange, host }, self, layout){
    if (one({ u32, setU32, compareExchange }, self, IA_SET_INPUT_LAYOUT, layout) !== 0)
    {
        return host();
    }
    return 0;
}

/**
 * void IASetPrimitiveTopology(this, D3D10_PRIMITIVE_TOPOLOGY)
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} self @param {u32} topology
 * @returns {u32}
 */
export function IASetPrimitiveTopology({ u32, setU32, compareExchange, host }, self, topology){
    if (one({ u32, setU32, compareExchange }, self, IA_SET_PRIMITIVE_TOPOLOGY, topology) !== 0)
    {
        return host();
    }
    return 0;
}

/**
 * void RSSetState(this, ID3D10RasterizerState*)
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} self @param {u32} state
 * @returns {u32}
 */
export function RSSetState({ u32, setU32, compareExchange, host }, self, state){
    if (one({ u32, setU32, compareExchange }, self, RS_SET_STATE, state) !== 0)
    {
        return host();
    }
    return 0;
}

/**
 * void VSSetConstantBuffers(this, UINT start, UINT count, ID3D10Buffer *const *)
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} self @param {u32} start @param {u32} count
 * @param {u32} buffers
 * @returns {u32}
 */
export function VSSetConstantBuffers({ u32, setU32, compareExchange, host }, self, start, count,
    buffers)
{
    if (slots({ u32, setU32, compareExchange }, self, VS_SET_CONSTANT_BUFFERS, start, count,
        buffers) !== 0)
    {
        return host();
    }
    return 0;
}

/**
 * void PSSetConstantBuffers(this, UINT start, UINT count, ID3D10Buffer *const *)
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} self @param {u32} start @param {u32} count
 * @param {u32} buffers
 * @returns {u32}
 */
export function PSSetConstantBuffers({ u32, setU32, compareExchange, host }, self, start, count,
    buffers)
{
    if (slots({ u32, setU32, compareExchange }, self, PS_SET_CONSTANT_BUFFERS, start, count,
        buffers) !== 0)
    {
        return host();
    }
    return 0;
}

/**
 * void GSSetConstantBuffers(this, UINT start, UINT count, ID3D10Buffer *const *)
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} self @param {u32} start @param {u32} count
 * @param {u32} buffers
 * @returns {u32}
 */
export function GSSetConstantBuffers({ u32, setU32, compareExchange, host }, self, start, count,
    buffers)
{
    if (slots({ u32, setU32, compareExchange }, self, GS_SET_CONSTANT_BUFFERS, start, count,
        buffers) !== 0)
    {
        return host();
    }
    return 0;
}

/**
 * void VSSetShaderResources(this, UINT start, UINT count,
 *                           ID3D10ShaderResourceView *const *)
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} self @param {u32} start @param {u32} count
 * @param {u32} views
 * @returns {u32}
 */
export function VSSetShaderResources({ u32, setU32, compareExchange, host }, self, start, count,
    views)
{
    if (slots({ u32, setU32, compareExchange }, self, VS_SET_SHADER_RESOURCES, start, count,
        views) !== 0)
    {
        return host();
    }
    return 0;
}

/**
 * void PSSetShaderResources(this, UINT start, UINT count,
 *                           ID3D10ShaderResourceView *const *)
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} self @param {u32} start @param {u32} count
 * @param {u32} views
 * @returns {u32}
 */
export function PSSetShaderResources({ u32, setU32, compareExchange, host }, self, start, count,
    views)
{
    if (slots({ u32, setU32, compareExchange }, self, PS_SET_SHADER_RESOURCES, start, count,
        views) !== 0)
    {
        return host();
    }
    return 0;
}

/**
 * void GSSetShaderResources(this, UINT start, UINT count,
 *                           ID3D10ShaderResourceView *const *)
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} self @param {u32} start @param {u32} count
 * @param {u32} views
 * @returns {u32}
 */
export function GSSetShaderResources({ u32, setU32, compareExchange, host }, self, start, count,
    views)
{
    if (slots({ u32, setU32, compareExchange }, self, GS_SET_SHADER_RESOURCES, start, count,
        views) !== 0)
    {
        return host();
    }
    return 0;
}

/**
 * void VSSetSamplers(this, UINT start, UINT count, ID3D10SamplerState *const *)
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} self @param {u32} start @param {u32} count
 * @param {u32} samplers
 * @returns {u32}
 */
export function VSSetSamplers({ u32, setU32, compareExchange, host }, self, start, count,
    samplers)
{
    if (slots({ u32, setU32, compareExchange }, self, VS_SET_SAMPLERS, start, count,
        samplers) !== 0)
    {
        return host();
    }
    return 0;
}

/**
 * void PSSetSamplers(this, UINT start, UINT count, ID3D10SamplerState *const *)
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} self @param {u32} start @param {u32} count
 * @param {u32} samplers
 * @returns {u32}
 */
export function PSSetSamplers({ u32, setU32, compareExchange, host }, self, start, count,
    samplers)
{
    if (slots({ u32, setU32, compareExchange }, self, PS_SET_SAMPLERS, start, count,
        samplers) !== 0)
    {
        return host();
    }
    return 0;
}

/**
 * void GSSetSamplers(this, UINT start, UINT count, ID3D10SamplerState *const *)
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} self @param {u32} start @param {u32} count
 * @param {u32} samplers
 * @returns {u32}
 */
export function GSSetSamplers({ u32, setU32, compareExchange, host }, self, start, count,
    samplers)
{
    if (slots({ u32, setU32, compareExchange }, self, GS_SET_SAMPLERS, start, count,
        samplers) !== 0)
    {
        return host();
    }
    return 0;
}

/**
 * void IASetVertexBuffers(this, UINT start, UINT count, ID3D10Buffer *const *,
 *                         const UINT *strides, const UINT *offsets)
 *
 * The record: the first slot, how many, then the buffers, the strides and
 * the offsets, each `count` words.
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} self @param {u32} start @param {u32} count
 * @param {u32} buffers @param {u32} strides @param {u32} offsets
 * @returns {u32}
 */
export function IASetVertexBuffers({ u32, setU32, compareExchange, host }, self, start, count,
    buffers, strides, offsets)
{
    if (count > MOST || (count !== 0 && (buffers === 0 || strides === 0 || offsets === 0)))
    {
        return host();
    }
    const length = (ARGS + 8 + count * 12) >>> 0;
    const record = reserve({ u32, compareExchange }, u32(self + 4), length);
    if (record === 0)
    {
        return host();
    }
    setU32(record + ARGS, start);
    setU32(record + ARGS + 4, count);
    const stridesAt = (record + ARGS + 8 + count * 4) >>> 0;
    const offsetsAt = (stridesAt + count * 4) >>> 0;
    for (let index = 0; index < (count | 0); index++)
    {
        setU32(record + ARGS + 8 + index * 4, u32(buffers + index * 4));
        setU32(stridesAt + index * 4, u32(strides + index * 4));
        setU32(offsetsAt + index * 4, u32(offsets + index * 4));
    }
    return publish({ setU32, compareExchange }, u32(self + 4), record,
        IA_SET_VERTEX_BUFFERS, length);
}

/**
 * void IASetIndexBuffer(this, ID3D10Buffer*, DXGI_FORMAT, UINT offset)
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} self @param {u32} buffer @param {u32} format
 * @param {u32} offset
 * @returns {u32}
 */
export function IASetIndexBuffer({ u32, setU32, compareExchange, host }, self, buffer, format,
    offset)
{
    const record = reserve({ u32, compareExchange }, u32(self + 4), ARGS + 12);
    if (record === 0)
    {
        return host();
    }
    setU32(record + ARGS, buffer);
    setU32(record + ARGS + 4, format);
    setU32(record + ARGS + 8, offset);
    return publish({ setU32, compareExchange }, u32(self + 4), record,
        IA_SET_INDEX_BUFFER, ARGS + 12);
}

/**
 * void OMSetRenderTargets(this, UINT count, ID3D10RenderTargetView *const *,
 *                         ID3D10DepthStencilView*)
 *
 * The record: how many, the depth view, then the targets.
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} self @param {u32} count @param {u32} views
 * @param {u32} depth
 * @returns {u32}
 */
export function OMSetRenderTargets({ u32, setU32, compareExchange, host }, self, count, views,
    depth)
{
    if (count > 8 || (views === 0 && count !== 0))
    {
        return host();
    }
    const length = (ARGS + 8 + count * 4) >>> 0;
    const record = reserve({ u32, compareExchange }, u32(self + 4), length);
    if (record === 0)
    {
        return host();
    }
    setU32(record + ARGS, count);
    setU32(record + ARGS + 4, depth);
    for (let index = 0; index < (count | 0); index++)
    {
        setU32(record + ARGS + 8 + index * 4, u32(views + index * 4));
    }
    return publish({ setU32, compareExchange }, u32(self + 4), record,
        OM_SET_RENDER_TARGETS, length);
}

/**
 * void OMSetBlendState(this, ID3D10BlendState*, const FLOAT factor[4], UINT mask)
 *
 * The record: the state, the mask, whether there is a factor, and the
 * factor's four floats as bits (zero without one).
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} self @param {u32} state @param {u32} factor
 * @param {u32} mask
 * @returns {u32}
 */
export function OMSetBlendState({ u32, setU32, compareExchange, host }, self, state, factor,
    mask)
{
    const record = reserve({ u32, compareExchange }, u32(self + 4), ARGS + 28);
    if (record === 0)
    {
        return host();
    }
    setU32(record + ARGS, state);
    setU32(record + ARGS + 4, mask);
    setU32(record + ARGS + 8, factor === 0 ? 0 : 1);
    for (let index = 0; index < 4; index++)
    {
        setU32(record + ARGS + 12 + index * 4, factor === 0 ? 0 : u32(factor + index * 4));
    }
    return publish({ setU32, compareExchange }, u32(self + 4), record,
        OM_SET_BLEND_STATE, ARGS + 28);
}

/**
 * void OMSetDepthStencilState(this, ID3D10DepthStencilState*, UINT stencilRef)
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} self @param {u32} state @param {u32} reference
 * @returns {u32}
 */
export function OMSetDepthStencilState({ u32, setU32, compareExchange, host }, self, state,
    reference)
{
    const record = reserve({ u32, compareExchange }, u32(self + 4), ARGS + 8);
    if (record === 0)
    {
        return host();
    }
    setU32(record + ARGS, state);
    setU32(record + ARGS + 4, reference);
    return publish({ setU32, compareExchange }, u32(self + 4), record, OM_SET_DEPTH_STENCIL_STATE,
        ARGS + 8);
}

/**
 * void RSSetViewports(this, UINT count, const D3D10_VIEWPORT*): six words each.
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} self @param {u32} count @param {u32} viewports
 * @returns {u32}
 */
export function RSSetViewports({ u32, setU32, compareExchange, host }, self, count, viewports){
    if (counted({ u32, setU32, compareExchange }, self, RS_SET_VIEWPORTS, count, viewports, 6)
        !== 0)
    {
        return host();
    }
    return 0;
}

/**
 * void ID3D11DeviceContext::RSSetViewports(this, UINT count, const D3D11_VIEWPORT*):
 * six floats each, in a record of their own.
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} self @param {u32} count @param {u32} viewports
 * @returns {u32}
 */
export function ContextRSSetViewports({ u32, setU32, compareExchange, host }, self, count,
    viewports)
{
    if (counted({ u32, setU32, compareExchange }, self, RS_SET_VIEWPORTS11, count, viewports, 6)
        !== 0)
    {
        return host();
    }
    return 0;
}

/**
 * A record of how many items, then the items, `words` dwords each, copied:
 * 0 once written, 1 where the host has to make the call.
 *
 * @guestCode stdcall
 * @param {Pick<Guest, 'u32' | 'setU32' | 'compareExchange'>} guest
 * @param {u32} self @param {u32} slot @param {u32} count @param {u32} items
 * @param {u32} words
 * @returns {u32}
 */
export function counted({ u32, setU32, compareExchange }, self, slot, count, items, words){
    if (count > MOST || (items === 0 && count !== 0))
    {
        return 1;
    }
    const copied = Math.imul(count, words);
    const length = (ARGS + 4 + copied * 4) >>> 0;
    const record = reserve({ u32, compareExchange }, u32(self + 4), length);
    if (record === 0)
    {
        return 1;
    }
    setU32(record + ARGS, count);
    for (let index = 0; index < (copied | 0); index++)
    {
        setU32(record + ARGS + 4 + index * 4, u32(items + index * 4));
    }
    return publish({ setU32, compareExchange }, u32(self + 4), record, slot, length);
}

/**
 * void RSSetScissorRects(this, UINT count, const D3D10_RECT*): four words each.
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} self @param {u32} count @param {u32} rects
 * @returns {u32}
 */
export function RSSetScissorRects({ u32, setU32, compareExchange, host }, self, count, rects){
    if (count > MOST || (rects === 0 && count !== 0))
    {
        return host();
    }
    const length = (ARGS + 4 + count * 16) >>> 0;
    const record = reserve({ u32, compareExchange }, u32(self + 4), length);
    if (record === 0)
    {
        return host();
    }
    setU32(record + ARGS, count);
    for (let index = 0; index < (count * 4 | 0); index++)
    {
        setU32(record + ARGS + 4 + index * 4, u32(rects + index * 4));
    }
    return publish({ setU32, compareExchange }, u32(self + 4), record,
        RS_SET_SCISSOR_RECTS, length);
}

/**
 * void Draw(this, UINT vertexCount, UINT startVertex)
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} self @param {u32} count @param {u32} start
 * @returns {u32}
 */
export function Draw({ u32, setU32, compareExchange, host }, self, count, start){
    const record = reserve({ u32, compareExchange }, u32(self + 4), ARGS + 8);
    if (record === 0)
    {
        return host();
    }
    setU32(record + ARGS, count);
    setU32(record + ARGS + 4, start);
    return publish({ setU32, compareExchange }, u32(self + 4), record, DRAW, ARGS + 8);
}

/**
 * void DrawIndexed(this, UINT indexCount, UINT startIndex, INT baseVertex)
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} self @param {u32} count @param {u32} start
 * @param {u32} base
 * @returns {u32}
 */
export function DrawIndexed({ u32, setU32, compareExchange, host }, self, count, start, base){
    const record = reserve({ u32, compareExchange }, u32(self + 4), ARGS + 12);
    if (record === 0)
    {
        return host();
    }
    setU32(record + ARGS, count);
    setU32(record + ARGS + 4, start);
    setU32(record + ARGS + 8, base);
    return publish({ setU32, compareExchange }, u32(self + 4), record, DRAW_INDEXED, ARGS + 12);
}

/**
 * void DrawInstanced(this, UINT vertexCount, UINT instanceCount, UINT startVertex,
 *                    UINT startInstance)
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} self @param {u32} count @param {u32} instances
 * @param {u32} start @param {u32} first
 * @returns {u32}
 */
export function DrawInstanced({ u32, setU32, compareExchange, host }, self, count, instances,
    start, first)
{
    const record = reserve({ u32, compareExchange }, u32(self + 4), ARGS + 16);
    if (record === 0)
    {
        return host();
    }
    setU32(record + ARGS, count);
    setU32(record + ARGS + 4, instances);
    setU32(record + ARGS + 8, start);
    setU32(record + ARGS + 12, first);
    return publish({ setU32, compareExchange }, u32(self + 4), record, DRAW_INSTANCED, ARGS + 16);
}

/**
 * void DrawIndexedInstanced(this, UINT indexCount, UINT instanceCount, UINT startIndex,
 *                           INT baseVertex, UINT startInstance)
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} self @param {u32} count @param {u32} instances
 * @param {u32} start @param {u32} base @param {u32} first
 * @returns {u32}
 */
export function DrawIndexedInstanced({ u32, setU32, compareExchange, host }, self, count,
    instances, start, base, first)
{
    const record = reserve({ u32, compareExchange }, u32(self + 4), ARGS + 20);
    if (record === 0)
    {
        return host();
    }
    setU32(record + ARGS, count);
    setU32(record + ARGS + 4, instances);
    setU32(record + ARGS + 8, start);
    setU32(record + ARGS + 12, base);
    setU32(record + ARGS + 16, first);
    return publish({ setU32, compareExchange }, u32(self + 4), record, DRAW_INDEXED_INSTANCED,
        ARGS + 20);
}

/**
 * void ClearRenderTargetView(this, ID3D10RenderTargetView*, const FLOAT colour[4])
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} self @param {u32} view @param {u32} colour
 * @returns {u32}
 */
export function ClearRenderTargetView({ u32, setU32, compareExchange, host }, self, view,
    colour)
{
    if (colour === 0)
    {
        return host();
    }
    const record = reserve({ u32, compareExchange }, u32(self + 4), ARGS + 20);
    if (record === 0)
    {
        return host();
    }
    setU32(record + ARGS, view);
    for (let index = 0; index < 4; index++)
    {
        setU32(record + ARGS + 4 + index * 4, u32(colour + index * 4));
    }
    return publish({ setU32, compareExchange }, u32(self + 4), record, CLEAR_RENDER_TARGET_VIEW,
        ARGS + 20);
}

/**
 * void ClearDepthStencilView(this, ID3D10DepthStencilView*, UINT flags, FLOAT depth,
 *                            UINT8 stencil): the depth as its bits.
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} self @param {u32} view @param {u32} flags
 * @param {u32} depth @param {u32} stencil
 * @returns {u32}
 */
export function ClearDepthStencilView({ u32, setU32, compareExchange, host }, self, view, flags,
    depth, stencil)
{
    const record = reserve({ u32, compareExchange }, u32(self + 4), ARGS + 16);
    if (record === 0)
    {
        return host();
    }
    setU32(record + ARGS, view);
    setU32(record + ARGS + 4, flags);
    setU32(record + ARGS + 8, depth);
    setU32(record + ARGS + 12, stencil & 0xff);
    return publish({ setU32, compareExchange }, u32(self + 4), record, CLEAR_DEPTH_STENCIL_VIEW,
        ARGS + 16);
}

/**
 * HRESULT ID3D10Buffer::Map(this, D3D10_MAP, UINT flags, void **data), for a
 * dynamic buffer whose bytes live in guest memory: NO_OVERWRITE hands out the
 * storage the buffer is on; DISCARD moves it onto a storage the host has
 * let go of (`B_FREE`), whose bytes no unmap in the ring still names. Every
 * other map, a buffer mapped already, and a DISCARD with no storage free are
 * the host's.
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} self @param {u32} type @param {u32} flags
 * @param {u32} out
 * @returns {u32}
 */
export function BufferMap({ u32, setU32, compareExchange, host }, self, type, flags, out){
    const storage = out === 0 ? 0 : mapStorage({ u32, setU32, compareExchange }, self, type);
    if (storage === 0)
    {
        return host();
    }
    setU32(out, storage);
    return 0;
}

/**
 * HRESULT ID3D11DeviceContext::Map(this, ID3D11Resource*, UINT subresource,
 * D3D11_MAP, UINT flags, D3D11_MAPPED_SUBRESOURCE*): a dynamic buffer's map
 * as `BufferMap`, its pitches the buffer's length as the host answers them.
 * A deferred context has no ring (the word past its pointer is zero): its
 * maps are the host's, kept apart for its command list.
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} self @param {u32} resource @param {u32} subresource
 * @param {u32} type @param {u32} flags @param {u32} out
 * @returns {u32}
 */
export function ContextMap({ u32, setU32, compareExchange, host }, self, resource, subresource,
    type, flags, out)
{
    const storage = out === 0 || resource === 0 || subresource !== 0 || u32(self + 4) === 0 ? 0
        : mapStorage({ u32, setU32, compareExchange }, resource, type);
    if (storage === 0)
    {
        return host();
    }
    const length = u32(u32(resource + 4) + B_LENGTH);
    setU32(out, storage);
    setU32(out + 4, length);
    setU32(out + 8, length);
    return 0;
}

/**
 * A dynamic buffer mapped in the guest: the storage it is now on, or 0 where
 * the host has to make the map. The device's lock is let go before the
 * answer, so the program's pointer is written through with it free.
 *
 * @guestCode stdcall
 * @param {Pick<Guest, 'u32' | 'setU32' | 'compareExchange'>} guest
 * @param {u32} buffer @param {u32} type
 * @returns {u32}
 */
export function mapStorage({ u32, setU32, compareExchange }, buffer, type){
    const block = u32(buffer + 4);
    if (block === 0 || (u32(block + B_FLAGS) & FLAG_SLOW_PATH) !== 0
        || u32(block + B_MAPPED) !== 0
        || (type !== WRITE_DISCARD && type !== WRITE_NO_OVERWRITE))
    {
        return 0;
    }
    const device = u32(block + B_DEVICE);
    if (device === 0 || (u32(device) & FLAG_SLOW_PATH) !== 0
        || compareExchange(device + HELD, 0, HELD_GUEST) !== 0)
    {
        return 0;
    }
    const free = u32(block + B_FREE);
    if (type === WRITE_DISCARD && free === 0 && letGo({ compareExchange }, device) !== 0)
    {
        return 0;
    }
    if (type === WRITE_DISCARD)
    {
        let index = 0;
        while (((free >>> index) & 1) === 0)
        {
            index++;
        }
        setU32(block + B_FREE, (free & ~(1 << index)) >>> 0);
        setU32(block + B_CURRENT, u32(block + B_STORAGES + index * 4));
    }
    setU32(block + B_MAPPED, type);
    const storage = u32(block + B_CURRENT);
    if (letGo({ compareExchange }, device) === 0)
    {
        return 0;
    }
    return storage;
}

/**
 * The device's lock let go with a locked instruction: 1, whatever the word held.
 *
 * @guestCode stdcall
 * @param {Pick<Guest, 'compareExchange'>} guest @param {u32} device
 * @returns {u32}
 */
export function letGo({ compareExchange }, device){
    return ((compareExchange(device + HELD, HELD_GUEST, 0) & 0) + 1) >>> 0;
}

/**
 * void ID3D10Buffer::Unmap(this), of a map the guest made: the unmap goes into
 * the device's ring, naming the storage the buffer is on and how it was
 * mapped, and the host takes what the program wrote there in its turn. An
 * unmap of a map the host made is the host's.
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} self
 * @returns {u32}
 */
export function BufferUnmap({ u32, setU32, compareExchange, host }, self){
    if (unmapStorage({ u32, setU32, compareExchange }, self) !== 0)
    {
        return host();
    }
    return 0;
}

/**
 * void ID3D11DeviceContext::Unmap(this, ID3D11Resource*, UINT subresource):
 * a dynamic buffer's unmap of a map the guest made, as `BufferUnmap`.
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} self @param {u32} resource @param {u32} subresource
 * @returns {u32}
 */
export function ContextUnmap({ u32, setU32, compareExchange, host }, self, resource,
    subresource)
{
    if (resource === 0 || subresource !== 0 || u32(self + 4) === 0
        || unmapStorage({ u32, setU32, compareExchange }, resource) !== 0)
    {
        return host();
    }
    return 0;
}

/**
 * The unmap of a map the guest made, into the ring: 0 once written, 1 where
 * the host has to make it.
 *
 * @guestCode stdcall
 * @param {Pick<Guest, 'u32' | 'setU32' | 'compareExchange'>} guest @param {u32} buffer
 * @returns {u32}
 */
export function unmapStorage({ u32, setU32, compareExchange }, buffer){
    const block = u32(buffer + 4);
    if (block === 0 || (u32(block + B_FLAGS) & FLAG_SLOW_PATH) !== 0
        || u32(block + B_MAPPED) === 0)
    {
        return 1;
    }
    const device = u32(block + B_DEVICE);
    const record = reserve({ u32, compareExchange }, device, ARGS + 12);
    if (record === 0)
    {
        return 1;
    }
    setU32(record + ARGS, buffer);
    setU32(record + ARGS + 4, u32(block + B_CURRENT));
    setU32(record + ARGS + 8, u32(block + B_MAPPED));
    setU32(block + B_MAPPED, 0);
    return publish({ setU32, compareExchange }, device, record, BUFFER_UNMAP, ARGS + 12);
}
