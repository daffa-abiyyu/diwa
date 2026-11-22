# diwa — Digital Wallet

diwa is a responsive wallet and expense tracker built with Next.js, Tailwind CSS, and Firebase. It keeps the original blue palette, light/dark themes, bold card outlines, desktop sidebar, iPhone bottom navigation, and edge-to-edge PWA layout.

## Product requirements

- Track balances across multiple bank, e-wallet, cash, and custom accounts.
- Record income, expenses, and internal transfers without counting transfers as income or expenses.
- Search and filter transactions by type, account, category, date, and amount; edit or delete from transaction details.
- Review and correct receipt OCR results before saving a transaction; keep the receipt image available across devices.
- Work offline, sync across devices after sign-in, and let the user choose a local or cloud version when edits conflict.
- Keep data private to the signed-in Firebase UID and allow English as the default language.
- Preserve the existing colors, theme behavior, safe areas, and iPhone PWA status-bar treatment.

## Implemented in this iteration

- Added the requested React Hook Form, Zod, Zustand, Motion, date-fns, clsx, and tailwind-merge packages, plus Firebase, Dexie, and Tesseract.js.
- Added email/password and Google Firebase Authentication, password reset, Firebase client configuration, and UID-scoped Firestore/Storage rules.
- Added a Dexie IndexedDB model, offline outbox, Firestore synchronization for accounts and transactions, and local/cloud conflict choices in Settings.
- Added on-device OCR for English and Indonesian receipt photos. Detected amounts and dates populate the form for review; receipt images are queued locally and uploaded to Firebase Storage when online.
- Bundled Outfit and JetBrains Mono locally so production builds do not need to fetch fonts from Google.
- Updated app metadata to use the name diwa and retained the existing visual design.
- English is the selected default; the auth and transaction flows are English, while some dashboard and account copy still needs localization.

## Firebase setup

Copy the keys from `.env.example` into an untracked `.env.local` using the Firebase web app values. Enable Email/Password and Google providers in Firebase Authentication, configure the authorized domains for web and PWA sign-in, and deploy `firestore.rules` and `storage.rules` to the same Firebase project. Restart the development server after changing environment values. Never commit `.env.local` or paste credentials into chat.

The Firebase connection and deployed rules still need to be checked against your project. OCR text recognition runs locally in the browser; the source receipt image is retained in IndexedDB until it uploads to Firebase Storage. OCR language data may need to download on first use, so first-time scanning requires a connection.

Existing legacy data under the old unscoped `diwa-wallet-v1` localStorage key is left untouched. It is not imported automatically because the old prototype mixed demo records with user-entered data; a review-and-select migration screen remains to be built.

## Run locally

```bash
npm run dev
```

Open `http://localhost:3000`. Installing the PWA requires HTTPS. For iPhone edge-to-edge status-bar behavior, add the site to the Home Screen and open it in standalone mode.

## Current verification

- `npm run lint` — passed.
- `tsc --noEmit` — passed.
- `npm run build` — passed with Next.js 16.4.6 and self-hosted fonts.
- Firebase sync, deployed security rules, real-device PWA behavior, OCR accuracy, and migration flow still need project/device verification.
