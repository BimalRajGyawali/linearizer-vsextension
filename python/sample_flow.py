"""Synthetic flow for exercising the tracer end-to-end."""
from __future__ import annotations

from typing import Iterable, List, Dict


def analyze_git_repo(branch: str = "main") -> Dict[str, object]:
    greeting = f"Analyzing branch {branch}"
    commits = collect_commit_history(branch)
    enriched = enrich_commits(commits)
    report = render_report(branch, enriched)
    return {"greeting": greeting, "commits": commits, "report": report}


def collect_commit_history(branch: str) -> List[str]:
    stream = acquire_git_stream(branch)
    commits = list(stream)
    return commits


def acquire_git_stream(branch: str) -> Iterable[str]:
    command = build_git_log_command(branch)
    # In a real implementation we would run the command. For tests we just expand.
    for idx in range(1, 4):
        yield f"{command}-{idx}"


def build_git_log_command(branch: str) -> str:
    return f"git-log-{branch}"


def enrich_commits(commits: List[str]) -> List[Dict[str, object]]:
    return [{"id": commit, "length": len(commit)} for commit in commits]


def render_report(branch: str, commits: List[Dict[str, object]]) -> Dict[str, object]:
    return {
        "branch": branch,
        "count": len(commits),
        "first": commits[0]["id"] if commits else None,
    }


if __name__ == "__main__":
    result = analyze_git_repo("demo")
    import json

    print(json.dumps(result, indent=2))
