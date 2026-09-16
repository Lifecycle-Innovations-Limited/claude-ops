#!/usr/bin/env python3
"""Match text against HASHED operator-identity terms.

WHY THE TERMS ARE HASHED

A public repo cannot carry the operator's own name, handles, account id or
phone number in cleartext: the denylist would itself be the leak. That is why
`test-no-secrets.sh` loads identity terms from an out-of-repo file.

But an out-of-repo file is not present in CI, so that check SKIPs there — and a
check that skips is the reason a personal name reached a public commit message
and a public PR body while `pii-gate` reported success the whole time.

So the same terms also live in the repo as SALTED SHA-256 DIGESTS. CI can then
refuse a term without ever publishing it. This is obscurity, not secrecy: a
12-digit account id has little entropy and a determined reader with a wordlist
can recover it. That is the right trade anyway — the job is to keep this data
off a public, search-indexed surface, not to keep it cryptographically secret
from someone who already holds it.

The cleartext denylist still wins where it exists (a developer machine): it
catches substrings and new terms the digest file has never seen.

USAGE
    pii-digest.py <digest-file> <salt> < text

Reads text on stdin, prints one "<token>\t<line>" per hit — the token that
matched, and the whole line it sat on, so a caller can name both.
"""

import hashlib
import re
import sys

# A token is an identifier-ish run. The separators stay INSIDE the class so a
# whole address ("someone.example@some-domain.tld") hashes as one token; the
# split pass below then also hashes its parts, so a brand term embedded in a
# domain is caught without hashing every English word around it.
TOKEN_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.+@-]*")
SPLIT_RE = re.compile(r"[._+@-]+")
ALPHA_RE = re.compile(r"^[A-Za-z]+$")


def load_digests(path):
    """One digest per line; '#' comments and blanks ignored."""
    out = set()
    try:
        with open(path, "r", encoding="utf-8") as fh:
            for raw in fh:
                line = raw.split("#", 1)[0].strip().lower()
                if line:
                    out.add(line)
    except OSError:
        pass
    return out


def candidates(line):
    """Every hashable form of one line, lowercased.

    Three forms, because a term hides in three shapes: as a whole token
    ("someusername"), as a piece of a longer one ("brand" inside
    "brand.example"), and as two words with a space between them, which is how
    a person's name is written in a commit message.
    """
    toks = [t.strip(".-_+") for t in TOKEN_RE.findall(line)]
    toks = [t for t in toks if t]
    seen = []
    for tok in toks:
        seen.append(tok.lower())
        for part in SPLIT_RE.split(tok):
            if len(part) > 2:
                seen.append(part.lower())
    words = [t for t in toks if ALPHA_RE.match(t)]
    for i in range(len(words) - 1):
        seen.append((words[i] + " " + words[i + 1]).lower())
    return seen


def main():
    if len(sys.argv) != 3:
        sys.stderr.write("usage: pii-digest.py <digest-file> <salt>\n")
        return 2
    digests = load_digests(sys.argv[1])
    if not digests:
        # No digest file is not "clean": say nothing and let the caller decide.
        return 0
    salt = sys.argv[2].encode("utf-8")

    hits = 0
    for raw in sys.stdin:
        line = raw.rstrip("\n")
        if not line.strip():
            continue
        reported = set()
        for cand in candidates(line):
            if cand in reported:
                continue
            digest = hashlib.sha256(salt + cand.encode("utf-8")).hexdigest()
            if digest in digests:
                reported.add(cand)
                hits += 1
                # The token is printed back so the human sees WHICH term fired.
                # It is their own data and they are the only reader; the point
                # of the hash is the repo, not the terminal.
                sys.stdout.write("%s\t%s\n" % (cand, line))
    return 0 if hits == 0 else 0


if __name__ == "__main__":
    sys.exit(main())
