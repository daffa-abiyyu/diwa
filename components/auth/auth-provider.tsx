"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { onAuthStateChanged, signOut, type User } from "firebase/auth";
import { getFirebaseClient, isFirebaseConfigured } from "@/lib/firebase/client";

type AuthState = {
  status: "loading" | "authenticated" | "unauthenticated" | "unconfigured";
  user: User | null;
  signOutUser: () => Promise<void>;
};

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [status, setStatus] = useState<AuthState["status"]>(() => isFirebaseConfigured() ? "loading" : "unconfigured");

  useEffect(() => {
    const client = getFirebaseClient();
    if (!client) return;
    return onAuthStateChanged(client.auth, (nextUser) => {
      setUser(nextUser);
      setStatus(nextUser ? "authenticated" : "unauthenticated");
    });
  }, []);

  async function signOutUser() {
    const client = getFirebaseClient();
    if (!client) return;
    await signOut(client.auth);
  }

  return <AuthContext.Provider value={{ status, user, signOutUser }}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used inside AuthProvider.");
  return value;
}
