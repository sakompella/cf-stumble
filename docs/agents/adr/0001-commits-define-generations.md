---
Status: superseded by ADR-0002
---

# Treat commits as generations

The initial design made each commit a generation and derived its number from its depth in the commit DAG, keeping content, lineage, and generation naming in Git. That made exploratory commits into unintended activation attempts and gave two branches created after a rollback the same depth-derived number. ADR-0002 replaces this model.
