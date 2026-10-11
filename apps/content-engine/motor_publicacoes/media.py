"""Imagens, com mídia original opcional e capa ilustrativa honesta como fallback.

- Nenhuma imagem de produto é inventada ou atribuída a um anúncio.
- Busca externa SOMENTE com fetch_images=True, HTTPS e verificação de IP público.
- Arquivos locais só são aceitos dentro do diretório media_root configurado.
"""
from __future__ import annotations

import hashlib
import http.client
import ipaddress
import io
import os
import re
import socket
import ssl
from datetime import datetime
from pathlib import Path
from urllib.parse import urljoin, urlparse
from zoneinfo import ZoneInfo

from PIL import Image, ImageDraw, ImageFont, ImageOps, UnidentifiedImageError

from .ingestion import format_money

MAX_IMAGE_BYTES = 8 * 1024 * 1024


def _font(size: int, bold: bool = False):
    paths = (
        ["/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", "/usr/share/fonts/truetype/lato/Lato-Bold.ttf"]
        if bold else
        ["/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "/usr/share/fonts/truetype/lato/Lato-Regular.ttf"]
    )
    for path in paths:
        if Path(path).exists():
            return ImageFont.truetype(path, size=size)
    return ImageFont.load_default()


def _resolve_public_ip(host: str) -> str:
    if host.lower() in {"localhost", "localhost.localdomain"}:
        raise ValueError("Destino privado proibido")
    options = []
    for _, _, _, _, addr in socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM):
        ip = ipaddress.ip_address(addr[0])
        if not ip.is_global:
            raise ValueError("URL resolve para endereço não público")
        options.append(str(ip))
    if not options:
        raise ValueError("Não foi possível resolver o host")
    return options[0]



def safe_online_image_url(spec: object) -> str | None:
    """URL HTTPS de imagem com destino DNS público para prévia opcional."""
    if not isinstance(spec, str) or len(spec) > 2048:
        return None
    parsed = urlparse(spec.strip())
    if (parsed.scheme != "https" or not parsed.hostname or
            parsed.username or parsed.password or parsed.port not in (None, 443)):
        return None
    try:
        _resolve_public_ip(parsed.hostname)
    except (OSError, ValueError, OverflowError):
        return None
    return parsed._replace(fragment="").geturl()


def save_original_preview(image: Image.Image, out: Path) -> dict:
    """Fotografia capturada para consulta privada, sem arte promocional."""
    photo = image.copy()
    photo.thumbnail((1800, 1800), Image.Resampling.LANCZOS)
    out.parent.mkdir(parents=True, exist_ok=True)
    photo.save(out, format="WEBP", quality=90, method=5)
    return {"file": out.name, "width": photo.width, "height": photo.height}



def fetch_public_image(url: str, max_redirects: int = 3) -> bytes:
    """HTTPS com TLS verificado e IP de destino fixado contra DNS rebinding."""
    for _ in range(max_redirects + 1):
        parsed = urlparse(url)
        if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.port not in (None, 443):
            raise ValueError("Imagens externas requerem URL HTTPS pública na porta 443")
        ip = _resolve_public_ip(parsed.hostname)
        context = ssl.create_default_context()
        with socket.create_connection((ip, 443), timeout=10) as sock:
            with context.wrap_socket(sock, server_hostname=parsed.hostname) as tls:
                path = parsed.path or "/"
                if parsed.query:
                    path += "?" + parsed.query
                tls.sendall((f"GET {path} HTTP/1.1\r\nHost: {parsed.hostname}\r\n"
                             f"User-Agent: MotorPublicacoes/2.0\r\nAccept: image/jpeg,image/png,image/webp\r\n"
                             "Connection: close\r\n\r\n").encode("utf-8"))
                response = http.client.HTTPResponse(tls)
                response.begin()
                if response.status in (301, 302, 303, 307, 308):
                    destination = response.getheader("Location", "")
                    if not destination:
                        raise ValueError("Redirect sem Location")
                    url = urljoin(url, destination)
                    continue
                if response.status != 200:
                    raise ValueError(f"Falha HTTP ao consultar imagem: {response.status}")
                content_type = (response.getheader("Content-Type", "").split(";")[0]).lower()
                if content_type not in {"image/png", "image/jpeg", "image/webp"}:
                    raise ValueError("O recurso não é uma imagem PNG/JPEG/WebP")
                length = response.getheader("Content-Length")
                if length and int(length) > MAX_IMAGE_BYTES:
                    raise ValueError("Imagem excede limite de tamanho")
                raw = response.read(MAX_IMAGE_BYTES + 1)
                if len(raw) > MAX_IMAGE_BYTES:
                    raise ValueError("Imagem excede limite de tamanho")
                return raw
    raise ValueError("Imagem redirecionada muitas vezes")


def read_media(spec: object, *, media_root: Path | None, fetch_images: bool) -> tuple[Image.Image | None, str | None, str | None]:
    if not spec:
        return None, None, "imagem_nao_fornecida"
    spec = str(spec)
    try:
        if spec.startswith("https://"):
            if not fetch_images:
                return None, spec, "download_externo_desativado"
            data = fetch_public_image(spec)
            source = spec
        else:
            if spec.startswith("http://"):
                return None, spec, "imagem_exige_https"
            if media_root is None:
                return None, None, "diretorio_de_imagens_nao_configurado"
            root = media_root.resolve()
            path = (root / spec).resolve()
            if not path.is_relative_to(root) or not path.is_file():
                return None, None, "imagem_local_inexistente_ou_fora_do_diretorio"
            if path.stat().st_size > MAX_IMAGE_BYTES:
                return None, None, "imagem_excede_limite"
            data = path.read_bytes()
            source = str(path)
        Image.MAX_IMAGE_PIXELS = 35_000_000
        img = Image.open(io.BytesIO(data))
        img.load()
        if img.format not in {"PNG", "JPEG", "WEBP"}:
            return None, source, "formato_de_imagem_invalido"
        return ImageOps.exif_transpose(img).convert("RGB"), source, None
    except (OSError, UnidentifiedImageError, Image.DecompressionBombError, ValueError, OverflowError) as err:
        return None, None, f"erro_imagem:{type(err).__name__}"


def _wrap(draw: ImageDraw.ImageDraw, text: str, font, max_width: int, max_lines: int) -> list[str]:
    words = re.split(r"\s+", text or "")
    lines = []
    line = ""
    for word in words:
        maybe = (line + " " + word).strip()
        if draw.textbbox((0, 0), maybe, font=font)[2] <= max_width:
            line = maybe
        else:
            if line:
                lines.append(line)
            line = word
            if len(lines) >= max_lines:
                break
    if line and len(lines) < max_lines:
        lines.append(line)
    # Se há conteúdo truncado, sinalizar reticências.
    if len(" ".join(lines)) < len(text.strip()) and lines:
        last = lines[-1]
        while last and draw.textbbox((0, 0), last + "…", font=font)[2] > max_width:
            last = last[:-1]
        lines[-1] = last.rstrip() + "…"
    return lines


def _rounded_pill(draw, xy, text, fill, foreground, font):
    draw.rounded_rectangle(xy, radius=22, fill=fill)
    bx = draw.textbbox((0, 0), text, font=font)
    cy = (xy[1] + xy[3] - (bx[3]-bx[1])) // 2 - bx[1]
    draw.text((xy[0]+18, cy), text, font=font, fill=foreground)


def _fallback_art(draw, xy, accent: tuple[int,int,int]):
    x1, y1, x2, y2 = xy
    cx, cy = (x1+x2)//2, (y1+y2)//2 - 25
    draw.rounded_rectangle((cx-200, cy-105, cx+200, cy+105), radius=30, outline="#b6c2d1", width=7, fill="#f3f6fa")
    draw.ellipse((cx-138, cy-66, cx-18, cy+54), width=6, outline=accent)
    draw.ellipse((cx+18, cy-66, cx+138, cy+54), width=6, outline=accent)
    draw.line((cx-180, cy+122, cx+180, cy+122), fill="#c2ccda", width=6)
    font = _font(27, False)
    label = "Imagem original não fornecida"
    w = draw.textbbox((0, 0), label, font=font)[2]
    draw.text((cx-w//2, cy+170), label, font=font, fill="#607085")


def _capture_date(record: dict) -> str:
    value = (record.get("source") or {}).get("captured_at")
    if value:
        try:
            dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
            return dt.astimezone(ZoneInfo("America/Sao_Paulo")).strftime("%d/%m/%Y")
        except (ValueError, OverflowError):
            pass
    return "data da captura não informada"


def render_card(item: dict, out: Path, *, kind: str = "square", original: Image.Image | list[Image.Image] | None = None,
                accent: str = "#047c88") -> dict:
    """Gera arte promocional. Sem mídia real, imagem é explicitamente ilustrativa."""
    if kind not in {"square", "story", "wide"}:
        raise ValueError("Formato inválido")
    w, h = {"square": (1080, 1080), "story": (1080, 1920), "wide": (1200, 630)}[kind]
    canvas = Image.new("RGB", (w, h), "#f4f7fa")
    draw = ImageDraw.Draw(canvas)
    ac = tuple(int(accent[i:i+2], 16) for i in (1,3,5))
    draw.rounded_rectangle((36, 32, w-36, h-32), radius=38, fill="#ffffff")
    draw.rounded_rectangle((36, 32, w-36, 46), radius=6, fill=ac)
    short_name = ((item.get("source") or {}).get("name") or "Conteúdo selecionado")[:25]
    draw.text((76, 71), short_name, font=_font(31, True), fill="#102e40")
    draw.text((w-275, 77), "PUBLICAÇÃO", font=_font(21, True), fill=ac)
    if kind == "wide":
        photo_box = (64, 138, 510, 560)
        text_box = (550, 156, w-86, h-100)
    else:
        photo_box = (76, 134, w-76, 545 if kind == "square" else 1100)
        text_box = (76, 570 if kind == "square" else 1150, w-76, h-82)
    draw.rounded_rectangle(photo_box, radius=27, fill="#f5f8fb", outline="#e1e8ef", width=3)
    originals = (original if isinstance(original, list) else ([original] if original else []))[:4]
    if originals:
        pad = 20
        area = (photo_box[0]+pad, photo_box[1]+pad, photo_box[2]-pad, photo_box[3]-pad)
        cells = []
        n = len(originals)
        if n == 1:
            cells = [area]
        elif n == 2:
            if kind == "wide":
                mid = (area[0]+area[2])//2
                cells = [(area[0],area[1],mid-6,area[3]),(mid+6,area[1],area[2],area[3])]
            else:
                mid = (area[1]+area[3])//2
                cells = [(area[0],area[1],area[2],mid-6),(area[0],mid+6,area[2],area[3])]
        else:
            midx, midy = (area[0]+area[2])//2, (area[1]+area[3])//2
            cells = [(area[0],area[1],midx-6,midy-6),(midx+6,area[1],area[2],midy-6),
                     (area[0],midy+6,midx-6,area[3]),(midx+6,midy+6,area[2],area[3])][:n]
        for picture, cell in zip(originals, cells):
            bx = (cell[2]-cell[0], cell[3]-cell[1])
            reduced = picture.copy()
            reduced.thumbnail(bx, Image.Resampling.LANCZOS)
            ox = cell[0] + (bx[0]-reduced.width)//2
            oy = cell[1] + (bx[1]-reduced.height)//2
            canvas.paste(reduced, (ox, oy))
    else:
        _fallback_art(draw, photo_box, ac)
    title = item.get("title") or "Conteúdo"
    if kind == "wide":
        x, y, r = 550, 166, w-75
        title_font, price_font, maxlines, lineheight = _font(38, True), _font(57, True), 4, 50
    else:
        x, y, r = 79, text_box[1], w-79
        title_font, price_font, maxlines, lineheight = _font(48 if kind == "square" else 61, True), _font(78 if kind == "square" else 86, True), (3 if kind == "square" else 5), (58 if kind == "square" else 80)
    lines = _wrap(draw, title, title_font, r-x, maxlines)
    for line in lines:
        draw.text((x,y), line, font=title_font, fill="#15283a")
        y += lineheight
    price = format_money(item.get("price"), item.get("currency"))
    if price:
        y += 13 if kind == "wide" else 15
        draw.text((x, y), price, font=price_font, fill=ac)
        y += 90 if kind == "square" else 103 if kind == "story" else 66
        draw.text((x, y), "Preço capturado no Pix" if item.get("kind") == "produto" and item.get("currency", "BRL") == "BRL" else "Preço informado na captura", font=_font(23 if kind != "story" else 28), fill="#66788e")
    elif item.get("description"):
        y += 12
        for line in _wrap(draw, item["description"], _font(26), r-x, 3):
            draw.text((x,y), line, font=_font(26), fill="#526579")
            y += 36
    if kind != "wide":
        footer_y = h-119
        draw.line((76, footer_y, w-76, footer_y), fill="#dfe6ed", width=2)
        draw.text((78, footer_y+22), f"Capturado: {_capture_date(item)} • Confira no site", font=_font(23), fill="#647388")
        if item.get("requires_review"):
            draw.text((78, footer_y-38), "DADOS SUJEITOS A REVISÃO", font=_font(21, True), fill="#bb6128")
    else:
        draw.text((548, h-78), "Confira informações e disponibilidade no anúncio", font=_font(19), fill="#647388")
    out.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(out, format="PNG", optimize=True)
    return {"file": out.name, "width": w, "height": h, "source_image_used": bool(originals), "source_images_count": len(originals),
            "fallback_is_illustrative": not bool(originals)}


def fetch_public_html(url: str, max_redirects: int = 3) -> str:
    """Lê apenas HTML público para descobrir fotos OG/JSON-LD. Sem JS nem cookies."""
    for _ in range(max_redirects + 1):
        p = urlparse(url)
        if p.scheme != "https" or not p.hostname or p.port not in (None,443) or p.username or p.password:
            raise ValueError("Enriquecimento aceita apenas HTTPS público")
        ip = _resolve_public_ip(p.hostname)
        with socket.create_connection((ip,443),timeout=10) as sock:
            with ssl.create_default_context().wrap_socket(sock,server_hostname=p.hostname) as tls:
                path = p.path or "/"
                if p.query:
                    path += "?"+p.query
                tls.sendall((f"GET {path} HTTP/1.1\r\nHost: {p.hostname}\r\n"
                             "User-Agent: MotorPublicacoes/2.0 (metadata-only)\r\n"
                             "Accept: text/html,application/xhtml+xml\r\nConnection: close\r\n\r\n").encode())
                response=http.client.HTTPResponse(tls)
                response.begin()
                if response.status in (301,302,303,307,308):
                    redirect=response.getheader("Location")
                    if not redirect:
                        raise ValueError("Redirect inválido")
                    new_url=urljoin(url,redirect)
                    from .ingestion import registrable_host
                    if registrable_host(urlparse(new_url).hostname) != registrable_host(p.hostname):
                        raise ValueError("Redirect para outro domínio não permitido")
                    url=new_url
                    continue
                if response.status!=200:
                    raise ValueError(f"Não foi possível ler metadados da página (HTTP {response.status})")
                ct=(response.getheader("Content-Type") or "").lower()
                if "text/html" not in ct and "application/xhtml+xml" not in ct:
                    raise ValueError("Resposta não é HTML")
                length=response.getheader("Content-Length")
                if length and int(length)>1_500_000:
                    raise ValueError("HTML excede limite de 1,5 MB")
                raw=response.read(1_500_001)
                if len(raw)>1_500_000:
                    raise ValueError("HTML excede limite de 1,5 MB")
                return raw.decode("utf-8",errors="replace")
    raise ValueError("Limite de redirects do HTML excedido")


def image_from_product_html(page: str, url: str, expected_title: str = "") -> str | None:
    """Busca foto do produto correto; evita imagens de produtos recomendados."""
    from .ingestion import HTMLMetadata, _html_to_source, compact, safe_http_url

    def matches(value: str) -> bool:
        if not expected_title:
            return True
        actual = {t for t in re.findall(r"\w+", compact(value).casefold()) if len(t) >= 4}
        expected = {t for t in re.findall(r"\w+", compact(expected_title).casefold()) if len(t) >= 4}
        return len(actual & expected) >= (2 if len(expected) >= 3 else 1)

    parser = HTMLMetadata()
    parser.feed(page)
    payload = _html_to_source(page, url)
    for row in payload["items"]:
        if row.get("kind") != "produto" or not row.get("image_url"):
            continue
        if not matches(str(row.get("title") or "")):
            continue
        safe = safe_http_url(row["image_url"], url)
        if safe and safe.startswith("https://"):
            return safe

    title = parser.meta.get("og:title") or compact("".join(parser.title_parts))
    if matches(title):
        og = (parser.meta.get("og:image:secure_url") or
              parser.meta.get("og:image") or parser.meta.get("twitter:image"))
        safe = safe_http_url(og, url)
        if safe and safe.startswith("https://"):
            return safe

    for alt, raw in parser.image_candidates:
        if not alt or not matches(alt):
            continue
        safe = safe_http_url(raw, url)
        if safe and safe.startswith("https://") and not re.search(
            r"(?:placeholder|no[-_]?image|spinner|logo|\.svg(?:[?#]|$))", safe, re.I
        ):
            return safe
    return None
