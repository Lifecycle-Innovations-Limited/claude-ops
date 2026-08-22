#!/usr/bin/env python3
"""cliproxy Browser Use reauth wrapper with a longer OAuth timeout."""
import sys
# Legacy deployed runtime path retained for compatibility.
sys.path.insert(0, "/opt/crsproxy")
import bu_reauth
# Increase total timeout from 300 to 600 seconds
bu_reauth.TOTAL_TIMEOUT = 600
bu_reauth.main()
