import { pinyin } from "pinyin-pro";

type Direction = "en-to-zh" | "zh-to-en";
type Provider = "auto" | "openai" | "deepseek" | "offline";

type FieldResult = {
  label: string;
  source: string;
  translation: string;
};

type ParsedField = {
  label: string;
  value: string;
};

const systemRules = `You are a professional certified document translator.
Rules:
- Translate content only. Do not reproduce Word layout, tables, fonts, borders, or original formatting.
- Translate every visible item. Do not omit labels, numbers, dates, addresses, footers, notes, stamps, signatures, QR/barcode captions, or back-side instructions.
- Use the user's standard template expressions where relevant, especially for graduation certificates, degree certificates, identity cards, and birth certificates.
- Preserve document numbers, ID numbers, license numbers, postal codes, URLs, email addresses, and codes exactly.
- Address order is mandatory: English output uses small-to-large order; Chinese output uses large-to-small order.
- For Chinese-to-English names, default to given name before surname unless the user/source supplies an official spelling.
- For English-to-Chinese names, do not invent Chinese names when no confirmed Chinese name is provided. Keep the English name.
- Dates: use Chinese date format for Chinese output; use Month D, YYYY for English output unless the source is a numeric table-like field.
- Illegible or uncertain content must be marked as 待确认 for Chinese output or illegible for English output. Do not guess.
- Return only JSON with keys: mode, title, summary, fields, polished, notes. fields is an array of {label, source, translation}.`;

export async function POST(request: Request) {
  const payload = await request.json().catch(() => ({}));
  const text = typeof payload.text === "string" ? payload.text : "";
  const direction: Direction = payload.direction === "en-to-zh" ? "en-to-zh" : "zh-to-en";
  const provider = normalizeProvider(payload.provider);
  const docType = typeof payload.docType === "string" ? payload.docType : "other";

  if (!text.trim()) {
    return Response.json(offlineTranslate("", direction, docType, "文本为空"));
  }

  const selected = selectProvider(provider);

  if (selected === "openai" && process.env.OPENAI_API_KEY) {
    const modelResult = await callOpenAI(text, direction, docType).catch(() => null);
    if (modelResult) return Response.json(modelResult);
  }

  if (selected === "deepseek" && process.env.DEEPSEEK_API_KEY) {
    const modelResult = await callDeepSeek(text, direction, docType).catch(() => null);
    if (modelResult) return Response.json(modelResult);
  }

  if (provider === "auto" && process.env.OPENAI_API_KEY) {
    const modelResult = await callOpenAI(text, direction, docType).catch(() => null);
    if (modelResult) return Response.json(modelResult);
  }

  return Response.json(offlineTranslate(text, direction, docType, "未配置模型密钥，已使用离线完整翻译规则"));
}

function normalizeProvider(value: unknown): Provider {
  if (value === "openai" || value === "deepseek" || value === "offline") return value;
  return "auto";
}

function selectProvider(provider: Provider) {
  if (provider === "auto") {
    if (process.env.OPENAI_API_KEY) return "openai";
    if (process.env.DEEPSEEK_API_KEY) return "deepseek";
    return "offline";
  }
  return provider;
}

async function callOpenAI(text: string, direction: Direction, docType: string) {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
      temperature: 0.1,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemRules },
        { role: "user", content: buildPrompt(text, direction, docType, "OpenAI GPT") },
      ],
    }),
  });

  if (!response.ok) return null;
  const data = await response.json();
  return parseModelJson(data?.choices?.[0]?.message?.content, "OpenAI GPT");
}

async function callDeepSeek(text: string, direction: Direction, docType: string) {
  const response = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: process.env.DEEPSEEK_MODEL || "deepseek-chat",
      temperature: 0.1,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemRules },
        { role: "user", content: buildPrompt(text, direction, docType, "DeepSeek") },
      ],
    }),
  });

  if (!response.ok) return null;
  const data = await response.json();
  return parseModelJson(data?.choices?.[0]?.message?.content, "DeepSeek");
}

function buildPrompt(text: string, direction: Direction, docType: string, engine: string) {
  const target = direction === "en-to-zh" ? "Simplified Chinese" : "professional English";

  return `Engine: ${engine}
Document type: ${docType}
Target language: ${target}
Preferred template expressions:
- ${templateExpressions(docType).join("\n- ")}
Source text extracted from OCR/PDF/Word:
${text}`;
}

function parseModelJson(content: unknown, fallbackMode: string) {
  if (typeof content !== "string") return null;
  const parsed = JSON.parse(content);
  return {
    mode: typeof parsed.mode === "string" ? parsed.mode : fallbackMode,
    title: typeof parsed.title === "string" ? parsed.title : "模型专业译文",
    summary: typeof parsed.summary === "string" ? parsed.summary : "已按完整翻译规则生成译文。",
    fields: Array.isArray(parsed.fields) ? parsed.fields : [],
    polished: typeof parsed.polished === "string" ? parsed.polished : "",
    notes: Array.isArray(parsed.notes) ? parsed.notes : ["请复核 OCR 识别的姓名、号码、日期和地址。"],
  };
}

function offlineTranslate(text: string, direction: Direction, docType: string, reason: string) {
  const parsed = parseFields(text, docType);
  const fields = parsed.map((field) => ({
    label: translateLabel(field.label, direction),
    source: field.value,
    translation: translateField(field, direction, docType),
  }));

  return {
    mode: "offline rules",
    title: direction === "zh-to-en" ? "Offline Chinese-to-English Complete Translation" : "离线英译中完整译文",
    summary: `${reason}。离线模式会按字段和模板表达翻译；如果 OCR 原文有错，请先在左侧修正。`,
    fields,
    polished: buildPolished(fields, direction, docType),
    notes:
      direction === "zh-to-en"
        ? ["英文地址按小到大输出，例如：No. 1, Kefa Road, Science and Technology Park, Nanshan District, Shenzhen City, Guangdong Province, China。", "姓名默认名在前、姓在后；若客户提供官方拼写，应以官方拼写为准。", "PDF/Word 已支持可复制文字提取；扫描 PDF 仍需要 OCR 或模型视觉。"]
        : ["中文地址按大到小输出。", "英文人名没有确认中文名时默认保留英文。", "模糊或无法确认内容标注为“待确认”。"],
  };
}

function parseFields(text: string, docType: string): ParsedField[] {
  const normalized = text.replace(/\r/g, "\n").replace(/[ \t]+/g, " ").trim();
  const fields: ParsedField[] = [];

  if (docType === "id-card" || /居民身份证|公民身份号码|Citizen Identity Card/i.test(normalized)) {
    pushIf(fields, "Document Title", normalized.match(/中华人民共和国居民身份证|居民身份证/)?.[0] ?? "中华人民共和国居民身份证");
    pushIf(fields, "Name", findValue(normalized, ["姓名", "Name"]));
    pushIf(fields, "Sex", findValue(normalized, ["性别", "Sex"]));
    pushIf(fields, "Ethnicity", findValue(normalized, ["民族", "Ethnicity"]));
    pushIf(fields, "Date of Birth", findValue(normalized, ["出生", "出生日期", "Date of Birth"]));
    pushIf(fields, "Address", findValue(normalized, ["住址", "地址", "Address"]));
    pushIf(fields, "Citizen ID Number", findValue(normalized, ["公民身份号码", "身份号码", "Citizen ID Number", "ID Number"]));
    return fillFallbackFields(fields, normalized);
  }

  const lines = normalized
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of lines) {
    const match = line.match(/^([^:：|]{1,40})[:：]\s*(.+)$/);
    if (match) {
      fields.push({ label: normalizeLabel(match[1]), value: match[2].trim() });
    } else {
      fields.push({ label: inferLabel(line), value: line });
    }
  }

  return fields.slice(0, 80);
}

function findValue(text: string, labels: string[]) {
  const escaped = labels.map((label) => escapeRegExp(label)).join("|");
  const stopLabels = [
    "姓名",
    "性别",
    "民族",
    "出生",
    "出生日期",
    "住址",
    "地址",
    "公民身份号码",
    "签发机关",
    "有效期限",
    "Name",
    "Sex",
    "Ethnicity",
    "Date of Birth",
    "Address",
    "Citizen ID Number",
    "ID Number",
  ];
  const stops = stopLabels.filter((label) => !labels.includes(label)).map((label) => escapeRegExp(label)).join("|");
  const pattern = new RegExp(`(?:${escaped})\\s*[:：]?\\s*([\\s\\S]*?)(?=\\n\\s*(?:${stops})\\s*[:：]?|$)`, "i");
  const match = text.match(pattern);
  return cleanupValue(match?.[1] ?? "");
}

function fillFallbackFields(fields: ParsedField[], text: string) {
  const existing = new Set(fields.map((field) => field.label));
  const idNumber = text.match(/\b\d{17}[\dXx]\b|\b\d{15}\b/)?.[0];
  if (idNumber && !existing.has("Citizen ID Number")) fields.push({ label: "Citizen ID Number", value: idNumber });
  return fields.filter((field) => field.value && field.value !== "待确认");
}

function pushIf(fields: ParsedField[], label: string, value: string) {
  const cleaned = cleanupValue(value);
  if (cleaned) fields.push({ label, value: cleaned });
}

function cleanupValue(value: string) {
  return value.replace(/^[:：\s]+/, "").replace(/\s+/g, " ").trim();
}

function normalizeLabel(label: string) {
  const key = label.trim().toLowerCase();
  const labels: Record<string, string> = {
    姓名: "Name",
    性别: "Sex",
    民族: "Ethnicity",
    出生: "Date of Birth",
    出生日期: "Date of Birth",
    住址: "Address",
    地址: "Address",
    公民身份号码: "Citizen ID Number",
    身份证号码: "Citizen ID Number",
    证书编号: "Certificate No.",
    学校名称: "University Name",
    培养单位: "Training Unit",
    新生儿姓名: "Neonatal Name",
    出生时间: "Time of Birth",
    出生体重: "Birth Weight",
    出生身长: "Birth Length",
    出生地点: "Birth Place",
    母亲姓名: "Mother's Name",
    父亲姓名: "Father's Name",
  };

  return labels[key] ?? label.trim();
}

function inferLabel(line: string) {
  if (/\d{17}[\dXx]|\d{15}/.test(line)) return "Citizen ID Number";
  if (/省|市|区|县|路|街|号|室|road|street|avenue|apt|suite/i.test(line)) return "Address";
  if (/\d{4}[年/-]\d{1,2}[月/-]\d{1,2}/.test(line)) return "Date";
  return "Text";
}

function translateLabel(label: string, direction: Direction) {
  if (direction === "zh-to-en") return label;
  const labels: Record<string, string> = {
    "Document Title": "文件名称",
    Name: "姓名",
    Sex: "性别",
    Ethnicity: "民族",
    "Date of Birth": "出生日期",
    Address: "地址",
    "Citizen ID Number": "公民身份号码",
    "Certificate No.": "证书编号",
    "University Name": "学校名称",
    "Training Unit": "培养单位",
    "Neonatal Name": "新生儿姓名",
    "Time of Birth": "出生时间",
    "Birth Weight": "出生体重",
    "Birth Length": "出生身长",
    "Birth Place": "出生地点",
    "Mother's Name": "母亲姓名",
    "Father's Name": "父亲姓名",
  };
  return labels[label] ?? label;
}

function translateField(field: ParsedField, direction: Direction, docType: string) {
  if (direction === "zh-to-en") return translateToEnglish(field, docType);
  return translateToChinese(field, docType);
}

function translateToEnglish(field: ParsedField, docType: string) {
  const value = field.value;
  switch (field.label) {
    case "Document Title":
      if (/身份证/.test(value)) return "Citizen Identity Card of the People's Republic of China";
      return translateCommonToEnglish(value);
    case "Name":
      return chineseNameToEnglish(value);
    case "Sex":
      return value.includes("女") ? "Female" : value.includes("男") ? "Male" : translateCommonToEnglish(value);
    case "Ethnicity":
      return value.includes("汉") ? "Han" : chineseTextToPinyin(value);
    case "Date of Birth":
    case "Date":
      return dateToEnglish(value);
    case "Address":
      return chineseAddressToEnglish(value);
    case "Citizen ID Number":
      return value.replace(/\D(?!(X|x)$)/g, "");
    default:
      return translateTemplateTextToEnglish(value, docType);
  }
}

function translateToChinese(field: ParsedField, docType: string) {
  const value = field.value;
  switch (field.label) {
    case "Document Title":
      return translateCommonToChinese(value);
    case "Date of Birth":
    case "Date":
      return dateToChinese(value);
    case "Address":
      return englishAddressToChinese(value);
    default:
      return translateTemplateTextToChinese(value, docType);
  }
}

function chineseNameToEnglish(value: string) {
  const clean = value.replace(/[^\u4e00-\u9fa5·]/g, "");
  if (!clean) return value;
  const surname = clean.slice(0, 1);
  const given = clean.slice(1);
  const givenPinyin = titleCaseWords(pinyin(given, { toneType: "none", type: "array" }).join(" "));
  const surnamePinyin = titleCaseWords(pinyin(surname, { toneType: "none" }));
  return [givenPinyin, surnamePinyin].filter(Boolean).join(" ");
}

function chineseTextToPinyin(value: string) {
  return titleCaseWords(pinyin(value.replace(/[^\u4e00-\u9fa5]/g, ""), { toneType: "none" })) || value;
}

function titleCaseWords(value: string) {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.slice(0, 1).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}

function chineseAddressToEnglish(value: string) {
  const clean = value.replace(/\s+/g, "");
  const country = /中国|中华人民共和国/.test(clean) ? "China" : "China";
  const province = clean.match(/([^省]+省)/)?.[1] ?? "";
  const city = clean.match(/([^省市]+市)/)?.[1] ?? "";
  const district = clean.match(/([^市区县]+[区县])/)?.[1] ?? "";
  const streetPart = clean
    .replace(/^.*?省/, "")
    .replace(/^.*?市/, "")
    .replace(/^.*?[区县]/, "");
  const street = translateChineseStreet(streetPart);
  const parts = [street, translateRegion(district), translateRegion(city), translateRegion(province), country].filter(Boolean);
  return parts.join(", ");
}

function translateChineseStreet(value: string) {
  if (!value) return "";
  return value
    .replace(/(\d+)号/g, "No. $1, ")
    .replace(/(\d+)室/g, "Room $1, ")
    .replace(/([A-ZＡ-Ｚ])座/gi, "Tower $1, ")
    .replace(/科技园/g, "Science and Technology Park, ")
    .replace(/科发路/g, "Kefa Road")
    .replace(/华夏路/g, "Huaxia Road")
    .replace(/珠江新城/g, "Zhujiang New Town, ")
    .replace(/富力盈凯广场/g, "R&F Yingkai Plaza, ")
    .replace(/路/g, " Road")
    .replace(/街/g, " Street")
    .replace(/,/g, ", ")
    .replace(/\s+/g, " ")
    .replace(/,\s*,/g, ",")
    .replace(/,\s*$/g, "")
    .trim();
}

function translateRegion(value: string) {
  if (!value) return "";
  return value
    .replace(/广东省/g, "Guangdong Province")
    .replace(/深圳市/g, "Shenzhen City")
    .replace(/广州市/g, "Guangzhou City")
    .replace(/南山区/g, "Nanshan District")
    .replace(/天河区/g, "Tianhe District")
    .replace(/省/g, " Province")
    .replace(/市/g, " City")
    .replace(/区/g, " District")
    .replace(/县/g, " County");
}

function englishAddressToChinese(value: string) {
  const normalized = value
    .replace(/\bUSA\b|United States(?: of America)?/gi, "美国")
    .replace(/\bCA\b/g, "加利福尼亚州")
    .replace(/San Francisco/gi, "旧金山")
    .replace(/Market Street/gi, "市场街")
    .replace(/\bApt\.?\s*/gi, "公寓")
    .replace(/\bSuite\s*/gi, "套房")
    .replace(/No\.\s*/gi, "")
    .replace(/,\s*/g, "");
  return normalized;
}

function dateToEnglish(value: string) {
  const clean = value.replace(/\s+/g, "");
  const chinese = clean.match(/(\d{4})年(\d{1,2})月(\d{1,2})日?/);
  if (chinese) return `${monthName(Number(chinese[2]))} ${Number(chinese[3])}, ${chinese[1]}`;
  const numeric = clean.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
  if (numeric) return `${monthName(Number(numeric[1]))} ${Number(numeric[2])}, ${normalizeYear(numeric[3])}`;
  return value;
}

function dateToChinese(value: string) {
  const numeric = value.trim().match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
  if (numeric) return `${normalizeYear(numeric[3])}年${Number(numeric[1])}月${Number(numeric[2])}日`;
  const month = value.match(/(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s+(\d{4})/i);
  if (month) return `${month[3]}年${monthNumber(month[1])}月${Number(month[2])}日`;
  return value;
}

function normalizeYear(year: string) {
  return year.length === 2 ? `20${year}` : year;
}

function translateTemplateTextToEnglish(value: string, docType: string) {
  return translateCommonToEnglish(value)
    .replace(/普通高等学校/g, "General Higher Educational Institutes")
    .replace(/毕业证书/g, "Graduation Certificate")
    .replace(/学士学位证书/g, "Bachelor's Degree Certificate")
    .replace(/出生医学证明/g, "Medical Certificate of Birth")
    .replace(/证书编号/g, "Certificate No.")
    .replace(/学校名称/g, "University Name")
    .replace(/培养单位/g, "Training Unit")
    .replace(/新生儿姓名/g, "Neonatal Name")
    .replace(/出生时间/g, "Time of Birth")
    .replace(/出生体重/g, "Birth Weight")
    .replace(/出生身长/g, "Birth Length")
    .replace(/出生地点/g, "Birth Place")
    .replace(/母亲姓名/g, "Mother's Name")
    .replace(/父亲姓名/g, "Father's Name")
    .replace(/有效身份证件号码/g, "Valid Identification No.")
    .replace(/有效身份证件/g, "Valid Identification")
    .replace(/男/g, "Male")
    .replace(/女/g, "Female")
    .replace(/汉/g, "Han");
}

function translateTemplateTextToChinese(value: string, docType: string) {
  return translateCommonToChinese(value)
    .replace(/General Higher Educational Institutes/gi, "普通高等学校")
    .replace(/Graduation Certificate/gi, "毕业证书")
    .replace(/Bachelor'?s Degree Certificate/gi, "学士学位证书")
    .replace(/Citizen Identity Card of the People's Republic of China/gi, "中华人民共和国居民身份证")
    .replace(/Medical Certificate of Birth|Birth Certificate/gi, "出生医学证明")
    .replace(/Certificate No\./gi, "证书编号")
    .replace(/University Name/gi, "学校名称")
    .replace(/Training Unit/gi, "培养单位");
}

function translateCommonToEnglish(value: string) {
  return value
    .replace(/中华人民共和国居民身份证|居民身份证/g, "Citizen Identity Card of the People's Republic of China")
    .replace(/待确认/g, "illegible");
}

function translateCommonToChinese(value: string) {
  return value
    .replace(/Driver'?s? Licen[cs]e/gi, "驾驶执照")
    .replace(/Name/gi, "姓名")
    .replace(/Address/gi, "地址")
    .replace(/Date of Birth|DOB/gi, "出生日期")
    .replace(/Class/gi, "准驾类别")
    .replace(/Expires|EXP/gi, "有效期至")
    .replace(/illegible/gi, "待确认");
}

function buildPolished(fields: FieldResult[], direction: Direction, docType: string) {
  if (!fields.length) return direction === "zh-to-en" ? "Illegible: no translatable content was extracted." : "待确认：未能提取可翻译内容。";

  const lines = fields.map((field) => `${field.label}: ${field.translation}`);
  if (docType === "id-card" && direction === "zh-to-en") {
    return ["Citizen Identity Card of the People's Republic of China", ...lines.filter((line) => !line.startsWith("Document Title:"))].join("\n");
  }
  return lines.join("\n");
}

function templateExpressions(docType: string) {
  const common = [
    "Translator Statement: I hereby certify that this is a true and correct translation of the original document to the best of my knowledge.",
    "Certificate No.",
  ];
  const byType: Record<string, string[]> = {
    "graduation-certificate": [
      "General Higher Educational Institutes",
      "Graduation Certificate",
      "This is to certify that the student [Name], [gender], born on [date], has studied in [University] with a major of [Major] from [date] to [date]. Upon completing and passing all the required courses of the [program length] program, the student is granted graduation.",
      "University Name: [University] (sealed) President: [Name] (signature/sealed)",
      "Website for Academic Certificate Verification of the Ministry of Education of the People's Republic of China: http://www.chsi.com.cn",
    ],
    "degree-certificate": [
      "BACHELOR'S DEGREE CERTIFICATE",
      "Upon review, the student has met the requirements stipulated in the Regulations of the People's Republic of China on Academic Degrees and is hereby awarded the [degree].",
      "(General Higher Education Graduate)",
    ],
    "id-card": ["Citizen Identity Card of the People's Republic of China", "Name", "Sex", "Ethnicity", "Date of Birth", "Address", "Citizen ID Number"],
    "birth-certificate": [
      "MEDICAL CERTIFICATE OF BIRTH",
      "Neonatal Name",
      "Gender",
      "Time of Birth",
      "Gestational Age",
      "Birth Weight",
      "Birth Length",
      "Birth Place",
      "Medical Institutions",
      "Mother's Name",
      "Father's Name",
      "Valid Identification No.",
      "Issued Authority (Stamp)",
    ],
  };

  return [...(byType[docType] ?? []), ...common];
}

function monthName(month: number) {
  return ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"][
    Math.max(0, Math.min(11, month - 1))
  ];
}

function monthNumber(month: string) {
  return ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"].indexOf(month.toLowerCase()) + 1;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
