import sys
import json
import pdfplumber
import fitz
import re
import statistics
import unicodedata
import os

# รับค่าจาก Node.js
PDF_FILENAME = sys.argv[1]
UPLOAD_TYPE = sys.argv[2] if len(sys.argv) > 2 else "all_teachers"

CELL_Y_PADDING = 1.5
HEADER_LOOKBACK = 30
HEADER_BAND_PADDING_X = 3

DAY_CANONICAL = {"จ": "จันทร์", "จ.": "จันทร์", "อ": "อังคาร", "อ.": "อังคาร", "พ": "พุธ", "พ.": "พุธ", "พฤ": "พฤหัสบดี", "พฤ.": "พฤหัสบดี", "ศ": "ศุกร์", "ศ.": "ศุกร์"}

# ==================== เครื่องมือแปลงฟอนต์ของคุณณัฏฐ์ ====================
def decode_sgs_font(text):
    if not isinstance(text, str) or not text: return ""
    tone_map = { 0x00C9: "่", 0x00CA: "้", 0x00CB: "๊", 0x00CC: "๋", 0x00CD: "์" }
    result = []
    for c in text:
        code = ord(c)
        if 0x0158 <= code <= 0x0161: result.append(chr(code - 0x0128))
        elif code in tone_map: result.append(tone_map[code])
        else: result.append(c)
    return "".join(result)

def normalize_thai_text(text):
    if not isinstance(text, str): return ""
    text = unicodedata.normalize("NFC", text)
    replacements = { "ชัÊน": "ชั้น", "ทีÉ": "ที่", "ประจํา": "ประจำ", "ภาคเรยีน": "ภาคเรียน" }
    for old, new in replacements.items(): text = text.replace(old, new)
    return re.sub(r"[ \t\r\n]+", " ", text).strip()

def group_words_into_lines(words):
    if not words: return []
    items = []
    heights = []
    for w in words:
        if len(w) < 5: continue
        x0, y0, x1, y1, text = w[:5]
        if not text: continue
        items.append({"x0": x0, "y0": y0, "x1": x1, "y1": y1, "yc": (y0 + y1) / 2.0, "text": text})
        heights.append(max(0.1, y1 - y0))
    if not items: return []
    median_height = statistics.median(heights) if heights else 8.0
    tolerance = max(1.5, min(5.0, median_height * 0.60))
    items.sort(key=lambda item: (item["yc"], item["x0"]))
    lines = []
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
            best_line["yc"] = sum(x["yc"] for x in best_line["words"]) / len(best_line["words"])
    lines.sort(key=lambda line: line["yc"])
    return lines

def words_line_to_text(line):
    if not line: return ""
    line["words"].sort(key=lambda item: item["x0"])
    raw_text = " ".join(item["text"] for item in line["words"])
    return normalize_thai_text(decode_sgs_font(raw_text))

def dedupe_words_by_position(words):
    result = []
    for word in words:
        if not result:
            result.append(word)
            continue
        previous = result[-1]
        same_text = (word["text"] == previous["text"])
        close_x = (abs(word["x0"] - previous["x0"]) < 1.5)
        close_y = (abs(word["yc"] - previous["yc"]) < 1.5)
        if not (same_text and close_x and close_y): result.append(word)
    return result

def extract_text_from_rect(page, rect):
    page_rect = page.rect
    safe_rect = fitz.Rect(max(0, rect.x0), max(0, rect.y0 - CELL_Y_PADDING), min(page_rect.width, rect.x1), min(page_rect.height, rect.y1 + CELL_Y_PADDING))
    raw_words = page.get_text("words", clip=safe_rect)
    lines = group_words_into_lines(raw_words)
    ordered_words = []
    for line in lines:
        line["words"].sort(key=lambda item: item["x0"])
        ordered_words.extend(line["words"])
    ordered_words = dedupe_words_by_position(ordered_words)
    raw_text = " ".join(item["text"] for item in ordered_words)
    return normalize_thai_text(decode_sgs_font(raw_text))

def extract_local_header_line(page, table_bbox):
    x0_tbl, top_of_table, x1_tbl, _ = table_bbox
    header_rect = fitz.Rect(max(0, x0_tbl - HEADER_BAND_PADDING_X), max(0, top_of_table - HEADER_LOOKBACK), min(page.rect.width, x1_tbl + HEADER_BAND_PADDING_X), min(page.rect.height, top_of_table + 1))
    words = page.get_text("words", clip=header_rect)
    lines = group_words_into_lines(words)
    candidates = []
    for line in lines:
        line_text = words_line_to_text(line)
        if "ภาคเรียน" in line_text:
            candidates.append((abs(top_of_table - line["yc"]), line_text))
    if candidates:
        candidates.sort(key=lambda item: item[0])
        return candidates[0][1]
    if lines:
        lines.sort(key=lambda line: abs(top_of_table - line["yc"]))
        return words_line_to_text(lines[0])
    return ""

def parse_teacher_header(text):
    text = normalize_thai_text(text)
    if not text: return "000", "ไม่ทราบชื่อ"
    
    id_match = re.search(r"(?<!\d)(\d{2,4})(?!\d)", text)
    teacher_id = id_match.group(1) if id_match else "000"
    
    title_pattern = r"(ว่าที่\s*(?:ร\.?ต\.?|ร้อยตรี|ร้อยเอก|ร้อยโท)|นางสาว|นาง|นาย|ดร\.?|ผศ\.?|รศ\.?|ศ\.ดร\.?|Mr\.?|Mrs\.?|Ms\.?|Miss)"
    title_match = re.search(title_pattern, text, flags=re.IGNORECASE)
    title = title_match.group(1).strip() if title_match else ""
    
    semester_match = re.search(r"ภาคเรียน\s*(?:ที่)?\s*(\d+\s*/\s*\d+)", text)
    name = ""
    if title_match:
        start = title_match.end()
        end = semester_match.start() if semester_match else len(text)
        name = text[start:end].strip(" ,:-")
        name = re.sub(r"\s+", " ", name)
    if title == "นาง" and name.startswith("สาว "):
        title = "นางสาว"
        name = name[4:].strip()
    return teacher_id, f"{title}{name}".strip()

def get_row_bbox(row):
    valid_cells = [cell for cell in row.cells if cell is not None]
    if not valid_cells: return None
    return (min(c[0] for c in valid_cells), min(c[1] for c in valid_cells), max(c[2] for c in valid_cells), max(c[3] for c in valid_cells))

def infer_column_bbox(rows, col_idx):
    x0_values = []
    x1_values = []
    for row in rows:
        if col_idx >= len(row.cells): continue
        cell = row.cells[col_idx]
        if cell is None: continue
        x0_values.append(cell[0])
        x1_values.append(cell[2])
    if not x0_values: return None
    return (statistics.median(x0_values), statistics.median(x1_values))

def canonical_day(text):
    if not text: return None
    text = normalize_thai_text(text)
    text = re.sub(r"[^ก-๙A-Za-z.]", "", text)
    return DAY_CANONICAL.get(text)

def get_first_column_text(page, rows, row_idx, first_col_bounds):
    row = rows[row_idx]
    if row.cells and row.cells[0] is not None:
        x0, top, x1, bottom = row.cells[0]
        return extract_text_from_rect(page, fitz.Rect(x0, top, x1, bottom))
    row_bbox = get_row_bbox(row)
    if row_bbox is None or first_col_bounds is None: return ""
    _, top, _, bottom = row_bbox
    x0, x1 = first_col_bounds
    return extract_text_from_rect(page, fitz.Rect(x0, top, x1, bottom))

def detect_day_rows(page, table):
    rows = table.rows
    if not rows: return {}
    first_col_bounds = infer_column_bbox(rows, 0)
    detected = []
    for row_idx in range(len(rows)):
        text = get_first_column_text(page, rows, row_idx, first_col_bounds)
        day = canonical_day(text)
        if day: detected.append((row_idx, day))
    
    expected = ["จันทร์", "อังคาร", "พุธ", "พฤหัสบดี", "ศุกร์"]
    if [day for _, day in detected] == expected:
        return {row_idx: day for row_idx, day in detected}
    
    # SGS Fallback ของคุณณัฏฐ์
    fallback = { 2: "จันทร์", 3: "อังคาร", 4: "พุธ", 5: "พฤหัสบดี", 6: "ศุกร์" }
    return {r: d for r, d in fallback.items() if 0 <= r < len(rows)}

# ==================== MAIN EXECUTION ====================
def main():
    if not os.path.exists(PDF_FILENAME):
        print(json.dumps({"error": "File not found"}))
        return

    doc = fitz.open(PDF_FILENAME)
    result_json = {"teachers": []} if UPLOAD_TYPE in ["all_teachers", "personal"] else {"classes": []}

    with pdfplumber.open(PDF_FILENAME) as pdf:
        for page_num, page_plumber in enumerate(pdf.pages):
            page = doc[page_num]
            tables = page_plumber.find_tables()
            tables = sorted(tables, key=lambda table: (table.bbox[1], table.bbox[0]))

            for table in tables:
                raw_header = extract_local_header_line(page, table.bbox)
                
                # โหมดตารางครู
                if UPLOAD_TYPE in ["all_teachers", "personal"]:
                    t_id, t_name = parse_teacher_header(raw_header)
                    if not t_name: continue
                    
                    schedule_list = []
                    day_mapping = detect_day_rows(page, table)
                    
                    for row_idx, row in enumerate(table.rows):
                        if row_idx not in day_mapping: continue
                        day_str = day_mapping[row_idx]
                        
                        # วนลูปตามคอลัมน์ (ข้ามคอลัมน์แรกที่เป็นชื่อวัน)
                        for col_idx, cell in enumerate(row.cells):
                            if col_idx == 0 or cell is None: continue
                            
                            c_x0, c_top, c_x1, c_bottom = cell
                            cell_text = extract_text_from_rect(page, fitz.Rect(c_x0 + 1, c_top, c_x1 - 1, c_bottom))
                            
                            if cell_text.strip():
                                lines = cell_text.split()
                                subj = lines[0] if len(lines) > 0 else ""
                                cls_room = lines[1] if len(lines) > 1 else ""
                                room_num = lines[2] if len(lines) > 2 else ""
                                
                                schedule_list.append({
                                    "day": day_str,
                                    "period": str(col_idx), # col_idx เทียบเท่าคาบเรียนในตาราง SGS
                                    "subject": subj,
                                    "class_room": cls_room,
                                    "room_number": room_num
                                })
                    
                    result_json["teachers"].append({
                        "teacher_id": t_id,
                        "teacher_name": t_name,
                        "schedule": schedule_list
                    })

                # โหมดตารางนักเรียน (ถ้ามีการสกัดตารางเด็ก จะเขียนเพิ่มตรงนี้)
                else:
                    # ใช้ตรรกะแบบเดียวกัน แต่สลับ Key ให้ตรงฟอร์แมต classes
                    pass

    doc.close()
    
    # Print JSON ออกมาเพื่อให้ Node.js อ่านไปใช้งานต่อ
    print(json.dumps(result_json, ensure_ascii=False))

if __name__ == "__main__":
    main()