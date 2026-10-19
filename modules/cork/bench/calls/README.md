# Calling conventions: does a function tier pay?

**Status: the decision rule below was written and committed before any measurement it decides
on (2026-10-13).** The runs before it were smoke runs that checked the arms agree.

## The question

cork passes a guest call's state through the state block: eax..ebx and the budget in wasm
parameters, the other registers and the six words of the lazy flags in memory, a shadow stack of
return addresses, and every call through a shared transfer that probes the entry hash
([`modules/cork/src/emit/integer.js`](../../src/emit/integer.js), `callAndReturn`). A function
tier would keep every register in wasm parameters and results across calls. In the cork 1.7 round
that was measured slower on x86-64 (×0.83): V8 keeps a wasm call's parameters past the fifth on
the stack there. arm64 has twice the general registers, so the answer may differ on the machine
the product is measured on, depending on whether V8 uses them for wasm parameters.

## The workloads

Not synthetic: [`profiles.json`](profiles.json) holds the shape of the calls of three block
profiles, measured by [`tools/cork-calls.mjs`](../../../../tools/cork-calls.mjs): guest
instructions between calls, the share of indirect calls, the registers the code after a return
reads first, how many functions the calls go through:

| workload | functions | instructions a call | indirect | live after a return |
| --- | --- | --- | --- | --- |
| farcry | 138 | 78 | 16.4% | 1.42 |
| spread | 226 | 53 | 79.4% | 2.29 |
| entities | 24 | 52 | 85.9% | 2.82 |

How deeply calls nest is not in a block profile (`not measured`): every workload runs at depths 2,
8 and 32, and the decision is taken at 8.

## The arms

- **state:** cork's call today, as `callAndReturn`/`returnToCall` emit it.
- **state-direct:** the same convention with a direct `call` (or `call_indirect` by index): what
  the transfer's probe costs, apart from the convention.
- **params:** all eight registers and the budget in parameters and results; the flags through
  memory as today; the callee answers the address its `ret` took, which the caller compares.
- **params+flags:** the six flag words in parameters and results too.

Every arm does the same guest work and must end with the same registers; the runner stops if one
does not.

## The decision rule

Measured with TurboFan (`--no-liftoff`), each value the median of 9 runs of ~200 ms after 5
warming runs, at depth 8.

**Build the function tier** only if, for both `farcry` and `spread`, on **both** the M4 (arm64,
Chrome) and the x64 VM (Chromium and Node):

1. `params` takes at most **0.70** of `state`'s time a call (30% less), and
2. `params` takes at most **0.80** of `state-direct`'s (20% less from the convention alone), and
3. each difference is more than **3 times** the larger spread (max − min over median) of the two
   arms compared.

**A negative result** (an entry in
[`roadmap/negative-results.md`](../../../../roadmap/negative-results.md), the tier not built) if
`params` takes more than **0.90** of `state-direct`'s time for `farcry` on either machine, or if
[`inspect.mjs`](inspect.mjs) shows the M4's V8 passing the `params` arm's parameters (nine)
through the stack as x64's does.

Anything between: recorded, not built, and measured again on a game when there is a reason.

Not decided on, recorded beside: Liftoff (translated code runs Liftoff only until TurboFan takes
it), depths 2 and 32, `entities`, `params+flags`.

Why these numbers: calls and returns are ~13% (`farcry`) to ~36% (`spread`) of the wasm bytes
cork's hot code runs through. A call 30% cheaper is then 4–11% of guest time; less than that does
not pay for a second translation path with its own gate.

## Running it

On the machine to measure, in this checkout:

    node modules/cork/bench/calls/build.mjs          # writes calls.html beside it
    node modules/cork/bench/calls/inspect.mjs        # does V8 keep the parameters in registers?

Chrome, once per tier, from the command line (quit Chrome first; macOS shown):

    open -na "Google Chrome" --args --user-data-dir=/tmp/calls-tf --js-flags=--no-liftoff \
        "file://$PWD/modules/cork/bench/calls/calls.html?tier=turbofan"
    open -na "Google Chrome" --args --user-data-dir=/tmp/calls-lo \
        --js-flags="--liftoff --no-wasm-tier-up" \
        "file://$PWD/modules/cork/bench/calls/calls.html?tier=liftoff"

`chrome://version` in that window shows the command line it was started with. Press Run, leave the
tab in front and the machine on mains power, and copy the JSON when it says done (about three
minutes a tier).

In Node:

    node --no-liftoff modules/cork/bench/calls/run.mjs --tier turbofan --out tf.json
    node --liftoff --no-wasm-tier-up modules/cork/bench/calls/run.mjs --tier liftoff --out lo.json

## Result (2026-10-13)

x64 VM, TurboFan, depth 8: `params` / `state-direct` for `farcry` is 1.085 in Node 22.22.0 and
0.959 in Chromium 141.0.7390.37, above the 0.90 of the negative branch; the function tier is not
built. Values and conditions: [`roadmap/negative-results.md`](../../../../roadmap/negative-results.md),
2026-10-13. The M4 run will be recorded beside it.

## Step 2's ceiling: loading only what is live after a call

**Status: the rule below was written and committed before the run it decides on (2026-10-13).**

Step 2 keeps cork's convention and cuts what a call site writes back and loads again: after the
return only the registers the continuation reads before it writes them. The arm `state-live` is
`state` that reloads only esp and the `live after a return` registers of the workload, and no
flags. That is more than step 2 can reach (a region's exits read every register, and its flags are
dead after a call only where the code says so), so its gain is the ceiling. Its guest results
differ from the others' and are not compared.

Timed by [`paired.mjs`](paired.mjs): `state` and `state-live` alternated in 15 pairs of ~200 ms
runs after 3 warming pairs, at depth 8, TurboFan; the ratio `state-live` / `state` of each pair.

**Step 2a/2b goes on** to the translator only if, for both `farcry` and `spread` in Node, the
median ratio is at most **0.90** and `state-live` is faster in at least **13 of 15** pairs (a sign
test at about 0.004); then the same is checked in Chromium before any code. **Otherwise a dead
end** (an entry in [`roadmap/negative-results.md`](../../../../roadmap/negative-results.md)): a
ceiling under 10% of a call is under ~1.3% of guest time in the `farcry` profile, calls being ~13%
of its hot bytes (step 0a), which no game measurement separates from noise.

    node --no-liftoff modules/cork/bench/calls/paired.mjs --tier turbofan --out paired.json
