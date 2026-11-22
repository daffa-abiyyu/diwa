"use client";

import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode, type SetStateAction } from "react";
import { format, parseISO } from "date-fns";
import { enUS } from "date-fns/locale";
import { zodResolver } from "@hookform/resolvers/zod";
import { useFieldArray, useForm, useWatch } from "react-hook-form";
import { motion, useReducedMotion } from "motion/react";
import {
  ArrowDownLeft,
  ArrowLeftRight,
  ArrowUpRight,
  Bell,
  CalendarDays,
  Check,
  ChevronDown,
  CircleHelp,
  CreditCard,
  Eye,
  EyeOff,
  FileText,
  ImagePlus,
  Landmark,
  LayoutDashboard,
  Menu,
  Plus,
  Search,
  Settings2,
  SlidersHorizontal,
  Wallet,
  X,
} from "lucide-react";
import { ThemeToggle } from "@/components/theme-toggle";
import { useTheme } from "@/components/theme-provider";
import { useWalletUiStore, type WalletView } from "@/stores/wallet-ui-store";
import { accountFormSchema, transactionFormSchema, type AccountFormValues, type TransactionFormValues } from "@/lib/validation/transaction";
import { AuthProvider, useAuth } from "@/components/auth/auth-provider";
import { AuthScreen } from "@/components/auth/auth-screen";
import type { Account, Transaction, TransactionItem, WalletData } from "@/lib/types/wallet";
import { readReceipt } from "@/lib/ocr/receipt";
import { persistWalletChanges, queueReceipt, type LocalConflict } from "@/lib/db/diwa-db";
import { getWalletConflicts, readLocalWallet, resolveWalletConflict, syncWallet } from "@/lib/sync/wallet-sync";

const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const WALLET_STORAGE_KEY = "diwa-wallet-v1";
const SERVER_WALLET_SNAPSHOT = JSON.stringify({ accounts: [], transactions: [] });
const walletSnapshots = new Map<string, string>();
const initializedWalletUsers = new Set<string>();
const walletStoreListeners = new Map<string, Set<() => void>>();

function walletStorageKey(userId: string) {
  return `${WALLET_STORAGE_KEY}:${userId}`;
}

function getWalletSnapshot(userId: string) {
  if (typeof window === "undefined") return SERVER_WALLET_SNAPSHOT;
  if (!initializedWalletUsers.has(userId)) {
    try {
      const stored = localStorage.getItem(walletStorageKey(userId));
      if (stored) {
        JSON.parse(stored);
        walletSnapshots.set(userId, stored);
      } else {
        walletSnapshots.set(userId, SERVER_WALLET_SNAPSHOT);
      }
    } catch {
      walletSnapshots.set(userId, SERVER_WALLET_SNAPSHOT);
    }
    initializedWalletUsers.add(userId);
  }
  return walletSnapshots.get(userId) || SERVER_WALLET_SNAPSHOT;
}

function subscribeToWalletStore(userId: string, listener: () => void) {
  const listeners = walletStoreListeners.get(userId) || new Set<() => void>();
  listeners.add(listener);
  walletStoreListeners.set(userId, listeners);
  const handleStorage = (event: StorageEvent) => {
    if (event.key !== walletStorageKey(userId)) return;
    try {
      walletSnapshots.set(userId, event.newValue ? JSON.stringify(JSON.parse(event.newValue)) : SERVER_WALLET_SNAPSHOT);
    } catch {
      walletSnapshots.set(userId, SERVER_WALLET_SNAPSHOT);
    }
    initializedWalletUsers.add(userId);
    walletStoreListeners.get(userId)?.forEach((notify) => notify());
  };
  window.addEventListener("storage", handleStorage);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) walletStoreListeners.delete(userId);
    window.removeEventListener("storage", handleStorage);
  };
}

function updateWalletStore(userId: string, updater: (current: WalletData) => WalletData) {
  const current = JSON.parse(getWalletSnapshot(userId)) as WalletData;
  const next = updater(current);
  const snapshot = JSON.stringify(next);
  walletSnapshots.set(userId, snapshot);
  initializedWalletUsers.add(userId);
  try { localStorage.setItem(walletStorageKey(userId), snapshot); } catch { /* Keep this session usable when storage is unavailable. */ }
  walletStoreListeners.get(userId)?.forEach((listener) => listener());
  void persistWalletChanges(userId, current, next).then(async () => {
    if (!navigator.onLine) return;
    const result = await syncWallet(userId);
    replaceWalletSnapshot(userId, result.wallet);
  }).catch(() => { /* Keep the local wallet available while offline or while cloud setup is incomplete. */ });
}

function replaceWalletSnapshot(userId: string, wallet: WalletData) {
  const snapshot = JSON.stringify(wallet);
  walletSnapshots.set(userId, snapshot);
  initializedWalletUsers.add(userId);
  try { localStorage.setItem(walletStorageKey(userId), snapshot); } catch { /* Keep the current session usable. */ }
  walletStoreListeners.get(userId)?.forEach((listener) => listener());
}

const navItems: { id: WalletView; label: string; icon: typeof LayoutDashboard }[] = [
  { id: "overview", label: "Overview", icon: LayoutDashboard },
  { id: "transactions", label: "Transactions", icon: ArrowLeftRight },
  { id: "accounts", label: "Accounts", icon: Wallet },
  { id: "settings", label: "Settings", icon: Settings2 },
];

const rupiah = (amount: number) => `Rp ${Math.round(amount).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".")}`;
const shortDate = (date: string) => format(parseISO(`${date}T00:00:00`), "d MMM", { locale: enUS });

export function WalletApp() {
  return <AuthProvider><WalletAppGate /></AuthProvider>;
}

function WalletAppGate() {
  const { status, user } = useAuth();
  useEffect(() => {
    if (user) useWalletUiStore.getState().reset();
  }, [user]);

  if (status === "loading") return <main className="grid min-h-dvh place-items-center bg-background text-sm text-muted-foreground">Loading your wallet…</main>;
  if (status === "unconfigured") return <FirebaseSetupNotice />;
  if (!user) return <AuthScreen />;
  return <AuthenticatedWalletApp key={user.uid} userId={user.uid} />;
}

function FirebaseSetupNotice() {
  return <main className="grid min-h-dvh place-items-center bg-background px-4 py-10 text-foreground"><section className="surface-card w-full max-w-lg p-6 sm:p-8"><h1 className="text-xl font-extrabold">Firebase setup required</h1><p className="mt-2 text-sm leading-relaxed text-muted-foreground">Add the Firebase web app settings to <code>.env.local</code> using the keys in <code>.env.example</code>, enable Email/Password and Google sign-in in Firebase Authentication, then restart the development server.</p><p className="mt-4 text-xs leading-relaxed text-muted-foreground">Do not paste credentials into chat or commit <code>.env.local</code>. Firestore Security Rules must be deployed before using real financial data.</p></section></main>;
}

function AuthenticatedWalletApp({ userId }: { userId: string }) {
  const { user, signOutUser } = useAuth();
  const view = useWalletUiStore((state) => state.view);
  const setView = useWalletUiStore((state) => state.setView);
  const menuOpen = useWalletUiStore((state) => state.menuOpen);
  const setMenuOpen = useWalletUiStore((state) => state.setMenuOpen);
  const toast = useWalletUiStore((state) => state.toast);
  const setToast = useWalletUiStore((state) => state.setToast);
  const subscribeWallet = useMemo(() => (listener: () => void) => subscribeToWalletStore(userId, listener), [userId]);
  const getUserWalletSnapshot = useMemo(() => () => getWalletSnapshot(userId), [userId]);
  const walletSnapshot = useSyncExternalStore(subscribeWallet, getUserWalletSnapshot, () => SERVER_WALLET_SNAPSHOT);
  const walletData = useMemo(() => JSON.parse(walletSnapshot) as WalletData, [walletSnapshot]);
  const accounts = walletData.accounts;
  const transactions = walletData.transactions;
  const setAccounts = (next: SetStateAction<Account[]>) => updateWalletStore(userId, (current) => ({
    ...current,
    accounts: typeof next === "function" ? next(current.accounts) : next,
  }));
  const setTransactions = (next: SetStateAction<Transaction[]>) => updateWalletStore(userId, (current) => ({
    ...current,
    transactions: typeof next === "function" ? next(current.transactions) : next,
  }));
  const [showBalance, setShowBalance] = useState(true);
  const [showTransactionForm, setShowTransactionForm] = useState(false);
  const [showAccountForm, setShowAccountForm] = useState(false);
  const [selectedTransaction, setSelectedTransaction] = useState<Transaction | null>(null);
  const [selectedAccount, setSelectedAccount] = useState<Account | null>(null);
  const [editingAccount, setEditingAccount] = useState<Account | null>(null);
  const [showArchivedAccounts, setShowArchivedAccounts] = useState(false);
  const [editingTransaction, setEditingTransaction] = useState<Transaction | null>(null);
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState("all");
  const [accountFilter, setAccountFilter] = useState("all");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [dateFilter, setDateFilter] = useState("all");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [minAmount, setMinAmount] = useState("");
  const [maxAmount, setMaxAmount] = useState("");
  const [sortBy, setSortBy] = useState("newest");
  const [conflicts, setConflicts] = useState<LocalConflict[]>([]);
  const [isOnline, setIsOnline] = useState<boolean | null>(null);
  useEffect(() => {
    let active = true;
    const synchronize = async () => {
      const local = JSON.parse(getWalletSnapshot(userId)) as WalletData;
      const stored = await readLocalWallet(userId);
      if (!stored.accounts.length && !stored.transactions.length && (local.accounts.length || local.transactions.length)) {
        await persistWalletChanges(userId, { accounts: [], transactions: [] }, local);
      }
      const result = await syncWallet(userId);
      if (!active) return;
      replaceWalletSnapshot(userId, result.wallet);
      setConflicts(await getWalletConflicts(userId));
      if (result.conflicts) setToast(`${result.conflicts} sync conflict${result.conflicts === 1 ? "" : "s"} need review in Settings.`);
    };
    void synchronize().catch(() => setToast("Sync paused. Your changes remain on this device."));
    const handleOnline = () => { setIsOnline(true); void synchronize().catch(() => setToast("Sync paused. Your changes remain on this device.")); };
    const handleOffline = () => setIsOnline(false);
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => { active = false; window.removeEventListener("online", handleOnline); window.removeEventListener("offline", handleOffline); };
  }, [setToast, userId]);
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 2800);
    return () => window.clearTimeout(timer);
  }, [setToast, toast]);

  const activeAccounts = accounts.filter((account) => !account.archived);
  const archivedAccounts = accounts.filter((account) => account.archived);
  const totalBalance = activeAccounts.reduce((sum, account) => sum + account.balance, 0);
  const income = transactions.filter((item) => item.type === "income").reduce((sum, item) => sum + item.amount, 0);
  const expenses = transactions.filter((item) => item.type === "expense").reduce((sum, item) => sum + item.amount, 0);
  const filteredTransactions = useMemo(() => transactions.filter((item) => {
    const matchesSearch = `${item.title} ${item.category} ${item.account} ${item.toAccount || ""}`.toLowerCase().includes(search.toLowerCase());
    const matchesType = typeFilter === "all" || item.type === typeFilter;
    const matchesAccount = accountFilter === "all" || item.account === accountFilter || item.toAccount === accountFilter;
    const matchesCategory = categoryFilter === "all" || item.category === categoryFilter;
    const matchesMin = !minAmount || item.amount >= Number(minAmount);
    const matchesMax = !maxAmount || item.amount <= Number(maxAmount);
    const age = Math.floor((Date.parse(`${today}T00:00:00+07:00`) - Date.parse(`${item.date}T00:00:00+07:00`)) / 86_400_000);
    const matchesDate = dateFilter === "all"
      || (dateFilter === "week" && age >= 0 && age <= 7)
      || (dateFilter === "month" && item.date.slice(0, 7) === today.slice(0, 7))
      || (dateFilter === "year" && item.date.slice(0, 4) === today.slice(0, 4))
      || (dateFilter === "custom" && (!dateFrom || item.date >= dateFrom) && (!dateTo || item.date <= dateTo));
    return matchesSearch && matchesType && matchesAccount && matchesCategory && matchesMin && matchesMax && matchesDate;
  }).sort((a, b) => sortBy === "oldest" ? a.date.localeCompare(b.date) : sortBy === "largest" ? b.amount - a.amount : sortBy === "smallest" ? a.amount - b.amount : b.date.localeCompare(a.date)), [transactions, search, typeFilter, accountFilter, categoryFilter, dateFilter, dateFrom, dateTo, minAmount, maxAmount, sortBy]);

  const navigate = (next: WalletView) => {
    setView(next);
    setMenuOpen(false);
  };

  async function saveTransaction(values: TransactionFormValues, receiptFile?: File) {
    const { type, amount, account: accountName, toAccount = "", items: formItems } = values;
    const title = values.title?.trim() || (type === "transfer" ? `Transfer ke ${toAccount}` : "Transactions baru");
    const category = values.category || (type === "transfer" ? "Transfer" : "Lainnya");
    if (type === "transfer" && (!toAccount || accountName === toAccount)) {
      setToast("Choose a different destination account.");
      return;
    }
    const source = accounts.find((account) => account.name === accountName);
    const destination = accounts.find((account) => account.name === toAccount);
    if (!source || (type === "transfer" && !destination)) return;
    const availableAfterReversal = source.balance
      + (editingTransaction?.account === source.name ? editingTransaction.type === "income" ? -editingTransaction.amount : editingTransaction.amount : 0)
      - (editingTransaction?.type === "transfer" && editingTransaction.toAccount === source.name ? editingTransaction.amount : 0);
    if ((type === "expense" || type === "transfer") && availableAfterReversal < amount) {
      setToast("Insufficient account balance.");
      return;
    }
    const nextAccounts = accounts.map((account) => {
      let balance = account.balance;
      if (editingTransaction) {
        if (editingTransaction.account === account.name) balance += editingTransaction.type === "income" ? -editingTransaction.amount : editingTransaction.amount;
        if (editingTransaction.type === "transfer" && editingTransaction.toAccount === account.name) balance -= editingTransaction.amount;
      }
      if (account.id === source.id) balance += type === "income" ? amount : -amount;
      if (type === "transfer" && destination && account.id === destination.id) balance += amount;
      return { ...account, balance };
    });
    const items: TransactionItem[] = formItems.filter((item) => item.name.trim());
    const transaction: Transaction = {
      id: editingTransaction?.id || crypto.randomUUID(), title, category, type, amount, account: accountName,
      date: values.date, note: values.note?.trim() || undefined,
      paymentMethod: values.paymentMethod || undefined,
      items: items.length ? items : undefined,
      receiptName: values.receiptName || undefined,
      receiptPath: receiptFile ? `users/${userId}/transactions/${editingTransaction?.id || "new"}/receipt` : editingTransaction?.receiptPath,
      createdAt: editingTransaction?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      toAccount: type === "transfer" ? toAccount : undefined, syncStatus: "Pending",
    };
    if (receiptFile) {
      transaction.receiptPath = `users/${userId}/transactions/${transaction.id}/receipt`;
      try { await queueReceipt(userId, transaction.id, receiptFile, transaction.receiptPath); }
      catch (error) { setToast(error instanceof Error ? error.message : "Receipt could not be saved."); return; }
    }
    setAccounts(nextAccounts);
    setTransactions((current) => editingTransaction ? current.map((item) => item.id === transaction.id ? transaction : item) : [transaction, ...current]);
    setEditingTransaction(null);
    setShowTransactionForm(false);
    setToast(editingTransaction ? "Transactions berhasil diperbarui." : "Transactions tersimpan di perangkat ini.");
  }

  function saveAccount(values: AccountFormValues) {
    const { name, provider, accountType: type, balance, openingDate } = values;
    if (editingAccount) {
      setAccounts((current) => current.map((account) => account.id === editingAccount.id ? { ...account, name, provider, type, balance, openingDate } : account));
      if (editingAccount.name !== name) {
        setTransactions((current) => current.map((item) => ({
          ...item,
          account: item.account === editingAccount.name ? name : item.account,
          toAccount: item.toAccount === editingAccount.name ? name : item.toAccount,
        })));
      }
      setEditingAccount(null);
    } else {
      setAccounts((current) => [...current, { id: crypto.randomUUID(), name, provider, type, balance, openingDate, color: "from-primary to-blue-700" }]);
    }
    setShowAccountForm(false);
    setToast(editingAccount ? "Accounts berhasil diperbarui." : "Accounts berhasil ditambahkan.");
  }

  return (
    <div className="wallet-shell min-h-dvh bg-background text-foreground">
      <aside className="wallet-sidebar hidden lg:flex">
        <div className="flex items-center gap-3 px-3 py-4">
          <div className="flex size-10 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-[3px_3px_0_var(--card-outline)]"><Wallet size={21} /></div>
          <div><p className="font-bold tracking-tight">diwa</p><p className="text-xs text-muted-foreground">Digital Wallet</p></div>
        </div>
        <p className="px-3 pb-2 pt-8 text-[11px] font-bold uppercase tracking-[0.16em] text-muted-foreground">Menu utama</p>
        <nav className="space-y-1">
          {navItems.map(({ id, label, icon: Icon }) => <button key={id} onClick={() => navigate(id)} className={`wallet-nav-item ${view === id ? "active" : ""}`}><Icon size={18} /><span>{label}</span></button>)}
        </nav>
        <div className="mt-auto rounded-2xl border-2 border-card-outline bg-card p-4 shadow-[3px_3px_0_var(--card-outline)]">
          <div className="mb-3 flex size-9 items-center justify-center rounded-xl bg-primary/10 text-primary"><CircleHelp size={18} /></div>
          <p className="text-sm font-bold">Butuh bantuan?</p><p className="mt-1 text-xs leading-relaxed text-muted-foreground">Pusat bantuan diwa siap membantu.</p>
          <button onClick={() => setToast("Pusat bantuan akan segera tersedia.")} className="mt-3 text-xs font-bold text-primary hover:underline">Kunjungi pusat bantuan →</button>
        </div>
      </aside>

      <div className="wallet-main min-w-0">
        <header className="wallet-topbar">
          <div className="flex min-w-0 items-center gap-3">
            <button className="icon-button lg:hidden" onClick={() => setMenuOpen(!menuOpen)} aria-label="Buka navigasi">{menuOpen ? <X size={20} /> : <Menu size={20} />}</button>
            <div className="min-w-0"><p className="hidden text-xs text-muted-foreground sm:block">Your personal wallet</p><h1 className="truncate text-lg font-extrabold tracking-tight sm:text-xl">{view === "overview" ? "Overview" : navItems.find((item) => item.id === view)?.label}</h1></div>
          </div>
          <div className="flex items-center gap-2 sm:gap-3"><ThemeToggle /><button className="icon-button relative" aria-label="Notifikasi" onClick={() => setToast("No new notifications.")}><Bell size={18} /><span className="absolute right-2 top-2 size-1.5 rounded-full bg-primary" /></button><div className="hidden h-8 w-px bg-border sm:block" /><div className="hidden items-center gap-2 sm:flex"><div className="flex size-9 items-center justify-center rounded-full bg-primary/10 text-sm font-bold text-primary">{(user?.displayName || user?.email || "D").slice(0, 2).toUpperCase()}</div><div><p className="max-w-32 truncate text-sm font-bold leading-tight">{user?.displayName || "Personal"}</p><p className="max-w-32 truncate text-[11px] text-muted-foreground">{user?.email}</p></div></div></div>
        </header>

        {menuOpen && <div className="mobile-nav-panel lg:hidden">{navItems.map(({ id, label, icon: Icon }) => <button key={id} onClick={() => navigate(id)} className={`wallet-nav-item ${view === id ? "active" : ""}`}><Icon size={18} />{label}</button>)}</div>}

        <main className="wallet-content">
          {view === "overview" && <>
            <section className="mb-6 grid gap-5 xl:grid-cols-[1.55fr_1fr]">
              <div className="balance-card relative overflow-hidden rounded-3xl border-2 border-card-outline bg-linear-to-br from-primary via-blue-700 to-indigo-800 p-6 text-white shadow-[5px_5px_0_var(--card-outline)] sm:p-8">
                <div className="pointer-events-none absolute -right-16 -top-24 size-72 rounded-full border border-white/15" /><div className="pointer-events-none absolute -right-1 -top-10 size-48 rounded-full border border-white/10" />
                <div className="relative flex items-start justify-between"><div><p className="text-sm font-medium text-white/75">Total balance</p><div className="mt-3 flex items-center gap-3"><p className="font-mono text-3xl font-bold tracking-tight sm:text-4xl">{showBalance ? rupiah(totalBalance) : "Rp ••••••••"}</p><button className="rounded-lg p-1.5 text-white/75 hover:bg-white/10 hover:text-white" onClick={() => setShowBalance(!showBalance)} aria-label={showBalance ? "Hide balance" : "Show balance"}>{showBalance ? <Eye size={17} /> : <EyeOff size={17} />}</button></div><p className="mt-2 text-xs text-white/70">Across {activeAccounts.length} active accounts</p></div><div className="rounded-xl border border-white/20 bg-white/10 p-2.5"><Wallet size={21} /></div></div>
                <div className="relative mt-8 flex flex-wrap gap-3"><button onClick={() => setShowTransactionForm(true)} className="flex items-center gap-2 rounded-xl bg-white px-4 py-2.5 text-sm font-bold text-primary shadow-sm transition hover:bg-white/90"><Plus size={17} />Add transaction</button><button onClick={() => navigate("accounts")} className="flex items-center gap-2 rounded-xl border border-white/30 bg-white/10 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-white/20"><Landmark size={16} />View accounts</button></div>
              </div>
              <div className="grid grid-cols-2 gap-4 xl:grid-cols-1">
                <StatCard label="Income" amount={income} icon={ArrowDownLeft} tone="positive" caption="Periode ini" />
                <StatCard label="Expenses" amount={expenses} icon={ArrowUpRight} tone="negative" caption="Periode ini" />
              </div>
            </section>

            <section className="mb-6 grid gap-5 xl:grid-cols-[1.35fr_1fr]">
              <div className="surface-card p-5 sm:p-6"><div className="mb-5 flex items-center justify-between gap-3"><div><h2 className="section-title">Cash flow</h2><p className="mt-1 text-xs text-muted-foreground">Income and expense summary</p></div><button className="filter-button"><CalendarDays size={14} /> This month <ChevronDown size={13} /></button></div><div className="flex h-40 items-end justify-between gap-3 px-1 sm:px-5">{[{ label: "M1", a: 43, b: 30 }, { label: "M2", a: 64, b: 39 }, { label: "M3", a: 48, b: 28 }, { label: "M4", a: 78, b: 45 }, { label: "M5", a: 58, b: 33 }, { label: "M6", a: 92, b: 53 }, { label: "M7", a: 70, b: 39 }].map((bar) => <div key={bar.label} className="flex h-full flex-1 flex-col items-center justify-end gap-2"><div className="flex h-[calc(100%-22px)] w-full items-end justify-center gap-1"><div className="w-2/5 max-w-5 rounded-t-md bg-primary/25" style={{ height: `${bar.b}%` }} /><div className="w-2/5 max-w-5 rounded-t-md bg-primary" style={{ height: `${bar.a}%` }} /></div><span className="text-[10px] text-muted-foreground">{bar.label}</span></div>)}</div><div className="mt-4 flex items-center justify-center gap-5 text-[11px] text-muted-foreground"><span className="flex items-center gap-1.5"><i className="size-2 rounded-sm bg-primary" />Income</span><span className="flex items-center gap-1.5"><i className="size-2 rounded-sm bg-primary/25" />Expenses</span></div></div>
              <div className="surface-card p-5 sm:p-6"><div className="mb-5 flex items-center justify-between"><div><h2 className="section-title">My accounts</h2><p className="mt-1 text-xs text-muted-foreground">Balance across accounts</p></div><button onClick={() => navigate("accounts")} className="text-xs font-bold text-primary hover:underline">View all</button></div><div className="space-y-3">{activeAccounts.slice(0, 4).map((account) => <AccountRow key={account.id} account={account} onSelect={() => setSelectedAccount(account)} />)}</div><button onClick={() => setShowAccountForm(true)} className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl border-2 border-dashed border-card-outline py-3 text-sm font-semibold text-muted-foreground transition hover:border-primary hover:text-primary"><Plus size={16} />Tambah rekening</button></div>
            </section>
            <TransactionList transactions={transactions.slice(0, 5)} onSelect={setSelectedTransaction} onViewAll={() => navigate("transactions")} />
          </>}

          {view === "transactions" && <section className="surface-card p-4 sm:p-6"><div className="mb-5 flex flex-wrap items-center justify-between gap-3"><div><h2 className="section-title">All transactions</h2><p className="mt-1 text-xs text-muted-foreground">Kelola dan telusuri aktivitas keuanganmu.</p></div><button onClick={() => setShowTransactionForm(true)} className="primary-button"><Plus size={16} />Add transaction</button></div><div className="mb-5 grid gap-2 sm:grid-cols-2 xl:grid-cols-4"><label className="search-field sm:col-span-2"><Search size={16} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search transactions..." /></label><label className="filter-button"><SlidersHorizontal size={15} /><select value={typeFilter} onChange={(event) => setTypeFilter(event.target.value)}><option value="all">All types</option><option value="expense">Expenses</option><option value="income">Income</option><option value="transfer">Transfer</option></select><ChevronDown size={13} /></label><label className="filter-button"><Landmark size={15} /><select value={accountFilter} onChange={(event) => setAccountFilter(event.target.value)}><option value="all">Semua rekening</option>{accounts.map((account) => <option key={account.id} value={account.name}>{account.name}</option>)}</select><ChevronDown size={13} /></label><label className="filter-button"><FileText size={15} /><select value={categoryFilter} onChange={(event) => setCategoryFilter(event.target.value)}><option value="all">Semua kategori</option>{Array.from(new Set(transactions.map((item) => item.category))).map((category) => <option key={category} value={category}>{category}</option>)}</select><ChevronDown size={13} /></label><label className="filter-button"><CalendarDays size={15} /><select value={dateFilter} onChange={(event) => setDateFilter(event.target.value)}><option value="all">Semua waktu</option><option value="week">7 hari terakhir</option><option value="month">This month</option><option value="year">Tahun ini</option><option value="custom">Rentang khusus</option></select><ChevronDown size={13} /></label><label className="filter-button"><span className="text-[10px]">Min</span><input aria-label="Nominal minimum" type="number" min="0" value={minAmount} onChange={(event) => setMinAmount(event.target.value)} placeholder="Rp" className="w-full min-w-0 bg-transparent text-xs text-foreground outline-none" /></label><label className="filter-button"><span className="text-[10px]">Maks</span><input aria-label="Nominal maksimum" type="number" min="0" value={maxAmount} onChange={(event) => setMaxAmount(event.target.value)} placeholder="Rp" className="w-full min-w-0 bg-transparent text-xs text-foreground outline-none" /></label><label className="filter-button"><select aria-label="Urutkan" value={sortBy} onChange={(event) => setSortBy(event.target.value)}><option value="newest">Terbaru</option><option value="oldest">Terlama</option><option value="largest">Nominal terbesar</option><option value="smallest">Nominal terkecil</option></select><ChevronDown size={13} /></label></div>{dateFilter === "custom" && <div className="mb-5 grid gap-2 sm:grid-cols-2"><label className="form-label">Dari tanggal<input type="date" value={dateFrom} onChange={(event) => setDateFrom(event.target.value)} className="form-input" /></label><label className="form-label">Sampai tanggal<input type="date" value={dateTo} onChange={(event) => setDateTo(event.target.value)} className="form-input" /></label></div>}<TransactionList transactions={filteredTransactions} onSelect={setSelectedTransaction} /></section>}

          {view === "accounts" && <section><div className="mb-5 flex flex-wrap items-center justify-between gap-3"><div><h2 className="section-title">My accounts</h2><p className="mt-1 text-sm text-muted-foreground">Atur saldo bank, e-wallet, dan uang tunai.</p></div><button onClick={() => setShowAccountForm(true)} className="primary-button"><Plus size={16} />Tambah rekening</button></div><div className="mb-5 surface-card flex flex-wrap items-center justify-between gap-4 p-5"><div><p className="text-sm text-muted-foreground">Total balance seluruh rekening</p><p className="mt-1 font-mono text-2xl font-bold">{rupiah(totalBalance)}</p></div><div className="flex size-11 items-center justify-center rounded-2xl bg-primary/10 text-primary"><CreditCard size={21} /></div></div><div className="grid gap-4 md:grid-cols-2">{(showArchivedAccounts ? archivedAccounts : activeAccounts).map((account) => <div key={account.id} role="button" tabIndex={0} onClick={() => setSelectedAccount(account)} className="surface-card relative overflow-hidden p-5 cursor-pointer"><div className={`absolute inset-x-0 top-0 h-1.5 bg-linear-to-r ${account.color}`} /><div className="flex items-start justify-between"><div className="flex items-center gap-3"><div className={`flex size-11 items-center justify-center rounded-xl bg-linear-to-br ${account.color} text-white`}><Landmark size={20} /></div><div><p className="font-bold">{account.name}</p><p className="text-xs text-muted-foreground">{account.type} · {account.provider}</p></div></div><span className="rounded-full bg-emerald-500/10 px-2.5 py-1 text-[10px] font-bold text-emerald-700 dark:text-emerald-400">{account.archived ? "Diarsipkan" : "Aktif"}</span></div><div className="mt-6"><p className="text-xs text-muted-foreground">Current balance</p><p className="mt-1 font-mono text-2xl font-bold">{rupiah(account.balance)}</p></div><div className="mt-4 border-t border-border pt-3 text-xs text-muted-foreground">Opening balance tercatat · Riwayat transaksi tersedia</div></div>)}</div><button onClick={() => setShowArchivedAccounts(!showArchivedAccounts)} className="mt-4 mr-3 text-xs font-semibold text-muted-foreground hover:text-primary">{showArchivedAccounts ? "View accounts aktif" : `Lihat arsip (${archivedAccounts.length})`}</button><button onClick={() => setShowAccountForm(true)} className="mt-4 flex min-h-24 w-full items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-card-outline text-sm font-semibold text-muted-foreground hover:border-primary hover:text-primary"><Plus size={17} />Tambah rekening baru</button></section>}

          {view === "settings" && <section className="mx-auto max-w-3xl space-y-4"><div className="surface-card p-5 sm:p-6"><h2 className="section-title">App preferences</h2><p className="mt-1 text-sm text-muted-foreground">Sesuaikan tampilan dan privasi diwa.</p><div className="mt-5 divide-y divide-border"><div className="flex flex-col justify-between gap-3 py-4 sm:flex-row sm:items-center"><div><p className="text-sm font-semibold">App theme</p><p className="mt-1 text-xs text-muted-foreground">Pilih tema terang, gelap, atau mengikuti perangkat.</p></div><ThemeOptions /></div><div className="flex items-center justify-between gap-4 py-4"><div><p className="text-sm font-semibold">Balance privacy</p><p className="mt-1 text-xs text-muted-foreground">Sembunyikan nilai saldo pada layar.</p></div><button onClick={() => setShowBalance(!showBalance)} className="icon-button">{showBalance ? <Eye size={17} /> : <EyeOff size={17} />}</button></div><div className="flex items-center justify-between gap-4 py-4"><div><p className="text-sm font-semibold">Storage</p><p className="mt-1 text-xs text-muted-foreground">Perubahan disimpan di perangkat dan disinkronkan saat online.</p></div><span className="rounded-full bg-primary/10 px-3 py-1 text-xs font-semibold text-primary">{isOnline === false ? "Offline" : isOnline === true ? "Sync enabled" : "Checking…"}</span></div></div></div>{conflicts.length > 0 && <div className="surface-card p-5 sm:p-6"><h2 className="section-title">Sync conflicts</h2><p className="mt-1 text-sm text-muted-foreground">This record changed on another device. Choose which version to keep.</p><div className="mt-4 space-y-3">{conflicts.map((conflict) => <div key={conflict.id} className="rounded-xl border border-border p-4"><p className="text-sm font-semibold">{conflict.entity === "account" ? "Account" : "Transaction"} · {conflict.entityId}</p><p className="mt-1 text-xs text-muted-foreground">Local and cloud versions are available for review.</p><div className="mt-3 flex gap-2"><button className="secondary-button flex-1" onClick={() => void resolveWalletConflict(userId, conflict.id, "cloud").then(async () => { replaceWalletSnapshot(userId, await readLocalWallet(userId)); setConflicts(await getWalletConflicts(userId)); }).catch(() => setToast("Could not apply the cloud version."))}>Use cloud</button><button className="primary-button flex-1 justify-center" onClick={() => void resolveWalletConflict(userId, conflict.id, "local").then(async () => { replaceWalletSnapshot(userId, await readLocalWallet(userId)); setConflicts(await getWalletConflicts(userId)); }).catch(() => setToast("Could not sync the local version."))}>Keep local</button></div></div>)}</div></div>}<div className="surface-card p-5 sm:p-6"><h2 className="section-title">About diwa</h2><p className="mt-2 text-sm leading-relaxed text-muted-foreground">diwa (Digital Wallet) membantu mencatat pemasukan, pengeluaran, transfer, dan saldo dari berbagai rekening dalam satu tempat.</p><p className="mt-4 text-xs text-muted-foreground">Versi 1.0</p></div><div className="surface-card flex flex-wrap items-center justify-between gap-4 p-5 sm:p-6"><div><h2 className="section-title">Account</h2><p className="mt-1 text-sm text-muted-foreground">{user?.email}</p></div><button className="secondary-button" onClick={() => void signOutUser().catch(() => setToast("Could not sign out. Try again."))}>Sign out</button></div></section>}
        </main>

        <nav className="wallet-bottom-nav lg:hidden">{navItems.slice(0, 2).map(({ id, label, icon: Icon }) => <button key={id} onClick={() => navigate(id)} className={view === id ? "active" : ""}><Icon size={19} /><span>{label}</span></button>)}<button className="wallet-bottom-add" onClick={() => setShowTransactionForm(true)} aria-label="Add transaction"><Plus size={20} /></button>{navItems.slice(2).map(({ id, label, icon: Icon }) => <button key={id} onClick={() => navigate(id)} className={view === id ? "active" : ""}><Icon size={19} /><span>{label}</span></button>)}</nav>
      </div>

      {showTransactionForm && <TransactionForm accounts={activeAccounts} initial={editingTransaction} onClose={() => { setShowTransactionForm(false); setEditingTransaction(null); }} onSubmit={saveTransaction} />}
      {showAccountForm && <AccountForm initial={editingAccount} onClose={() => { setShowAccountForm(false); setEditingAccount(null); }} onSubmit={saveAccount} />}
      {selectedAccount && <AccountDetail account={selectedAccount} transactions={transactions.filter((item) => item.account === selectedAccount.name || item.toAccount === selectedAccount.name)} onClose={() => setSelectedAccount(null)} onEdit={() => { setEditingAccount(selectedAccount); setSelectedAccount(null); setShowAccountForm(true); }} onArchive={() => { setAccounts((current) => current.map((account) => account.id === selectedAccount.id ? { ...account, archived: !account.archived } : account)); setSelectedAccount(null); setToast("Accounts diperbarui."); }} />}
      {selectedTransaction && <TransactionDetail transaction={selectedTransaction} onClose={() => setSelectedTransaction(null)} onEdit={() => { setEditingTransaction(selectedTransaction); setSelectedTransaction(null); setShowTransactionForm(true); }} onDelete={() => { const removed = selectedTransaction; setAccounts((current) => current.map((account) => ({ ...account, balance: account.balance + (removed.account === account.name ? (removed.type === "income" ? -removed.amount : removed.type === "expense" || removed.type === "transfer" ? removed.amount : 0) : 0) + (removed.type === "transfer" && removed.toAccount === account.name ? -removed.amount : 0) }))); setTransactions((current) => current.filter((item) => item.id !== removed.id)); setSelectedTransaction(null); setToast("Transactions dihapus dan saldo disesuaikan."); }} />}
      {toast && <div role="status" className="wallet-toast"><Check size={16} />{toast}</div>}
    </div>
  );
}

function StatCard({ label, amount, icon: Icon, tone, caption }: { label: string; amount: number; icon: typeof ArrowDownLeft; tone: "positive" | "negative"; caption: string }) {
  return <div className="surface-card flex items-center gap-3 p-4 sm:gap-4 sm:p-5"><div className={`flex size-10 shrink-0 items-center justify-center rounded-xl ${tone === "positive" ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" : "bg-rose-500/10 text-rose-600 dark:text-rose-400"}`}><Icon size={19} /></div><div className="min-w-0"><p className="text-xs text-muted-foreground">{label}</p><p className="truncate font-mono text-base font-bold sm:text-lg">{rupiah(amount)}</p><p className="mt-0.5 text-[10px] text-muted-foreground sm:text-xs">{caption}</p></div></div>;
}

function ThemeOptions() {
  const { theme, setTheme } = useTheme();
  return <div className="grid grid-cols-3 rounded-xl border border-border bg-muted p-1" aria-label="Pilih tema"><button type="button" onClick={() => setTheme("light")} className={`rounded-lg px-3 py-2 text-xs font-semibold ${theme === "light" ? "bg-card text-foreground shadow-sm" : "text-muted-foreground"}`}>Light</button><button type="button" onClick={() => setTheme("dark")} className={`rounded-lg px-3 py-2 text-xs font-semibold ${theme === "dark" ? "bg-card text-foreground shadow-sm" : "text-muted-foreground"}`}>Dark</button><button type="button" onClick={() => setTheme("system")} className={`rounded-lg px-3 py-2 text-xs font-semibold ${theme === "system" ? "bg-card text-foreground shadow-sm" : "text-muted-foreground"}`}>System</button></div>;
}

function AccountRow({ account, onSelect }: { account: Account; onSelect: () => void }) {
  return <button type="button" onClick={onSelect} className="flex w-full items-center justify-between gap-3 rounded-xl p-1 text-left transition hover:bg-muted"><span className="flex min-w-0 items-center gap-3"><span className={`flex size-9 shrink-0 items-center justify-center rounded-xl bg-linear-to-br ${account.color} text-white`}><Landmark size={16} /></span><span className="min-w-0"><span className="block truncate text-sm font-semibold">{account.name}</span><span className="block text-[11px] text-muted-foreground">{account.type} · {account.provider}</span></span></span><span className="shrink-0 font-mono text-sm font-bold">{rupiah(account.balance)}</span></button>;
}

function TransactionList({ transactions, onSelect, onViewAll }: { transactions: Transaction[]; onSelect: (item: Transaction) => void; onViewAll?: () => void }) {
  const groups = transactions.reduce<Record<string, Transaction[]>>((result, item) => {
    (result[item.date] ||= []).push(item);
    return result;
  }, {});
  return <section className="surface-card p-4 sm:p-6"><div className="mb-4 flex items-center justify-between"><div><h2 className="section-title">Transactions terbaru</h2><p className="mt-1 text-xs text-muted-foreground">Aktivitas rekening terkini</p></div>{onViewAll && <button onClick={onViewAll} className="text-xs font-bold text-primary hover:underline">View all</button>}</div>{transactions.length ? <div>{Object.entries(groups).map(([date, items]) => <div key={date} className="mb-3 last:mb-0"><div className="flex items-center justify-between border-b border-border pb-2 text-[11px] font-bold text-muted-foreground"><span>{date === today ? "Today" : shortDate(date)}</span><span>{items.length} transaksi</span></div><div className="divide-y divide-border">{items.map((item) => <button key={item.id} onClick={() => onSelect(item)} className="transaction-row w-full text-left"><span className={`flex size-10 shrink-0 items-center justify-center rounded-xl ${item.type === "income" ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" : item.type === "transfer" ? "bg-primary/10 text-primary" : "bg-rose-500/10 text-rose-600 dark:text-rose-400"}`}>{item.type === "income" ? <ArrowDownLeft size={18} /> : item.type === "transfer" ? <ArrowLeftRight size={17} /> : <ArrowUpRight size={18} />}</span><span className="min-w-0 flex-1"><span className="block truncate text-sm font-semibold">{item.title}</span><span className="mt-1 block truncate text-[11px] text-muted-foreground">{item.category} · {item.account}{item.toAccount ? ` → ${item.toAccount}` : ""} · {shortDate(item.date)}</span></span><span className="text-right"><span className={`block whitespace-nowrap font-mono text-sm font-bold ${item.type === "income" ? "text-emerald-600 dark:text-emerald-400" : ""}`}>{item.type === "income" ? "+" : item.type === "expense" ? "−" : ""}{rupiah(item.amount)}</span><span className="mt-1 block text-[10px] text-muted-foreground">{item.syncStatus === "Pending" ? "Menunggu sinkronisasi" : "Tersinkron"}</span></span></button>)}</div></div>)}</div> : <div className="py-12 text-center"><div className="mx-auto flex size-12 items-center justify-center rounded-2xl bg-muted text-muted-foreground"><FileText size={20} /></div><p className="mt-3 text-sm font-semibold">Belum ada transaksi</p><p className="mt-1 text-xs text-muted-foreground">Coba ubah kata kunci atau filter yang dipilih.</p></div>}</section>;
}

function TransactionForm({ accounts, onClose, onSubmit, initial }: { accounts: Account[]; onClose: () => void; onSubmit: (values: TransactionFormValues, receiptFile?: File) => void; initial?: Transaction | null }) {
  const [detailsOpen, setDetailsOpen] = useState(Boolean(initial?.note || initial?.items?.length || initial?.receiptName));
  const [ocrMessage, setOcrMessage] = useState("");
  const [receiptFile, setReceiptFile] = useState<File>();
  const { register, control, handleSubmit, setValue, formState: { errors, isSubmitting } } = useForm<TransactionFormValues>({
    resolver: zodResolver(transactionFormSchema),
    defaultValues: {
      type: initial?.type || "expense",
      amount: initial?.amount,
      title: initial?.title || "",
      account: initial?.account || accounts[0]?.name || "",
      toAccount: initial?.toAccount || accounts[1]?.name || accounts[0]?.name || "",
      category: initial?.category || (initial?.type === "income" ? "Gaji" : "Makanan"),
      date: initial?.date || today,
      note: initial?.note || "",
      paymentMethod: initial?.paymentMethod || "Debit",
      items: initial?.items || [],
      receiptName: initial?.receiptName || "",
    },
  });
  const type = useWatch({ control, name: "type" }) || "expense";
  const items = useWatch({ control, name: "items" }) || [];
  const receiptName = useWatch({ control, name: "receiptName" }) || "";
  const { fields, append, remove } = useFieldArray({ control, name: "items" });
  const itemTotal = items.reduce((sum, item) => sum + (item?.quantity || 0) * (item?.unitPrice || 0), 0);
  const categoryOptions = type === "income"
    ? ["Salary", "Freelance", "Gift", "Investment", "Other"]
    : ["Food", "Shopping", "Transport", "Bills", "Health", "Entertainment", "Other"];

  function submit(values: TransactionFormValues) {
    if (type !== "transfer" && itemTotal > 0 && values.amount !== itemTotal) {
      const message = `Item subtotal ${rupiah(itemTotal)} differs from transaction amount ${rupiah(values.amount)}. Save the difference for tax, discount, or fees?`;
      if (!window.confirm(message)) return;
    }
    onSubmit(values, receiptFile);
  }

  async function scanReceipt(file?: File) {
    if (!file) return;
    setReceiptFile(file);
    setValue("receiptName", file.name);
    setOcrMessage("Reading receipt locally… 0%");
    try {
      const result = await readReceipt(file, (progress) => setOcrMessage(`Reading receipt locally… ${Math.round(progress * 100)}%`));
      if (result.amount) setValue("amount", result.amount, { shouldValidate: true, shouldDirty: true });
      if (result.date) setValue("date", result.date, { shouldValidate: true, shouldDirty: true });
      setOcrMessage(result.amount || result.date ? "Review the detected amount and date before saving." : "No amount or date detected. Enter them manually.");
    } catch {
      setOcrMessage("Receipt scan failed. Enter the details manually and try another image.");
    }
  }

  return <Modal title={initial ? "Edit transaction" : type === "transfer" ? "Transfer money" : "Add transaction"} onClose={onClose}>
    <form onSubmit={handleSubmit(submit)} className="space-y-5">
      <input type="hidden" {...register("type")} />
      <input type="hidden" {...register("receiptName")} />
      {!initial && <div className="grid grid-cols-3 rounded-xl bg-muted p-1">{(["expense", "income", "transfer"] as const).map((value) => <button type="button" key={value} onClick={() => { setValue("type", value, { shouldValidate: true }); if (value !== "transfer") setValue("category", value === "income" ? "Salary" : "Food"); }} className={`rounded-lg px-2 py-2 text-xs font-semibold transition sm:text-sm ${type === value ? "bg-card text-foreground shadow-sm" : "text-muted-foreground"}`}>{value === "expense" ? "Expense" : value === "income" ? "Income" : "Transfer"}</button>)}</div>}
      <label className="form-label">Amount<input {...register("amount", { valueAsNumber: true })} type="number" inputMode="numeric" min="1" placeholder="0" className="form-input amount-input" aria-invalid={Boolean(errors.amount)} /></label>
      {errors.amount && <p role="alert" className="-mt-4 text-xs text-rose-600">{errors.amount.message}</p>}
      {type !== "transfer" && <><label className="form-label">Name<input {...register("title")} placeholder={type === "income" ? "e.g. Monthly salary" : "e.g. Lunch"} className="form-input" aria-invalid={Boolean(errors.title)} /></label>{errors.title && <p role="alert" className="-mt-4 text-xs text-rose-600">{errors.title.message}</p>}</>}
      <label className="form-label">{type === "transfer" ? "From account" : "Account"}<select {...register("account")} className="form-input">{accounts.map((account) => <option key={account.id} value={account.name}>{account.name} · {rupiah(account.balance)}</option>)}</select></label>
      {errors.account && <p role="alert" className="-mt-4 text-xs text-rose-600">{errors.account.message}</p>}
      {type === "transfer" && <><label className="form-label">To account<select {...register("toAccount")} className="form-input">{accounts.map((account) => <option key={account.id} value={account.name}>{account.name}</option>)}</select></label>{errors.toAccount && <p role="alert" className="-mt-4 text-xs text-rose-600">{errors.toAccount.message}</p>}</>}
      {type !== "transfer" && <><label className="form-label">Category<select {...register("category")} className="form-input">{categoryOptions.map((category) => <option key={category}>{category}</option>)}</select></label>{errors.category && <p role="alert" className="-mt-4 text-xs text-rose-600">{errors.category.message}</p>}</>}
      <label className="form-label">Date<input {...register("date")} type="date" required className="form-input" /></label>
      {type !== "transfer" && <button type="button" onClick={() => setDetailsOpen(!detailsOpen)} className="flex w-full items-center justify-between rounded-xl border border-border px-4 py-3 text-sm font-semibold"><span>More details (notes, items, receipt)</span><ChevronDown size={16} className={`transition ${detailsOpen ? "rotate-180" : ""}`} /></button>}
      {detailsOpen && type !== "transfer" && <div className="space-y-4 rounded-xl bg-muted/60 p-4">
        <label className="form-label">Note<textarea {...register("note")} rows={2} placeholder="Add a note..." className="form-input resize-none" /></label>
        <label className="form-label">Payment method<select {...register("paymentMethod")} className="form-input"><option>Debit</option><option>Credit</option><option>Bank transfer</option><option>QRIS</option><option>Cash</option><option>E-Wallet</option><option>Other</option></select></label>
        <div><div className="mb-2 flex items-center justify-between"><p className="text-xs font-bold">Items (optional)</p><button type="button" onClick={() => append({ name: "", quantity: 1, unitPrice: 0 })} className="flex items-center gap-1 text-xs font-bold text-primary"><Plus size={14} />Add item</button></div>
          {fields.map((field, index) => <div key={field.id} className="mb-2 grid grid-cols-[1fr_54px_90px_28px] gap-2"><input {...register(`items.${index}.name`)} aria-label="Item name" placeholder="Item name" className="form-input min-w-0 px-2 text-xs" /><input {...register(`items.${index}.quantity`, { valueAsNumber: true })} aria-label="Quantity" type="number" min="1" className="form-input px-2 text-xs" /><input {...register(`items.${index}.unitPrice`, { valueAsNumber: true })} aria-label="Unit price" type="number" min="0" className="form-input px-2 text-xs" /><button type="button" aria-label="Remove item" onClick={() => remove(index)} className="text-muted-foreground hover:text-rose-600"><X size={15} /></button></div>)}
          {items.length > 0 && <p className="text-right text-[11px] text-muted-foreground">Item subtotal: <strong className="text-foreground">{rupiah(itemTotal)}</strong></p>}
          {errors.items?.root?.message && <p role="alert" className="text-xs text-rose-600">{errors.items.root.message}</p>}
        </div>
        <label className="flex cursor-pointer items-center gap-3 rounded-xl border border-dashed border-card-outline bg-card p-3"><ImagePlus size={18} className="text-primary" /><span className="min-w-0 flex-1 truncate text-xs font-semibold">{receiptName || "Upload and scan a receipt"}</span><input type="file" accept="image/*" className="sr-only" onChange={(event) => void scanReceipt(event.target.files?.[0])} /></label>
        {ocrMessage && <p role="status" className="text-xs text-muted-foreground">{ocrMessage}</p>}
      </div>}
      <div className="flex gap-3 pt-1"><button type="button" onClick={onClose} className="secondary-button flex-1">Cancel</button><button type="submit" disabled={isSubmitting} className="primary-button flex-1 justify-center disabled:opacity-60">{type === "transfer" ? "Confirm transfer" : initial ? "Save changes" : "Save transaction"}</button></div>
    </form>
  </Modal>;
}

function AccountForm({ onClose, onSubmit, initial }: { onClose: () => void; onSubmit: (values: AccountFormValues) => void; initial?: Account | null }) {
  const [receipt, setReceipt] = useState("");
  const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm<AccountFormValues>({
    resolver: zodResolver(accountFormSchema),
    defaultValues: {
      accountType: (initial?.type as AccountFormValues["accountType"]) || "Bank",
      provider: initial?.provider || "",
      name: initial?.name || "",
      balance: initial?.balance ?? 0,
      openingDate: initial?.openingDate || today,
    },
  });
  return <Modal title={initial ? "Edit account" : "Add account"} onClose={onClose}><form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
    <label className="form-label">Account type<select {...register("accountType")} className="form-input"><option>Bank</option><option>E-Wallet</option><option>Cash</option><option>Other</option></select></label>
    <label className="form-label">Provider<input {...register("provider")} placeholder="e.g. BCA, DANA" className="form-input" /></label>{errors.provider && <p role="alert" className="-mt-3 text-xs text-rose-600">{errors.provider.message}</p>}
    <label className="form-label">Account name<input {...register("name")} placeholder="e.g. Main account" className="form-input" /></label>{errors.name && <p role="alert" className="-mt-3 text-xs text-rose-600">{errors.name.message}</p>}
    <label className="form-label">Opening / current balance<input {...register("balance", { valueAsNumber: true })} type="number" inputMode="numeric" min="0" className="form-input" /></label>{errors.balance && <p role="alert" className="-mt-3 text-xs text-rose-600">{errors.balance.message}</p>}
    <label className="form-label">Opening balance date<input {...register("openingDate")} type="date" className="form-input" /></label>{errors.openingDate && <p role="alert" className="-mt-3 text-xs text-rose-600">{errors.openingDate.message}</p>}
    <div><p className="mb-2 text-xs font-semibold">Import a balance screenshot (optional)</p><label className="flex cursor-pointer items-center gap-3 rounded-xl border-2 border-dashed border-card-outline p-4 transition hover:border-primary"><ImagePlus size={19} className="text-primary" /><span className="min-w-0 flex-1"><span className="block truncate text-xs font-semibold">{receipt || "Choose account screenshot"}</span><span className="mt-1 block text-[10px] text-muted-foreground">Use it as a manual reference.</span></span><input type="file" accept="image/*" multiple className="sr-only" onChange={(event) => setReceipt(Array.from(event.target.files || []).map((file) => file.name).join(", "))} /></label><p className="mt-2 text-[10px] leading-relaxed text-muted-foreground">The balance is not extracted automatically yet. Check and enter it manually.</p></div>
    <div className="flex gap-3 pt-2"><button type="button" onClick={onClose} className="secondary-button flex-1">Cancel</button><button type="submit" disabled={isSubmitting} className="primary-button flex-1 justify-center disabled:opacity-60">{initial ? "Save changes" : "Save account"}</button></div>
  </form></Modal>;
}

function AccountDetail({ account, transactions, onClose, onEdit, onArchive }: { account: Account; transactions: Transaction[]; onClose: () => void; onEdit: () => void; onArchive: () => void }) {
  const income = transactions.filter((item) => item.type === "income" && item.account === account.name).reduce((sum, item) => sum + item.amount, 0);
  const expenses = transactions.filter((item) => item.type === "expense" && item.account === account.name).reduce((sum, item) => sum + item.amount, 0);
  const transfers = transactions.filter((item) => item.type === "transfer");
  const transferIn = transfers.filter((item) => item.toAccount === account.name).reduce((sum, item) => sum + item.amount, 0);
  const transferOut = transfers.filter((item) => item.account === account.name).reduce((sum, item) => sum + item.amount, 0);
  return <Modal title="Detail rekening" onClose={onClose}><div className="text-center"><span className={`mx-auto flex size-14 items-center justify-center rounded-2xl bg-linear-to-br ${account.color} text-white`}><Landmark size={24} /></span><h3 className="mt-3 font-bold">{account.name}</h3><p className="text-xs text-muted-foreground">{account.type} · {account.provider}</p><p className="mt-3 font-mono text-3xl font-bold">{rupiah(account.balance)}</p><p className="mt-1 text-xs text-muted-foreground">Current balance</p></div><div className="mt-5 grid grid-cols-2 gap-2"><div className="rounded-xl bg-muted/70 p-3"><p className="text-[10px] text-muted-foreground">Opening balance</p><p className="mt-1 font-mono text-sm font-bold">{rupiah(account.balance - income + expenses - transferIn + transferOut)}</p></div><div className="rounded-xl bg-muted/70 p-3"><p className="text-[10px] text-muted-foreground">Income · Expenses</p><p className="mt-1 text-xs font-bold">{rupiah(income)} · {rupiah(expenses)}</p></div></div><div className="mt-4 flex items-center justify-between rounded-xl border border-border p-3 text-xs"><span className="text-muted-foreground">Transfer masuk / keluar</span><span className="font-semibold">{rupiah(transferIn)} / {rupiah(transferOut)}</span></div><div className="mt-5"><p className="mb-2 text-xs font-bold">Transactions rekening</p><div className="max-h-40 divide-y divide-border overflow-y-auto rounded-xl border border-border px-3">{transactions.length ? transactions.map((item) => <div key={item.id} className="flex justify-between gap-3 py-2.5 text-xs"><span className="truncate">{item.title}</span><span className="shrink-0 font-mono font-bold">{rupiah(item.amount)}</span></div>) : <p className="py-4 text-center text-xs text-muted-foreground">Belum ada transaksi.</p>}</div></div><div className="mt-5 flex gap-2"><button onClick={onEdit} className="secondary-button flex-1">Edit rekening</button><button onClick={onArchive} className="secondary-button flex-1">{account.archived ? "Pulihkan rekening" : "Arsipkan rekening"}</button></div></Modal>;
}

function TransactionDetail({ transaction, onClose, onEdit, onDelete }: { transaction: Transaction; onClose: () => void; onEdit: () => void; onDelete: () => void }) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  return <Modal title="Detail transaksi" onClose={onClose}><div className="text-center"><span className={`mx-auto flex size-14 items-center justify-center rounded-2xl ${transaction.type === "income" ? "bg-emerald-500/10 text-emerald-600" : transaction.type === "transfer" ? "bg-primary/10 text-primary" : "bg-rose-500/10 text-rose-600"}`}>{transaction.type === "income" ? <ArrowDownLeft size={24} /> : transaction.type === "transfer" ? <ArrowLeftRight size={22} /> : <ArrowUpRight size={24} />}</span><p className="mt-3 text-sm text-muted-foreground">{transaction.title}</p><p className="mt-1 font-mono text-3xl font-bold">{transaction.type === "income" ? "+" : transaction.type === "expense" ? "−" : ""}{rupiah(transaction.amount)}</p><span className="mt-3 inline-flex rounded-full bg-emerald-500/10 px-3 py-1 text-[11px] font-semibold text-emerald-700 dark:text-emerald-400">{transaction.syncStatus === "Pending" ? "Menunggu sinkronisasi" : "Tersinkron"}</span></div><div className="mt-6 divide-y divide-border rounded-xl border border-border px-4"><DetailRow label="Jenis" value={transaction.type === "income" ? "Income" : transaction.type === "expense" ? "Expenses" : "Transfer"} /><DetailRow label="Kategori" value={transaction.category} /><DetailRow label="Accounts" value={transaction.toAccount ? `${transaction.account} → ${transaction.toAccount}` : transaction.account} /><DetailRow label="Tanggal" value={shortDate(transaction.date)} />{transaction.createdAt && <DetailRow label="Dibuat" value={new Date(transaction.createdAt).toLocaleString("id-ID")} />}{transaction.updatedAt && <DetailRow label="Diperbarui" value={new Date(transaction.updatedAt).toLocaleString("id-ID")} />}{transaction.paymentMethod && <DetailRow label="Metode pembayaran" value={transaction.paymentMethod} />}{transaction.items?.map((item, index) => <DetailRow key={index} label={`${item.name} × ${item.quantity}`} value={rupiah(item.unitPrice * item.quantity)} />)}{transaction.receiptName && <DetailRow label="Bukti" value={transaction.receiptName} />}{transaction.note && <DetailRow label="Catatan" value={transaction.note} />}</div>{confirmDelete ? <div className="mt-5 rounded-xl border border-rose-500/30 bg-rose-500/5 p-4"><p className="text-sm font-semibold">Hapus transaksi ini?</p><p className="mt-1 text-xs text-muted-foreground">Saldo rekening akan disesuaikan dari transaksi ini.</p><div className="mt-3 flex gap-2"><button className="secondary-button flex-1" onClick={() => setConfirmDelete(false)}>Batal</button><button className="rounded-xl bg-rose-600 px-4 py-2 text-sm font-bold text-white" onClick={onDelete}>Hapus</button></div></div> : <div className="mt-5 flex gap-3"><button onClick={onEdit} className="secondary-button flex-1">Edit transaksi</button><button onClick={() => setConfirmDelete(true)} className="rounded-xl border border-rose-500/30 px-4 text-sm font-semibold text-rose-600 hover:bg-rose-500/5">Hapus</button></div>}</Modal>;
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return <div className="flex items-start justify-between gap-4 py-3 text-sm"><span className="text-muted-foreground">{label}</span><span className="text-right font-semibold">{value}</span></div>;
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const reduceMotion = useReducedMotion();
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);
  return <motion.div className="wallet-modal-backdrop" initial={reduceMotion ? false : { opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: reduceMotion ? 0 : 0.16 }} onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><motion.section role="dialog" aria-modal="true" aria-label={title} className="wallet-modal" initial={reduceMotion ? false : { opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: reduceMotion ? 0 : 0.2, ease: "easeOut" }}><div className="mb-5 flex items-center justify-between"><h2 className="text-lg font-extrabold">{title}</h2><button onClick={onClose} className="icon-button" aria-label="Close"><X size={18} /></button></div>{children}</motion.section></motion.div>;
}
