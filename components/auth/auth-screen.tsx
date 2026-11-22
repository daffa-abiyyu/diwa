"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { GoogleAuthProvider, RecaptchaVerifier, browserLocalPersistence, createUserWithEmailAndPassword, sendPasswordResetEmail, setPersistence, signInWithEmailAndPassword, signInWithPhoneNumber, signInWithPopup, signInWithRedirect, updateProfile, type ConfirmationResult } from "firebase/auth";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { useReducedMotion, motion } from "motion/react";
import { ArrowDownLeft, ArrowLeft, ArrowRight, ChartNoAxesCombined, Eye, EyeOff, Landmark, LockKeyhole, Mail, ShieldCheck, UserRound, Wallet } from "lucide-react";
import { getFirebaseClient } from "@/lib/firebase/client";

type AuthMode = "login" | "register" | "reset";
type LoginMethod = "email" | "phone";
type AuthFormValues = { displayName?: string; email: string; password?: string; confirmPassword?: string };

function normalizePhoneNumber(value: string) {
  const compact = value.trim().replace(/[\s()-]/g, "");
  const phone = compact.startsWith("+")
    ? compact
    : compact.startsWith("62")
      ? `+${compact}`
      : `+62${compact.replace(/^0/, "")}`;
  return /^\+[1-9]\d{7,14}$/.test(phone) ? phone : null;
}

function getAuthSchema(mode: AuthMode) {
  return z.object({
    displayName: z.string().trim().optional(),
    email: z.email("Enter a valid email address."),
    password: z.string().optional(),
    confirmPassword: z.string().optional(),
  }).superRefine((values, context) => {
    if (mode !== "reset" && (!values.password || values.password.length < 8)) {
      context.addIssue({ code: "custom", path: ["password"], message: "Password must be at least 8 characters." });
    }
    if (mode === "register" && (values.displayName?.trim().length || 0) < 2) {
      context.addIssue({ code: "custom", path: ["displayName"], message: "Enter your name." });
    }
    if (mode === "register" && values.password !== values.confirmPassword) {
      context.addIssue({ code: "custom", path: ["confirmPassword"], message: "Passwords do not match." });
    }
  });
}

function authErrorMessage(error: unknown) {
  const code = typeof error === "object" && error && "code" in error ? String(error.code) : "";
  if (code.includes("email-already-in-use")) return "An account with this email already exists.";
  if (code.includes("invalid-credential") || code.includes("user-not-found") || code.includes("wrong-password")) return "Email or password is incorrect.";
  if (code.includes("weak-password")) return "Choose a stronger password.";
  if (code.includes("network-request-failed")) return "Connection failed. Check your internet and try again.";
  if (code.includes("operation-not-allowed")) return "This sign-in method is disabled in Firebase Authentication settings.";
  if (code.includes("invalid-phone-number")) return "Enter a valid phone number with its country code.";
  if (code.includes("invalid-verification-code")) return "That SMS code is incorrect. Check it and try again.";
  if (code.includes("code-expired")) return "That SMS code has expired. Request a new code.";
  if (code.includes("quota-exceeded")) return "SMS sign-in is temporarily limited. Try again later.";
  if (code.includes("too-many-requests")) return "Too many sign-in attempts. Try again later.";
  if (code.includes("popup-closed-by-user")) return "Google sign-in was canceled.";
  return "We couldn't complete that request. Please try again.";
}

export function AuthScreen() {
  const [mode, setMode] = useState<AuthMode>("login");
  const [errorMessage, setErrorMessage] = useState("");
  const [successMessage, setSuccessMessage] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [loginMethod, setLoginMethod] = useState<LoginMethod>("email");
  const [phoneNumber, setPhoneNumber] = useState("");
  const [verificationCode, setVerificationCode] = useState("");
  const [phoneConfirmation, setPhoneConfirmation] = useState<ConfirmationResult | null>(null);
  const [isSendingCode, setIsSendingCode] = useState(false);
  const [isVerifyingCode, setIsVerifyingCode] = useState(false);
  const recaptchaVerifier = useRef<RecaptchaVerifier | null>(null);
  const reduceMotion = useReducedMotion();
  const schema = useMemo(() => getAuthSchema(mode), [mode]);
  const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm<AuthFormValues>({
    resolver: zodResolver(schema),
    defaultValues: { displayName: "", email: "", password: "", confirmPassword: "" },
  });

  useEffect(() => () => { recaptchaVerifier.current?.clear(); }, []);

  async function submit(values: AuthFormValues) {
    const client = getFirebaseClient();
    if (!client) return setErrorMessage("Firebase is not configured. Add the project settings to .env.local and restart the app.");
    setErrorMessage("");
    setSuccessMessage("");
    try {
      if (mode === "reset") {
        await sendPasswordResetEmail(client.auth, values.email);
        setSuccessMessage("Password reset instructions were sent to your email.");
        return;
      }
      await setPersistence(client.auth, browserLocalPersistence);
      if (mode === "register") {
        const credential = await createUserWithEmailAndPassword(client.auth, values.email, values.password || "");
        await updateProfile(credential.user, { displayName: values.displayName?.trim() || "" });
      } else {
        await signInWithEmailAndPassword(client.auth, values.email, values.password || "");
      }
    } catch (error) {
      setErrorMessage(authErrorMessage(error));
    }
  }

  async function signInWithGoogle() {
    const client = getFirebaseClient();
    if (!client) return setErrorMessage("Firebase is not configured. Add the project settings to .env.local and restart the app.");
    setErrorMessage("");
    try {
      await setPersistence(client.auth, browserLocalPersistence);
      if (window.matchMedia("(max-width: 767px)").matches) {
        await signInWithRedirect(client.auth, new GoogleAuthProvider());
        return;
      }
      await signInWithPopup(client.auth, new GoogleAuthProvider());
    } catch (error) {
      const code = typeof error === "object" && error && "code" in error ? String(error.code) : "";
      if (code.includes("popup-blocked") || code.includes("operation-not-supported-in-this-environment")) {
        await signInWithRedirect(client.auth, new GoogleAuthProvider());
        return;
      }
      setErrorMessage(authErrorMessage(error));
    }
  }

  async function sendPhoneCode() {
    const client = getFirebaseClient();
    if (!client) return setErrorMessage("Firebase is not configured. Add the project settings to .env.local and restart the app.");
    const normalizedPhone = normalizePhoneNumber(phoneNumber);
    if (!normalizedPhone) {
      setErrorMessage("Enter a valid phone number. Use +country code, for example +62 812 3456 7890.");
      return;
    }
    setErrorMessage("");
    setSuccessMessage("");
    setPhoneConfirmation(null);
    recaptchaVerifier.current?.clear();
    setIsSendingCode(true);
    try {
      await setPersistence(client.auth, browserLocalPersistence);
      const verifier = new RecaptchaVerifier(client.auth, "diwa-phone-recaptcha", { size: "invisible" });
      recaptchaVerifier.current = verifier;
      const confirmation = await signInWithPhoneNumber(client.auth, normalizedPhone, verifier);
      setPhoneNumber(normalizedPhone);
      setPhoneConfirmation(confirmation);
      setSuccessMessage(`A verification code was sent to ${normalizedPhone}.`);
    } catch (error) {
      recaptchaVerifier.current?.clear();
      recaptchaVerifier.current = null;
      setErrorMessage(authErrorMessage(error));
    } finally {
      setIsSendingCode(false);
    }
  }

  async function verifyPhoneCode() {
    if (!phoneConfirmation) return;
    const code = verificationCode.replace(/\s/g, "");
    if (!/^\d{6}$/.test(code)) {
      setErrorMessage("Enter the 6-digit code sent to your phone.");
      return;
    }
    setErrorMessage("");
    setIsVerifyingCode(true);
    try {
      await phoneConfirmation.confirm(code);
      recaptchaVerifier.current?.clear();
      recaptchaVerifier.current = null;
    } catch (error) {
      setErrorMessage(authErrorMessage(error));
    } finally {
      setIsVerifyingCode(false);
    }
  }

  function selectLoginMethod(next: LoginMethod) {
    setLoginMethod(next);
    setPhoneConfirmation(null);
    setPhoneNumber("");
    setVerificationCode("");
    setErrorMessage("");
    setSuccessMessage("");
    recaptchaVerifier.current?.clear();
    recaptchaVerifier.current = null;
  }

  function switchMode(next: AuthMode) {
    setMode(next);
    setErrorMessage("");
    setSuccessMessage("");
  }

  const authFieldClass = "flex h-[3.7rem] items-center gap-4 rounded-2xl border border-[#d9deed] bg-white/80 px-4 text-[#66718e] shadow-[inset_0_1px_2px_rgba(31,56,105,.03)]";

  if (mode === "register") return <AuthPageFrame reduceMotion={reduceMotion}>
    <button type="button" onClick={() => switchMode("login")} aria-label="Back to sign in" className="absolute left-0 top-1 flex size-12 items-center justify-center rounded-full bg-white/90 text-[#123d9e] shadow-sm"><ArrowLeft size={23} /></button>
    <BrandMark compact />
    <h1 className="mt-5 text-center text-3xl font-extrabold tracking-tight text-[#101a58]">Create Your Account</h1>
    <p className="mt-2 text-center text-base leading-snug text-[#667092]">Start managing your finances<br />with diwa</p>
    <SignupIllustration />
    <form onSubmit={handleSubmit(submit)} className="space-y-3.5" noValidate>
      <label className={authFieldClass}><UserRound size={22} /><input {...register("displayName")} autoComplete="name" placeholder="Full Name" aria-label="Full name" aria-invalid={Boolean(errors.displayName)} className="min-w-0 flex-1 bg-transparent text-base text-[#17265c] outline-none placeholder:text-[#939cb4]" /></label>
      {errors.displayName && <p role="alert" className="px-2 text-xs text-rose-600">{errors.displayName.message}</p>}
      <label className={authFieldClass}><Mail size={22} /><input {...register("email")} type="email" autoComplete="email" inputMode="email" placeholder="Email Address" aria-label="Email address" aria-invalid={Boolean(errors.email)} className="min-w-0 flex-1 bg-transparent text-base text-[#17265c] outline-none placeholder:text-[#939cb4]" /></label>
      {errors.email && <p role="alert" className="px-2 text-xs text-rose-600">{errors.email.message}</p>}
      <label className={authFieldClass}><LockKeyhole size={22} /><input {...register("password")} type={showPassword ? "text" : "password"} autoComplete="new-password" placeholder="Password" aria-label="Password" aria-invalid={Boolean(errors.password)} className="min-w-0 flex-1 bg-transparent text-base text-[#17265c] outline-none placeholder:text-[#939cb4]" /><button type="button" onClick={() => setShowPassword((visible) => !visible)} aria-label={showPassword ? "Hide password" : "Show password"}>{showPassword ? <Eye size={21} /> : <EyeOff size={21} />}</button></label>
      {errors.password && <p role="alert" className="px-2 text-xs text-rose-600">{errors.password.message}</p>}
      <label className={authFieldClass}><LockKeyhole size={22} /><input {...register("confirmPassword")} type={showConfirmPassword ? "text" : "password"} autoComplete="new-password" placeholder="Confirm Password" aria-label="Confirm password" aria-invalid={Boolean(errors.confirmPassword)} className="min-w-0 flex-1 bg-transparent text-base text-[#17265c] outline-none placeholder:text-[#939cb4]" /><button type="button" onClick={() => setShowConfirmPassword((visible) => !visible)} aria-label={showConfirmPassword ? "Hide confirm password" : "Show confirm password"}>{showConfirmPassword ? <Eye size={21} /> : <EyeOff size={21} />}</button></label>
      {errors.confirmPassword && <p role="alert" className="px-2 text-xs text-rose-600">{errors.confirmPassword.message}</p>}
      <div className="flex items-center gap-4 rounded-2xl bg-[#eaf2ff] px-4 py-3.5 text-[#17418b]"><ShieldCheck size={34} className="shrink-0 text-[#1672e8]" /><div><p className="text-sm font-bold">Your data is safe with us</p><p className="mt-1 text-xs leading-relaxed text-[#657394]">We use industry-standard security to protect your personal information.</p></div></div>
      {errorMessage && <p role="alert" className="rounded-xl bg-rose-500/10 p-3 text-sm text-rose-700">{errorMessage}</p>}
      <button type="submit" disabled={isSubmitting} className="flex w-full items-center justify-center gap-3 rounded-[1.15rem] bg-gradient-to-r from-[#1769d2] to-[#2365ce] px-5 py-4 text-lg font-bold text-white shadow-[0_8px_18px_rgba(28,94,201,.2)] transition hover:brightness-105 disabled:opacity-60">{isSubmitting ? "Please wait…" : "Create Account"}<ArrowRight size={23} /></button>
    </form>
    <AuthDivider label="or sign up with" />
    <GoogleButton onClick={signInWithGoogle} />
    <p className="mt-5 text-center text-sm text-[#596687]">Already have an account? <button type="button" onClick={() => switchMode("login")} className="font-semibold text-[#145ed0]">Sign In</button></p>
  </AuthPageFrame>;

  if (mode === "reset") return <AuthPageFrame reduceMotion={reduceMotion}>
    <button type="button" onClick={() => switchMode("login")} aria-label="Back to sign in" className="absolute left-0 top-1 flex size-12 items-center justify-center rounded-full bg-white/90 text-[#123d9e] shadow-sm"><ArrowLeft size={23} /></button>
    <BrandMark />
    <h1 className="mt-5 text-center text-[2.4rem] font-extrabold tracking-tight text-[#101a58]">Forgot Password?</h1>
    <p className="mt-2 text-center text-base leading-snug text-[#667092]">Don&apos;t worry! Enter your email address<br />and we&apos;ll send you a reset link.</p>
    <ResetIllustration />
    <form onSubmit={handleSubmit(submit)} className="space-y-3.5" noValidate>
      <label className={authFieldClass}><Mail size={22} /><input {...register("email")} type="email" autoComplete="email" inputMode="email" placeholder="Email Address" aria-label="Email address" aria-invalid={Boolean(errors.email)} className="min-w-0 flex-1 bg-transparent text-base text-[#17265c] outline-none placeholder:text-[#939cb4]" /></label>
      {errors.email && <p role="alert" className="px-2 text-xs text-rose-600">{errors.email.message}</p>}
      {errorMessage && <p role="alert" className="rounded-xl bg-rose-500/10 p-3 text-sm text-rose-700">{errorMessage}</p>}
      {successMessage && <p role="status" className="rounded-xl bg-emerald-500/10 p-3 text-sm text-emerald-700">{successMessage}</p>}
      <button type="submit" disabled={isSubmitting} className="flex w-full items-center justify-center gap-3 rounded-[1.15rem] bg-gradient-to-r from-[#1769d2] to-[#2365ce] px-5 py-4 text-lg font-bold text-white shadow-[0_8px_18px_rgba(28,94,201,.2)] transition hover:brightness-105 disabled:opacity-60">{isSubmitting ? "Please wait…" : "Send Reset Link"}<ArrowRight size={23} /></button>
    </form>
    <AuthDivider label="or" />
    <GoogleButton onClick={signInWithGoogle} />
    <p className="mt-6 text-center text-sm text-[#596687]">Remember your password? <button type="button" onClick={() => switchMode("login")} className="font-semibold text-[#145ed0]">Sign In</button></p>
  </AuthPageFrame>;

  return <main className="relative min-h-dvh overflow-x-hidden bg-white px-5 pb-[calc(env(safe-area-inset-bottom)+1.5rem)] pt-[calc(env(safe-area-inset-top)+1.25rem)] text-[#17265c] sm:px-8">
    <div aria-hidden="true" className="pointer-events-none absolute -left-32 -top-36 size-80 rounded-full bg-[#e5efff] sm:-left-44 sm:-top-48 sm:size-[32rem]" />
    <div aria-hidden="true" className="pointer-events-none absolute -right-40 top-[18rem] size-72 rounded-full bg-[#f0f5ff] sm:-right-52 sm:size-[27rem]" />
    <svg aria-hidden="true" className="pointer-events-none absolute inset-x-0 bottom-0 h-32 w-full text-[#dceaff] sm:h-40" viewBox="0 0 390 120" preserveAspectRatio="none"><path fill="currentColor" d="M0 34C57 3 91 45 151 53c71 10 132-1 239-45v112H0Z" /></svg>
    <motion.section className="relative z-10 mx-auto flex w-full max-w-[28rem] flex-col" initial={reduceMotion ? false : { opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: reduceMotion ? 0 : 0.2 }}>
      <header className="pt-2 text-center">
        <div className="relative mx-auto flex size-[4.5rem] items-center justify-center rounded-[1.35rem] bg-gradient-to-br from-[#168be0] to-[#0757bb] text-white shadow-[0_12px_24px_rgba(20,104,205,.22)]"><Wallet size={37} strokeWidth={2.3} /><span className="absolute right-0 top-7 size-4 rounded-full border-2 border-white bg-[#ffc843]" /></div>
        <h1 className="mt-3 text-[3.2rem] font-extrabold leading-none tracking-[-0.055em] text-[#11195c]">diwa</h1>
        <p className="mt-2 text-lg font-semibold tracking-tight text-[#122757] sm:text-xl">Satu Tempat, Semua Saldo</p>
      </header>

      <WalletPreview />
      <p className="mx-auto -mt-1 max-w-[25rem] text-center text-[1.05rem] font-semibold leading-snug text-[#46527f] sm:text-xl">Kelola semua rekening dan e-wallet Anda dengan mudah</p>

      <div className="mt-6 sm:mt-8">
        <h2 className="sr-only">Masuk ke diwa</h2>
        <div className="mb-4 grid grid-cols-2 rounded-xl bg-[#edf2fc] p-1 text-sm font-semibold"><button type="button" aria-pressed={loginMethod === "email"} onClick={() => selectLoginMethod("email")} className={`rounded-lg px-3 py-2.5 transition ${loginMethod === "email" ? "bg-white text-[#174b9c] shadow-sm" : "text-[#647092]"}`}>Email &amp; password</button><button type="button" aria-pressed={loginMethod === "phone"} onClick={() => selectLoginMethod("phone")} className={`rounded-lg px-3 py-2.5 transition ${loginMethod === "phone" ? "bg-white text-[#174b9c] shadow-sm" : "text-[#647092]"}`}>Phone number</button></div>
        {loginMethod === "email" && <form onSubmit={handleSubmit(submit)} className="space-y-3.5" noValidate>
          <label className="flex h-[3.7rem] items-center gap-4 rounded-2xl border border-[#d9deed] bg-[#f5f7fc] px-4 text-[#66718e] shadow-[inset_0_1px_2px_rgba(31,56,105,.03)]"><Mail aria-hidden="true" size={22} /><input {...register("email")} type="email" autoComplete="email" inputMode="email" placeholder="Email Anda" aria-label="Email" aria-invalid={Boolean(errors.email)} className="min-w-0 flex-1 bg-transparent text-base text-[#17265c] outline-none placeholder:text-[#939cb4]" /></label>
          {errors.email && <p role="alert" className="px-2 text-xs text-rose-600">{errors.email.message}</p>}
          <label className="flex h-[3.7rem] items-center gap-4 rounded-2xl border border-[#d9deed] bg-[#f5f7fc] px-4 text-[#66718e] shadow-[inset_0_1px_2px_rgba(31,56,105,.03)]"><LockKeyhole aria-hidden="true" size={22} /><input {...register("password")} type={showPassword ? "text" : "password"} autoComplete={"current-password"} placeholder="Password" aria-label="Password" aria-invalid={Boolean(errors.password)} className="min-w-0 flex-1 bg-transparent text-base text-[#17265c] outline-none placeholder:text-[#939cb4]" /><button type="button" onClick={() => setShowPassword((visible) => !visible)} className="shrink-0 text-[#637092]" aria-label={showPassword ? "Hide password" : "Show password"}>{showPassword ? <Eye size={21} /> : <EyeOff size={21} />}</button></label>
          {errors.password && <p role="alert" className="px-2 text-xs text-rose-600">{errors.password.message}</p>}
          {errorMessage && <p role="alert" className="rounded-xl bg-rose-500/10 p-3 text-sm text-rose-700">{errorMessage}</p>}
          {successMessage && <p role="status" className="rounded-xl bg-emerald-500/10 p-3 text-sm text-emerald-700">{successMessage}</p>}
          <button type="submit" disabled={isSubmitting} className="w-full rounded-[1.15rem] bg-gradient-to-r from-[#1769d2] to-[#2365ce] px-5 py-4 text-lg font-bold text-white shadow-[0_8px_18px_rgba(28,94,201,.2)] transition hover:brightness-105 disabled:opacity-60">{isSubmitting ? "Mohon tunggu…" : "Masuk"}</button>
        </form>}
        {loginMethod === "phone" && <div className="space-y-3.5">
          {!phoneConfirmation ? <>
            <label className={authFieldClass}><Mail aria-hidden="true" size={22} /><input type="tel" autoComplete="tel" inputMode="tel" value={phoneNumber} onChange={(event) => setPhoneNumber(event.target.value)} placeholder="+62 812 3456 7890" aria-label="Phone number" className="min-w-0 flex-1 bg-transparent text-base text-[#17265c] outline-none placeholder:text-[#939cb4]" /></label>
            <p className="px-1 text-xs leading-relaxed text-[#75809a]">We’ll text you a one-time code. Standard SMS rates may apply. Google/Firebase processes phone numbers for verification and abuse prevention.</p>
            <button type="button" onClick={() => void sendPhoneCode()} disabled={isSendingCode} className="w-full rounded-[1.15rem] bg-gradient-to-r from-[#1769d2] to-[#2365ce] px-5 py-4 text-lg font-bold text-white shadow-[0_8px_18px_rgba(28,94,201,.2)] disabled:opacity-60">{isSendingCode ? "Sending code…" : "Send SMS code"}</button>
          </> : <>
            <label className={authFieldClass}><LockKeyhole aria-hidden="true" size={22} /><input type="text" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={verificationCode} onChange={(event) => setVerificationCode(event.target.value.replace(/\D/g, "").slice(0, 6))} placeholder="6-digit code" aria-label="SMS verification code" className="min-w-0 flex-1 bg-transparent text-base tracking-[0.3em] text-[#17265c] outline-none placeholder:tracking-normal placeholder:text-[#939cb4]" /></label>
            <button type="button" onClick={() => void verifyPhoneCode()} disabled={isVerifyingCode} className="w-full rounded-[1.15rem] bg-gradient-to-r from-[#1769d2] to-[#2365ce] px-5 py-4 text-lg font-bold text-white shadow-[0_8px_18px_rgba(28,94,201,.2)] disabled:opacity-60">{isVerifyingCode ? "Verifying…" : "Verify and continue"}</button>
            <div className="flex justify-between px-1 text-xs"><button type="button" onClick={() => { setPhoneConfirmation(null); setVerificationCode(""); setSuccessMessage(""); }} className="font-medium text-[#647092]">Change phone number</button><button type="button" onClick={() => void sendPhoneCode()} disabled={isSendingCode} className="font-semibold text-[#145ed0]">Resend code</button></div>
          </>}
          {errorMessage && <p role="alert" className="rounded-xl bg-rose-500/10 p-3 text-sm text-rose-700">{errorMessage}</p>}
          {successMessage && <p role="status" className="rounded-xl bg-emerald-500/10 p-3 text-sm text-emerald-700">{successMessage}</p>}
          <div id="diwa-phone-recaptcha" className="min-h-px" />
        </div>}
        <>
          <div className="my-4 flex items-center gap-4 text-sm font-medium text-[#647092]"><span className="h-px flex-1 bg-[#d9deed]" />atau<span className="h-px flex-1 bg-[#d9deed]" /></div>
          <button type="button" onClick={signInWithGoogle} className="flex h-[3.5rem] w-full items-center justify-center gap-3 rounded-2xl border border-[#d4daea] bg-white text-base font-medium text-[#29345f] transition hover:bg-[#f8faff]"><GoogleMark />Lanjut dengan Google</button>
        </>
        <div className="mt-5 flex flex-wrap items-center justify-center gap-x-2 gap-y-2 text-sm text-[#46527f]">
          <><span>Belum punya akun?</span><button type="button" onClick={() => switchMode("register")} className="font-semibold text-[#145ed0]">Daftar Sekarang</button><button type="button" onClick={() => switchMode("reset")} className="w-full pt-1 text-xs text-[#637092] hover:text-[#145ed0]">Lupa password?</button></>
        </div>
      </div>
    </motion.section>
  </main>;
}

function AuthPageFrame({ children, reduceMotion }: { children: ReactNode; reduceMotion: boolean | null }) {
  return <main className="relative min-h-dvh overflow-x-hidden bg-white px-5 pb-[calc(env(safe-area-inset-bottom)+1.5rem)] pt-[calc(env(safe-area-inset-top)+1.25rem)] text-[#17265c] sm:px-8">
    <div aria-hidden="true" className="pointer-events-none absolute -left-32 -top-36 size-80 rounded-full bg-[#e5efff] sm:-left-44 sm:-top-48 sm:size-[32rem]" />
    <div aria-hidden="true" className="pointer-events-none absolute -right-40 top-[18rem] size-72 rounded-full bg-[#f0f5ff] sm:-right-52 sm:size-[27rem]" />
    <svg aria-hidden="true" className="pointer-events-none absolute inset-x-0 bottom-0 h-32 w-full text-[#dceaff] sm:h-40" viewBox="0 0 390 120" preserveAspectRatio="none"><path fill="currentColor" d="M0 34C57 3 91 45 151 53c71 10 132-1 239-45v112H0Z" /></svg>
    <motion.section className="relative z-10 mx-auto flex w-full max-w-[28rem] flex-col" initial={reduceMotion ? false : { opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: reduceMotion ? 0 : 0.2 }}>{children}</motion.section>
  </main>;
}

function BrandMark({ compact = false }: { compact?: boolean }) {
  return <div className={`text-center ${compact ? "mt-1" : "mt-7"}`}>
    <div className="relative mx-auto flex size-[4.5rem] items-center justify-center rounded-[1.35rem] bg-gradient-to-br from-[#168be0] to-[#0757bb] text-white shadow-[0_12px_24px_rgba(20,104,205,.22)]"><Wallet size={37} strokeWidth={2.3} /><span className="absolute right-0 top-7 size-4 rounded-full border-2 border-white bg-[#ffc843]" /></div>
    <p className={`${compact ? "mt-2 text-3xl" : "mt-3 text-[2.8rem]"} font-extrabold leading-none tracking-[-0.055em] text-[#11195c]`}>diwa</p>
  </div>;
}

function AuthDivider({ label }: { label: string }) {
  return <div className="my-4 flex items-center gap-4 text-sm font-medium text-[#647092]"><span className="h-px flex-1 bg-[#d9deed]" />{label}<span className="h-px flex-1 bg-[#d9deed]" /></div>;
}

function GoogleButton({ onClick }: { onClick: () => void }) {
  return <button type="button" onClick={onClick} className="flex h-[3.5rem] w-full items-center justify-center gap-3 rounded-2xl border border-[#d4daea] bg-white text-base font-medium text-[#29345f] transition hover:bg-[#f8faff]"><GoogleMark />Continue with Google</button>;
}

function SignupIllustration() {
  return <div role="img" aria-label="Illustration of growing wallet activity" className="relative mx-auto my-2 flex h-[10.5rem] w-full max-w-[22rem] items-center justify-center sm:my-3 sm:h-[12rem]">
    <div className="absolute bottom-3 left-1/2 h-32 w-[19rem] -translate-x-1/2 rounded-[48%] bg-[#edf4ff]" />
    <div className="relative mt-5 flex h-[8.2rem] w-[13.5rem] -rotate-3 items-end justify-center overflow-hidden rounded-t-[1.6rem] border-[6px] border-b-0 border-[#2a5a9d] bg-white px-5 pb-3 shadow-[8px_5px_0_#9dc0f0] sm:h-[9.5rem] sm:w-[15rem]">
      <div className="absolute inset-x-0 top-0 h-4 bg-[#b8d5ff]" /><ChartNoAxesCombined className="mb-1 text-[#4388ef]" size={100} strokeWidth={1.8} />
    </div>
    <div className="absolute bottom-4 right-[8%] flex h-[6.5rem] w-12 flex-col gap-2 rounded-lg border border-[#dce8fb] bg-white p-2 shadow-md"><span className="h-1.5 w-7 rounded bg-[#68a2fa]" /><span className="h-1 w-8 rounded bg-[#d8e6fb]" /><span className="h-1 w-6 rounded bg-[#d8e6fb]" /><span className="h-1 w-8 rounded bg-[#d8e6fb]" /><span className="h-1 w-5 rounded bg-[#d8e6fb]" /></div>
    <span className="absolute bottom-14 left-[7%] flex size-12 items-center justify-center rounded-full bg-emerald-400 text-white shadow-lg"><ArrowRight className="-rotate-90" size={25} strokeWidth={3} /></span>
    <span className="absolute bottom-2 left-[16%] flex size-9 items-center justify-center rounded-full bg-rose-400 text-white shadow-lg"><ArrowRight className="rotate-90" size={22} strokeWidth={3} /></span>
    <span aria-hidden="true" className="absolute left-[28%] top-4 text-lg text-[#a9caff]">✦</span><span aria-hidden="true" className="absolute right-[16%] top-2 text-xl text-[#a9caff]">✦</span>
  </div>;
}

function ResetIllustration() {
  return <div role="img" aria-label="Password reset message in a blue envelope" className="relative mx-auto my-3 flex h-[13.5rem] w-full max-w-[22rem] items-center justify-center sm:my-5 sm:h-[15rem]">
    <div className="absolute inset-x-4 bottom-2 h-36 rounded-[50%] bg-[#edf4ff]" />
    <svg className="relative z-10 h-full w-full drop-shadow-[0_12px_14px_rgba(44,104,185,.16)]" viewBox="0 0 340 220" fill="none" aria-hidden="true">
      <path d="M55 91 148 22a37 37 0 0 1 44 0l94 69v91H55V91Z" fill="#1688df" />
      <path d="M82 67h176a14 14 0 0 1 14 14v91H68V81a14 14 0 0 1 14-14Z" fill="#F8FBFF" />
      <path d="M141 118a18 18 0 1 1 36 0v12h-36v-12Z" stroke="#2584E8" strokeWidth="8" />
      <rect x="136" y="125" width="46" height="37" rx="9" fill="#2584E8" />
      <path d="m55 91 115 83L55 202V91Z" fill="#1595F1" />
      <path d="m285 91-115 83 115 28V91Z" fill="#0875CD" />
      <path d="m55 202 115-82 115 82H55Z" fill="#57B3FF" />
      <path d="m276 51 47-17-25 43-5-17-17-9Z" fill="#388BF1" />
      <path d="M294 76c2 23-7 35-20 44" stroke="#9BC5FF" strokeWidth="3" strokeDasharray="6 7" />
    </svg>
    <span aria-hidden="true" className="absolute left-[12%] top-9 h-7 w-1.5 rotate-[-45deg] rounded-full bg-amber-400" />
    <span aria-hidden="true" className="absolute left-[8%] top-16 h-7 w-1.5 rotate-[-75deg] rounded-full bg-amber-400" />
  </div>;
}

function WalletPreview() {
  return <div role="img" aria-label="Preview saldo dan beberapa rekening" className="relative mx-auto my-5 h-[15.7rem] w-full max-w-[24rem] sm:my-6 sm:h-[17.5rem]">
    <div aria-hidden="true" className="absolute bottom-4 left-1/2 h-40 w-[18rem] -translate-x-1/2 rounded-[48%] bg-[#e8f1ff]" />
    <div className="absolute left-1/2 top-1 h-[15rem] w-[12.2rem] -translate-x-1/2 rotate-[-7deg] rounded-[2rem] border-[7px] border-[#255591] bg-white p-3.5 shadow-[8px_10px_0_#8db6ee] sm:top-0 sm:h-[16.5rem] sm:w-[13.5rem]">
      <div className="mx-auto mb-3 h-1.5 w-12 rounded-full bg-[#254b83]" />
      <p className="text-[10px] font-semibold italic text-[#34517e]">Total saldo</p><p className="mt-1 text-lg font-extrabold tracking-tight text-[#173c79]">Rp 12.750.000</p>
      <div className="mt-3 space-y-2.5">
        <PreviewAccount icon={<Landmark size={15} />} label="Bank Mandiri" balance="Rp 5.000.000" tone="bg-[#123b72] text-amber-300" />
        <PreviewAccount icon={<Wallet size={15} />} label="BCA" balance="Rp 4.250.000" tone="bg-[#1388df] text-white" />
        <PreviewAccount icon={<ArrowDownLeft size={15} />} label="DANA" balance="Rp 2.000.000" tone="bg-sky-500 text-white" />
      </div>
    </div>
    <span aria-hidden="true" className="absolute right-[14%] top-5 h-8 w-1.5 rotate-45 rounded-full bg-amber-400" />
    <span aria-hidden="true" className="absolute right-[10%] top-12 h-8 w-1.5 rotate-[75deg] rounded-full bg-amber-400" />
  </div>;
}

function PreviewAccount({ icon, label, balance, tone }: { icon: ReactNode; label: string; balance: string; tone: string }) {
  return <div className="flex items-center gap-2"><span className={`flex size-7 shrink-0 items-center justify-center rounded-lg ${tone}`}>{icon}</span><span className="min-w-0"><span className="block truncate text-[9px] font-semibold text-[#34517e]">{label}</span><span className="block text-[10px] font-medium text-[#34517e]">{balance}</span></span></div>;
}

function GoogleMark() {
  return <svg aria-hidden="true" viewBox="0 0 48 48" className="size-6"><path fill="#4285F4" d="M43.6 24.5c0-1.4-.1-2.8-.4-4.1H24v7.8h11a9.4 9.4 0 0 1-4.1 6.2v5.1h6.6c3.9-3.6 6.1-8.9 6.1-15Z" /><path fill="#34A853" d="M24 44c5.5 0 10.1-1.8 13.5-4.8l-6.6-5.1c-1.8 1.2-4.1 2-6.9 2-5.3 0-9.8-3.6-11.4-8.4H5.8v5.3A20 20 0 0 0 24 44Z" /><path fill="#FBBC05" d="M12.6 27.7a12 12 0 0 1 0-7.4V15H5.8a20 20 0 0 0 0 18l6.8-5.3Z" /><path fill="#EA4335" d="M24 11.9c3 0 5.7 1 7.8 3.1l5.8-5.8C34.1 5.9 29.5 4 24 4A20 20 0 0 0 5.8 15l6.8 5.3c1.6-4.8 6.1-8.4 11.4-8.4Z" /></svg>;
}
