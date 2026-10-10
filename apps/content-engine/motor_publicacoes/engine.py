"""Orquestrador de jobs: normaliza, valida, produz mídias e publicações."""
from __future__ import annotations

import csv
import hashlib
import json
import os
import uuid
import time
from collections import Counter
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

from .ingestion import brl, normalize
from .media import read_media, render_card, fetch_public_html, image_from_product_html
from .publications import safe_slug, write_index, write_post_files


@dataclass
class Options:
    query: str = ""
    only_relevant: bool = False
    max_items: int = 500
    fetch_images: bool = False
    media_root: Path | None = None
    media_map: dict | None = None
    public_base_url: str | None = None
    accent: str = "#047c88"
    create_story: bool = False
    create_wide: bool = True
    create_excel: bool = False
    enrich_images: bool = False
    enrich_limit: int = 20
    enrich_delay: float = 0.3

    def check(self):
        if not 1 <= self.max_items <= 5000:
            raise ValueError("max_items deve estar entre 1 e 5000")
        if not (self.accent.startswith("#") and len(self.accent) == 7 and all(c in '0123456789abcdefABCDEF' for c in self.accent[1:])):
            raise ValueError("Cor accent inválida; use #RRGGBB")
        if not 0 <= self.enrich_limit <= 1000 or self.enrich_delay < 0:
            raise ValueError("Limites de enriquecimento inválidos")
        if self.public_base_url:
            p = urlparse(self.public_base_url)
            if p.scheme != "https" or not p.hostname or p.username or p.password:
                raise ValueError("public_base_url deve ser endereço HTTPS público")


def make_json(output: Path, payload: object) -> None:
    output.write_text(json.dumps(payload, ensure_ascii=False, indent=2, default=str), encoding="utf-8")


def _csv_export(records: list[dict], output: Path) -> None:
    cols = ["id", "title", "kind", "category", "brand", "price", "previous_price", "currency", "coupon",
            "rating", "stock", "free_shipping", "query_match", "requires_review", "warnings", "url", "image_input", "captured_at"]
    with output.open("w", newline="", encoding="utf-8-sig") as stream:
        writer = csv.DictWriter(stream, fieldnames=cols, delimiter=";")
        writer.writeheader()
        for r in records:
            writer.writerow({col: (";".join(r.get("warnings") or []) if col == "warnings" else
                                   (r.get("source") or {}).get("captured_at") if col == "captured_at" else
                                   r.get(col)) for col in cols})


def create_report(snapshot: dict, media_counts: Counter, opts: Options) -> str:
    total = snapshot["total"]
    review = snapshot["review_required"]
    categories = Counter(r["category"] for r in snapshot["items"])
    page = ["# Relatório de refinamento e publicações", "", f"- Itens preparados: **{total}**",
            f"- Itens sujeitos a revisão: **{review}**", f"- Sem bloqueios encontrados: **{total-review}**",
            f"- Imagens fornecidas ou obtidas dos metadados: **{media_counts['originais']}**",
            f"- Artes sem fotografia original: **{media_counts['ilustrativas']}**",
            f"- Filtro de relevância: **{opts.query or 'não informado'}**",
            f"- Apenas relevantes: **{'sim' if opts.only_relevant else 'não'}**", "",
            "## Categorias", ""]
    page.extend(f"- {name}: {count}" for name, count in sorted(categories.items()))
    page.extend(["", "## Advertências de qualidade", ""])
    if not snapshot["warnings_by_type"]:
        page.append("Nenhuma advertência estrutural detectada.")
    page.extend(f"- {name}: {count}" for name,count in snapshot["warnings_by_type"].items())
    page.extend(["", "## Políticas de saída", "", "- Nenhuma mensagem foi enviada.",
                 "- A data da captura não é uma confirmação de preço atual.",
                 "- Divergências não são corrigidas por suposição: exigem revisão.",
                 "- Percentuais promocionais inconsistentes não são incluídos no texto publicitário.",
                 "- Quando a imagem do produto não está disponível, a arte sinaliza isso expressamente.",
                 "- Prévia Open Graph é válida somente depois de hospedar os arquivos em um domínio HTTPS público.",
                 "- WhatsApp exige consentimento e integração oficial autorizada para envio programático.",
                 "- E-mails requerem consentimento/base legal e política de descadastramento.", ""])
    return "\n".join(page)


def process(source: object, output_root: Path, opts: Options | None = None) -> tuple[Path, dict]:
    opts = opts or Options()
    opts.check()
    normalized = normalize(source, query=opts.query, media_map=opts.media_map,
                           only_relevant=opts.only_relevant, max_items=opts.max_items)
    if not normalized["items"]:
        raise ValueError("A captura não possui itens elegíveis para a geração")
    output_root = output_root.resolve()
    output_root.mkdir(parents=True, exist_ok=True)
    job_id = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid.uuid4().hex[:8]
    job_dir = (output_root / job_id).resolve()
    job_dir.mkdir(parents=True, exist_ok=False)
    (job_dir / "publicacoes").mkdir()
    make_json(job_dir / "registros_refinados.json", normalized)
    _csv_export(normalized["items"], job_dir / "registros_refinados.csv")
    slugs: dict[str, str] = {}
    manifest_items = []
    media_counts: Counter = Counter()
    warnings_media = Counter()
    enriched_pages = 0
    for record in normalized["items"]:
        slug = safe_slug(record)
        slugs[record["id"]] = slug
        folder = job_dir / "publicacoes" / slug
        originals = []
        sources = []
        notes = []
        image_inputs = list(record.get("image_inputs", []))
        if not image_inputs and opts.enrich_images and enriched_pages < opts.enrich_limit and record.get("url"):
            source_host = urlparse((record.get("source") or {}).get("url") or "").hostname
            product_host = urlparse(record["url"]).hostname
            if source_host and product_host == source_host:
                enriched_pages += 1
                try:
                    page = fetch_public_html(record["url"])
                    image_url = image_from_product_html(page,record["url"])
                    if image_url:
                        image_inputs.append(image_url)
                        record["image_input"] = image_url
                        record["image_inputs"] = [image_url]
                    else:
                        notes.append("pagina_sem_imagem_og_ou_jsonld")
                except (OSError, ValueError, RuntimeError) as exc:
                    notes.append(f"enriquecimento_falhou:{type(exc).__name__}")
                if opts.enrich_delay:
                    time.sleep(opts.enrich_delay)
            else:
                notes.append("enriquecimento_host_diferente_da_origem")
        for spec in image_inputs[:4]:
            img, source_label, issue = read_media(spec, media_root=opts.media_root, fetch_images=(opts.fetch_images or opts.enrich_images))
            if img is not None:
                originals.append(img)
                sources.append(source_label)
            if issue:
                notes.append(issue)
                warnings_media[issue] += 1
        square = render_card(record, folder / "card-square.png", kind="square", original=originals, accent=opts.accent)
        if opts.create_wide:
            render_card(record, folder / "card-wide.png", kind="wide", original=originals, accent=opts.accent)
        if opts.create_story:
            render_card(record, folder / "card-story.png", kind="story", original=originals, accent=opts.accent)
        for img in originals:
            img.close()
        if originals:
            media_counts["originais"] += 1
        else:
            media_counts["ilustrativas"] += 1
        image_info = {**square, "source_image_references": sources, "warnings": notes}
        entry = write_post_files(record, folder, public_base_url=opts.public_base_url,
                                 image_info=image_info, status=record["publication_status"])
        manifest_items.append(entry)
    write_index(job_dir, normalized["items"], slugs)
    make_json(job_dir / "registros_refinados.json", normalized)
    _csv_export(normalized["items"], job_dir / "registros_refinados.csv")
    (job_dir / "RELATORIO.md").write_text(create_report(normalized, media_counts, opts), encoding="utf-8")
    checksum = hashlib.sha256(json.dumps(source, ensure_ascii=False, sort_keys=True, default=str).encode()).hexdigest()
    manifest = {
        "engine": "Motor de Publicações", "schema_version": "2.0.0", "job_id": job_id,
        "created_utc": datetime.now(timezone.utc).isoformat(), "input_sha256": checksum,
        "total": len(manifest_items), "review_required": normalized["review_required"],
        "ready_for_manual_review": True,
        "messages_sent": 0, "image_summary": dict(media_counts),
        "image_warnings": dict(warnings_media),
        "channels": ["whatsapp", "telegram", "email", "facebook", "instagram", "linkedin", "sms", "webhook"],
        "publication_base_url": opts.public_base_url,
        "items": manifest_items,
    }
    make_json(job_dir / "manifest.json", manifest)
    if opts.create_excel:
        from .xlsx_export import export_excel
        export_excel(normalized["items"], job_dir / "analise.xlsx")
    return job_dir, manifest
