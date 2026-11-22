import { create } from "zustand";

export type WalletView = "overview" | "transactions" | "accounts" | "settings";

type WalletUiState = {
  view: WalletView;
  menuOpen: boolean;
  toast: string;
  setView: (view: WalletView) => void;
  setMenuOpen: (open: boolean) => void;
  setToast: (message: string) => void;
  reset: () => void;
};

export const useWalletUiStore = create<WalletUiState>((set) => ({
  view: "overview",
  menuOpen: false,
  toast: "",
  setView: (view) => set({ view }),
  setMenuOpen: (menuOpen) => set({ menuOpen }),
  setToast: (toast) => set({ toast }),
  reset: () => set({ view: "overview", menuOpen: false, toast: "" }),
}));
