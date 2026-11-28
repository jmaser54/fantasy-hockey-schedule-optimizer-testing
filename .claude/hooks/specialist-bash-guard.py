#!/usr/bin/env python3
"""PreToolUse guard for the specialist subagents (.claude/agents/*.md); never used by the main session.

Blocks Bash commands that commit, push, change git state, call GitHub's CLI, install packages, run the data
refresh scripts, touch the Live repository, send data with curl/wget, or write files outside /tmp.
Exit 2 blocks the call and shows the reason to the subagent.

This is a guardrail, not a security boundary: a program started from an allowed command (for example a
Node or Python script) can still write files itself. The main session therefore checks `git status` in both
clones after every delegation (CLAUDE.md, "Delegation").
"""
import json
import re
import shlex
import sys


def block(reason: str) -> None:
    print(f"Blocked by the specialist guard: {reason}. Specialists are read-only; ask the main session to do this.", file=sys.stderr)
    sys.exit(2)


try:
    data = json.load(sys.stdin)
    cmd = data.get("tool_input", {}).get("command", "")
    if not isinstance(cmd, str):
        raise ValueError("no command")
except Exception:
    block("the command could not be read")

# Whole-command checks.
if re.search(r"fantasy-hockey-schedule-optimizer(?!-testing)", cmd):
    block("the Live repository is off limits")
if re.search(r"\b(npm|pnpm|yarn)\s+(run\s+)?data:", cmd) or re.search(r"scripts/(refresh-data|refresh-insights|fetch-historical-stats)", cmd):
    block("data refresh scripts write public data")

GIT_READ = {"status", "log", "show", "diff", "rev-parse", "ls-files", "ls-tree", "blame", "grep", "describe", "cat-file", "shortlog", "rev-list", "merge-base", "name-rev", "check-ignore", "for-each-ref", "show-ref", "help", "version", "--version"}
WRITE_TOOLS = {"rm", "rmdir", "mv", "chmod", "chown", "ln", "truncate", "dd", "install", "rsync", "scp", "shred"}
TMP_ONLY = {"tee", "cp", "mkdir", "touch"}


def outside_tmp(path: str) -> bool:
    return not (path.startswith("/tmp/") or path in ("/dev/null", "/dev/stdout", "/dev/stderr"))


# Output redirections anywhere in the command must target /tmp.
for m in re.finditer(r"(?:^|[^<>&\d])(?:\d|&)?>>?\s*([^\s;|&<>()]+)", cmd):
    target = m.group(1)
    if target.startswith("&"):
        continue  # fd duplication such as 2>&1
    if outside_tmp(target):
        block(f"writing to {target} (only /tmp is allowed)")

# Per-segment checks.
for seg in re.split(r"&&|\|\||;|\||\n|&", cmd):
    try:
        words = shlex.split(seg, comments=False, posix=True)
    except ValueError:
        words = seg.split()
    while words and re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", words[0]):
        words = words[1:]  # leading VAR=value assignments
    while words and words[0] in ("sudo", "env", "nohup", "time", "command", "exec", "xargs", "timeout"):
        words = words[1:]
        if words and re.match(r"^\d+[smh]?$", words[0]):
            words = words[1:]  # timeout duration
    if not words:
        continue
    prog = words[0].rsplit("/", 1)[-1]
    args = words[1:]
    if prog == "git":
        rest = list(args)
        while rest and rest[0] in ("-C", "-c", "--git-dir", "--work-tree"):
            rest = rest[2:]
        while rest and rest[0].startswith("-") and rest[0] not in ("--version",):
            rest = rest[1:]
        sub = rest[0] if rest else "status"
        if sub == "branch" and all(a.startswith("--") or a in ("-a", "-r", "-v", "-vv", "--list") for a in rest[1:]):
            continue
        if sub not in GIT_READ:
            block(f"`git {sub}` changes repository state")
    elif prog in ("gh", "hub"):
        block("the GitHub CLI is not available to specialists")
    elif prog in ("npm", "pnpm", "yarn"):
        sub = next((a for a in args if not a.startswith("-")), "")
        if sub not in ("test", "run", "ls", "list", "view", "outdated", "--version"):
            block(f"`{prog} {sub}` changes installed packages or publishes")
        if sub == "run":
            script = next((a for a in args[args.index("run") + 1:] if not a.startswith("-")), "")
            if script not in ("test", "typecheck", "build", "preview"):
                block(f"`{prog} run {script}` is not an allowed script (test, typecheck, build, preview)")
    elif prog == "npx":
        tool = next((a for a in args if not a.startswith("-")), "")
        if tool not in ("vitest", "tsc", "vite", "playwright"):
            block(f"`npx {tool}` is not allowed")
        if tool == "playwright" and "install" in args:
            block("installing browsers is not allowed")
    elif prog in ("curl", "wget"):
        if any(a in ("-X", "--request", "-d", "--data", "--data-raw", "--data-binary", "--data-urlencode", "-F", "--form", "-T", "--upload-file", "--post-data", "--post-file", "--method") or a.startswith(("-X", "--data", "--request=", "--method=")) for a in args):
            block(f"`{prog}` may only fetch (no uploads or non-GET methods)")
    elif prog in WRITE_TOOLS:
        block(f"`{prog}` modifies files")
    elif prog in ("sed", "perl", "ruby") and any(a == "-i" or a.startswith("-i") or a.startswith("--in-place") for a in args):
        block(f"`{prog} -i` edits files in place")
    elif prog in TMP_ONLY:
        paths = [a for a in args if not a.startswith("-")]
        if prog == "cp":
            paths = paths[-1:]  # the destination
        if any(outside_tmp(p) for p in paths):
            block(f"`{prog}` outside /tmp")
sys.exit(0)
