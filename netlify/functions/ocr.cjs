const Busboy = require("busboy");

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return json(204, {});
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });

  const serviceUrl = (process.env.OCR_SERVICE_URL || "").replace(/\/+$/, "");
  if (!serviceUrl) return json(503, { error: "OCR_SERVICE_URL is not configured" });

  try {
    const { fields, file } = await readMultipart(event);
    if (!file) return json(400, { error: "Missing file" });

    const form = new FormData();
    form.set("file", new Blob([file.buffer], { type: file.mimeType || "application/octet-stream" }), file.filename || "upload");
    form.set("mode", fields.mode || "full");
    form.set("doc_type", fields.docType || fields.doc_type || "other");

    const response = await fetch(`${serviceUrl}/ocr`, { method: "POST", body: form });
    const body = await response.text();

    return {
      statusCode: response.status,
      headers: {
        ...corsHeaders(),
        "Content-Type": response.headers.get("content-type") || "application/json; charset=utf-8",
      },
      body,
    };
  } catch (error) {
    return json(500, { error: error instanceof Error ? error.message : "OCR failed" });
  }
};

function readMultipart(event) {
  return new Promise((resolve, reject) => {
    const contentType = event.headers["content-type"] || event.headers["Content-Type"];
    if (!contentType) {
      reject(new Error("Missing content type"));
      return;
    }

    const fields = {};
    let file = null;
    const busboy = Busboy({ headers: { "content-type": contentType } });

    busboy.on("field", (name, value) => {
      fields[name] = value;
    });

    busboy.on("file", (_name, stream, info) => {
      const chunks = [];
      stream.on("data", (chunk) => chunks.push(chunk));
      stream.on("end", () => {
        file = {
          buffer: Buffer.concat(chunks),
          filename: info.filename,
          mimeType: info.mimeType,
        };
      });
    });

    busboy.on("error", reject);
    busboy.on("finish", () => resolve({ fields, file }));
    busboy.end(Buffer.from(event.body || "", event.isBase64Encoded ? "base64" : "utf8"));
  });
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      ...corsHeaders(),
      "Content-Type": "application/json; charset=utf-8",
    },
    body: statusCode === 204 ? "" : JSON.stringify(body),
  };
}
