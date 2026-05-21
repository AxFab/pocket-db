# Search

This directory will contain query parsing, query planning, and search execution.

The first supported planner should stay intentionally small:

- exact field match;
- indexed lookup when an index exists;
- collection scan fallback.
