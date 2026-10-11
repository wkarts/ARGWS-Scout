"""Entrada estruturada, scraping textual, HTML/JSON-LD e adapters específicos.

A camada de extração é deliberadamente separada da criação de publicações.
Nenhuma chamada externa acontece durante a ingestão.
"""
from __future__ import annotations

import hashlib
import html
import json
import re
from collections import Counter
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from html.parser import HTMLParser
from urllib.parse import urljoin, urlparse

from . import adapter_kabum

_money = re.compile(r"R\$\s*((?:\d{1,3}(?:\.\d{3})+|\d+),\d{2})", re.I)
_inst = re.compile(r"(\d+)\s*x\s*de\s*R\$\s*((?:\d{1,3}(?:\.\d{3})+|\d+),\d{2})", re.I)
_stock = re.compile(r"Resta(?:m)?\s+(\d+)\s+Unid", re.I)
_rating = re.compile(r"Avalia[çc][ãa]o\s*(\d+(?:[,.]\d+)?)\s*de\s*5", re.I)
_discount = re.compile(r"Desconto:\s*-?\s*(\d+(?:[,.]\d+)?)\s*%", re.I)
_pua = re.compile(r"[\ue000-\uf8ff\u200b\u200c\u200d\ufe0f]")


def compact(value: object) -> str:
    return re.sub(r"\s+", " ", _pua.sub("", html.unescape(str(value or "")))).strip()


def as_decimal(value: object) -> Decimal | None:
    if value is None or value == "":
        return None
    if isinstance(value, Decimal):
        return value.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    s = str(value).strip().replace("R$", "").strip()
    if "," in s:
        s = s.replace(".", "").replace(",", ".")
    try:
        return Decimal(s).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    except (ValueError, InvalidOperation):
        return None


def decimal_text(value: object) -> str | None:
    dec = as_decimal(value)
    return str(dec) if dec is not None else None


def brl(value: object) -> str | None:
    return format_money(value, "BRL")


def format_money(value: object, currency: object = "BRL") -> str | None:
    """Não rotula USD/EUR/GBP como reais. Valores desconhecidos mantêm ISO."""
    number = as_decimal(value)
    if number is None:
        return None
    iso = str(currency or "BRL").upper().strip()[:3]
    formatted = f"{number:,.2f}".replace(",", "_").replace(".", ",").replace("_", ".")
    prefix = {"BRL": "R$", "USD": "US$", "EUR": "€", "GBP": "£", "CAD": "CA$", "JPY": "¥"}.get(iso, iso)
    return f"{prefix} {formatted}"


def safe_http_url(value: object, base: str = "") -> str | None:
    raw = str(value or "").strip()
    if not raw:
        return None
    absolute = urljoin(base, raw) if base else raw
    obj = urlparse(absolute)
    if obj.scheme.lower() not in {"http", "https"} or not obj.hostname or obj.username or obj.password:
        return None
    return absolute


def registrable_host(value: str | None) -> str:
    """Agrupamento de subdomínios conservador, sem bibliotecas de domínio externas."""
    if not value:
        return ""
    parts = value.lower().rstrip(".").split(".")
    if len(parts) < 2:
        return value.lower()
    # Sufixos com domínio de segundo nível público: www/loja/produto são
    # subdomínios do mesmo registrante, mas sites distintos não são unidos.
    public_second = {"com.br", "net.br", "org.br", "com.mx", "co.uk", "com.au", "co.jp", "com.ar"}
    suffix = ".".join(parts[-2:])
    return ".".join(parts[-3:]) if suffix in public_second and len(parts) >= 3 else ".".join(parts[-2:])

class HTMLMetadata(HTMLParser):
    """Leitor mínimo de metadados. NÃO executa scripts externos."""
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.meta: dict[str, str] = {}
        self.title_parts: list[str] = []
        self.scripts: list[str] = []
        self._in_title = False
        self._in_jsonld = False
        self._script_buffer: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        vals = dict(attrs)
        if tag == "meta":
            key = vals.get("property") or vals.get("name")
            if key and vals.get("content"):
                self.meta[key.lower()] = str(vals["content"])
        if tag == "title":
            self._in_title = True
        if tag == "script" and "ld+json" in (vals.get("type") or "").lower():
            self._in_jsonld = True
            self._script_buffer = []

    def handle_endtag(self, tag: str) -> None:
        if tag == "title":
            self._in_title = False
        if tag == "script" and self._in_jsonld:
            self.scripts.append("".join(self._script_buffer))
            self._in_jsonld = False

    def handle_data(self, data: str) -> None:
        if self._in_title:
            self.title_parts.append(data)
        if self._in_jsonld:
            self._script_buffer.append(data)


def _jsonld_nodes(data: object) -> list[dict]:
    result = []
    if isinstance(data, list):
        for item in data:
            result.extend(_jsonld_nodes(item))
    elif isinstance(data, dict):
        result.append(data)
        if "@graph" in data:
            result.extend(_jsonld_nodes(data["@graph"]))
        if "itemListElement" in data:
            for el in data["itemListElement"]:
                if isinstance(el, dict):
                    result.extend(_jsonld_nodes(el.get("item", el)))
    return result


def _jsonld_records(documents: list[object], source_url: str) -> list[dict]:
    """Normaliza schema.org tanto de HTML quanto de JSON-LD extraído pelo Scout."""
    items: list[dict] = []
    for document in documents:
        for node in _jsonld_nodes(document):
            type_value = node.get("@type", "")
            types = [type_value] if isinstance(type_value, str) else type_value
            if not set(types or []) & {"Product", "Article", "NewsArticle", "BlogPosting", "Event", "Service", "JobPosting", "Recipe", "RealEstateListing", "Offer", "LocalBusiness", "Organization", "Course"}:
                continue
            offers = node.get("offers") or {}
            if isinstance(offers, list):
                offers = offers[0] if offers else {}
            if not isinstance(offers, dict):
                offers = {}
            images = node.get("image") or []
            if isinstance(images, (str, dict)):
                images = [images]
            image = images[0] if isinstance(images, list) and images else None
            image_url = (image.get("contentUrl") or image.get("url")) if isinstance(image, dict) else image
            items.append({
                "kind": ("produto" if "Product" in types or "Offer" in types else
                         "evento" if "Event" in types else
                         "servico" if "Service" in types else
                         "vaga" if "JobPosting" in types else
                         "imovel" if "RealEstateListing" in types else
                         "empresa" if "LocalBusiness" in types or "Organization" in types else
                         "curso" if "Course" in types else "artigo"),
                "id": node.get("sku") or node.get("productID") or node.get("@id"),
                "title": node.get("name") or node.get("headline") or node.get("title"),
                "description": node.get("description"),
                "url": node.get("url") or source_url,
                "image_url": image_url if isinstance(image_url, str) else None,
                "price": offers.get("price"),
                "currency": offers.get("priceCurrency", "BRL"),
                "brand": (node.get("brand") or {}).get("name") if isinstance(node.get("brand"), dict) else node.get("brand"),
                "published_at": node.get("datePublished") or node.get("startDate"),
                "location": node.get("location"),
            })
    return items


def _html_to_source(page: str, source_url: str) -> dict:
    parser = HTMLMetadata()
    parser.feed(page)
    documents = []
    for script in parser.scripts:
        try:
            documents.append(json.loads(script))
        except (ValueError, TypeError):
            continue
    items = _jsonld_records(documents, source_url)
    if not items:
        meta = parser.meta
        items = [{
            "kind": "artigo",
            "title": meta.get("og:title") or compact("".join(parser.title_parts)),
            "description": meta.get("og:description") or meta.get("description"),
            "url": meta.get("og:url") or source_url,
            "image_url": meta.get("og:image"),
        }]
    return {"items": items, "title": compact("".join(parser.title_parts))}


def generic_links(data: dict, base: str) -> list[dict]:
    """Heurística genérica conservadora para produtos e outros registros.

    Itens sem preço devem ter um caminho semântico e texto suficientemente
    descritivo. Não transforma links de menus/rodapé em publicações.
    """
    results: list[dict] = []
    allowed_host = urlparse(base).hostname
    item_paths = re.compile(r"/(?:produto|product|products|item|listing|anuncio|anuncios|p|dp|imovel|imoveis|noticia|noticias|article|blog|post|evento|event|vaga|vagas|jobs|servico|service)/", re.I)
    for link in data.get("links", []):
        if not isinstance(link, dict):
            continue
        url = safe_http_url(link.get("href"), base)
        if not url:
            continue
        parsed = urlparse(url)
        if allowed_host and registrable_host(parsed.hostname) != registrable_host(allowed_host):
            continue
        raw = str(link.get("text") or "")[:2000]
        head = re.split(r"No\s+PIX\b", raw, maxsplit=1, flags=re.I)[0]
        prices = list(_money.finditer(head))
        semantic = bool(item_paths.search(parsed.path))
        if not semantic and not prices:
            continue
        heading = head[:prices[0].start()] if prices else head
        heading = _rating.sub("", heading)
        heading = re.sub(r"Frete\s+gr[áa]tis\s*\*?", "", heading, flags=re.I)
        title = compact(heading)
        if len(title) < (10 if prices else 24):
            continue
        if not prices and len(parsed.path.strip("/").split("/")) < 2:
            continue
        installments = _inst.search(raw)
        advertised = _discount.search(raw)
        price = decimal_text(prices[-1].group(1)) if prices else None
        previous = decimal_text(prices[-2].group(1)) if len(prices) > 1 else None
        warnings = []
        if advertised and price and previous and as_decimal(previous) > 0:
            calculated = (1 - as_decimal(price) / as_decimal(previous)) * 100
            if abs(calculated - Decimal(advertised.group(1).replace(",", "."))) > 2:
                warnings.append("desconto_anunciado_diverge_do_calculado")
        path_segments = [part for part in parsed.path.split("/") if part]
        item_id = path_segments[-1] if path_segments else hashlib.sha256(url.encode()).hexdigest()[:12]
        part = parsed.path.lower()
        kind = ("evento" if re.search(r"/(?:event|evento)/",part) else
                "vaga" if re.search(r"/(?:vaga|vagas|jobs)/",part) else
                "imovel" if re.search(r"/(?:imovel|imoveis)/",part) else
                "servico" if re.search(r"/(?:service|servico)/",part) else
                "artigo" if not prices else "produto")
        result = {
            "id":item_id, "title":title,"url":url,"price":price,
            "previous_price":previous,"kind":kind,"warnings":warnings,
            "rating":float(_rating.search(raw).group(1).replace(",",".")) if _rating.search(raw) else None,
            "stock":int(_stock.search(raw).group(1)) if _stock.search(raw) else None,
            "advertised_discount_pct":float(advertised.group(1).replace(",",".")) if advertised else None,
            "installment_count":int(installments.group(1)) if installments else None,
            "installment_value":decimal_text(installments.group(2)) if installments else None,
        }
        if link.get("image_url") or link.get("image"):
            result["image_url"] = safe_http_url(link.get("image_url") or link.get("image"), base)
        results.append(result)
    return results


def _flatten_products(data: object) -> tuple[list[dict], dict]:
    """Adapta formatos pré-processados, JSON de browser e HTML/JSON-LD."""
    if isinstance(data, list):
        return [v for v in data if isinstance(v, dict)], {}
    if not isinstance(data, dict):
        raise ValueError("Entrada precisa ser um objeto JSON, lista ou HTML")
    if isinstance(data.get("result"), dict):
        return _flatten_products(data["result"])
    if isinstance(data.get("produtos"), list):
        return data["produtos"], data.get("origem") or {}
    if isinstance(data.get("items"), list) or isinstance(data.get("records"), list):
        return data.get("items", data.get("records")) or [], data.get("source") or {}
    wrapper = data.get("data") if isinstance(data.get("data"), dict) else data
    base = data.get("finalUrl") or data.get("requestedUrl") or data.get("url") or ""
    parsed_base = urlparse(base)
    if "value" in wrapper:
        value = wrapper["value"]
        if isinstance(value, list):
            return [item for item in value if isinstance(item, dict)], {"url_final":base,"data_captura_utc":data.get("capturedAt")}
        if isinstance(value, dict):
            return _flatten_products({"data":value,"finalUrl":base,"capturedAt":data.get("capturedAt")})
        if isinstance(value, str) and value.strip():
            return [{"title":value.strip()[:160],"description":value[:1800],"url":base,"kind":"artigo"}], {"url_final":base,"data_captura_utc":data.get("capturedAt")}
    if isinstance(wrapper.get("structuredData"), list) and wrapper["structuredData"]:
        structured = _jsonld_records(wrapper["structuredData"], base)
        if structured:
            return structured, {"url_final":base,"titulo_pagina":wrapper.get("title"),"data_captura_utc":data.get("capturedAt")}
    if isinstance(wrapper.get("html"), str):
        page = _html_to_source(wrapper["html"], base)
        return page["items"], {"url_final": base, "titulo_pagina": page.get("title"), "data_captura_utc": data.get("capturedAt")}
    for key in ("items", "products", "results", "listings", "entries", "posts", "events", "articles", "services", "jobs", "offers", "records", "produtos"):
        if isinstance(wrapper.get(key), list):
            return wrapper[key], {"url_final": base, "data_captura_utc": data.get("capturedAt")}
    if isinstance(wrapper.get("data"), dict):
        nested, info = _flatten_products({"data":wrapper["data"],"finalUrl":base,"capturedAt":data.get("capturedAt")})
        return nested, info
    if isinstance(wrapper.get("links"), list):
        if parsed_base.hostname in {"www.kabum.com.br", "kabum.com.br"}:
            obj = adapter_kabum.refinement(data)
            return obj["produtos"], obj["origem"]
        extracted = generic_links(wrapper, base)
        if extracted:
            return extracted, {"url_final": base, "titulo_pagina": wrapper.get("title"), "data_captura_utc": data.get("capturedAt")}
    if wrapper.get("title") or wrapper.get("description") or wrapper.get("text"):
        open_graph = wrapper.get("openGraph") if isinstance(wrapper.get("openGraph"), dict) else {}
        text = compact(wrapper.get("text", ""))
        return [{"kind": "artigo", "title": wrapper.get("title") or data.get("title") or open_graph.get("title") or text[:140],
                 "description": wrapper.get("description") or open_graph.get("description") or text[:1000],
                 "url": open_graph.get("url") or base,
                 "image_url": wrapper.get("image_url") or wrapper.get("ogImage") or open_graph.get("image")}], {"url_final": base, "data_captura_utc": data.get("capturedAt")}
    if data.get("title") or data.get("titulo"):
        return [data], {"url_final": base}
    raise ValueError("Formato não reconhecido; forneça items, produtos, data.links ou HTML")


def normalize(source: object, query: str = "", media_map: dict | None = None,
              only_relevant: bool = False, max_items: int = 500) -> dict:
    raw_items, info = _flatten_products(source)
    media_map = media_map or {}
    normalized: list[dict] = []
    seen = set()
    used_ids: set[str] = set()
    base = info.get("url_final") or info.get("url") or ""
    term_tokens = re.findall(r"\w+", query.casefold())
    for p in raw_items:
        if len(normalized) >= max_items:
            break
        if not isinstance(p, dict):
            continue
        title = compact(p.get("titulo") or p.get("title") or p.get("name"))
        link = safe_http_url(p.get("url") or p.get("link") or p.get("href"), base)
        if not title:
            continue
        item_id = str(p.get("produto_id") or p.get("product_id") or p.get("id") or
                      hashlib.sha256((title + (link or "")).encode()).hexdigest()[:12])
        dedup_key = link or f"{item_id}:{title.casefold()}"
        if dedup_key in seen:
            continue
        seen.add(dedup_key)
        was_duplicated = item_id in used_ids
        if was_duplicated:
            suffix = hashlib.sha256((link or title).encode()).hexdigest()[:10]
            item_id = f"{item_id[:170]}-{suffix}"
        used_ids.add(item_id)
        relevant = all(token in title.casefold() for token in term_tokens) if term_tokens else True
        if only_relevant and not relevant:
            continue
        image_input = media_map.get(item_id) or media_map.get(link or "") or media_map.get(title)
        if image_input is None:
            image_input = (p.get("image_url") or p.get("imagem_url") or p.get("image")
                           or p.get("images") or p.get("image_urls") or p.get("primaryImage")
                           or p.get("thumbnail") or p.get("media"))
        candidate_images = image_input if isinstance(image_input, list) else ([image_input] if image_input else [])
        image_inputs = []
        for entry in candidate_images:
            if isinstance(entry, dict):
                # APIs de marketplaces e schema.org podem usar ImageObject.
                entry = next((entry[k] for k in ("contentUrl", "url", "image_url",
                              "original", "large", "src", "path")
                              if isinstance(entry.get(k), str) and entry[k]), None)
            if not isinstance(entry, str) or not entry.strip():
                continue
            spec = entry.strip()
            # Caminhos de URL relativos/sem esquema usam a origem da captura.
            # Nomes de arquivo simples permanecem válidos no modo CLI.
            if spec.startswith("/") and base:
                spec = safe_http_url(spec, base)
            if spec and spec not in image_inputs:
                image_inputs.append(spec)
            if len(image_inputs) >= 4:
                break
        image_input = image_inputs[0] if image_inputs else None
        warnings = list(p.get("alertas") or p.get("warnings") or [])
        if was_duplicated:
            warnings.append("identificador_original_repetido")
        cost = decimal_text(p.get("preco_pix") if p.get("preco_pix") is not None else p.get("price"))
        before = decimal_text(p.get("preco_anterior") if p.get("preco_anterior") is not None else p.get("previous_price"))
        classification = str(p.get("categoria") or p.get("category") or p.get("kind") or "").lower()
        if not classification and cost is None and p.get("description"):
            classification = "artigo"
        noncommercial = {"artigo", "article", "evento", "event", "servico", "service", "vaga", "job", "imovel", "empresa", "curso", "conteudo", "content", "recipe", "localbusiness", "organization"}
        if cost is None and classification not in noncommercial:
            warnings.append("preco_ausente")
        if not link:
            warnings.append("url_ausente_ou_invalida")
        installments = p.get("parcelamento") or {}
        if not isinstance(installments, dict):
            installments = {}
        discount = p.get("desconto_anunciado_pct", p.get("advertised_discount_pct"))
        review_blockers = {"identificador_original_repetido", "preco_ausente", "url_ausente_ou_invalida", "divergencia_cpu_titulo_url", "divergencia_gpu_titulo_url", "desconto_anunciado_diverge_do_calculado", "preco_anterior_menor_que_atual"}
        needs_review = bool(review_blockers.intersection(warnings))
        category = p.get("categoria") or p.get("category") or p.get("kind") or classification or "conteudo"
        normalized_kind = str(category).lower()
        if normalized_kind in {"article","newsarticle","blogposting","artigo"}:
            normalized_kind = "artigo"
        elif normalized_kind in {"product","produto","placa_video","notebook","computador","placa_mae","kit_gpu_fonte"}:
            normalized_kind = "produto"
        elif normalized_kind in {"service","servico"}:
            normalized_kind = "servico"
        elif normalized_kind in {"event","evento"}:
            normalized_kind = "evento"
        elif normalized_kind in {"job", "jobposting", "vaga"}:
            normalized_kind = "vaga"
        item = {
            "id": item_id,
            "kind": normalized_kind,
            "category": str(category),
            "title": title,
            "description": compact(p.get("descricao") or p.get("description"))[:1800] or None,
            "url": link,
            "price": cost,
            "previous_price": before,
            "currency": p.get("moeda") or p.get("currency") or "BRL",
            "sku": p.get("sku_anunciado") or p.get("sku"),
            "brand": p.get("marca") or p.get("brand"),
            "gpu_model": p.get("modelo_gpu"),
            "published_at": p.get("published_at") or p.get("datePublished"),
            "location": p.get("location"),
            "rating": p.get("avaliacao", p.get("rating")),
            "stock": p.get("quantidade_restante_anunciada", p.get("stock")),
            "free_shipping": p.get("frete_gratis_anunciado", p.get("free_shipping")),
            "coupon": p.get("cupom_anunciado", p.get("coupon")),
            "installments": {
                "count": installments.get("quantidade") or p.get("installment_count"),
                "amount": installments.get("valor_parcela") or p.get("installment_value"),
            },
            "advertised_discount_pct": discount,
            "calculated_discount_pct": p.get("desconto_calculado_pct"),
            "image_input": image_input,
            "image_inputs": image_inputs,
            "query_match": relevant,
            "warnings": sorted(set(warnings)),
            "requires_review": needs_review,
            "publication_status": "revisao" if needs_review else "rascunho",
            "source": {
                "url": base,
                "captured_at": info.get("data_captura_utc") or info.get("capturedAt"),
                "name": info.get("loja") or (urlparse(base).hostname or "Origem") ,
            },
            "source_record": p,
        }
        normalized.append(item)
    issue_counter = Counter(w for p in normalized for w in p["warnings"])
    return {
        "schema_version": "2.0.0",
        "source": info,
        "query": query,
        "total": len(normalized),
        "raw_items": len(raw_items),
        "selected_relevant_only": only_relevant,
        "review_required": sum(p["requires_review"] for p in normalized),
        "warnings_by_type": dict(sorted(issue_counter.items())),
        "items": normalized,
    }
