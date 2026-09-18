"""Launch review from the exact calling Hermes session, without a second chat."""

import os
from pathlib import Path
import re
import shutil
import sqlite3


def setup(parser):
    parser.add_argument("document", nargs="?", help="Artifact to review")
    parser.add_argument("--root", help="Vault root (default: current working directory)")
    parser.add_argument("--session", help="Exact existing session; defaults to Hermes's per-command session id")
    parser.add_argument("--turn", type=int, help="An already completed delivery row (outside an active Hermes turn)")
    parser.add_argument("--port", type=int, default=0, help="Local port; default: choose a free port")
    parser.add_argument("--no-open", action="store_true", help="Print the review link without opening a browser")
    parser.add_argument("--setup", metavar="CLI_PATH", help="Remember an existing Marginote executable or built CLI .js for this profile")


def command_for_path(value):
    path = Path(value).expanduser().resolve(strict=True)
    if not path.is_file():
        raise ValueError("Marginote CLI must be a file")
    if path.suffix in {".js", ".mjs"}:
        node = shutil.which("node")
        if not node:
            raise RuntimeError("Node.js is required by the installed Marginote CLI")
        return [node, str(path)]
    if not os.access(path, os.X_OK):
        raise ValueError("Marginote CLI is not executable")
    return [str(path)]


def resolve_command(ctx):
    configured = ctx.get_config("cli_command")
    if configured is not None:
        if not isinstance(configured, list) or not configured or not all(isinstance(x, str) and x for x in configured):
            raise ValueError("Invalid Marginote cli_command setting; run hermes marginote --setup CLI_PATH")
        if not Path(configured[0]).is_file():
            raise ValueError("Saved Marginote CLI is unavailable; run hermes marginote --setup CLI_PATH")
        return configured
    installed = shutil.which("marginote")
    if installed:
        return [installed]
    checkout = Path(__file__).resolve().parents[2] / "packages/cli/bin/marginote.js"
    if checkout.is_file():
        return command_for_path(checkout)
    raise RuntimeError("Marginote is not on PATH. Configure its existing installation once: hermes marginote --setup /path/to/marginote.js")


def launch_args(args, profile_home):
    if not args.document:
        raise ValueError("Use hermes marginote report.md")
    document = Path(args.document).expanduser().resolve(strict=True)
    if not document.is_file():
        raise ValueError("The review artifact must be an existing file")
    root = Path(args.root).expanduser().resolve(strict=True) if args.root else Path.cwd().resolve()
    if not args.root and not document.is_relative_to(root):
        root = document.parent
    relative = document.relative_to(root).as_posix()
    session = args.session or os.environ.get("HERMES_SESSION_ID")
    if not isinstance(session, str) or not re.fullmatch(r"[\w-]{1,160}", session):
        raise ValueError("No current Hermes session. Run this command inside Hermes, or supply --session ID --turn ROW. Never create a substitute chat.")
    if args.session and args.session != os.environ.get("HERMES_SESSION_ID") and args.turn is None:
        raise ValueError("An explicitly selected session requires its completed --turn ROW")
    db_path = (Path(profile_home) / "state.db").resolve(strict=True)
    db = sqlite3.connect(db_path.as_uri() + "?mode=ro", uri=True)
    try:
        if not db.execute("SELECT 1 FROM sessions WHERE id=?", (session,)).fetchone():
            raise ValueError("The calling Hermes session is not in this profile; finish its first persisted message before opening review")
        if args.turn is not None:
            if args.turn <= 0:
                raise ValueError("The delivery row must be positive")
            boundary = ["--origin-turn", str(args.turn)]
        else:
            marker = db.execute("SELECT COALESCE(MAX(id), 0) FROM messages WHERE session_id=?", (session,)).fetchone()[0]
            boundary = ["--origin-after", str(marker)]
    finally:
        db.close()
    if not 0 <= args.port <= 65535:
        raise ValueError("Invalid local port")
    return [str(root), "--doc", relative, "--port", str(args.port), "--no-discover",
            "--origin-provider", "hermes", "--origin-session", session, *boundary,
            *([] if args.no_open else ["--open"])]


def main(ctx, args):
    if args.setup:
        command = command_for_path(args.setup)
        ctx.set_config("cli_command", command)
        print("Marginote launcher configured for this Hermes profile. In Hermes, use: hermes marginote report.md")
        return 0
    from hermes_constants import get_hermes_home

    home = get_hermes_home()
    command = [*resolve_command(ctx), *launch_args(args, home)]
    # Capture the native profile before exec; this also works for named profiles.
    env = dict(os.environ, HERMES_HOME=str(home))
    os.execvpe(command[0], command, env)
