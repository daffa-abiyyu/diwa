import { z } from "zod";

export const transactionItemSchema = z.object({
  name: z.string().trim().min(1, "Enter an item name."),
  quantity: z.number().int().min(1, "Quantity must be at least 1."),
  unitPrice: z.number().int().min(0, "Unit price cannot be negative."),
});

export const transactionFormSchema = z.object({
  type: z.enum(["expense", "income", "transfer"]),
  amount: z.number().int().positive("Amount must be a positive whole number."),
  title: z.string().trim().optional(),
  account: z.string().min(1, "Choose an account."),
  toAccount: z.string().optional(),
  category: z.string().optional(),
  date: z.iso.date("Enter a valid date."),
  note: z.string().optional(),
  paymentMethod: z.string().optional(),
  items: z.array(transactionItemSchema),
  receiptName: z.string().optional(),
}).superRefine((values, context) => {
  if (values.type !== "transfer" && !values.title?.trim()) {
    context.addIssue({ code: "custom", path: ["title"], message: "Enter a transaction name." });
  }
  if (values.type !== "transfer" && !values.category) {
    context.addIssue({ code: "custom", path: ["category"], message: "Choose a category." });
  }
  if (values.type === "transfer" && (!values.toAccount || values.toAccount === values.account)) {
    context.addIssue({ code: "custom", path: ["toAccount"], message: "Choose a different destination account." });
  }
});

export type TransactionFormValues = z.infer<typeof transactionFormSchema>;

export const accountFormSchema = z.object({
  accountType: z.enum(["Bank", "E-Wallet", "Cash", "Other"]),
  provider: z.string().trim().min(1, "Enter a provider."),
  name: z.string().trim().min(1, "Enter an account name."),
  balance: z.number().finite().min(0, "Balance cannot be negative."),
  openingDate: z.iso.date("Enter a valid date."),
});

export type AccountFormValues = z.infer<typeof accountFormSchema>;
