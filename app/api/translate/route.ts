type Direction = "en-to-zh" | "zh-to-en";
type Provider = "auto" | "openai" | "deepseek" | "offline";

type FieldResult = {
  label: string;
  source: string;
  translation: string;
};

const systemRules = `You are a professional certified document translator.
Rules:
- Translate every visible item. Do not omit labels, numbers, dates, addresses, footers, notes, stamps, signatures, QR/barcode captions, or back-side instructions.
- This product translates content only. Do not attempt to reproduce Word layout, tables, fonts, or original formatting.
- Use the user's standard template expressions where relevant, especially for graduation certificates, degree certificates, identity cards, and birth certificates.
- Preserve document numbers, ID numbers, license numbers, postal codes, URLs, email addresses, and codes exactly.
- Translate addresses completely, including country, state/province, city, district, street, road type, building, unit, room, mailbox, and postal code.
- For English-to-Chinese, do not invent Chinese personal names when no confirmed Chinese name is provided. Keep the English name.
- For Chinese-to-English, default Chinese personal names to given name before surname unless the source clearly uses another official spelling.
- Dates: use Chinese date format for Chinese output; use Month D, YYYY for English output unless the source is a numeric table-like field.
- Stamps may follow source/template wording as (sealed), (stamped), or (signature). Embossed seals should be rendered as (with embossed seal).
- Illegible or uncertain content must be marked as 待确认 for Chinese output or illegible for English output. Do not guess.
- Return only JSON with keys: mode, title, summary, fields, polished, notes. fields is an array of {label, source, translation}.`;

export async function POST(request: Request) {
  const payload = await request.json().catch(() => ({}));
  const text = typeof payload.text === "string" ? payload.text : "";
  const direction = payload.direction === "zh-to-en" ? "zh-to-en" : "en-to-zh";
  const provider = normalizeProvider(payload.provider);
  const docType = typeof payload.docType === "string" ? payload.docType : "document";

  if (!text.trim()) {
    return Response.json(offlineTranslate("", direction, "文本为空"));
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

  if (provider === "auto" && selected !== "openai" && process.env.OPENAI_API_KEY) {
    const modelResult = await callOpenAI(text, direction, docType).catch(() => null);
    if (modelResult) return Response.json(modelResult);
  }

  return Response.json(offlineTranslate(text, direction, "未配置模型密钥，已使用离线证件规则"));
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
  const content = data?.choices?.[0]?.message?.content;
  return parseModelJson(content, "OpenAI GPT");
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
  const content = data?.choices?.[0]?.message?.content;
  return parseModelJson(content, "DeepSeek");
}

function buildPrompt(text: string, direction: Direction, docType: string, engine: string) {
  const target = direction === "en-to-zh" ? "Simplified Chinese" : "professional English";

  return `Engine: ${engine}
Document type: ${docType}
Target language: ${target}
Preferred template expressions:
${templateExpressions(docType)}
Source OCR text:
${text}`;
}

function parseModelJson(content: unknown, fallbackMode: string) {
  if (typeof content !== "string") return null;
  const parsed = JSON.parse(content);
  return {
    mode: typeof parsed.mode === "string" ? parsed.mode : fallbackMode,
    title: typeof parsed.title === "string" ? parsed.title : "模型专业译文",
    summary: typeof parsed.summary === "string" ? parsed.summary : "已按证件翻译规则生成译文。",
    fields: Array.isArray(parsed.fields) ? parsed.fields : [],
    polished: typeof parsed.polished === "string" ? parsed.polished : "",
    notes: Array.isArray(parsed.notes) ? parsed.notes : ["请复核 OCR 识别的姓名、号码、日期和地址。"],
  };
}

function offlineTranslate(text: string, direction: Direction, reason: string) {
  const fields = extractFields(text, direction);
  const title = direction === "en-to-zh" ? "离线英译中证件译文" : "Offline Chinese-to-English Document Translation";

  return {
    mode: "offline rules",
    title,
    summary: `${reason}。离线模式会优先保留号码与日期，完整处理地址，并标出需要人工确认的内容。`,
    fields,
    polished: buildPolished(fields, text, direction),
    notes:
      direction === "en-to-zh"
        ? ["英文人名默认保留原文，不擅自音译。", "地址会尽量完整中文化；不确定片段请人工校对。", "模板表达只用于术语和句式，不复制 Word 排版。"]
        : ["中文姓名默认按名在前、姓在后输出。", "地址按中国地址层级完整译成英文。", "毕业证、学位证、身份证、出生证会优先套用标准模板表达。"],
  };
}

function extractFields(text: string, direction: Direction): FieldResult[] {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const fields: FieldResult[] = [];

  for (const line of lines) {
    const [rawLabel, ...rest] = line.split(/[:：]/);
    const source = rest.length ? rest.join(":").trim() : line;
    const label = rest.length ? normalizeLabel(rawLabel, direction) : inferLabel(line, direction);
    fields.push({ label, source, translation: translateLine(source, direction, label) });
  }

  return fields.slice(0, 18);
}

function normalizeLabel(label: string, direction: Direction) {
  const key = label.trim().toLowerCase();
  const enToZh: Record<string, string> = {
    name: "姓名",
    address: "地址",
    "date of birth": "出生日期",
    dob: "出生日期",
    class: "准驾类别",
    expires: "有效期至",
    exp: "有效期至",
    issued: "签发日期",
    iss: "签发日期",
    "license no.": "驾驶证号码",
    dln: "驾驶证号码",
    "certificate no.": "证书编号",
    "university name": "学校名称",
    "training unit": "培养单位",
    "neonatal name": "新生儿姓名",
    "time of birth": "出生时间",
    "birth weight": "出生体重",
    "birth length": "出生身长",
    "birth place": "出生地点",
    "mother's name": "母亲姓名",
    "father's name": "父亲姓名",
    nationality: "国籍",
    "ethnic group": "民族",
    "valid identification": "有效身份证件",
    "valid identification no.": "有效身份证件号码",
  };
  const zhToEn: Record<string, string> = {
    姓名: "Name",
    性别: "Sex",
    民族: "Ethnicity",
    出生: "Date of Birth",
    住址: "Address",
    公民身份号码: "Citizen ID Number",
    身份证号码: "ID Number",
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
    国籍: "Nationality",
    有效身份证件: "Valid Identification",
    有效身份证件号码: "Valid Identification No.",
  };

  return direction === "en-to-zh" ? enToZh[key] ?? label.trim() : zhToEn[label.trim()] ?? label.trim();
}

function inferLabel(line: string, direction: Direction) {
  if (/\d{5}(?:-\d{4})?/.test(line) || /road|street|avenue|drive|apt|suite|省|市|区|路|号/i.test(line)) {
    return direction === "en-to-zh" ? "地址/文字" : "Address/Text";
  }
  return direction === "en-to-zh" ? "文字" : "Text";
}

function translateLine(source: string, direction: Direction, label: string) {
  if (!source.trim()) return direction === "en-to-zh" ? "待确认" : "illegible";
  if (/号码|number|dln|license|id/i.test(label)) return source;
  if (/日期|birth|expires|issued|date/i.test(label)) return translateDate(source, direction);
  if (/地址|address/i.test(label)) return translateAddress(source, direction);
  if (direction === "en-to-zh") return translateCommonToChinese(source);
  return translateCommonToEnglish(source);
}

function translateAddress(source: string, direction: Direction) {
  if (direction === "zh-to-en") {
    return source
      .replace(/中华人民共和国/g, "People's Republic of China")
      .replace(/广东省/g, "Guangdong Province")
      .replace(/广州市/g, "Guangzhou City")
      .replace(/天河区/g, "Tianhe District")
      .replace(/珠江新城/g, "Zhujiang New Town")
      .replace(/华夏路/g, "Huaxia Road")
      .replace(/富力盈凯广场/g, "R&F Yingkai Plaza")
      .replace(/号/g, " No. ")
      .replace(/座/g, " Tower ")
      .replace(/室/g, " Room ");
  }

  return source
    .replace(/\bUSA\b|United States(?: of America)?/gi, "美国")
    .replace(/\bCA\b/g, "加利福尼亚州")
    .replace(/San Francisco/gi, "旧金山")
    .replace(/Market Street/gi, "市场街")
    .replace(/\bApt\.?\s*/gi, "公寓 ")
    .replace(/\bSuite\s*/gi, "套房 ");
}

function translateDate(source: string, direction: Direction) {
  const numeric = source.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
  if (!numeric) return source;
  const [, month, day, year] = numeric;
  const fullYear = year.length === 2 ? `20${year}` : year;
  if (direction === "en-to-zh") return `${fullYear}年${Number(month)}月${Number(day)}日`;
  return `${monthName(Number(month))} ${Number(day)}, ${fullYear}`;
}

function translateCommonToChinese(source: string) {
  return source
    .replace(/DRIVER'?S? LICEN[CS]E/gi, "驾驶执照")
    .replace(/General Higher Educational Institutes/gi, "普通高等学校")
    .replace(/Graduation Certificate/gi, "毕业证书")
    .replace(/BACHELOR’S DEGREE CERTIFICATE|BACHELOR'S DEGREE CERTIFICATE/gi, "学士学位证书")
    .replace(/Master’s Degree Candidate|Master's Degree Candidate/gi, "硕士研究生")
    .replace(/Citizen Identity Card of the People's Republic of China/gi, "中华人民共和国居民身份证")
    .replace(/MEDICAL CERTIFICATE OF BIRTH|BIRTH CERTIFICATE/gi, "出生医学证明")
    .replace(/Translator Statement/gi, "翻译声明")
    .replace(/Certificate No\./gi, "证书编号")
    .replace(/University Name/gi, "学校名称")
    .replace(/Training Unit/gi, "培养单位")
    .replace(/Class/gi, "准驾类别")
    .replace(/None/gi, "无")
    .replace(/Corrective Lenses/gi, "矫正镜片")
    .replace(/Federal Limits Apply/gi, "联邦限制适用");
}

function translateCommonToEnglish(source: string) {
  return source
    .replace(/中华人民共和国居民身份证/g, "Resident Identity Card of the People's Republic of China")
    .replace(/居民身份证/g, "Citizen Identity Card")
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

function templateExpressions(docType: string) {
  const common = [
    "Translator Statement: I hereby certify that this is a true and correct translation of the original document to the best of my knowledge.",
    "Certificate No.",
    "Use (sealed), (stamped), or (signature) only when visible or implied by the source/template.",
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

  return [...(byType[docType] ?? []), ...common].join("\n- ");
}

function buildPolished(fields: FieldResult[], text: string, direction: Direction) {
  if (!fields.length) return direction === "en-to-zh" ? "待确认：未能提取可翻译字段。" : "Illegible: no translatable fields were extracted.";

  return fields.map((field) => `${field.label}: ${field.translation}`).join("\n") || text;
}

function monthName(month: number) {
  return ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"][
    Math.max(0, Math.min(11, month - 1))
  ];
}
