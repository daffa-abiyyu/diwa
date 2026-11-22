"use client";

import { collection, doc, getDocs, runTransaction, Timestamp } from "firebase/firestore";
import { deleteObject, ref, uploadBytes } from "firebase/storage";
import { getFirebaseClient } from "@/lib/firebase/client";
import { diwaDb, type LocalAccount, type LocalTransaction } from "@/lib/db/diwa-db";
import type { Account, Transaction, WalletData } from "@/lib/types/wallet";

function asAccount(data: Record<string, unknown>): Account {
  return {
    id: String(data.id), name: String(data.name), provider: String(data.provider),
    type: String(data.type), balance: Number(data.openingBalance), color: String(data.color),
    openingDate: String(data.openingDate), archived: Boolean(data.archived),
  };
}

export async function syncWallet(userId: string): Promise<{ wallet: WalletData; conflicts: number }> {
  const client = getFirebaseClient();
  if (!client || !navigator.onLine) return { wallet: await readLocalWallet(userId), conflicts: 0 };

  const accountCollection = collection(client.db, "users", userId, "accounts");
  const transactionCollection = collection(client.db, "users", userId, "transactions");
  const [remoteAccounts, remoteTransactions] = await Promise.all([getDocs(accountCollection), getDocs(transactionCollection)]);
  const accountById = new Map(remoteAccounts.docs.map((entry) => [entry.id, entry.data()]));
  const transactionById = new Map(remoteTransactions.docs.map((entry) => [entry.id, entry.data()]));
  const pending = await diwaDb.outbox.where("userId").equals(userId).and((entry) => entry.state === "pending").sortBy("createdAt");
  let conflicts = 0;

  for (const operation of pending) {
    const remote = (operation.entity === "account" ? accountById : transactionById).get(operation.entityId);
    const remoteVersion = Number(remote?.version ?? 0);
    if ((remote && operation.operation === "create") || (remote && remoteVersion !== operation.baseVersion)) {
      const conflictId = `${operation.entity}:${operation.entityId}`;
      await diwaDb.transaction("rw", diwaDb.outbox, diwaDb.conflicts, async () => {
        await diwaDb.outbox.where("operationId").equals(operation.operationId).modify({ state: "conflict" });
        await diwaDb.conflicts.put({ id: conflictId, userId, entity: operation.entity, entityId: operation.entityId, operationId: operation.operationId, localVersion: operation.payload, remoteVersion: remote, detectedAt: new Date().toISOString() });
      });
      conflicts++;
      continue;
    }
    const storedRecord = operation.entity === "account"
      ? await diwaDb.accounts.get([userId, operation.entityId])
      : await diwaDb.transactions.get([userId, operation.entityId]);
    const payload = (operation.operation === "delete" ? storedRecord : operation.payload) as Record<string, unknown>;
    const now = Timestamp.now();
    let body: Record<string, unknown>;
    if (operation.entity === "account") {
      const existing = await diwaDb.accounts.get([userId, operation.entityId]);
      body = {
        id: operation.entityId,
        name: String(payload.name ?? existing?.name ?? ""),
        provider: String(payload.provider ?? existing?.provider ?? "Other"),
        type: ["Bank", "E-Wallet", "Cash", "Other"].includes(String(payload.type)) ? payload.type : "Other",
        openingBalance: Number(payload.balance ?? existing?.balance ?? 0),
        openingDate: String(payload.openingDate ?? existing?.openingDate ?? new Date().toISOString().slice(0, 10)),
        color: String(payload.color ?? existing?.color ?? "from-primary to-blue-700"),
        archived: Boolean(payload.archived ?? existing?.archived), version: operation.baseVersion + 1,
        createdAt: remote?.createdAt || now, updatedAt: now,
        ...(operation.operation === "delete" ? { deletedAt: now } : {}),
      };
    } else {
      const tx = payload as Partial<Transaction>;
      const receipt = await diwaDb.receipts.get([userId, operation.entityId]);
      if (receipt && receipt.uploadState !== "uploaded") {
        await uploadBytes(ref(client.storage, receipt.storagePath), receipt.file, { contentType: receipt.contentType, customMetadata: { ownerUid: userId } });
        await diwaDb.receipts.update([userId, operation.entityId], { uploadState: "uploaded" });
      }
      const accounts = await diwaDb.accounts.where("userId").equals(userId).toArray();
      const from = accounts.find((account) => account.name === tx.account);
      const to = accounts.find((account) => account.name === tx.toAccount);
      body = {
        id: operation.entityId, type: tx.type, amount: Math.round(Number(tx.amount)), title: String(tx.title ?? ""),
        categoryNameSnapshot: String(tx.category ?? "Other"), ...(tx.type === "transfer" ? { fromAccountId: from?.id, toAccountId: to?.id } : { accountId: from?.id }),
        ...(receipt || tx.receiptPath ? { receiptPath: receipt?.storagePath ?? tx.receiptPath, ...(receipt ? { receiptName: receipt.fileName } : {}) } : {}),
        transactionDate: String(tx.date ?? new Date().toISOString().slice(0, 10)), note: tx.note ?? "", paymentMethod: tx.paymentMethod ?? "",
        items: tx.items ?? [], version: operation.baseVersion + 1, createdAt: remote?.createdAt || now,
        updatedAt: now, source: "manual", operationId: operation.operationId,
        ...(operation.operation === "delete" ? { deletedAt: now } : {}),
      };
    }
    if ((operation.entity === "transaction" && ((payload.type === "transfer" && (!body.fromAccountId || !body.toAccountId)) || (payload.type !== "transfer" && !body.accountId)))) {
      await diwaDb.outbox.where("operationId").equals(operation.operationId).modify({ state: "failed", attempts: operation.attempts + 1 });
      continue;
    }
    const path = operation.entity === "account" ? "accounts" : "transactions";
    const remoteRef = doc(client.db, "users", userId, path, operation.entityId);
    const concurrentVersion = await runTransaction(client.db, async (transaction) => {
      const latest = await transaction.get(remoteRef);
      const latestData = latest.exists() ? latest.data() : undefined;
      const latestVersion = Number(latestData?.version ?? 0);
      if ((latest.exists() && operation.operation === "create") || (latest.exists() && latestVersion !== operation.baseVersion)) return latestData;
      transaction.set(remoteRef, body);
      return undefined;
    });
    if (concurrentVersion) {
      const conflictId = `${operation.entity}:${operation.entityId}`;
      await diwaDb.transaction("rw", diwaDb.outbox, diwaDb.conflicts, async () => {
        await diwaDb.outbox.where("operationId").equals(operation.operationId).modify({ state: "conflict" });
        await diwaDb.conflicts.put({ id: conflictId, userId, entity: operation.entity, entityId: operation.entityId, operationId: operation.operationId, localVersion: operation.payload, remoteVersion: concurrentVersion, detectedAt: new Date().toISOString() });
      });
      conflicts++;
      continue;
    }
    if (operation.entity === "transaction" && operation.operation === "delete") {
      const receipt = await diwaDb.receipts.get([userId, operation.entityId]);
      const storagePath = receipt?.storagePath ?? (typeof payload.receiptPath === "string" ? payload.receiptPath : undefined);
      if (storagePath) {
        try { await deleteObject(ref(client.storage, storagePath)); }
        catch (error) {
          if (typeof error === "object" && error && "code" in error && error.code !== "storage/object-not-found") throw error;
        }
      }
      if (receipt) await diwaDb.receipts.delete([userId, operation.entityId]);
    }
    await diwaDb.transaction("rw", diwaDb.accounts, diwaDb.transactions, diwaDb.outbox, async () => {
      await diwaDb.outbox.where("operationId").equals(operation.operationId).delete();
      const key: [string, string] = [userId, operation.entityId];
      if (operation.entity === "account") await diwaDb.accounts.update(key, { syncState: "synced", version: operation.baseVersion + 1 });
      else await diwaDb.transactions.update(key, { syncState: "synced", version: operation.baseVersion + 1 });
    });
  }

  for (const entry of remoteAccounts.docs) {
    const local = await diwaDb.accounts.get([userId, entry.id]);
    const remoteVersion = Number(entry.data().version ?? 0);
    if (local && (local.syncState !== "synced" || local.version >= remoteVersion)) continue;
    const account = asAccount(entry.data());
    await diwaDb.accounts.put({ ...account, userId, syncState: "synced", version: remoteVersion, deletedAt: entry.data().deletedAt ? String(entry.data().deletedAt) : null });
  }
  const localAccounts = await diwaDb.accounts.where("userId").equals(userId).toArray();
  for (const entry of remoteTransactions.docs) {
    const data = entry.data();
    const local = await diwaDb.transactions.get([userId, entry.id]);
    const remoteVersion = Number(data.version ?? 0);
    if (local && (local.syncState !== "synced" || local.version >= remoteVersion)) continue;
    const from = localAccounts.find((account) => account.id === data.accountId || account.id === data.fromAccountId);
    const to = localAccounts.find((account) => account.id === data.toAccountId);
    if (!from || (data.type === "transfer" && !to)) continue;
    const transaction: Transaction = {
      id: entry.id, title: String(data.title), category: String(data.categoryNameSnapshot ?? "Other"), type: data.type,
      amount: Number(data.amount), account: from.name, toAccount: to?.name, date: String(data.transactionDate),
      note: String(data.note ?? ""), paymentMethod: String(data.paymentMethod ?? ""), syncStatus: "Synced",
      receiptPath: data.receiptPath ? String(data.receiptPath) : undefined,
      receiptName: data.receiptName ? String(data.receiptName) : undefined,
    };
    await diwaDb.transactions.put({ ...transaction, userId, syncState: "synced", version: remoteVersion, deletedAt: data.deletedAt ? String(data.deletedAt) : null });
  }

  return { wallet: await readLocalWallet(userId), conflicts };
}

export async function readLocalWallet(userId: string): Promise<WalletData> {
  const [accounts, transactions] = await Promise.all([
    diwaDb.accounts.where("userId").equals(userId).toArray(),
    diwaDb.transactions.where("userId").equals(userId).toArray(),
  ]);
  return {
    accounts: accounts.filter((entry: LocalAccount) => !entry.deletedAt).map((entry) => Object.fromEntries(Object.entries(entry).filter(([key]) => !["userId", "syncState", "version", "deletedAt"].includes(key))) as Account),
    transactions: transactions.filter((entry: LocalTransaction) => !entry.deletedAt).map((entry) => ({ ...Object.fromEntries(Object.entries(entry).filter(([key]) => !["userId", "syncState", "version", "deletedAt"].includes(key))), syncStatus: "Synced" as const }) as Transaction),
  };
}

export async function getWalletConflicts(userId: string) {
  return diwaDb.conflicts.where("userId").equals(userId).toArray();
}

export async function resolveWalletConflict(userId: string, conflictId: string, choice: "local" | "cloud") {
  const conflict = await diwaDb.conflicts.get([userId, conflictId]);
  if (!conflict) return;
  const remote = conflict.remoteVersion as Record<string, unknown>;
  if (choice === "cloud") {
    if (conflict.entity === "account") {
      const account = asAccount(remote);
      await diwaDb.accounts.put({ ...account, userId, syncState: "synced", version: Number(remote.version ?? 0), deletedAt: remote.deletedAt ? String(remote.deletedAt) : null });
    } else if (conflict.entity === "transaction") {
      const accounts = await diwaDb.accounts.where("userId").equals(userId).toArray();
      const from = accounts.find((account) => account.id === remote.accountId || account.id === remote.fromAccountId);
      const to = accounts.find((account) => account.id === remote.toAccountId);
      if (from) {
        const transaction: Transaction = {
          id: conflict.entityId, title: String(remote.title), category: String(remote.categoryNameSnapshot ?? "Other"),
          type: remote.type as Transaction["type"], amount: Number(remote.amount), account: from.name,
          toAccount: to?.name, date: String(remote.transactionDate), note: String(remote.note ?? ""),
          paymentMethod: String(remote.paymentMethod ?? ""), syncStatus: "Synced",
          receiptPath: remote.receiptPath ? String(remote.receiptPath) : undefined,
          receiptName: remote.receiptName ? String(remote.receiptName) : undefined,
        };
        await diwaDb.transactions.put({ ...transaction, userId, syncState: "synced", version: Number(remote.version ?? 0), deletedAt: remote.deletedAt ? String(remote.deletedAt) : null });
      }
    }
    await diwaDb.outbox.where("operationId").equals(conflict.operationId).delete();
    await diwaDb.conflicts.delete([userId, conflictId]);
    return;
  }
  await diwaDb.outbox.where("operationId").equals(conflict.operationId).modify({ baseVersion: Number(remote.version ?? 0), state: "pending" });
  await diwaDb.conflicts.delete([userId, conflictId]);
  await syncWallet(userId);
}
