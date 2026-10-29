#!/usr/bin/env bash
# Blocks a push to main from inside a session.
grep -q 'git push origin main' && exit 2 || exit 0
