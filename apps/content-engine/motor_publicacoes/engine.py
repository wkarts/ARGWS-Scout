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

from .ingestion import brl, normalize, registrable_host
from .media import (read_media, render_card, fetch_public_html, image_from_product_html,
                    safe_online_image_url, save_original_preview)
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
    enrich_limit: int = 100
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
    blocked_hosts: set[str] = set()
    for record in normalized["items"]:
        slug = safe_slug(record)
        slugs[record["id"]] = slug
        folder = job_dir / "publicacoes" / slug
        originals = []
        sources = []
        notes = []
        image_inputs = list(record.get("image_inputs", []))
        checked: set[str] = set()

        def load_image(spec: str) -> None:
            if spec in checked:
                return
            checked.add(spec)
            image, source, issue = read_media(
                spec, media_root=opts.media_root,
                fetch_images=(opts.fetch_images or opts.enrich_images),
            )
            if image is not None:
                originals.append(image)
                sources.append(source)
            if issue:
                notes.append(issue)
                warnings_media[issue] += 1

        for spec in image_inputs[:4]:
            load_image(spec)

        # Tenta a página oficial se a foto da captura está ausente OU falhou.
        # O limite cobre o lote solicitado, não apenas os dez primeiros itens.
        if not originals and opts.enrich_images and enriched_pages < opts.enrich_limit and record.get("url"):
            source_host = registrable_host(urlparse((record.get("source") or {}).get("url") or "").hostname)
            product_host = registrable_host(urlparse(record["url"]).hostname)
            product_url = record["url"]
            if source_host and source_host == product_host and product_host not in blocked_hosts and product_url.startswith("https://"):
                enriched_pages += 1
                try:
                    page = fetch_public_html(product_url)
                    image_url = image_from_product_html(page, product_url, record["title"])
                    if image_url:
                        if image_url not in image_inputs:
                            image_inputs.append(image_url)
                        record["image_input"] = image_inputs[0]
                        record["image_inputs"] = image_inputs
                        load_image(image_url)
                    else:
                        notes.append("pagina_sem_fotografia_do_produto")
                except (OSError, ValueError, RuntimeError) as exc:
                    notes.append(f"enriquecimento_falhou:{type(exc).__name__}")
                    # Evita dezenas de requisições quando o site bloqueia a coleta.
                    if any(code in str(exc) for code in ("HTTP 401", "HTTP 403", "HTTP 429")):
                        blocked_hosts.add(product_host)
                if opts.enrich_delay:
                    time.sleep(opts.enrich_delay)
            elif product_host in blocked_hosts:
                notes.append("site_bloqueou_enriquecimento")
            else:
                notes.append("enriquecimento_domino_nao_autorizado")

        if originals:
            save_original_preview(originals[0], folder / "original.webp")
            record["image_status"] = "stored"
            record["image_source_url"] = next(
                (src for src in sources if isinstance(src, str) and src.startswith("https://")),
                None,
            )
            media_counts["originais"] += 1
        else:
            remote = next(
                (safe_online_image_url(spec) for spec in image_inputs if
                 isinstance(spec, str) and (opts.fetch_images or opts.enrich_images)),
                None,
            )
            record["image_online_url"] = remote
            record["image_status"] = "online" if remote else "illustrative"
            media_counts["online" if remote else "ilustrativas"] += 1

        square = render_card(record, folder / "card-square.png", kind="square", original=originals, accent=opts.accent)
        if opts.create_wide:
            render_card(record, folder / "card-wide.png", kind="wide", original=originals, accent=opts.accent)
        if opts.create_story:
            render_card(record, folder / "card-story.png", kind="story", original=originals, accent=opts.accent)
        for image in originals:
            image.close()
        image_info = {**square, "source_image_references": sources,
                      "online_preview_url": record.get("image_online_url"),
                      "original_file": "original.webp" if originals else None,
                      "warnings": notes}
        record["image_warnings"] = notes
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
