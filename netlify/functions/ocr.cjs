const path = require("node:path");
const { createWorker } = require("tesseract.js");

let workerPromise;
const workerPath = require.resolve("tesseract.js/src/worker-script/node/index.js");
const corePath = require.resolve("tesseract.js-core/tesseract-core-lstm.wasm.js");

const ID_LABELS = [
  "\u59d3\u540d",
  "\u6027\u522b",
  "\u6c11\u65cf",
  "\u51fa\u751f",
  "\u4f4f\u5740",
  "\u516c\u6c11\u8eab\u4efd\u53f7\u7801",
  "\u5c45\u6c11\u8eab\u4efd\u8bc1",
];
const ADDRESS_CHARS = ["\u7701", "\u5e02", "\u533a", "\u53bf", "\u9547", "\u8def", "\u53f7", "\u5e74", "\u6708", "\u65e5"];
const NO_RELIABLE_TEXT = "\u6ca1\u6709\u8bc6\u522b\u5230\u53ef\u9760\u6587\u5b57\uff0c\u8bf7\u4e0a\u4f20\u66f4\u6e05\u6670\u3001\u8bc1\u4ef6\u5360\u753b\u9762\u66f4\u5927\u7684\u539f\u56fe\u3002";
const NO_MODEL_TEXT = "\u6a21\u578b\u6ca1\u6709\u8bc6\u522b\u5230\u6587\u5b57\uff0c\u8bf7\u4e0a\u4f20\u66f4\u6e05\u6670\u3001\u8bc1\u4ef6\u5360\u753b\u9762\u66f4\u5927\u7684\u539f\u56fe\u3002";

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return json(405, { error: "Method not allowed" });
  }

  try {
    const payload = JSON.parse(event.body || "{}");
    const mode = payload.mode === "id" ? "id" : "full";
    const images = normalizeImages(payload);

    if (!images.length) {
      return json(400, { error: "Missing image data URL" });
    }

    if (process.env.OPENAI_API_KEY) {
      const result = await runOpenAiOcr(images, mode);
      return json(200, result);
    }

    const worker = await getWorker();
    const result = await recognizeBest(worker, images, mode);
    return json(200, result);
  } catch (error) {
    return json(500, { error: error instanceof Error ? error.message : "OCR failed" });
  }
};

function normalizeImages(payload) {
  if (Array.isArray(payload.images)) {
    return payload.images
      .map((item) => ({
        rotation: Number(item.rotation) || 0,
        image: typeof item.image === "string" ? item.image : "",
      }))
      .filter((item) => item.image.startsWith("data:image/"));
  }

  const image = typeof payload.image === "string" ? payload.image : "";
  return image.startsWith("data:image/") ? [{ rotation: 0, image }] : [];
}

async function runOpenAiOcr(images, mode) {
  const content = [
    {
      type: "text",
      text: [
        "You are a professional document OCR assistant.",
        "Extract all visible text from the document image. Do not translate, explain, or invent unclear content.",
        "If this is a Chinese Resident Identity Card, extract the original Chinese fields: document title, name, sex, ethnicity, date of birth, full address, and citizen identity number.",
        "Preserve the full address exactly as visible, including province, city, district/county, street, building, room, and number when present.",
        mode === "id" ? "Mode: prioritize Chinese identity card OCR." : "Mode: complete full-image OCR.",
      ].join("\n"),
    },
  ];

  for (const item of images.slice(0, 4)) {
    content.push({
      type: "image_url",
      image_url: { url: item.image, detail: "high" },
    });
  }

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: process.env.OPENAI_OCR_MODEL || process.env.OPENAI_MODEL || "gpt-4.1-mini",
      temperature: 0,
      messages: [{ role: "user", content }],
    }),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error?.message || "OpenAI OCR failed");
  }

  const text = cleanup(data.choices?.[0]?.message?.content || "");
  return {
    text,
    score: scoreText(text, mode),
    rotation: 0,
    variant: "openai-vision",
    warning: text ? null : NO_MODEL_TEXT,
  };
}

async function getWorker() {
  if (!workerPromise) {
    workerPromise = createWorker("chi_sim+eng", 1, {
      workerPath,
      corePath,
      langPath: path.join(__dirname, "tessdata"),
      cacheMethod: "readOnly",
    });
  }
  return workerPromise;
}

async function recognizeBest(worker, images, mode) {
  let best = { text: "", score: -Infinity, rotation: 0, variant: "normal" };
  const psmModes = mode === "id" ? ["6", "11"] : ["6"];

  for (const item of images) {
    const input = dataUrlToBuffer(item.image);
    if (!input.length) continue;

    for (const psm of psmModes) {
      await worker.setParameters({
        tessedit_pageseg_mode: psm,
        preserve_interword_spaces: "1",
        user_defined_dpi: "300",
      });

      const result = await worker.recognize(input);
      const text = cleanup(result.data.text);
      const score = scoreText(text, mode);
      if (score > best.score) {
        best = { text, score, rotation: item.rotation, variant: `psm-${psm}` };
      }
      if (score >= (mode === "id" ? 135 : 100)) break;
    }
  }

  const reliable = best.score >= (mode === "id" ? 28 : 18);
  return {
    text: reliable ? best.text : "",
    score: best.score,
    rotation: best.rotation,
    variant: best.variant,
    warning: reliable ? null : NO_RELIABLE_TEXT,
  };
}

function dataUrlToBuffer(image) {
  return Buffer.from(image.split(",")[1] || "", "base64");
}

function scoreText(text, mode) {
  if (!text) return -100;

  const chinese = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  const digits = (text.match(/\d/g) || []).length;
  const idNumber = /\d{17}[\dXx]|\d{15}/.test(text) ? 55 : 0;
  const labels = ID_LABELS.reduce((sum, label) => sum + (text.includes(label) ? 18 : 0), 0);
  const address = ADDRESS_CHARS.reduce((sum, label) => sum + (text.includes(label) ? 4 : 0), 0);
  const mojibake = (text.match(/[A-Za-z]{5,}|[|_~`^\\{}[\]<>]/g) || []).length;
  const brokenRuns = (text.match(/[^\u4e00-\u9fff\d\s:：,，.。()（）/-]{3,}/g) || []).length;
  const shortPenalty = text.length < 8 ? 35 : 0;
  const idBonus = mode === "id" ? idNumber + labels + address : 0;

  return chinese * 2 + Math.min(digits, 30) + idBonus - mojibake * 6 - brokenRuns * 8 - shortPenalty;
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
