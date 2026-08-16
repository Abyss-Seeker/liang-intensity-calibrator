declare module "cloudflare:workers" {
  export interface DurableObjectId {}

  export interface DurableObjectStub {
    fetch(request: Request): Promise<Response>;
  }

  export interface DurableObjectNamespace {
    idFromName(name: string): DurableObjectId;
    get(id: DurableObjectId): DurableObjectStub;
  }

  export interface DurableObjectStorage {
    readonly sql: unknown;
    transactionSync<T>(callback: () => T): T;
    deleteAlarm(): Promise<void>;
    getAlarm(): Promise<number | null>;
    setAlarm(scheduledTime: number | Date): Promise<void>;
  }

  export interface DurableObjectState {
    readonly storage: DurableObjectStorage;
    blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
  }

  export class DurableObject<Env = unknown> {
    protected readonly ctx: DurableObjectState;
    protected readonly env: Env;
    constructor(ctx: DurableObjectState, env: Env);
  }
}
