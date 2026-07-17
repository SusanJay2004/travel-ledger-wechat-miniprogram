import type {
  CloudCollection,
  CloudDatabase,
  CloudTransaction,
  QueryResult,
  UpdateResult,
} from '../cloud-repository';
import type { CloudSdk } from '../index';

type Document = Record<string, unknown>;

export class MemoryCloudDatabase implements CloudDatabase {
  private readonly collections = new Map<string, Map<string, Document>>();
  private readonly setFailures = new Set<string>();
  private transactionQueue: Promise<void> = Promise.resolve();

  collection<T>(name: string): CloudCollection<T> {
    const documents = this.collections.get(name) ?? new Map<string, Document>();
    this.collections.set(name, documents);
    return new MemoryCollection<T>(documents, name, (collectionName) => {
      if (!this.setFailures.delete(collectionName)) return;
      throw new Error(`injected ${collectionName} set failure`);
    });
  }

  documents(name: string): readonly Document[] {
    return [...(this.collections.get(name)?.values() ?? [])].map((value) => structuredClone(value));
  }

  failNextSet(collectionName: string): void {
    this.setFailures.add(collectionName);
  }

  runTransaction(
    callback: (transaction: CloudTransaction) => void | Promise<unknown>,
  ): Promise<unknown> {
    const run = this.transactionQueue.then(async () => {
      const snapshot = cloneCollections(this.collections);
      const transaction: CloudTransaction = {
        collection: <T>(name: string) => this.collection<T>(name),
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
      return { fileList: fileList.map((fileID) => ({ fileID, status: 0 })) };
    },
    getWXContext: context,
    init: () => undefined,
    openapi: {
      security: {
        mediaCheckAsync: async () => ({ traceId: 'memory-avatar-trace' }),
        msgSecCheck: async () => ({ result: { suggest: 'pass' } }),
      },
      wxacode: {
        getUnlimited: async () => ({ buffer: Buffer.from('png') }),
      },
    },
    downloadFile: async () => ({ fileContent: Buffer.from([0xff, 0xd8, 0xff, 0x00]) }),
    getTempFileURL: async ({ fileList }) => ({
      fileList: fileList.map((entry) => {
        const fileID = typeof entry === 'string' ? entry : entry.fileID;
        return {
          fileID,
          status: 0,
          tempFileURL: `https://example.test/${encodeURIComponent(fileID)}`,
        };
      }),
    }),
    uploadFile: async ({ cloudPath }) => ({ fileID: `cloud://memory/${cloudPath}` }),
  };
  return { database, deletedFileIds, sdk, setOpenId: (value) => (currentOpenId = value) };
}

class MemoryCollection<T> implements CloudCollection<T> {
  private query: Record<string, unknown> | null = null;
  private offset = 0;
  private maximum = Number.POSITIVE_INFINITY;

  constructor(
    private readonly documents: Map<string, Document>,
    private readonly collectionName: string,
    private readonly beforeSet: (collectionName: string) => void,
  ) {}

  async add(options: { data: T }): Promise<void> {
    const document = toDocument(options.data);
    const id = documentId(document);
    if (this.documents.has(id)) throw new Error('duplicate document');
    assertUnique(this.collectionName, this.documents, document);
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
        this.beforeSet(this.collectionName);
        const document = { ...structuredClone(toDocument(options.data)), _id: id };
        assertUnique(this.collectionName, this.documents, document, id);
        this.documents.set(id, document);
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
      const next = { ...document, ...structuredClone(toDocument(options.data)) };
      assertUnique(this.collectionName, this.documents, next, id);
      this.documents.set(id, next);
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
    const copy = new MemoryCollection<T>(this.documents, this.collectionName, this.beforeSet);
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

function assertUnique(
  collectionName: string,
  documents: ReadonlyMap<string, Document>,
  candidate: Document,
  excludedId?: string,
): void {
  const fields =
    collectionName === 'users'
      ? ['openId', 'publicId']
      : collectionName === 'friend_requests' || collectionName === 'trip_invitations'
        ? ['pendingKey']
        : [];
  for (const field of fields) {
    const value = candidate[field];
    const duplicate = [...documents.entries()].some(
      ([id, document]) => id !== excludedId && (document[field] ?? null) === (value ?? null),
    );
    if (duplicate) throw new Error(`duplicate ${collectionName}.${field}`);
  }
}
