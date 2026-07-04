#!/bin/bash
cd "$(dirname "$0")"
export PATH="$HOME/.local/node/bin:/usr/local/bin:/opt/homebrew/bin:$PATH"
if [ ! -d node_modules ]; then npm install; fi
npm start
