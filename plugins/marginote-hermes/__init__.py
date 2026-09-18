"""Marginote's native Hermes integration; no global configuration changes."""


def register(ctx):
    from .bridge import main
    from . import launcher

    ctx.register_cli_command(
        name="marginote-bridge",
        help="Serve Marginote's local native artifact conversation protocol",
        setup_fn=lambda parser: None,
        handler_fn=lambda args: main(ctx),
    )
    ctx.register_cli_command(
        name="marginote", help="Open an artifact and automatically continue this Hermes conversation",
        setup_fn=launcher.setup, handler_fn=lambda args: launcher.main(ctx, args),
    )
    ctx.register_system_prompt_section(
        id="marginote.review",
        content="To review an artifact in Marginote, run `hermes marginote PATH` through the terminal tool with background=true. "
                "This persistent local server prints a review URL, inherits this exact Hermes session and model, and connects automatically after your current answer finishes. "
                "Finish your answer after giving the URL; do not wait for connection inside the launching turn. "
                "Never create a throwaway Hermes chat to obtain IDs. No separate MCP setup is needed. "
                "If the launcher reports an unconfigured CLI, use its --setup command once with the existing Marginote CLI path; do not install another copy.",
    )
