#!/usr/bin/env node
process.stderr.write('bulk credential setup refused: staged enrollment is required\n');
process.exitCode = 2;
