#!/bin/bash -i
cd /usr/src/agoric-sdk/ || exit 1

tmux \
    new-session  'SLOGFILE=slog.slog ./upgrade-test-scripts/start_to_to.sh' \; \
    new-window   'bash -i'
