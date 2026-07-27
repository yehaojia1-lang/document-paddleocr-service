export const runtime = "edge";

type OcrResponse = {
  text?: string;
  pages?: Array<{ index: number; text: string }>;
  engine?: string;
  warning?: string;
  error?: string;
};

export async function POST(request: Request) {
  const serviceUrl = process.env.OCR_SERVICE_URL?.replace(/\/+$/, "");
  if (!serviceUrl) {
    return Response.json({ error: "OCR_SERVICE_URL is not configured" }, { status: 503 });
  }

  const incoming = await request.formData();
  const file = incoming.get("file");
  if (!(file instanceof File)) {
    return Response.json({ error: "Missing file" }, { status: 400 });
  }

  const outgoing = new FormData();
  outgoing.set("file", file, file.name || "upload");
  outgoing.set("mode", String(incoming.get("mode") || "full"));
  outgoing.set("doc_type", String(incoming.get("docType") || "other"));

  const response = await fetch(`${serviceUrl}/ocr`, {
    method: "POST",
    body: outgoing,
  });

  const data = (await response.json().catch(() => ({ error: "OCR service returned invalid JSON" }))) as OcrResponse;
  return Response.json(data, { status: response.status });
}
