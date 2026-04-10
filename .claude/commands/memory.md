Quick memory operation: $ARGUMENTS

Parse the subcommand from the arguments:

- `save <content>` - Call `memory_check_duplicate` first. If no duplicate, call `memory_ingest` with the content.
- `diary [date]` - Call `memory_diary_read` with the date (or today). Present entries chronologically.
- `diary write <entry>` - Call `memory_diary_write` with the entry content.
- `import <source>` - Ask for file path and format (Claude Code JSONL, ChatGPT JSON, or plain text). Call `memory_import`.
- `rules` - Call `memory_rules`. Show active procedural rules with confidence scores and domains.
- `session [show|clear]` - Call `memory_session` with show or clear.

If no subcommand is given, show this list of available subcommands.
