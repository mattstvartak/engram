Knowledge graph operation: $ARGUMENTS

Parse the subcommand from the arguments:

- `timeline <entity>` - Call `memory_kg_timeline` for the entity. Present results chronologically with valid-from/valid-to dates. Show both current and historical facts.
- `about <entity>` - Call `memory_kg_query` filtered to the entity as subject. Show all currently valid triples in a readable format. Group by predicate type if there are many.
- `add <subject> <predicate> <object>` - Call `memory_kg_add` with the triple. If the fact contradicts an existing one, ask if the old fact should be invalidated.
- `correct <subject> <predicate>` - Search for existing triples matching the subject and predicate. Show them. Ask the user for the correct value. Invalidate the old triple with `memory_kg_invalidate` and add the new one with `memory_kg_add`.
- `stats` - Call `memory_kg_stats`. Show entity count, triple count, active vs invalidated, and most connected entities.

If no subcommand is given, show this list of available subcommands.
