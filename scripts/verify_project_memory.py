#!/usr/bin/env python3
"""Check project memory structure and obvious credential shapes without exposing matches."""
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parents[1]
REQUIRED = (
    "AGENTS.md",
    "LEARNINGS.md",
    "docs/project_memory/README.md",
    "docs/project_memory/ACTIVE_CONTEXT.md",
    "docs/project_memory/DECISIONS.md",
    "docs/project_memory/HANDOFF_TEMPLATE.md",
    "scripts/verify_project_memory.py",
)
SHAPES = {
    "private key": r"-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----",
    "provider credential": r"\b(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{16,}|AKIA[A-Z0-9]{16})\b",
    "JWT": r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b",
    "bearer credential": r"\bBearer\s+[A-Za-z0-9._~+/-]{16,}={0,2}",
    "cookie value": r"\b(?:Cookie|Set-Cookie)\s*:\s*[^\s;=]+=[A-Za-z0-9%._~+/-]{16,}",
}
ASSIGNMENT = re.compile(
    r'''(?ix)\b(?:[a-z][a-z0-9]*[_-])*(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|client[_-]?secret)\b["']?\s*[:=]\s*["']?([A-Za-z0-9_./+=-]{16,})'''
)


def scan(text):
    findings = []
    for label, pattern in SHAPES.items():
        for match in re.finditer(pattern, text, re.IGNORECASE):
            findings.append((text.count("\n", 0, match.start()) + 1, label))
    for match in ASSIGNMENT.finditer(text):
        findings.append((text.count("\n", 0, match.start()) + 1, "credential assignment"))
    return sorted(set(findings))


def verify(root):
    errors = []
    for name in REQUIRED:
        target = root / name
        if not target.is_file() or target.is_symlink():
            errors.append(f"Missing regular file: {name}")
        elif not target.stat().st_size:
            errors.append(f"Empty file: {name}")
    paths = {root / "AGENTS.md", root / "LEARNINGS.md"}
    paths.update((root / "docs/project_memory").rglob("*.md"))
    texts = {}
    for file in sorted(paths):
        if not file.is_file():
            continue
        name = file.relative_to(root)
        if file.is_symlink() or not file.resolve().is_relative_to(root.resolve()):
            errors.append(f"Refusing memory link outside regular files: {name}")
            continue
        try:
            text = file.read_text(encoding="utf-8")
        except (OSError, UnicodeError):
            errors.append(f"Cannot read UTF-8 file: {name}")
            continue
        texts[str(name)] = text
        for line, label in scan(text):
            errors.append(f"Potential credential: {name}:{line} ({label}; value hidden)")
    agents = texts.get("AGENTS.md", "")
    targets = re.findall(r"\[[^\]]+\]\(<?([^\s)>]+)>?\)", agents)
    for name in ("ACTIVE_CONTEXT.md", "HANDOFF_TEMPLATE.md"):
        expected = f"docs/project_memory/{name}"
        if not any(link.removeprefix("./").split("#", 1)[0] == expected for link in targets):
            errors.append(f"AGENTS.md must link to {expected}")
    return errors, len(texts)


def main():
    errors, count = verify(ROOT)
    if errors:
        print("Project memory validation FAILED")
        print("\n".join(errors))
        return 1
    print(f"Project memory validation PASSED ({len(REQUIRED)} required files; {count} Markdown files scanned)")
    print("Finite pattern scan only; not a guarantee that all sensitive content is absent")
    return 0


if __name__ == "__main__":
    sys.exit(main())
