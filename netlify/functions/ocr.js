const path = require("node:path");
const { createWorker } = require("tesseract.js");

let workerPromise;

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return json(405, { error: "Method not allowed" });
  }

  try {
    const payload = JSON.parse(event.body || "{}");
    const image = typeof payload.image === "string" ? payload.image : "";
    const psm = typeof payload.psm === "string" ? payload.psm : "6";

    if (!image.startsWith("data:image/")) {
      return json(400, { error: "Missing image data URL" });
    }

    const buffer = Buffer.from(image.split(",")[1] || "", "base64");
    if (!buffer.length) {
      return json(400, { error: "Empty image" });
    }

    const worker = await getWorker();
    await worker.setParameters({
      tessedit_pageseg_mode: psm,
      preserve_interword_spaces: "1",
    });
    const result = await worker.recognize(buffer);
    return json(200, { text: cleanup(result.data.text) });
  } catch (error) {
    return json(500, { error: error instanceof Error ? error.message : "OCR failed" });
  }
};

async function getWorker() {
  if (!workerPromise) {
    workerPromise = createWorker("chi_sim+eng", 1, {
      langPath: path.join(__dirname, "tessdata"),
      cacheMethod: "readOnly",
    });
  }
  return workerPromise;
}

function cleanup(text) {
  return String(text || "")
    .replace(/[|]+/g, " ")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
}

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
    },
    body: JSON.stringify(body),
  };
}
