---
name: ops-leadgen
description: "Lead generation tracking and pipeline."
triggers:
  - ops:leadgen
  - leads
  - leadgen
  - pipeline
  - ops_leadgen
category: Business
usable_tools:
  - exec
  - read
  - edit
  - write
  - web_fetch
  - web_search
  - kimi_search
  - kimi_fetch
  - browser
  - message
  - sessions_spawn
  - g-brain__query
  - g-brain__search
  - g-brain__get_page
  - g-brain__put_page
  - g-brain__list_pages
  - g-brain__think
  - feishu_calendar_event
  - feishu_task_task
  - feishu_im_user_search_messages
  - feishu_im_user_get_messages
---

# OPS-LEADGEN — Lead generation tracking and pipeline.

## Overview

This skill is part of the claude-ops business operating system for OpenClaw.
Category: **Business**

## Triggers

- `ops:leadgen`
- `leads`
- `leadgen`
- `pipeline`
- `ops_leadgen`

## Usage

Type any of the trigger phrases to activate this skill.

## Integration

This skill integrates with OpenClaw's native tool system and channels.

## Data Storage

- Configuration: `skills/claude-ops/config.md`
- Runtime data: g-brain pages under `ops/`
- Logs: OpenClaw session logs

## Port Notes

This is an OpenClaw port of the claude-ops plugin skill.
Original: https://github.com/Lifecycle-Innovations-Limited/claude-ops
