#!/bin/bash
# Proma Dev RDP wrapper - disable GPU for Hyper-V + xrdp
exec "$(dirname "$0")/app/proma-dev" --disable-gpu --disable-software-rasterizer --remote-debugging-port=9224 "$@"