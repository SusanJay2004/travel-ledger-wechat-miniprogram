import type {
  CloudCollection,
  CloudDatabase,
  CloudDocumentReference,
  CloudTransaction,
  QueryResult,
  UpdateResult,
} from '../cloud-repository';
import type { CloudSdk } from '../index';

type Document = Record<string, unknown>;

export class MemoryCloudDatabase implements CloudDatabase {
  private readonly collections = new Map<string, Map<string, Document>>();
  private transactionQueue: Promise<void> = Promise.resolve();

  collection<T>(name: string): CloudCollection<T> {
    const documents = this.collections.get(name) ?? new Map<string, Document>();
    this.collections.set(name, documents);
    return new MemoryCollection<T>(documents);
  }

  documents(name: string): readonly Document[] {
    return [...(this.collections.get(name)?.values() ?? [])].map((value) => structuredClone(value));
  }

  runTransaction(
    callback: (transaction: CloudTransaction) => void | Promise<unknown>,
  ): Promise<unknown> {
    const run = this.transactionQueue.then(async () => {
      const snapshot = cloneCollections(this.collections);
      const transaction: CloudTransaction = {
        get: async <T>(document: CloudDocumentReference<T>) => {
          const result = await document.get();
          return { data: () => result.data };
        },
        set: async <T>(document: CloudDocumentReference<T>, data: T) => {
          await document.set({ data });
        },
      };
      try {
        return await callback(transaction);
      } catch (error: unknown) {
        restoreCollections(this.collections, snapshot);
        throw error;
      }
    });
    this.transactionQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

export function createMemoryCloudSdk(openId = 'test-openid'): {
  database: MemoryCloudDatabase;
  deletedFileIds: readonly string[];
  sdk: CloudSdk;
  setOpenId(value: string | undefined): void;
} {
  const database = new MemoryCloudDatabase();
  const deletedFileIds: string[] = [];
  let currentOpenId: string | undefined = openId;
  const context = () => (currentOpenId === undefined ? {} : { OPENID: currentOpenId });
  const sdk: CloudSdk = {
    DYNAMIC_CURRENT_ENV: Symbol('memory'),
    database: () => database,
    deleteFile: async ({ fileList }) => {
      deletedFileIds.push(...fileList);
      return undefined;
    },
    getWXContext: context,
    init: () => undefined,
    openapi: {
      security: {
        imgSecCheck: async () => ({}),
        msgSecCheck: async () => ({ result: { suggest: 'pass' } }),
      },
      wxacode: {
        getUnlimited: async () => ({ buffer: Buffer.from('png') }),
      },
    },
    downloadFile: async () => ({ fileContent: Buffer.alloc(0) }),
    uploadFile: async ({ cloudPath }) => ({ fileID: `cloud://memory/${cloudPath}` }),
  };
  return { database, deletedFileIds, sdk, setOpenId: (value) => (currentOpenId = value) };
}

class MemoryCollection<T> implements CloudCollection<T> {
  private query: Record<string, unknown> | null = null;
  private offset = 0;
  private maximum = Number.POSITIVE_INFINITY;

  constructor(private readonly documents: Map<string, Document>) {}

  async add(options: { data: T }): Promise<void> {
    const document = toDocument(options.data);
    const id = documentId(document);
    if (this.documents.has(id)) throw new Error('duplicate document');
    this.documents.set(id, structuredClone(document));
  }

  doc(id: string) {
    return {
      id,
      get: async () => {
        const document = this.documents.get(id);
        if (document === undefined) throw new Error('document not found');
        return { data: structuredClone(document) as T };
      },
      remove: async () => {
        this.documents.delete(id);
      },
      set: async (options: { data: T }) => {
        this.documents.set(id, { ...structuredClone(toDocument(options.data)), _id: id });
      },
    };
  }

  async get(): Promise<QueryResult<T>> {
    return { data: this.matches().slice(this.offset, this.offset + this.maximum) as T[] };
  }

  limit(value: number): CloudCollection<T> {
    const next = this.clone();
    next.maximum = value;
    return next;
  }

  skip(value: number): CloudCollection<T> {
    const next = this.clone();
    next.offset = value;
    return next;
  }

  where(query: Record<string, unknown>): CloudCollection<T> {
    const next = this.clone();
    next.query = query;
    return next;
  }

  async update(options: { data: Partial<T> }): Promise<UpdateResult> {
    let updated = 0;
    for (const [id, document] of this.documents) {
      if (!matches(document, this.query)) continue;
      this.documents.set(id, { ...document, ...structuredClone(toDocument(options.data)) });
      updated += 1;
    }
    return { stats: { updated } };
  }

  async remove(): Promise<UpdateResult> {
    let removed = 0;
    for (const [id, document] of this.documents) {
      if (!matches(document, this.query)) continue;
      this.documents.delete(id);
      removed += 1;
    }
    return { stats: { updated: removed } };
  }

  private clone(): MemoryCollection<T> {
    const copy = new MemoryCollection<T>(this.documents);
    copy.query = this.query;
    copy.offset = this.offset;
    copy.maximum = this.maximum;
    return copy;
  }

  private matches(): Document[] {
    return [...this.documents.values()].filter((document) => matches(document, this.query));
  }
}

function cloneCollections(
  collections: ReadonlyMap<string, Map<string, Document>>,
): Map<string, Map<string, Document>> {
  return new Map(
    [...collections].map(([name, documents]) => [
      name,
      new Map([...documents].map(([id, document]) => [id, structuredClone(document)])),
    ]),
  );
}

function restoreCollections(
  collections: Map<string, Map<string, Document>>,
  snapshot: ReadonlyMap<string, Map<string, Document>>,
): void {
  collections.clear();
  for (const [name, documents] of snapshot) collections.set(name, documents);
}

function toDocument(value: unknown): Document {
  if (typeof value !== 'object' || value === null) throw new Error('document must be an object');
  return value as Document;
}

function documentId(document: Document): string {
  const id = document['_id'] ?? document['id'];
  if (typeof id !== 'string' || id.length === 0) throw new Error('document id required');
  return id;
}

function matches(document: Document, query: Record<string, unknown> | null): boolean {
  if (query === null) return true;
  return Object.entries(query).every(([key, expected]) => {
    const actual = document[key];
    if (Array.isArray(actual)) return actual.includes(expected);
    return actual === expected;
  });
}
