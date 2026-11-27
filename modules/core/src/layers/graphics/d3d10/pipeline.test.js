/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPipelineState } from './pipeline.js';

test('a resource bound as a target is no stage\'s shader resource, as the runtime forces', ()=>{
    // WebGPU refuses a pass that samples what it renders into, and with it the
    // frame; Direct3D's runtime unbinds the resource from the stages instead.
    /** @type {string[]} */
    const said = [];
    // The stage methods are made by name, which the type does not follow.
    const methods = /** @type {any} */ (createPipelineState({
        diverge: detail=>said.push(detail) }).methods);
    const texture = {};
    const other = {};
    /** A view, alive and counted as the pipeline hands views out. @param {object} resource */
    const view = resource=>({ resource, refCount: 1, addRef(){}, release(){} });
    const shaderView = view(texture);
    const otherView = view(other);
    const targetView = view(texture);
    /** @type {any} */
    const out = {};
    methods.PSSetShaderResources(0, [shaderView, otherView]);
    methods.VSSetShaderResources(3, [shaderView]);
    methods.OMSetRenderTargets([targetView], null);
    methods.PSGetShaderResources(0, 2, out);
    assert.deepEqual(out.views, [null, otherView], 'the target\'s view unbound, the other kept');
    methods.VSGetShaderResources(3, 1, out);
    assert.deepEqual(out.views, [null]);
    methods.PSSetShaderResources(0, [shaderView]);
    methods.PSGetShaderResources(0, 1, out);
    assert.deepEqual(out.views, [null], 'set while it is a target, it is set as none');
    assert.ok(said.length >= 2);
    methods.OMSetRenderTargets([], null);
    methods.PSSetShaderResources(0, [shaderView]);
    methods.PSGetShaderResources(0, 1, out);
    assert.deepEqual(out.views, [shaderView], 'no longer a target, it binds');
});
