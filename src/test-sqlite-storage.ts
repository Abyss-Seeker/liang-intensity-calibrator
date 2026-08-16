import { DatabaseSync } from "node:sqlite";
import type {
  SqlCursorLike,
  SqlStorageLike,
  TransactionalStorageLike,
} from "./vote-store";

class TestCursor<T extends Record<string, unknown>>
  implements SqlCursorLike<T>
{
  constructor(
    private readonly rows: T[],
    readonly rowsWritten: number,
  ) {}

  toArray(): T[] {
    return this.rows;
  }
}

export class TestStorage implements TransactionalStorageLike {
  private readonly database = new DatabaseSync(":memory:");
  readonly scheduledAlarms: number[] = [];
  readonly executedQueries: string[] = [];
  private currentAlarm: number | null = null;

  readonly sql: SqlStorageLike = {
    exec: <T extends Record<string, unknown>>(
      query: string,
      ...bindings: Array<string | number | null>
    ): SqlCursorLike<T> => {
      this.executedQueries.push(query);
      if (bindings.length > 100) {
        throw new Error("Cloudflare SQLite allows at most 100 bindings");
      }
      const statements = query
        .split(";")
        .map((statement) => statement.trim())
        .filter(Boolean);
      if (bindings.length === 0 && statements.length > 1) {
        this.database.exec(query);
        return new TestCursor<T>([], 0);
      }

      const statement = this.database.prepare(query);
      if (/^\s*(SELECT|WITH|PRAGMA)\b/i.test(query)) {
        return new TestCursor<T>(statement.all(...bindings) as T[], 0);
      }
      const result = statement.run(...bindings);
      return new TestCursor<T>([], Number(result.changes));
    },
  };

  transactionSync<T>(callback: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = callback();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  setAlarm(scheduledTime: number | Date): Promise<void> {
    this.currentAlarm = Number(scheduledTime);
    this.scheduledAlarms.push(this.currentAlarm);
    return Promise.resolve();
  }

  getAlarm(): Promise<number | null> {
    return Promise.resolve(this.currentAlarm);
  }

  deleteAlarm(): Promise<void> {
    this.currentAlarm = null;
    return Promise.resolve();
  }

  close(): void {
    this.database.close();
  }
}
