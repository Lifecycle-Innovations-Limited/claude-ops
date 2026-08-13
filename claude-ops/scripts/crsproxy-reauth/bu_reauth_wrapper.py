#!/usr/bin/env python3
"""Wrapper for bu_reauth.py with increased timeout for slow OAuth flows."""
import sys
sys.path.insert(0, "/opt/crsproxy")
import bu_reauth
# Increase total timeout from 300 to 600 seconds
bu_reauth.TOTAL_TIMEOUT = 600
bu_reauth.main()
