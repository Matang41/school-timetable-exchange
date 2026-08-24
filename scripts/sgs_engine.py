#!/usr/bin/env python3
"""
SGS Schedule Extraction Engine V5
- Native PDF extraction with pdfplumber + PyMuPDF
- Supports SGS student/class schedules and teacher schedules
- JSON-only stdout for Node.js integration
- Optional debug logs to stderr
"""

from __future__ import annotations

import argparse
import json
import re
import statistics
import sys
import unicodedata
from pathlib import Path
from typing import Any

import fitz  # PyMuPDF
import pdfplumber


CELL_Y_PADDING = 1.5
HEADER_LOOKBACK = 30
HEADER_BAND_PADDING_X = 3
EXPECTED_DAYS = ["จ.", "อ.", "พ.", "พฤ.", "ศ."]
DAY_BY_ROW = {2: "จ.", 3: "อ.", 4: "พ.", 5: "พฤ.", 6: "ศ."}

DAY_CANONICAL = {
    "จ": "จ.", "จ.": "จ.",
    "อ": "อ.", "อ.": "อ.",
    "พ": "พ.", "พ.": "พ.",
    "พฤ": "พฤ.", "พฤ.": "พฤ.",
    "ศ": "ศ.", "ศ.": "ศ.",
}

TONE_MAP = {
    0x00C9: "่",
    0x00CA: "้",
    0x00CB: "๊",
    0x00CC: "๋",
    0x00CD: "์",
}


class SGSExtractionError(Exception):
    pass


def log(debug: bool, *parts: Any) -> None:
    if debug:
        print(*parts, file=sys.stderr)


def decode_sgs_font(text: str) -> str:
    if not isinstance(text, str) or not text:
        return ""

    result: list[str] = []
    for c in text:
        code = ord(c)
        if 0x0158 <= code <= 0x0161:
            result.append(chr(code - 0x0128))
        elif code in TONE_MAP:
            result.append(TONE_MAP[code])
        else:
            result.append(c)
    return "".join(result)


def normalize_thai_text(text: str) -> str:
    if not isinstance(text, str):
        return ""

    text = unicodedata.normalize("NFC", text)
    replacements = {
        "ชัÊน": "ชั้น",
        "ทีÉ": "ที่",
        "ประจํา": "ประจำ",
        "ภาคเรยีน": "ภาคเรียน",
        "ครพู": "ครู",
        "ครธู": "ครู",
        "ครปู": "ครู",
        "ครนู": "ครู",
        "ครอู": "ครู",
        "ครกู": "ครู",
        "ครวู": "ครู",
        "ครส": "ครู",
        "ครพ": "ครู",
        "ครต": "ครู",
    }
    for old, new in replacements.items():
        text = text.replace(old, new)
    return re.sub(r"\s+", " ", text).strip()


def group_words_into_lines(words: list[tuple]) -> list[dict[str, Any]]:
    if not words:
        return []

    items: list[dict[str, Any]] = []
    heights: list[float] = []
    for w in words:
        if len(w) < 5:
            continue
        x0, y0, x1, y1, text = w[:5]
        if not text:
            continue
        items.append({
            "x0": float(x0),
            "y0": float(y0),
            "x1": float(x1),
            "y1": float(y1),
            "yc": (float(y0) + float(y1)) / 2.0,
            "text": str(text),
        })
        heights.append(max(0.1, float(y1) - float(y0)))

    if not items:
        return []

    median_height = statistics.median(heights) if heights else 8.0
    tolerance = max(1.5, min(5.0, median_height * 0.60))
    items.sort(key=lambda x: (x["yc"], x["x0"]))

    lines: list[dict[str, Any]] = []
    for item in items:
        best_line = None
        best_distance = float("inf")
        for line in lines:
            distance = abs(item["yc"] - line["yc"])
            if distance <= tolerance and distance < best_distance:
                best_line = line
                best_distance = distance
        if best_line is None:
            lines.append({"yc": item["yc"], "words": [item]})
        else:
            best_line["words"].append(item)
            best_line["yc"] = sum(w["yc"] for w in best_line["words"]) / len(best_line["words"])

    lines.sort(key=lambda x: x["yc"])
    for line in lines:
        line["words"].sort(key=lambda x: x["x0"])
    return lines


def line_to_text(line: dict[str, Any]) -> str:
    raw = " ".join(word["text"] for word in line["words"])
    return normalize_thai_text(decode_sgs_font(raw))


def dedupe_words_by_position(words: list[dict[str, Any]]) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for word in words:
        if not result:
            result.append(word)
            continue
        previous = result[-1]
        same_text = word["text"] == previous["text"]
        close_x = abs(word["x0"] - previous["x0"]) < 1.5
        close_y = abs(word["yc"] - previous["yc"]) < 1.5
        if not (same_text and close_x and close_y):
            result.append(word)
    return result


def extract_text_from_rect(page: fitz.Page, rect: fitz.Rect, page_words: list[tuple] | None = None) -> str:
    page_rect = page.rect
    safe_rect = fitz.Rect(
        max(0, rect.x0),
        max(0, rect.y0 - CELL_Y_PADDING),
        min(page_rect.width, rect.x1),
        min(page_rect.height, rect.y1 + CELL_Y_PADDING),
    )
    if page_words is None:
        raw_words = page.get_text("words", clip=safe_rect)
    else:
        # Much faster than calling PyMuPDF clip thousands of times.
        raw_words = [
            w for w in page_words
            if safe_rect.x0 <= (w[0] + w[2]) / 2 <= safe_rect.x1
            and safe_rect.y0 <= (w[1] + w[3]) / 2 <= safe_rect.y1
        ]
    lines = group_words_into_lines(raw_words)
    ordered: list[dict[str, Any]] = []
    for line in lines:
        ordered.extend(line["words"])
    ordered = dedupe_words_by_position(ordered)
    raw = " ".join(item["text"] for item in ordered)
    return normalize_thai_text(decode_sgs_font(raw))


def extract_local_header_line(page: fitz.Page, table_bbox: tuple[float, float, float, float], page_words: list[tuple] | None = None) -> tuple[str, str]:
    x0_tbl, top_of_table, x1_tbl, _ = table_bbox
    rect = fitz.Rect(
        max(0, x0_tbl - HEADER_BAND_PADDING_X),
        max(0, top_of_table - HEADER_LOOKBACK),
        min(page.rect.width, x1_tbl + HEADER_BAND_PADDING_X),
        min(page.rect.height, top_of_table + 1),
    )
    if page_words is None:
        header_words = page.get_text("words", clip=rect)
    else:
        header_words = [
            w for w in page_words
            if rect.x0 <= (w[0] + w[2]) / 2 <= rect.x1
            and rect.y0 <= (w[1] + w[3]) / 2 <= rect.y1
        ]
    lines = group_words_into_lines(header_words)
    candidates: list[tuple[float, str]] = []
    for line in lines:
        text = line_to_text(line)
        if "ภาคเรียน" in text:
            candidates.append((abs(top_of_table - line["yc"]), text))
    if candidates:
        candidates.sort(key=lambda x: x[0])
        return candidates[0][1], "keyword_line"
    if lines:
        lines.sort(key=lambda line: abs(top_of_table - line["yc"]))
        return line_to_text(lines[0]), "nearest_line"
    return "", "none"


def infer_column_bbox(rows: list[Any], col_idx: int) -> tuple[float, float] | None:
    x0_values: list[float] = []
    x1_values: list[float] = []
    for row in rows:
        if col_idx >= len(row.cells):
            continue
        cell = row.cells[col_idx]
        if cell is None:
            continue
        x0_values.append(float(cell[0]))
        x1_values.append(float(cell[2]))
    if not x0_values:
        return None
    return statistics.median(x0_values), statistics.median(x1_values)


def get_row_bbox(row: Any) -> tuple[float, float, float, float] | None:
    valid = [cell for cell in row.cells if cell is not None]
    if not valid:
        return None
    return (
        min(cell[0] for cell in valid),
        min(cell[1] for cell in valid),
        max(cell[2] for cell in valid),
        max(cell[3] for cell in valid),
    )


def get_first_column_text(page: fitz.Page, rows: list[Any], row_idx: int, col_bounds: tuple[float, float] | None, page_words: list[tuple] | None = None) -> str:
    row = rows[row_idx]
    if row.cells and row.cells[0] is not None:
        x0, top, x1, bottom = row.cells[0]
        return extract_text_from_rect(page, fitz.Rect(x0, top, x1, bottom), page_words)
    row_bbox = get_row_bbox(row)
    if row_bbox is None or col_bounds is None:
        return ""
    _, top, _, bottom = row_bbox
    x0, x1 = col_bounds
    return extract_text_from_rect(page, fitz.Rect(x0, top, x1, bottom), page_words)


def canonical_day(text: str) -> str | None:
    text = normalize_thai_text(text)
    text = re.sub(r"[^ก-๙A-Za-z.]", "", text)
    return DAY_CANONICAL.get(text)


def detect_day_rows(page: fitz.Page, table: Any, page_words: list[tuple] | None = None) -> tuple[dict[int, str], str, bool]:
    rows = table.rows
    if not rows:
        return {}, "none", False
    col_bounds = infer_column_bbox(rows, 0)
    detected: list[tuple[int, str]] = []
    for idx in range(len(rows)):
        day = canonical_day(get_first_column_text(page, rows, idx, col_bounds, page_words))
        if day:
            detected.append((idx, day))
    sequence = [day for _, day in detected]
    if sequence == EXPECTED_DAYS:
        return {idx: day for idx, day in detected}, "pdf_text_exact", True

    detected_index = {day: idx for idx, day in detected}
    anchors = [detected_index[day] - i for i, day in enumerate(EXPECTED_DAYS) if day in detected_index]
    if anchors:
        anchor = round(statistics.median(anchors))
        candidate: dict[int, str] = {}
        for i, day in enumerate(EXPECTED_DAYS):
            row_idx = anchor + i
            if 0 <= row_idx < len(rows):
                candidate[row_idx] = day
        matching = sum(candidate.get(idx) == day for idx, day in detected)
        if matching >= 2:
            return candidate, "pdf_text_plus_structure", list(candidate.values()) == EXPECTED_DAYS

    fallback = {idx: day for idx, day in DAY_BY_ROW.items() if 0 <= idx < len(rows)}
    return fallback, "sgs_layout_fallback", list(fallback.values()) == EXPECTED_DAYS


def normalize_class_name(class_name: str) -> str:
    class_name = normalize_thai_text(class_name)
    class_name = re.sub(r"^ม\.\s*", "ม.", class_name)
    class_name = re.sub(r"\s*/\s*", "/", class_name)
    class_name = re.sub(r"^(\d+)\s*/", r"ม.\1/", class_name) if re.fullmatch(r"\d+\s*/\d+", class_name) else class_name
    return class_name.strip()


def extract_header_class_name(header: str) -> str:
    header = normalize_thai_text(header)
    m = re.search(r"ชั้น\s*(.+?)(?:\s+ห้อง|ห้อง)", header)
    if m:
        return normalize_class_name(m.group(1).strip())
    return normalize_class_name(header)


def clean_teacher_name(name: str) -> str:
    name = re.sub(r"^(?:คุณครู|ครู)\s*", "", name.strip())
    name = re.sub(r"\s+", " ", name)
    return name.strip()


def parse_student_cell(text: str) -> dict[str, str]:
    """Parse a student timetable cell conservatively.

    Important V7 rule:
    A trailing 3-4 digit number is NEVER treated as teacher_id by itself.
    A teacher_id is only extracted when a teacher marker/name is present.
    This prevents room numbers such as 335/512/322 from becoming teacher IDs.
    """
    text = normalize_thai_text(text)
    record = {
        "subject": text,
        "teacher_id": "",
        "teacher_name": "",
        "room_number": "",
    }
    if not text:
        return record

    code_match = re.match(r"^([ก-ฮA-Za-z]{1,8}\d{4,6})\b", text)
    if code_match:
        record["subject"] = code_match.group(1)
        remainder = text[code_match.end():].strip()
    else:
        remainder = text

    # Only parse teacher identity when a teacher marker is explicitly present.
    teacher_match = re.search(r"(?:คุณครู|ครู)\s*([^0-9]+?)(?:\s+(\d{3,4}))?\s*$", remainder)
    if teacher_match:
        name_part = clean_teacher_name(teacher_match.group(1))
        teacher_id = teacher_match.group(2) or ""
        if name_part:
            record["teacher_name"] = name_part
            record["teacher_id"] = teacher_id
            return record

    # Some SGS text may place teacher text without a clean marker.
    # We deliberately DO NOT infer teacher_id from a trailing number.
    # This number may be a classroom/room number.
    return record


def parse_teacher_cell(text: str) -> dict[str, str]:
    """Parse e.g. 'ท31101 4/9 615' or 'ประชุมสี'."""
    text = normalize_thai_text(text)
    record = {
        "subject": text,
        "class_room": "",
        "room_number": "",
    }
    if not text:
        return record

    # Course code is the first token in typical SGS teacher schedule cells.
    code_match = re.match(r"^([ก-ฮA-Za-z]{1,8}\d{4,6})\b", text)
    remainder = text[code_match.end():].strip() if code_match else text
    if code_match:
        record["subject"] = code_match.group(1)

    room_match = re.search(r"(?<!\d)(\d{3,4})\s*$", remainder)
    if room_match:
        record["room_number"] = room_match.group(1)
        remainder = remainder[:room_match.start()].strip()

    class_match = re.search(r"(?:\d+\/\d+|ม\.\s*\d+(?:\s*[ก-ฮ]\.?\s*\.\s*\d+)?|ม\.\s*\d+\s*[ก-ฮ]\.?\s*\d+)$", remainder)
    if class_match:
        record["class_room"] = class_match.group(0).strip()

    return record


def parse_teacher_header(header: str, fallback_name: str) -> tuple[str, str, str, str]:
    header = normalize_thai_text(header)
    id_match = re.search(r"(?<!\d)(\d{2,4})(?!\d)", header)
    teacher_id = id_match.group(1) if id_match else ""

    title_pattern = (
        r"(ว่าที่\s*(?:ร\.?ต\.?|ร้อยตรี|ร้อยเอก|ร้อยโท)|"
        r"นางสาว|นาง|นาย|ศ\.ดร\.?|ผศ\.?|รศ\.?|ดร\.?|"
        r"Mr\.?|Mrs\.?|Ms\.?|Miss)"
    )
    title_match = re.search(title_pattern, header, flags=re.IGNORECASE)
    title = title_match.group(1).strip() if title_match else ""

    semester_match = re.search(r"ภาคเรียน\s*(?:ที่)?\s*(\d+\s*/\s*\d+)", header)
    semester = re.sub(r"\s+", "", semester_match.group(1)) if semester_match else ""

    name = ""
    if title_match:
        end = semester_match.start() if semester_match else len(header)
        name = header[title_match.end():end].strip(" -,:;")
        name = re.sub(r"\s+", " ", name)
    elif id_match:
        end = semester_match.start() if semester_match else len(header)
        name = header[id_match.end():end].strip(" -,:;")

    if title == "นาง" and name.startswith("สาว "):
        title = "นางสาว"
        name = name[4:].strip()

    full_name = f"{title}{name}" if title else name
    if not full_name:
        full_name = fallback_name
    return teacher_id, full_name.strip(), semester, header


def table_to_student_schedule(page: fitz.Page, table: Any, page_number: int, table_number: int, page_words: list[tuple] | None = None) -> tuple[str, dict[str, Any], dict[str, Any]]:
    header, header_source = extract_local_header_line(page, table.bbox, page_words)
    class_name = extract_header_class_name(header)
    day_map, day_source, day_valid = detect_day_rows(page, table, page_words)
    schedule: list[dict[str, Any]] = []

    for row_idx, row in enumerate(table.rows):
        if row_idx not in day_map:
            continue
        day = day_map[row_idx]
        for col_idx in range(1, min(11, len(row.cells))):
            cell = row.cells[col_idx]
            if cell is None:
                text = ""
            else:
                text = extract_text_from_rect(page, fitz.Rect(cell[0] + 1, cell[1], cell[2] - 1, cell[3]), page_words)
            text = normalize_thai_text(text)
            if not text:
                continue
            parsed = parse_student_cell(text)
            schedule.append({
                "day": day,
                "period": col_idx,
                "subject": parsed["subject"],
                "class_room": class_name,
                "room_number": parsed["room_number"],
                "teacher_id": parsed["teacher_id"],
                "teacher_name": parsed["teacher_name"],
                "raw": text,
                "source": {"page": page_number, "table": table_number},
            })

    meta = {
        "page": page_number,
        "table": table_number,
        "header": header,
        "header_source": header_source,
        "class_name": class_name,
        "day_source": day_source,
        "day_valid": day_valid,
    }
    return class_name, {"class_name": class_name, "schedule": schedule}, meta


def table_to_teacher_schedule(page: fitz.Page, table: Any, page_number: int, table_number: int, page_words: list[tuple] | None = None) -> tuple[str, dict[str, Any], dict[str, Any]]:
    header, header_source = extract_local_header_line(page, table.bbox, page_words)
    teacher_id, teacher_name, semester, normalized_header = parse_teacher_header(
        header,
        fallback_name=f"ตารางครูที่_{table_number}",
    )
    day_map, day_source, day_valid = detect_day_rows(page, table, page_words)
    schedule: list[dict[str, Any]] = []

    for row_idx, row in enumerate(table.rows):
        if row_idx not in day_map:
            continue
        day = day_map[row_idx]
        for col_idx in range(1, min(11, len(row.cells))):
            cell = row.cells[col_idx]
            if cell is None:
                text = ""
            else:
                text = extract_text_from_rect(page, fitz.Rect(cell[0] + 1, cell[1], cell[2] - 1, cell[3]), page_words)
            text = normalize_thai_text(text)
            if not text:
                continue
            parsed = parse_teacher_cell(text)
            schedule.append({
                "day": day,
                "period": col_idx,
                "subject": parsed["subject"],
                "class_room": parsed["class_room"],
                "room_number": parsed["room_number"],
                "raw": text,
                "source": {"page": page_number, "table": table_number},
            })

    teacher = {
        "teacher_id": teacher_id,
        "teacher_name": teacher_name,
        "semester": semester,
        "schedule": schedule,
    }
    meta = {
        "page": page_number,
        "table": table_number,
        "header": normalized_header,
        "header_source": header_source,
        "teacher_id": teacher_id,
        "teacher_name": teacher_name,
        "day_source": day_source,
        "day_valid": day_valid,
    }
    return teacher_id, teacher, meta


def dedupe_student_classes(classes: list[dict[str, Any]]) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    seen: set[tuple] = set()
    for cls in classes:
        key = (cls["class_name"],)
        if key not in seen:
            seen.add(key)
            result.append(cls)
        else:
            existing = next(x for x in result if x["class_name"] == cls["class_name"])
            seen_slots = {(s["day"], s["period"]) for s in existing["schedule"]}
            for slot in cls["schedule"]:
                if (slot["day"], slot["period"]) not in seen_slots:
                    existing["schedule"].append(slot)
    return result


def extract_pdf(pdf_path: Path, kind: str, debug: bool = False) -> dict[str, Any]:
    if not pdf_path.exists():
        raise SGSExtractionError(f"ไม่พบไฟล์: {pdf_path}")

    try:
        doc = fitz.open(str(pdf_path))
    except Exception as exc:
        raise SGSExtractionError(f"เปิด PDF ไม่สำเร็จ: {exc}") from exc

    all_meta: list[dict[str, Any]] = []
    student_classes: list[dict[str, Any]] = []
    teachers: list[dict[str, Any]] = []

    try:
        with pdfplumber.open(str(pdf_path)) as pdf:
            for page_number, page_plumber in enumerate(pdf.pages, start=1):
                page = doc[page_number - 1]
                page_words = page.get_text("words")
                tables = sorted(
                    page_plumber.find_tables(),
                    key=lambda table: (table.bbox[1], table.bbox[0]),
                )
                log(debug, f"page {page_number}: {len(tables)} tables")

                for table_number, table in enumerate(tables, start=1):
                    if kind == "teacher":
                        teacher_id, teacher, meta = table_to_teacher_schedule(
                            page, table, page_number, table_number, page_words
                        )
                        teachers.append(teacher)
                    else:
                        class_name, cls, meta = table_to_student_schedule(
                            page, table, page_number, table_number, page_words
                        )
                        student_classes.append(cls)
                    all_meta.append(meta)

        student_classes = dedupe_student_classes(student_classes)

        # Deduplicate teacher headers if a malformed PDF repeats a table.
        teacher_by_id: dict[str, dict[str, Any]] = {}
        for teacher in teachers:
            key = teacher["teacher_id"] or teacher["teacher_name"]
            if key not in teacher_by_id:
                teacher_by_id[key] = teacher
            else:
                existing_slots = {(s["day"], s["period"]) for s in teacher_by_id[key]["schedule"]}
                teacher_by_id[key]["schedule"].extend(
                    s for s in teacher["schedule"] if (s["day"], s["period"]) not in existing_slots
                )
        teachers = list(teacher_by_id.values())

        invalid_tables = [m for m in all_meta if not m.get("day_valid") or m.get("header_source") == "none"]

        result: dict[str, Any] = {
            "success": True,
            "engine": "sgs_python_v5",
            "kind": kind,
            "source_file": pdf_path.name,
            "metadata": {
                "pages": len(doc),
                "tables": len(all_meta),
                "invalid_tables": len(invalid_tables),
                "warnings": invalid_tables,
            },
        }
        if kind == "teacher":
            result["data"] = {"teachers": teachers}
        else:
            result["data"] = {"classes": student_classes}
        return result
    finally:
        doc.close()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("pdf", help="PDF path")
    parser.add_argument("--type", choices=["student", "teacher", "auto"], default="auto")
    parser.add_argument("--debug", action="store_true")
    args = parser.parse_args()

    pdf_path = Path(args.pdf).expanduser().resolve()
    kind = args.type
    if kind == "auto":
        # Conservative default. Node passes the intended upload type in production.
        kind = "student"

    try:
        result = extract_pdf(pdf_path, kind, debug=args.debug)
        print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
        return 0
    except Exception as exc:
        error = {
            "success": False,
            "engine": "sgs_python_v5",
            "error": str(exc),
        }
        print(json.dumps(error, ensure_ascii=False, separators=(",", ":")))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
