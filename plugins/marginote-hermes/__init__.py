"""Marginote's native Hermes integration; no global configuration changes."""


def register(ctx):
    from .bridge import main

    ctx.register_cli_command(
        name="marginote-bridge",
        help="Serve Marginote's local native artifact conversation protocol",
        setup_fn=lambda parser: None,
        handler_fn=lambda args: main(ctx),
    )
