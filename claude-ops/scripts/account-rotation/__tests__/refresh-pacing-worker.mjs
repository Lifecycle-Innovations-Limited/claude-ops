#!/usr/bin/env node
import { claimRefreshPace } from '../crs-refresh-lock.mjs';

const key = process.argv[2];
const now = Number(process.argv[3]);
const value = claimRefreshPace(key, now, () => 0);
console.log(String(value));
