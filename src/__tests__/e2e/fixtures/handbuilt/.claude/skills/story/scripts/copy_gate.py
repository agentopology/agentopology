#!/usr/bin/env python3
"""Copy gate: refuses a script with a banned phrase."""
import sys
BANNED = ["delve", "tapestry"]
text = open(sys.argv[1]).read().lower()
bad = [w for w in BANNED if w in text]
sys.exit(1 if bad else 0)
