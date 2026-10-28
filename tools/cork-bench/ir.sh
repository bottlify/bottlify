#!/bin/bash
# Machine instructions an iteration of a cork-bench workload, cork or native (`ir.mjs`):
# valgrind's count of WARM+100 iterations less WARM+0, over 100. V8's GC heuristics are
# timed, so the node runs --predictable; liftoff and tier-up off, so every wasm function is
# the optimising compiler's from the start. Exact to ~0.05 % run to run.
#
# native/NAME.wasm: clang 18 `--target=wasm32 -O2 -nostdlib -Wl,--no-entry -Wl,--export=main
# src/NAME.c` rebuilds vm crc switch tree fmath vcall byte for byte; sort, game and str were built
# with flags not recorded.
#
#   tools/cork-bench/ir.sh NAME [native]   env NODE (node), WARM (1000), VARIANT, CORK, APP_ROOT
here=$(dirname "$0")
node=${NODE:-node}
warm=${WARM:-1000}
count(){
    valgrind --tool=callgrind --smc-check=all-non-file --callgrind-out-file=/dev/null "$node" \
        --single-threaded --predictable --predictable-gc-schedule --no-liftoff \
        --no-wasm-dynamic-tiering "$here/ir.mjs" "$1" "$warm" "$2" "$3" 2>&1 \
        | grep -o "Collected : [0-9]*" | grep -o "[0-9]*"
}
a=$(count "$1" 0 "$2")
b=$(count "$1" 100 "$2")
echo "$1 ${2:-cork} $(( (b - a) / 100 )) instructions an iteration"
