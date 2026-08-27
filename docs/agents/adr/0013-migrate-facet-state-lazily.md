# Migrate facet state lazily, on first read

Facet state carries a schema version, and new agent code migrates that state when it first reads it rather than when its generation is promoted. Migrating during promotion would turn an atomic pointer switch into a long-running data operation that can fail halfway, leaving the live pointer naming a generation whose state was only partly converted — a state rollback cannot undo, because the data has already moved.
