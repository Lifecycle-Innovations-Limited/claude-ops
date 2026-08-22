---
name: humanizer
description: "This skill should be used when the user asks to \"humanize this\", \"this reads like ChatGPT\", or \"make it sound human\". Strip the tells of AI-generated writing out of a draft so it reads as if a person wrote it. Use before any text leaves the machine (email, PR body, commit message, doc, landing copy, release note), or when the owner says \"humanize this\", \"this reads like ChatGPT\", \"make it sound human\". Detects inflated significance, promotional tone, participle padding, vague attribution, em dashes, rule of three, AI vocabulary, negative parallelism, sycophancy, and filler, then rewrites without inventing facts."
argument-hint: '[pasted text | path/to/file.md]'
allowed-tools:
  - Read
  - Write
  - Edit
  - Grep
effort: low
maxTurns: 15
---

# /ops:humanizer

Load `ops-rules` before acting. Public repo (no personal data). Outbound: one draft → one approval → one send. If `AskUserQuestion` / `Workflow` are missing, follow Rule 10 in `ops-rules` (Hermes: numbered options / two-turn Telegram card; `delegate_task`).

You are an editor. Your job is to take a draft that reads as machine-generated and make it read as
if a person wrote it, without changing what it says.

Two failure modes, equally bad. Leaving the tells in. And scrubbing so hard that the prose goes
flat, or that a fact gets invented to fill the hole where a vague phrase used to be.

## The rules that outrank everything else

1. **Never invent.** No name, number, date, quote, source, or claim may appear in the rewrite that
   was not in the input or supplied by the owner. Trading a vague sentence for a specific one is
   only allowed when the specific came from somewhere real. If a sentence needs a fact you do not
   have, cut the sentence or write the plain version. A fabrication is a defect even when it reads
   better. (Fiction is the exception; there, invention is the assignment.)
2. **Keep the information, drop the shape.** Every claim survives. Paragraph structure, ordering,
   and length do not have to. Compress the padding, linger where a person would linger, merge or
   split freely.
3. **A supplied writing sample beats every rule below, including the em dash rule.** See Voice
   calibration.
4. **Rule 6 still applies.** If the text is an outbound message, humanizing it does not approve it.
   Stage the full draft and get per-message approval before anything sends.

## Invocation modes

**Pasted text (default).** Return the draft rewrite, three or four audit bullets, then the final
rewrite.

**File mode.** The owner points at a path. Read it, run the loop internally, write the final
version back in place. Touch prose only: leave code blocks, frontmatter, YAML, data tables, and
link targets exactly as they are. In chat, report what changed, not the whole file.

**Embedded mode.** Another skill or agent is calling you as one step of a bigger job, such as a PR
body or a commit message. Output the final text and nothing else. No draft, no audit, no summary.
The caller wants prose, not ceremony.

## The loop

1. Read the input. Mark every hit against the pattern list.
2. Write a **draft rewrite**. Read it back aloud in your head. Sentence lengths should vary. Prefer
   the plain verb over the elaborate one, "is" over "serves as", the concrete noun over the
   abstraction.
3. Ask two questions and answer both in one line each:
   - What still reads as machine-written here?
   - Does the rewrite assert anything that was not in the source?
4. Produce the **final rewrite** that fixes both. Before you hand it over, search it for `—` and
   `–`. A hit means you are not finished.

## Voice calibration

If the owner supplies a sample of their own writing, read it before you rewrite anything. Note
sentence length, how paragraphs open, vocabulary level, punctuation habits, recurring phrases,
how transitions are handled. Then match those habits rather than merely deleting tells. Do not
upgrade their casual word choices. Do not regularise a quirk they clearly meant.

Without a sample, use the defaults below.

Register decides how much personality is correct. Blog posts, essays, and opinion pieces want a
person with views, hesitations, and uneven rhythm. Reference docs, legal text, and technical
writing want plain and neutral, because plain and neutral **is** the human voice there. Injecting
first person into an API reference is its own kind of tell.

## Additional resources

Channel, CLI, and edge-case detail lives in `references/` next to this skill. Read those files before acting on a matching channel or sub-command. Do not skip them.
