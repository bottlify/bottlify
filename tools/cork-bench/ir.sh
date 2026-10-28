#!/bin/bash
# Machine instructions an iteration of a cork-bench workload, cork or native (`ir.mjs`):
# valgrind's count of WARM+ITERS iterations less WARM+0, over ITERS. V8's GC heuristics are
# timed, so the node runs --predictable; liftoff and tier-up off, so every wasm function is
# the optimising compiler's from the start.
#
# The runtime's budgets are timed too, so what it translates follows the machine's load unless
# the run's clock is its own: CLOCK=0.001 ITERS=1000 (`ir.mjs`), within 0.23 % run to run.
#
# Exact is not unbiased: a one-off piece of host work (a collection, a compile) whose moment
# depends on the arm's heap can fall inside the counted iterations of one arm and not the
# other, a few per cent on a workload whose translation did not change. WASM=1 also counts the
# instructions in V8's printed wasm code (tools/wasm-grind.mjs), which such work never
# reaches: judge a change to cork's code by that column.
#
# native/NAME.wasm: clang 18 `--target=wasm32 -O2 -nostdlib -Wl,--no-entry -Wl,--export=main
# src/NAME.c` rebuilds vm crc switch tree fmath vcall byte for byte; sort, game and str were built
# with flags not recorded.
#
#   tools/cork-bench/ir.sh NAME [native]   env NODE (node), WARM (1000), ITERS (100), WASM,
#       VARIANT, CORK, APP_ROOT, CLOCK
here=$(dirname "$0")
node=${NODE:-node}
warm=${WARM:-1000}
iters=${ITERS:-100}
flags=(--single-threaded --predictable --predictable-gc-schedule --no-liftoff
    --no-wasm-dynamic-tiering)
count(){
    valgrind --tool=callgrind --smc-check=all-non-file --callgrind-out-file=/dev/null "$node" \
        "${flags[@]}" "$here/ir.mjs" "$1" "$warm" "$2" "$3" 2>&1 \
        | grep -o "Collected : [0-9]*" | grep -o "[0-9]*"
}
# "all wasm" of one run: callgrind's counts by instruction joined with the code V8 printed.
counted(){
    local base
    base=$(mktemp)
    valgrind --tool=callgrind --smc-check=all-non-file --dump-instr=yes \
        --callgrind-out-file="$base.out" "$node" --print-wasm-code "${flags[@]}" \
        "$here/ir.mjs" "$1" "$warm" "$2" "$3" > "$base.code" 2> /dev/null
    "$node" "$here/../wasm-grind.mjs" "$base.out" "$base.code" --exact
    rm -f "$base" "$base.out" "$base.code"
}
if [ -n "$WASM" ]; then
    read -r a wa <<< "$(counted "$1" 0 "$2")"
    read -r b wb <<< "$(counted "$1" "$iters" "$2")"
    echo "$1 ${2:-cork} $(( (b - a) / iters )) instructions an iteration," \
        "$(( (wb - wa) / iters )) in wasm"
else
    a=$(count "$1" 0 "$2")
    b=$(count "$1" "$iters" "$2")
    echo "$1 ${2:-cork} $(( (b - a) / iters )) instructions an iteration"
fi
