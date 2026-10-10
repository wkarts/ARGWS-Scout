"""Excel opcional com artifact_tool: inclui dados, revisão e desconto calculado por fórmula."""
from __future__ import annotations
from pathlib import Path
from .ingestion import as_decimal


def export_excel(records: list[dict], filename: Path) -> None:
    try:
        from artifact_tool import Workbook, SpreadsheetFile
    except ImportError as exc:
        raise RuntimeError("O Excel opcional requer o pacote artifact_tool; JSON e CSV continuam disponíveis") from exc
    book = Workbook.create()
    sheet = book.worksheets.add("Produtos")
    columns = ["ID", "Título", "Categoria", "Preço Pix", "Preço anterior", "Desc. anunciado %", "Desc. calculado %", "Revisão?", "URL", "Imagem informada?", "Alertas", "Capturado em"]
    data = [columns]
    for p in records:
        data.append([
            p["id"], p["title"], p["category"], float(as_decimal(p.get("price"))) if as_decimal(p.get("price")) is not None else None,
            float(as_decimal(p.get("previous_price"))) if as_decimal(p.get("previous_price")) is not None else None,
            p.get("advertised_discount_pct"), None, "SIM" if p["requires_review"] else "NÃO",
            p.get("url"), "SIM" if p.get("image_input") else "NÃO", ", ".join(p.get("warnings") or []),
            (p.get("source") or {}).get("captured_at")])
    sheet.get_range_by_indexes(0, 0, len(data), len(columns)).values = data
    last = len(data)
    if last > 1:
        sheet.get_range("G2").formulas = [['=IF(OR(D2="",E2="",E2=0),"",ROUND((1-D2/E2)*100,2))']]
        if last > 2:
            sheet.get_range(f"G2:G{last}").fill_down()
    header = sheet.get_range("A1:L1")
    header.format = {"fill": "#104052", "font": {"bold": True, "color": "#ffffff"}, "row_height": 32,
                     "vertical_alignment": "center"}
    sheet.get_range(f"A1:L{last}").format.row_height = 23
    header.format.row_height = 34
    sheet.freeze_panes.freeze_rows(1)
    for col, width in {"A":15,"B":42,"C":19,"D":16,"E":16,"F":18,"G":18,"H":13,"I":43,"J":18,"K":37,"L":25}.items():
        sheet.get_range(f"{col}:{col}").format.column_width = width
    if last > 1:
        sheet.get_range(f"D2:E{last}").set_number_format('"R$ "#,##0.00')
        sheet.get_range(f"F2:G{last}").set_number_format('0.00"%"')
        sheet.get_range(f"B2:B{last}").format.wrap_text = True
        sheet.get_range(f"H2:H{last}").data_validation = {"rule": {"type":"list","values":["SIM","NÃO"]}}
    sheet.tables.add(f"A1:L{last}", True, "RegistrosRefinados")
    summary = book.worksheets.add("Resumo")
    review = sum(bool(i["requires_review"]) for i in records)
    summary.get_range("A1:B6").values = [
        ["INDICADOR", "VALOR"], ["Registros", len(records)], ["Revisão necessária", review],
        ["Sem alertas bloqueantes", len(records)-review], ["Registros com imagem informada", sum(bool(i.get("image_input")) for i in records)],
        ["Canais de publicação", "WhatsApp, Email, Telegram, Social, Webhook"]]
    summary.get_range("A1:B1").format = {"fill":"#104052","font":{"bold":True,"color":"#ffffff"},"row_height":32}
    summary.get_range("A:A").format.column_width = 36
    summary.get_range("B:B").format.column_width = 60
    attention = book.worksheets.add("Validacoes")
    issues = [(p["id"],p["title"],x,p.get("url")) for p in records for x in p.get("warnings",[])]
    attention.get_range("A1:D1").values = [["ID", "Título", "Ocorrência", "URL"]]
    if issues:
        attention.get_range_by_indexes(1, 0, len(issues), 4).values = [list(x) for x in issues]
    attention.get_range("A1:D1").format = {"fill":"#104052","font":{"bold":True,"color":"#ffffff"},"row_height":32}
    for col,width in {"A":18,"B":45,"C":52,"D":54}.items():
        attention.get_range(f"{col}:{col}").format.column_width = width
    attention.freeze_panes.freeze_rows(1)
    SpreadsheetFile.export_xlsx(book).save(str(filename))
