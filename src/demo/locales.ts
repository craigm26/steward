// The scale run: translating the invoice queue's labels. Scripted agents write known variants, so the run shows
// throughput, not model quality, and is labeled scripted everywhere it appears.

export const LABELS = ["title", "pay", "hold", "invoice", "vendor", "amount", "decision", "held_note"] as const;

// Short, plain translations of locales/en.json, one row per language.
export const LANGUAGES: { code: string; name: string; labels: string[] }[] = [
	{ code: "fr", name: "French", labels: ["Factures à payer", "Payer", "Bloquer", "Facture", "Fournisseur", "Montant", "Décision", "en attente de vérification"] },
	{ code: "es", name: "Spanish", labels: ["Facturas por pagar", "Pagar", "Retener", "Factura", "Proveedor", "Importe", "Decisión", "retenidas para revisión"] },
	{ code: "de", name: "German", labels: ["Zu zahlende Rechnungen", "Zahlen", "Zurückhalten", "Rechnung", "Lieferant", "Betrag", "Entscheidung", "zur Prüfung zurückgehalten"] },
	{ code: "it", name: "Italian", labels: ["Fatture da pagare", "Paga", "Trattieni", "Fattura", "Fornitore", "Importo", "Decisione", "trattenute per una verifica"] },
	{ code: "pt", name: "Portuguese", labels: ["Faturas a pagar", "Pagar", "Reter", "Fatura", "Fornecedor", "Valor", "Decisão", "retidas para análise"] },
	{ code: "nl", name: "Dutch", labels: ["Te betalen facturen", "Betalen", "Vasthouden", "Factuur", "Leverancier", "Bedrag", "Beslissing", "vastgehouden voor controle"] },
	{ code: "sv", name: "Swedish", labels: ["Fakturor att betala", "Betala", "Håll inne", "Faktura", "Leverantör", "Belopp", "Beslut", "hålls inne för granskning"] },
	{ code: "da", name: "Danish", labels: ["Fakturaer til betaling", "Betal", "Tilbagehold", "Faktura", "Leverandør", "Beløb", "Beslutning", "tilbageholdt til kontrol"] },
	{ code: "nb", name: "Norwegian", labels: ["Fakturaer til betaling", "Betal", "Hold tilbake", "Faktura", "Leverandør", "Beløp", "Beslutning", "holdt tilbake for kontroll"] },
	{ code: "fi", name: "Finnish", labels: ["Maksettavat laskut", "Maksa", "Pidätä", "Lasku", "Toimittaja", "Summa", "Päätös", "pidätetty tarkistettavaksi"] },
	{ code: "pl", name: "Polish", labels: ["Faktury do zapłaty", "Zapłać", "Wstrzymaj", "Faktura", "Dostawca", "Kwota", "Decyzja", "wstrzymane do sprawdzenia"] },
	{ code: "cs", name: "Czech", labels: ["Faktury k úhradě", "Zaplatit", "Pozdržet", "Faktura", "Dodavatel", "Částka", "Rozhodnutí", "pozdrženo ke kontrole"] },
	{ code: "tr", name: "Turkish", labels: ["Ödenecek faturalar", "Öde", "Beklet", "Fatura", "Tedarikçi", "Tutar", "Karar", "inceleme için bekletiliyor"] },
	{ code: "ja", name: "Japanese", labels: ["支払う請求書", "支払う", "保留", "請求書", "仕入先", "金額", "判断", "確認のため保留中"] },
	{ code: "ko", name: "Korean", labels: ["지급할 송장", "지급", "보류", "송장", "공급업체", "금액", "결정", "검토를 위해 보류됨"] },
	{ code: "zh", name: "Chinese", labels: ["待付发票", "付款", "暂缓", "发票", "供应商", "金额", "决定", "暂缓待人工核查"] },
	{ code: "hi", name: "Hindi", labels: ["भुगतान के लिए बिल", "भुगतान करें", "रोकें", "बिल", "विक्रेता", "राशि", "निर्णय", "जांच के लिए रोके गए"] },
	{ code: "vi", name: "Vietnamese", labels: ["Hóa đơn cần thanh toán", "Thanh toán", "Tạm giữ", "Hóa đơn", "Nhà cung cấp", "Số tiền", "Quyết định", "tạm giữ để kiểm tra"] },
	{ code: "id", name: "Indonesian", labels: ["Faktur yang harus dibayar", "Bayar", "Tahan", "Faktur", "Pemasok", "Jumlah", "Keputusan", "ditahan untuk diperiksa"] },
	{ code: "el", name: "Greek", labels: ["Τιμολόγια προς πληρωμή", "Πληρωμή", "Αναμονή", "Τιμολόγιο", "Προμηθευτής", "Ποσό", "Απόφαση", "σε αναμονή για έλεγχο"] },
];

export type Variant = "good" | "wordy" | "missing" | "empty" | "invalid";

/** The six scripted agents on each translation task, and what each writes: one clean, one wordy, three broken. */
export const SCALE_LINEUP: Variant[] = ["good", "wordy", "missing", "empty", "invalid", "invalid"];

/** A scripted agent's translation file. Broken variants fail the task's file check; the wordy one passes but is long. */
export function translation(code: string, variant: Variant): string {
	const lang = LANGUAGES.find((l) => l.code === code);
	if (!lang) throw new Error(`no language ${code}`);
	const entries: [string, string][] = LABELS.map((k, i) => [k, lang.labels[i]!]);
	if (variant === "wordy") {
		// Every label padded with the page title: still right, twice as long to read.
		const title = lang.labels[0]!;
		for (const e of entries) e[1] = e[0] === "title" ? `${title}: ${lang.labels[7]}` : `${e[1]} (${title})`;
	}
	if (variant === "missing") entries.pop();
	if (variant === "empty") entries[6]![1] = "";
	const body = entries.map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(",\n");
	return variant === "invalid" ? `{\n${body},\n}\n` : `{\n${body}\n}\n`;
}

export function translationTask(code: string) {
	const lang = LANGUAGES.find((l) => l.code === code)!;
	return {
		id: `l-${code}`,
		title: `Translate the invoice queue into ${lang.name}`,
		description: `Add locales/${code}.json with every label of locales/en.json translated into ${lang.name}. Keep the labels short; a clerk reads them at a glance.`,
		path: "locales",
		done: [{ name: `locales/${code}.json has every label, none empty`, kind: "file", file: `locales/${code}.json`, like: "locales/en.json" }],
	};
}
