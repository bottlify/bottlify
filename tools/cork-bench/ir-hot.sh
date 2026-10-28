#!/bin/bash
# Where a cork-bench workload's executed machine instructions go (`ir-hot.mjs`): one run under
# valgrind callgrind with each instruction's count, V8 printing every wasm function's code as it
# compiles it, both laid together by function and by kind (spills and reloads, moves, ...).
# The node runs as `ir.sh`'s does; WARM iterations and ITERS more, all counted.
#
#   tools/cork-bench/ir-hot.sh NAME [ir-hot.mjs options]   env NODE (node), WARM (300),
#       ITERS (300), OUT (a directory for the two files, default a temporary one), VARIANT,
#       CORK, APP_ROOT
here=$(dirname "$0")
node=${NODE:-node}
out=${OUT:-$(mktemp -d)}
valgrind --tool=callgrind --smc-check=all-non-file --dump-instr=yes --compress-pos=no \
    --compress-strings=no --callgrind-out-file="$out/$1.callgrind" "$node" \
    --single-threaded --predictable --predictable-gc-schedule --no-liftoff \
    --no-wasm-dynamic-tiering --print-wasm-code "$here/ir.mjs" "$1" "${WARM:-300}" \
    "${ITERS:-300}" > "$out/$1.code" 2> /dev/null
name=$1
shift
"$node" "$here/ir-hot.mjs" "$out/$name.callgrind" "$out/$name.code" "$@"
