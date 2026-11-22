export type ReceiptOcrResult = {
  text: string;
  amount?: number;
  date?: string;
};

export async function readReceipt(file: File, onProgress: (progress: number) => void): Promise<ReceiptOcrResult> {
  const { createWorker } = await import("tesseract.js");
  const worker = await createWorker("eng+ind", undefined, {
    logger: (message) => {
      if (message.status === "recognizing text") onProgress(message.progress);
    },
  });
  try {
    const { data } = await worker.recognize(file);
    const text = data.text;
    const amountMatches = [...text.matchAll(/(?:rp\.?\s*)?([\d.,]{4,})/gi)]
      .map((match) => Number(match[1].replace(/[.,]/g, "")))
      .filter((amount) => Number.isSafeInteger(amount) && amount > 0);
    const dateMatch = text.match(/\b(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})\b/);
    let date: string | undefined;
    if (dateMatch) {
      const [, day, month, rawYear] = dateMatch;
      const year = rawYear.length === 2 ? `20${rawYear}` : rawYear;
      const candidate = `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
      if (!Number.isNaN(Date.parse(`${candidate}T00:00:00`))) date = candidate;
    }
    return { text, amount: amountMatches.length ? Math.max(...amountMatches) : undefined, date };
  } finally {
    await worker.terminate();
  }
}
