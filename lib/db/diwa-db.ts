import Dexie, { type Table } from "dexie";
import type { Account, Transaction, WalletData } from "@/lib/types/wallet";

export type SyncState = "pending" | "synced" | "conflict" | "failed";
export type SyncEntity = "account" | "transaction" | "category" | "profile";
export type SyncOperationType = "create" | "update" | "delete";

type LocalRecord = {
  userId: string;
  syncState: SyncState;
  version: number;
  deletedAt?: string | null;
};

export type LocalAccount = Account & LocalRecord;
export type LocalTransaction = Transaction & LocalRecord;

export type LocalCategory = {
  id: string;
  userId: string;
  name: string;
  type: "income" | "expense";
  icon: string;
  color: string;
  isDefault: boolean;
  updatedAt: string;
  deletedAt?: string | null;
  syncState: SyncState;
  version: number;
};

export type OutboxOperation = {
  userId: string;
  operationId: string;
  entity: SyncEntity;
  entityId: string;
  operation: SyncOperationType;
  baseVersion: number;
  payload: unknown;
  createdAt: string;
  attempts: number;
  state: "pending" | "conflict" | "failed";
};

export type LocalConflict = {
  id: string;
  userId: string;
  entity: SyncEntity;
  entityId: string;
  operationId: string;
  localVersion: unknown;
  remoteVersion: unknown;
  detectedAt: string;
};

export type LocalReceipt = {
  id: string;
  userId: string;
  transactionId: string;
  file: Blob;
  fileName: string;
  contentType: string;
  storagePath: string;
  uploadState: "pending" | "uploaded" | "failed";
};

export type LocalPreference = {
  id: string;
  userId: string;
  locale?: "en" | "id";
  currency?: string;
  theme?: "light" | "dark" | "system";
  accentColor?: string;
};

class DiwaDatabase extends Dexie {
  accounts!: Table<LocalAccount, [string, string]>;
  transactions!: Table<LocalTransaction, [string, string]>;
  categories!: Table<LocalCategory, [string, string]>;
  outbox!: Table<OutboxOperation, number>;
  conflicts!: Table<LocalConflict, [string, string]>;
  receipts!: Table<LocalReceipt, [string, string]>;
  preferences!: Table<LocalPreference, [string, string]>;

  constructor() {
    super("diwa-local");
    this.version(1).stores({
      accounts: "[userId+id],userId,updatedAt",
      transactions: "[userId+id],[userId+date],[userId+type],[userId+account],[userId+syncState],updatedAt,deletedAt",
      categories: "[userId+id],[userId+type],userId,name",
      outbox: "++sequence,userId,&operationId,[userId+state],createdAt",
      conflicts: "[userId+id],userId,operationId,[userId+entity+entityId]",
      receipts: "[userId+id],userId,transactionId,uploadState",
      preferences: "[userId+id],userId",
    });
  }
}

export const diwaDb = new DiwaDatabase();

export async function queueReceipt(userId: string, transactionId: string, file: File, storagePath: string) {
  if (file.size > 10 * 1024 * 1024) throw new Error("Receipt image must be smaller than 10 MB.");
  if (!/^image\/(jpeg|png|webp|heic)$/i.test(file.type)) throw new Error("Choose a JPEG, PNG, WebP, or HEIC image.");
  await diwaDb.receipts.put({
    id: transactionId, userId, transactionId, file, fileName: file.name,
    contentType: file.type, storagePath, uploadState: "pending",
  });
}

export async function enqueueLocalOperation(operation: OutboxOperation) {
  await diwaDb.transaction("rw", diwaDb.accounts, diwaDb.transactions, diwaDb.outbox, async () => {
    const key: [string, string] = [operation.userId, operation.entityId];
    if (operation.entity === "account") {
      const current = await diwaDb.accounts.get(key);
      const payload = operation.payload as Partial<Account>;
      if (operation.operation === "delete" && !current) throw new Error("Cannot delete a local account that does not exist.");
      const nextRecord: LocalAccount = {
        ...current,
        ...payload,
        id: operation.entityId,
        userId: operation.userId,
        syncState: "pending",
        version: current?.version ?? operation.baseVersion,
        deletedAt: operation.operation === "delete" ? current?.deletedAt || operation.createdAt : current?.deletedAt,
      } as LocalAccount;
      await diwaDb.accounts.put(nextRecord);
    } else if (operation.entity === "transaction") {
      const current = await diwaDb.transactions.get(key);
      const payload = operation.payload as Partial<Transaction>;
      if (operation.operation === "delete" && !current) throw new Error("Cannot delete a local transaction that does not exist.");
      const nextRecord: LocalTransaction = {
        ...current,
        ...payload,
        id: operation.entityId,
        userId: operation.userId,
        syncState: "pending",
        version: current?.version ?? operation.baseVersion,
        deletedAt: operation.operation === "delete" ? current?.deletedAt || operation.createdAt : current?.deletedAt,
      } as LocalTransaction;
      await diwaDb.transactions.put(nextRecord);
    } else {
      throw new Error(`Local persistence for ${operation.entity} is not available yet.`);
    }
    const queued = await diwaDb.outbox.where("userId").equals(operation.userId)
      .filter((entry) => entry.entity === operation.entity && entry.entityId === operation.entityId && entry.state === "pending")
      .first();
    if (queued?.operation === "create" && operation.operation === "delete") {
      await diwaDb.outbox.where("operationId").equals(queued.operationId).delete();
      if (operation.entity === "account") await diwaDb.accounts.delete(key);
      else await diwaDb.transactions.delete(key);
    } else if (queued) {
      await diwaDb.outbox.where("operationId").equals(queued.operationId).modify({
        operation: queued.operation === "create" ? "create" : operation.operation,
        payload: operation.payload,
        createdAt: operation.createdAt,
      });
    } else {
      await diwaDb.outbox.add(operation);
    }
  });
}

export async function persistWalletChanges(userId: string, previous: WalletData, next: WalletData) {
  const createdAt = new Date().toISOString();
  const changes: OutboxOperation[] = [];
  const collect = async <T extends Account | Transaction>(entity: "account" | "transaction", before: T[], after: T[]) => {
    const oldById = new Map(before.map((record) => [record.id, record]));
    const newById = new Map(after.map((record) => [record.id, record]));
    for (const record of after) {
      const previousRecord = oldById.get(record.id);
      if (previousRecord && JSON.stringify(previousRecord) === JSON.stringify(record)) continue;
      const localRecord = entity === "account"
        ? await diwaDb.accounts.get([userId, record.id])
        : await diwaDb.transactions.get([userId, record.id]);
      changes.push({
        userId,
        operationId: crypto.randomUUID(),
        entity,
        entityId: record.id,
        operation: previousRecord ? "update" : "create",
        baseVersion: localRecord?.version ?? 0,
        payload: record,
        createdAt,
        attempts: 0,
        state: "pending",
      });
    }
    for (const record of before) {
      if (!newById.has(record.id)) {
        const localRecord = entity === "account"
          ? await diwaDb.accounts.get([userId, record.id])
          : await diwaDb.transactions.get([userId, record.id]);
        changes.push({
        userId,
        operationId: crypto.randomUUID(),
        entity,
        entityId: record.id,
        operation: "delete",
        baseVersion: localRecord?.version ?? 0,
        payload: {},
        createdAt,
        attempts: 0,
        state: "pending",
        });
      }
    }
  };
  await collect("account", previous.accounts, next.accounts);
  await collect("transaction", previous.transactions, next.transactions);
  for (const operation of changes) await enqueueLocalOperation(operation);
  return changes.length;
}
