Search memories about: $ARGUMENTS

1. Call `memory_search` with the user's query
2. If the query mentions a specific time ("last week", "in March", "before I switched jobs"), the temporal pipeline will handle it automatically
3. If the query mentions a person or entity, the knowledge graph lookup kicks in
4. Present results naturally in conversation, not as a raw dump
5. If no results, say so honestly. Don't make things up.
6. If results seem stale or wrong, ask the user if they want to correct them (use `memory_outcome` with "corrected")

Keep it conversational. Group related memories together. If there are procedural rules relevant to the query, call those out specifically since they represent things the user explicitly told you to do or avoid.
