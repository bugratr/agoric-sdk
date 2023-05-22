#!/bin/bash
# Generates visualizations of the internal package dependency graph.
set -ueo pipefail
DIR=$(dirname -- "${BASH_SOURCE[0]}")
{
    echo 'digraph {'
    # Left is depended upon the least and right the most.
    echo 'rankdir=LR'
    cat "$DIR"/../packages/*/package.json | jq -r --slurp '
        . as $all |
        [.[] | {(.name): true}] | add as $locals |

        $all[] |
        .name as $from |
        (.dependencies // {}) |
        keys[] |
        {$from, to: .} |
        select($locals[.from] and $locals[.to]) |
        "\"\(.from)\" -> \"\(.to)\""
    '
    echo '}'
    # normalize
} | dot -Tcanon >packages-graph.dot
dot -Tpng <packages-graph.dot >"$DIR"/../packages-graph.png

dot -Tsvg <packages-graph.dot >"$DIR"/../packages-graph.svg

if acyclic packages-graph.dot | dot -Tcanon >packages-sans-cycles.dot; then
    echo "No cycles in 'dependencies' of packages."
else
    echo "Cycles detected. These lines appear only in the original graph and not the acyclic variant:"
    comm -23 <(sort packages-graph.dot) <(sort packages-sans-cycles.dot)
fi
