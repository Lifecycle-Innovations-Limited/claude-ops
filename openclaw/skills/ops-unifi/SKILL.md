---
name: ops-unifi
description: "UniFi network management."
triggers:
  - ops:unifi
  - unifi
  - network
  - ops_unifi
category: Utilities
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

# OPS-UNIFI — UniFi network management.

## Overview

This skill is part of the claude-ops business operating system for OpenClaw.
Category: **Utilities**

## Triggers

- `ops:unifi`
- `unifi`
- `network`
- `ops_unifi`

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
