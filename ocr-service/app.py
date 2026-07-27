import io
import os
import re
import subprocess
import tempfile
import zipfile
from pathlib import Path
from typing import Iterable

import pypdfium2 as pdfium
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from PIL import Image, ImageOps


MAX_PDF_PAGES = int(os.getenv("MAX_PDF_PAGES", "8"))
OCR_ENGINE = "tesseract"
MAX_IMAGE_SIDE = int(os.getenv("MAX_IMAGE_SIDE", "1500"))
ROTATIONS = (0, 90, 270)
ID_LABELS = (
    "\u59d3\u540d",
    "\u6027\u522b",
    "\u6c11\u65cf",
    "\u51fa\u751f",
    "\u4f4f\u5740",
    "\u516c\u6c11\u8eab\u4efd\u53f7\u7801",
    "\u5c45\u6c11\u8eab\u4efd\u8bc1",
)
ADDRESS_LABELS = (
    "\u7701",
    "\u5e02",
    "\u533a",
    "\u53bf",
    "\u9547",
    "\u8def",
    "\u53f7",
    "\u5ba4",
    "\u680b",
)

app = FastAPI(title="Document OCR Service", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=os.getenv("CORS_ALLOW_ORIGINS", "*").split(","),
    allow_methods=["POST", "GET"],
    allow_headers=["*"],
)


@app.get("/health")
def health():
    return {"ok": True, "engine": OCR_ENGINE}


@app.get("/")
def root():
    return {
        "ok": True,
        "engine": OCR_ENGINE,
        "endpoints": {
            "health": "/health",
            "ocr": "POST /ocr",
        },
    }


@app.head("/")
def root_head():
    return None


@app.post("/ocr")
async def ocr(
    file: UploadFile = File(...),
    mode: str = Form("full"),
    doc_type: str = Form("other"),
):
    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="Empty file")

    suffix = Path(file.filename or "").suffix.lower()
    mime = file.content_type or ""

    pages = []
    try:
        for index, image in enumerate(load_images(data, suffix, mime), start=1):
            text, rotation, score = recognize_best(image, mode=mode, doc_type=doc_type)
            if text.strip():
                pages.append({"index": index, "text": text, "rotation": rotation, "score": score})
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"OCR failed: {exc}") from exc

    combined = "\n\n".join(f"Page {page['index']}\n{page['text']}" for page in pages).strip()
    return {
        "engine": OCR_ENGINE,
        "text": combined,
        "pages": pages,
        "warning": None if combined else "No reliable text was recognized. Please upload a clearer original file.",
    }


def load_images(data: bytes, suffix: str, mime: str) -> Iterable[Image.Image]:
    if suffix == ".pdf" or mime == "application/pdf":
        yield from render_pdf_pages(data)
        return

    if suffix == ".docx":
        yield from extract_docx_images(data)
        return

    yield open_image(data)


def render_pdf_pages(data: bytes) -> Iterable[Image.Image]:
    document = pdfium.PdfDocument(data)
    page_count = min(len(document), MAX_PDF_PAGES)
    for page_index in range(page_count):
        page = document[page_index]
        bitmap = page.render(scale=1.8)
        yield bitmap.to_pil()


def extract_docx_images(data: bytes) -> Iterable[Image.Image]:
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        names = [
            name
            for name in archive.namelist()
            if name.lower().startswith("word/media/")
            and name.lower().endswith((".png", ".jpg", ".jpeg", ".bmp", ".tif", ".tiff"))
        ]
        for name in names:
            yield open_image(archive.read(name))


def open_image(data: bytes) -> Image.Image:
    image = Image.open(io.BytesIO(data))
    image = ImageOps.exif_transpose(image)
    if image.mode not in ("RGB", "L"):
        image = image.convert("RGB")
    return image


def recognize_best(image: Image.Image, mode: str, doc_type: str):
    best = ("", 0, -10_000)
    for rotation in ROTATIONS:
        candidate = image.rotate(rotation, expand=True) if rotation else image
        text = recognize_image(candidate)
        score = score_text(text, mode=mode, doc_type=doc_type)
        if score > best[2]:
            best = (text, rotation, score)
        if score >= 150:
            break
    return best


def recognize_image(image: Image.Image) -> str:
    image = prepare_for_ocr(image)
    with tempfile.NamedTemporaryFile(suffix=".jpg", delete=False) as temp:
        temp_path = temp.name
        image.save(temp_path, "JPEG", quality=82, optimize=True)

    try:
        return tesseract_text(temp_path)
    finally:
        Path(temp_path).unlink(missing_ok=True)

    return ""


def prepare_for_ocr(image: Image.Image) -> Image.Image:
    image = ImageOps.exif_transpose(image).convert("L")
    width, height = image.size
    longest = max(width, height)
    if longest > MAX_IMAGE_SIDE:
        ratio = MAX_IMAGE_SIDE / longest
        image = image.resize((max(1, int(width * ratio)), max(1, int(height * ratio))))
    return ImageOps.autocontrast(image)


def tesseract_text(image_path: str) -> str:
    env = os.environ.copy()
    env["OMP_THREAD_LIMIT"] = "1"
    env["OMP_NUM_THREADS"] = "1"
    completed = subprocess.run(
        ["tesseract", image_path, "stdout", "-l", "chi_sim+eng", "--psm", "6", "--dpi", "180"],
        check=False,
        capture_output=True,
        env=env,
        text=True,
        timeout=35,
    )
    return cleanup_text(completed.stdout)


def score_text(text: str, mode: str, doc_type: str) -> int:
    if not text:
        return -100

    chinese = len(re.findall(r"[\u4e00-\u9fff]", text))
    digits = len(re.findall(r"\d", text))
    id_number = 60 if re.search(r"\d{17}[\dXx]|\d{15}", text) else 0
    labels = sum(20 for label in ID_LABELS if label in text)
    address = sum(5 for label in ADDRESS_LABELS if label in text)
    latin_noise = len(re.findall(r"[A-Za-z]{8,}|[|_~`^\\{}[\]<>]", text))
    short_penalty = 35 if len(text) < 8 else 0
    id_bonus = id_number + labels + address if mode == "id" or doc_type == "id-card" else 0
    return chinese * 2 + min(digits, 35) + id_bonus - latin_noise * 8 - short_penalty


def cleanup_text(text: str) -> str:
    lines = [line.strip() for line in text.replace("|", " ").splitlines()]
    return "\n".join(line for line in lines if line)
