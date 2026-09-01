Quick memory operation: $ARGUMENTS

Parse the subcommand from the arguments:

- `save <content>` - Call `memory-ingest` with the content. It checks for duplicates on its own.
- `diary [date]` - Call `memory-diary-read` with the date (or today). Present entries chronologically.
- `diary write <entry>` - Call `memory-diary-write` with the entry content.
- `import <source>` - Ask for file path and format (Claude Code JSONL, ChatGPT JSON, or plain text). Call `memory-import`.
- `rules` - Call `memory-rules`. Show active procedural rules with confidence scores and domains.
- `session [show|clear]` - Call `memory-session` with show or clear.

If no subcommand is given, show this list of available subcommands.
