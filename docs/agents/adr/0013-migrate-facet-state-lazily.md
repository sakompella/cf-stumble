# Migrate facet state lazily, on first read

Facet state carries a schema version, and new agent code migrates it on first read rather than when its generation is promoted. Migrating at promotion would turn an atomic pointer switch into a long-running data operation that can fail halfway. The live pointer could then name a generation whose state is only partly converted, and rollback cannot undo it because the data has already moved.
