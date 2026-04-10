---
name: forget
description: "Remove or correct specific memories. Use when the user says /forget, 'forget that', 'that's wrong', 'delete that memory', or wants to correct something Engram remembers incorrectly."
user-invocable: true
metadata: {"openclaw":{"emoji":"🗑️"}}
---

# Forget

Remove, correct, or archive specific memories.

## Usage

```
/forget <what to forget>
```

## Behavior

1. Search for memories matching what the user wants removed using `memory_search`
2. Show the user what was found and confirm before taking action
3. For corrections: use `memory_outcome` with type "corrected" on the wrong memory, then `memory_ingest` the corrected version
4. For deletions: use `memory_outcome` with type "irrelevant" to heavily demote the memory. Mark it multiple times if needed to push it toward archival.
5. For knowledge graph facts that are wrong: use `memory_kg_invalidate` to mark the fact as no longer valid, then `memory_kg_add` the correct fact if applicable
6. For procedural rules that are wrong: note the contradiction so the rule's confidence drops

## Important

Always confirm with the user before acting. Show them exactly which memories you found so they can pick which ones to remove or correct. Don't delete blindly.

If the user says "forget everything about X" be extra careful. Confirm the scope.
