/**
 * Which Pi Durable conversation is each project's current thread. A fresh thread points the row at
 * a new conversation; the old one stays in the Supervisor's storage, unreferenced.
 */
export class ProjectConversations {
  private readonly sql: SqlStorage;

  constructor(storage: DurableObjectStorage) {
    this.sql = storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS project_conversations (
        project_id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL UNIQUE
      );
    `);
  }

  conversationOf(projectId: string): string | undefined {
    return this.sql
      .exec<{ conversation_id: string }>(
        "SELECT conversation_id FROM project_conversations WHERE project_id = ?",
        projectId,
      )
      .toArray()[0]?.conversation_id;
  }

  projectOf(conversationId: string): string | undefined {
    return this.sql
      .exec<{ project_id: string }>(
        "SELECT project_id FROM project_conversations WHERE conversation_id = ?",
        conversationId,
      )
      .toArray()[0]?.project_id;
  }

  conversations(): readonly string[] {
    return this.sql
      .exec<{ conversation_id: string }>("SELECT conversation_id FROM project_conversations")
      .toArray()
      .map((row) => row.conversation_id);
  }

  point(projectId: string, conversationId: string): void {
    this.sql.exec(
      `INSERT INTO project_conversations (project_id, conversation_id) VALUES (?, ?)
       ON CONFLICT (project_id) DO UPDATE SET conversation_id = excluded.conversation_id`,
      projectId,
      conversationId,
    );
  }

  forget(projectId: string): void {
    this.sql.exec("DELETE FROM project_conversations WHERE project_id = ?", projectId);
  }
}
