"""Modelos de publicação e arquivos individuais prontos para revisão/distribuição."""
from __future__ import annotations

import hashlib
import html
import json
import re
import unicodedata
from datetime import datetime
from email.message import EmailMessage
from pathlib import Path
from urllib.parse import urlparse
from zoneinfo import ZoneInfo

from .ingestion import format_money


def safe_slug(item: dict) -> str:
    title = str(item.get("title", "item"))[:48]
    ascii_title = unicodedata.normalize("NFKD", title).encode("ascii", "ignore").decode().lower()
    first = re.sub(r"[^a-z0-9]+", "-", ascii_title).strip("-")[:45] or "item"
    identity = re.sub(r"[^a-zA-Z0-9_-]", "", str(item.get("id", "")))[:22]
    if not identity:
        identity = hashlib.sha256(title.encode()).hexdigest()[:10]
    return f"{identity}-{first}"


def capture_stamp(item: dict) -> str:
    source = (item.get("source") or {}).get("captured_at")
    if not source:
        return "data não informada"
    try:
        dt = datetime.fromisoformat(source.replace("Z", "+00:00"))
        return dt.astimezone(ZoneInfo("America/Sao_Paulo")).strftime("%d/%m/%Y às %H:%M")
    except (ValueError, OverflowError):
        return "data não informada"


def _extract_text(item: dict) -> tuple[str, str]:
    title = str(item["title"])
    price = format_money(item.get("price"), item.get("currency"))
    if not price:
        return title, "Confira os detalhes"
    return title, (f"{price} no Pix" if item.get("kind") == "produto" and item.get("currency", "BRL") == "BRL" else price)


def whatsapp_caption(item: dict) -> str:
    name, price = _extract_text(item)
    # Limites pensados para legenda de imagem da WhatsApp Cloud API (<=1024 caracteres).
    name = name[:245].rstrip()
    parts = [f"*{name}*", "", f"💰 {price}"]
    n = item.get("installments") or {}
    if n.get("count") and n.get("amount"):
        parts.append(f"💳 {n['count']}x de {format_money(n['amount'], item.get("currency"))} (conforme anúncio)")
    coupon = item.get("coupon")
    if coupon:
        parts.append(f"🏷️ Cupom anunciado: {coupon}")
    if item.get("free_shipping") is True:
        parts.append("🚚 Frete grátis anunciado (verifique as condições)")
    parts += ["", "🔗 " + (item.get("url") or "URL indisponível"), "", "ℹ️ Dados capturados em " + capture_stamp(item) + ". Confira preço e estoque no site."]
    caption = "\n".join(parts)
    if len(caption) > 1024:
        # Preserva obrigatoriamente o link e o aviso de captura ao encurtar o nome.
        title_limit = max(40, 245 - (len(caption) - 1024) - 10)
        parts[0] = f"*{name[:title_limit].rstrip()}…*"
        caption = "\n".join(parts)
    if len(caption) > 1024:
        caption = (f"*{name[:100]}*\n{price}\n{item.get('url') or ''}\nDados capturados em {capture_stamp(item)}. Confira no site.")
    if len(caption) > 1024:
        raise ValueError("URL excessivamente longa para a legenda; disponibilize uma URL canônica menor")
    return caption


def telegram_caption(item: dict) -> str:
    caption = html.escape(str(item["title"])[:250])
    price = format_money(item.get("price"), item.get("currency"))
    msg = f"<b>{caption}</b>\n"
    if price:
        msg += f"💰 {html.escape(price)}{' no Pix' if item.get('kind') == 'produto' and item.get('currency', 'BRL') == 'BRL' else ''}\n"
    if item.get("coupon"):
        msg += f"🏷️ Cupom: {html.escape(str(item['coupon']))}\n"
    msg += f"\n{html.escape(str(item.get('url') or ''))}\n"
    msg += f"<i>Captura: {html.escape(capture_stamp(item))}. Verifique no site.</i>"
    return msg[:1024]


def plain_email(item: dict) -> str:
    title, price = _extract_text(item)
    blocks = [title, "", f"Preço anunciado: {price}"]
    if item.get("previous_price"):
        blocks.append(f"Preço anterior exibido: {format_money(item['previous_price'], item.get("currency"))}")
    if item.get("coupon"):
        blocks.append(f"Cupom anunciado: {item['coupon']}")
    if item.get("description"):
        blocks.extend(["", str(item["description"])[:650]])
    blocks.extend(["", "Acesse o anúncio:", item.get("url") or "Link não informado", "",
                   f"Fonte: {(item.get('source') or {}).get('name', 'Origem')}",
                   f"Capturado em: {capture_stamp(item)}",
                   "Preço, condições e disponibilidade devem ser confirmados no site.",
                   "", "Mensagem para destinatários que consentiram em receber comunicações."])
    return "\n".join(blocks)


def email_html(item: dict, src: str = "card-square.png") -> str:
    title = html.escape(item["title"])
    source = html.escape(str((item.get("source") or {}).get("name") or "Conteúdo selecionado"))
    url = html.escape(str(item.get("url") or ""), quote=True)
    price = format_money(item.get("price"), item.get("currency"))
    pix_text = 'no Pix' if item.get("kind") == "produto" and item.get("currency", "BRL") == "BRL" else ''
    price_html = (f'<p style="font-size:32px;font-weight:800;color:#047c88;margin:12px 0">{html.escape(price)} <small style="font-size:14px;font-weight:normal">{pix_text}</small></p>' if price else "")
    about = html.escape(str(item.get("description") or ""))
    description = f'<p style="color:#526374;line-height:1.6">{about}</p>' if about else ""
    safe_src = html.escape(src, quote=True)
    action = f'<a href="{url}" style="display:inline-block;padding:14px 22px;border-radius:8px;background:#047c88;color:white;text-decoration:none;font-weight:700">Conferir anúncio</a>' if url else ""
    warnings = '<p style="font-size:12px;color:#92531e">Esta oferta contém dados que exigem revisão antes de qualquer envio.</p>' if item.get("requires_review") else ""
    return f'''<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>{title}</title></head>
<body style="margin:0;background:#f1f5f9;font-family:Arial,Helvetica,sans-serif;color:#14283a">
<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;padding:24px 12px;background:#f1f5f9"><tr><td align="center">
<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;max-width:620px;background:white;border-radius:14px;overflow:hidden">
<tr><td style="padding:20px 26px;background:#fff;border-bottom:3px solid #047c88;font-size:18px;font-weight:700">{source}</td></tr>
<tr><td style="padding:20px 26px 6px"><img src="{safe_src}" width="568" alt="Arte de divulgação: {title}" style="width:100%;height:auto;display:block;border-radius:10px"></td></tr>
<tr><td style="padding:12px 26px 27px"><h1 style="font-size:23px;line-height:1.3;margin:0">{title}</h1>{price_html}{description}{action}{warnings}
<p style="font-size:12px;line-height:1.7;color:#65748a;margin-top:23px">Captura em {html.escape(capture_stamp(item))}. Confirme preços, estoque, frete e condições no site de origem.</p></td></tr>
</table><div style="max-width:610px;padding:16px;font-size:12px;color:#617286">Conteúdo preparado para lista com consentimento. O envio exige mecanismo de descadastramento conforme sua operação e legislação aplicável.</div>
</td></tr></table></body></html>'''


def write_eml(item: dict, output: Path, image_path: Path) -> None:
    """Rascunho MIME com imagem inline; sem destinatário nem remetente fictício."""
    mail = EmailMessage()
    mail["Subject"] = str(item["title"])[:150]
    mail.set_content(plain_email(item))
    mail.add_alternative(email_html(item, "cid:imagem_publicacao"), subtype="html")
    mail.get_payload()[-1].add_related(image_path.read_bytes(), maintype="image", subtype="png", cid="<imagem_publicacao>", filename="publicacao.png")
    output.write_bytes(mail.as_bytes())


def social_captions(item: dict) -> dict:
    price = format_money(item.get("price"), item.get("currency"))
    name = item["title"]
    url = item.get("url") or ""
    offer = (f"\n💰 {price}{' no Pix' if item.get('kind') == 'produto' and item.get('currency', 'BRL') == 'BRL' else ''}" if price else "")
    disclosure = f"\n\nConsulta: {capture_stamp(item)}. Confirme no site."
    return {
        "facebook": f"{name}{offer}\n\n🔗 {url}{disclosure}",
        "instagram": f"{name}{offer}{disclosure}\n\nLink do anúncio: {url}\n(Links na legenda do Instagram podem não ser clicáveis.)",
        "linkedin": f"{name}{offer}\n\nFonte: {(item.get('source') or {}).get('name', 'Origem')}\n{url}{disclosure}",
        "sms": f"{name[:75]} - {price or 'Consulte'} - {url} (captura {capture_stamp(item)})",
    }


def whatsapp_preview_html(item: dict, caption: str) -> str:
    """Simulador visual: não representa a UI oficial do WhatsApp."""
    safe_title = html.escape(item["title"])
    safe_domain = html.escape(urlparse(item.get("url") or "").hostname or "Origem")
    safe_caption = html.escape(caption).replace("\n", "<br>")
    safe_caption = re.sub(r"\*([^*<]{1,260})\*", r"<strong>\1</strong>", safe_caption)
    stamp = html.escape(capture_stamp(item))
    return f'''<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Prévia WhatsApp — {safe_title}</title>
<style>*{{box-sizing:border-box}}body{{font:14px Arial,Helvetica,sans-serif;background:#e9edef;margin:0;color:#152b33}}header{{padding:16px;text-align:center;background:white;border-bottom:1px solid #ddd}}header strong{{font-size:16px}}header p{{color:#60737f;font-size:12px}}main{{padding:32px 12px;min-height:90vh;background-color:#e6ded4;background-image:radial-gradient(#b8b6ad44 1px,transparent 1px);background-size:22px 22px}}.bubble{{background:#dcf8c6;border-radius:12px 12px 2px 12px;max-width:380px;padding:8px;margin:12px auto;box-shadow:0 1px 3px #1112}}.label{{font-weight:700;color:#2a826e;margin:4px 0 8px 5px}}.preview{{background:#fff;border-radius:8px;overflow:hidden}}.preview img{{width:100%;display:block}}.preview .detail{{padding:12px}}.preview b{{font-size:15px;line-height:1.4}}.preview small{{display:block;margin-top:6px;color:#70828e}}.message{{white-space:normal;padding:13px 5px 7px;font-size:14px;line-height:1.54;overflow-wrap:anywhere}}.message a{{color:#028c65}}.stamp{{font-size:10px;color:#647976;text-align:right;padding:3px 6px 6px}}</style></head>
<body><header><strong>Prévia de mensagem com imagem e legenda</strong><p>Representação para revisão. A apresentação real depende do WhatsApp e do tipo de mensagem.</p></header>
<main><div class="bubble"><div class="label">Publicação preparada</div><div class="preview"><img src="card-square.png" alt="Arte da publicação"><div class="detail"><b>{safe_title}</b><small>{safe_domain}</small></div></div>
<div class="message">{safe_caption}</div><div class="stamp">Captura {stamp}</div></div></main></body></html>'''


def write_post_files(item: dict, directory: Path, *, public_base_url: str | None,
                     image_info: dict, status: str) -> dict:
    directory.mkdir(parents=True, exist_ok=True)
    slug = directory.name
    whatsapp_text = whatsapp_caption(item)
    telegram_text = telegram_caption(item)
    (directory / "whatsapp.txt").write_text(whatsapp_text, encoding="utf-8")
    (directory / "whatsapp_preview.html").write_text(whatsapp_preview_html(item,whatsapp_text), encoding="utf-8")
    (directory / "telegram.html.txt").write_text(telegram_text, encoding="utf-8")
    (directory / "email.txt").write_text(plain_email(item), encoding="utf-8")
    (directory / "email.html").write_text(email_html(item), encoding="utf-8")
    write_eml(item, directory / "email.eml", directory / "card-square.png")
    social = social_captions(item)
    for channel, value in social.items():
        (directory / f"{channel}.txt").write_text(value, encoding="utf-8")
    (directory / "redes_sociais.json").write_text(json.dumps(social, ensure_ascii=False, indent=2), encoding="utf-8")
    # Publicação estática (não publicada pelo programa). Preview OG depende de URL externa acessível.
    absolute_landing = f"{public_base_url.rstrip('/')}/{slug}/landing.html" if public_base_url else ""
    absolute_image = f"{public_base_url.rstrip('/')}/{slug}/card-wide.png" if public_base_url and (directory/"card-wide.png").exists() else (
        f"{public_base_url.rstrip('/')}/{slug}/card-square.png" if public_base_url else "")
    og = (f'<meta property="og:url" content="{html.escape(absolute_landing, quote=True)}"><meta property="og:image" content="{html.escape(absolute_image, quote=True)}"><meta name="twitter:card" content="summary_large_image">' if public_base_url else "")
    landing = f'''<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>{html.escape(item['title'])}</title>
<meta property="og:title" content="{html.escape(item['title'],quote=True)}"><meta property="og:description" content="{html.escape(str(item.get('description') or (format_money(item.get('price'), item.get('currency')) or 'Confira o anúncio')),quote=True)}">{og}
<style>body{{font-family:system-ui,Arial;background:#f2f6f9;color:#17293d;margin:0;padding:24px}}main{{margin:auto;max-width:570px;background:white;border-radius:16px;overflow:hidden;box-shadow:0 15px 35px #12223313}}img{{max-width:100%;display:block}}article{{padding:24px}}a{{color:#027481;overflow-wrap:anywhere}}small{{color:#627186}}</style></head>
<body><main><img src="card-square.png" alt="Arte de publicação"><article><h1>{html.escape(item['title'])}</h1><h2>{html.escape(format_money(item.get('price'), item.get('currency')) or '')}</h2><p><a rel="nofollow noopener noreferrer" href="{html.escape(item.get('url') or '#',quote=True)}">Ver conteúdo original</a></p><small>Dados coletados em {html.escape(capture_stamp(item))}. Verifique as condições na origem.</small></article></main></body></html>'''
    (directory / "landing.html").write_text(landing, encoding="utf-8")
    (directory / "record.json").write_text(json.dumps(item, ensure_ascii=False, indent=2), encoding="utf-8")
    wa_payload = {
        "messaging_product": "whatsapp", "to": "<DESTINATARIO_E164>", "type": "image",
        "image": {"id": "<MEDIA_ID_DEVOLVIDO_PELO_UPLOAD>", "caption": whatsapp_text},
        "note": "Enviar mídia primeiro à API /media. A aplicação realiza o upload no comando send."
    }
    tg_payload = {"chat_id": "<CHAT_ID>", "caption": telegram_text, "parse_mode": "HTML", "photo_file": "card-square.png"}
    webhook = {"event": "publication.ready_for_review", "record_id": item["id"], "publication_status": status,
               "record": {"id": item["id"], "title": item["title"], "url": item.get("url"),
                          "price": item.get("price"), "currency": item.get("currency")},
               "channels": ["whatsapp", "email", "telegram", "facebook", "instagram", "linkedin", "sms"]}
    for name, payload in (("whatsapp_payload_template.json", wa_payload), ("telegram_payload_template.json", tg_payload), ("webhook.json", webhook)):
        (directory / name).write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    own_files = sorted(path.name for path in directory.iterdir() if path.is_file())
    return {"id": item["id"], "slug": slug, "status": status, "requires_review": item["requires_review"],
            "warnings": item["warnings"], "url": item.get("url"), "image": image_info,
            "files": own_files}


def write_index(job_dir: Path, records: list[dict], slug_by_id: dict[str, str]) -> None:
    cards = []
    for r in records:
        slug = slug_by_id[r["id"]]
        title = html.escape(r["title"])
        status = "Revisar" if r["requires_review"] else "Rascunho"
        source = (r.get("source") or {}).get("name") or "Origem"
        cards.append(f'''<article class="card"><a href="publicacoes/{slug}/landing.html"><img loading="lazy" alt="Arte da publicação" src="publicacoes/{slug}/card-square.png"></a><div class="pad"><div class="meta">{html.escape(str(source))} · {status}</div><h2>{title}</h2><div class="price">{html.escape(format_money(r.get('price'),r.get('currency')) or 'Sem preço anunciado')}</div><p class="links"><a href="publicacoes/{slug}/whatsapp_preview.html">WhatsApp</a><a href="publicacoes/{slug}/email.html">E-mail</a><a href="publicacoes/{slug}/record.json">Dados</a></p></div></article>''')
    page = f'''<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Prévia das publicações</title><style>
:root{{color-scheme:light}}body{{font-family:system-ui,Arial;color:#182a39;background:#f4f7fa;margin:0}}header{{background:white;padding:32px min(6vw,90px);border-bottom:1px solid #e1e8ec}}h1{{font-size:32px;margin:0 0 12px}}p{{line-height:1.55}}.muted,.meta{{color:#687b8e;font-size:13px}}main{{max-width:1320px;margin:auto;padding:35px 26px}}.grid{{display:grid;grid-template-columns:repeat(auto-fill,minmax(270px,1fr));gap:24px}}.card{{background:white;border:1px solid #e3ebef;border-radius:18px;overflow:hidden;box-shadow:0 5px 18px #1b31440c}}img{{display:block;width:100%;aspect-ratio:1;object-fit:cover}}.pad{{padding:18px}}h2{{font-size:16px;line-height:1.4;min-height:68px}}.price{{font-size:24px;color:#047c88;font-weight:800}}a{{color:#036b75}}.links{{display:flex;gap:16px;font-size:14px}}a:hover{{text-decoration:none}}</style></head>
<body><header><h1>Publicações preparadas</h1><p class="muted">{len(records)} itens · prévias para revisão · nenhum envio realizado. Imagens sem foto original estão identificadas como ilustrativas.</p></header><main><div class="grid">{''.join(cards)}</div></main></body></html>'''
    (job_dir / "index.html").write_text(page, encoding="utf-8")
