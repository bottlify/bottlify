/*
 * Copyright Bottlify Project 2026
 * Licenses and contributions: THIRD-PARTY-NOTICES.md
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeConfig } from "./config.js";

const KNOWN = ["alpha", "beta"];

test("defaults enable every module with null config", () => {
    const out = normalizeConfig(undefined, KNOWN);
    assert.deepEqual([...out.keys()], KNOWN);
    for (const name of KNOWN) {
        assert.deepEqual(out.get(name), { enabled: true, config: null });
    }
});

test("false and null disable modules", () => {
    const out = normalizeConfig({ alpha: false, beta: null }, KNOWN);
    const alpha = out.get("alpha");
    const beta = out.get("beta");
    assert.ok(alpha && beta);
    assert.equal(alpha.enabled, false);
    assert.equal(beta.enabled, false);
});

test("an object enables a module and is passed as config", () => {
    const out = normalizeConfig({ alpha: { seed: 7 } }, KNOWN);
    assert.deepEqual(out.get("alpha"), { enabled: true, config: { seed: 7 } });
});

test("true and undefined keep the default configuration", () => {
    const out = normalizeConfig({ alpha: true }, KNOWN);
    assert.deepEqual(out.get("alpha"), { enabled: true, config: null });
    assert.deepEqual(out.get("beta"), { enabled: true, config: null });
});

test("unknown module name is a configuration error", () => {
    assert.throws(() => normalizeConfig({ gamma: true }, KNOWN), /Unknown module/);
});

test("an unsupported value type is a configuration error", () => {
    assert.throws(() => normalizeConfig({ alpha: 42 }, KNOWN), /expected boolean\/null\/object/);
});