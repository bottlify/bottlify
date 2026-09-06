/*
 * Copyright Bottlify Project 2026
 * Licenses and contributions: THIRD-PARTY-NOTICES.md
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { makeScopedHost } from "./host.js";

test("requireApi of an undeclared dependency is rejected", () => {
    const host = makeScopedHost("owner", new Set(["owner"]), new Map());
    assert.throws(() => host.requireApi("other"), /did not declare/);
});

test("provide of a foreign interface name is rejected", () => {
    const host = makeScopedHost("owner", new Set(["owner"]), new Map());
    assert.throws(() => host.provide("other", {}), /foreign interface/);
});

test("requireApi before the interface is created is rejected", () => {
    const host = makeScopedHost("owner", new Set(["owner", "fresh"]), new Map());
    assert.throws(() => host.requireApi("fresh"), /not created yet/);
});

test("provide then requireApi roundtrip through the shared registry", () => {
    const apis = new Map();
    const host = makeScopedHost("me", new Set(["me", "you"]), apis);
    host.provide("me", { hello: () => 1 });
    apis.set("you", { hello: () => 2 });
    assert.equal(host.requireApi("me").hello(), 1);
    assert.equal(host.requireApi("you").hello(), 2);
});