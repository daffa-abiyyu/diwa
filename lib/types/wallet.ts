export type TransactionType = "expense" | "income" | "transfer";

export type Account = {
  id: string;
  name: string;
  provider: string;
  type: string;
  balance: number;
  color: string;
  openingDate?: string;
  archived?: boolean;
};

export type TransactionItem = {
  name: string;
  quantity: number;
  unitPrice: number;
};

export type Transaction = {
  id: string;
  title: string;
  category: string;
  type: TransactionType;
  amount: number;
  account: string;
  date: string;
  note?: string;
  paymentMethod?: string;
  items?: TransactionItem[];
  receiptName?: string;
  receiptPath?: string;
  toAccount?: string;
  createdAt?: string;
  updatedAt?: string;
  syncStatus: "Synced" | "Pending";
};

export type WalletData = {
  accounts: Account[];
  transactions: Transaction[];
};
