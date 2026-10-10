// Safe, dependency-free online documentation renderer.
export function escapeHtml(v) {
  return String(v)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
function linkTarget(input) {
  const uri = String(input).trim();
  if (/^(?:\.\/)?[a-z0-9_-]+\.md(?:#[a-z0-9_-]+)?$/i.test(uri)) {
    const [file, section] = uri.replace(/^\.\//, "").split("#");
    return (
      "/docs/viewer.html?doc=" +
      encodeURIComponent(file.slice(0, -3)) +
      (section ? "#" + encodeURIComponent(section) : "")
    );
  }
  if (
    /^https:\/\//i.test(uri) ||
    /^#[a-z0-9_-]+$/i.test(uri) ||
    /^\/docs\/[a-z0-9/_-]+\.html$/i.test(uri)
  )
    return uri;
  return "#";
}
function inline(text) {
  const codes = [];
  let html = escapeHtml(text);
  html = html.replace(/`([^`]+)`/g, (_, code) => {
    const id = codes.push("<code>" + code + "</code>") - 1;
    return "\u001a" + id + "\u001a";
  });
  html = html.replace(/\[([^\]]+)\]\(([^()\s]+)\)/g, (_, title, value) => {
    const href = linkTarget(value.replace(/&amp;/g, "&"));
    const external = href.startsWith("https://");
    return (
      '<a href="' +
      escapeHtml(href) +
      '"' +
      (external ? ' target="_blank" rel="noopener noreferrer"' : "") +
      ">" +
      title +
      "</a>"
    );
  });
  html = html
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "<em>$1</em>");
  return html.replace(
    /\u001a(\d+)\u001a/g,
    (_, index) => codes[Number(index)] ?? "",
  );
}
function slug(text) {
  return (
    text
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "topico"
  );
}
export function renderMarkdown(source) {
  const lines = String(source).replace(/\r\n/g, "\n").split("\n");
  const result = [];
  let i = 0;
  const list = (value) => /^\s*(?:[-*+]\s+|\d+[.)]\s+)/.test(value);
  const table = (value) =>
    /^\s*\|?\s*:?-{3,}[:|\s-]*\|?\s*$/.test(value) && value.includes("-");
  const cells = (value) =>
    value
      .trim()
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split(/(?<!\\)\|/)
      .map((part) => part.trim().replace(/\\\|/g, "|"));
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    if (/^\s*```/.test(line)) {
      const language = line
        .trim()
        .slice(3)
        .split(/\s/)[0]
        .replace(/[^a-z0-9_-]/gi, "");
      const code = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i]))
        code.push(lines[i++]);
      if (i < lines.length) i++;
      result.push(
        "<pre><code" +
          (language ? ' class="language-' + language + '"' : "") +
          ">" +
          escapeHtml(code.join("\n")) +
          "</code></pre>",
      );
      continue;
    }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      const n = heading[1].length;
      result.push(
        "<h" +
          n +
          ' id="' +
          slug(heading[2]) +
          '">' +
          inline(heading[2]) +
          "</h" +
          n +
          ">",
      );
      i++;
      continue;
    }
    if (/^\s*---+\s*$/.test(line)) {
      result.push("<hr>");
      i++;
      continue;
    }
    if (/^\s*>/.test(line)) {
      const parts = [];
      while (i < lines.length && /^\s*>/.test(lines[i]))
        parts.push(lines[i++].replace(/^\s*>\s?/, ""));
      result.push(
        "<blockquote><p>" + inline(parts.join(" ")) + "</p></blockquote>",
      );
      continue;
    }
    if (
      line.trim().startsWith("|") &&
      i + 1 < lines.length &&
      table(lines[i + 1])
    ) {
      const heads = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trim().startsWith("|"))
        rows.push(cells(lines[i++]));
      result.push(
        '<div class="table-scroll"><table><thead><tr>' +
          heads.map((cell) => "<th>" + inline(cell) + "</th>").join("") +
          "</tr></thead><tbody>" +
          rows
            .map(
              (row) =>
                "<tr>" +
                heads
                  .map((_, col) => "<td>" + inline(row[col] ?? "") + "</td>")
                  .join("") +
                "</tr>",
            )
            .join("") +
          "</tbody></table></div>",
      );
      continue;
    }
    if (list(line)) {
      const tag = /^\s*\d+[.)]\s+/.test(line) ? "ol" : "ul";
      const items = [];
      while (i < lines.length && list(lines[i])) {
        const part = lines[i++].replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+)/, "");
        const rest = [];
        while (
          i < lines.length &&
          /^\s{2,}\S/.test(lines[i]) &&
          !list(lines[i]) &&
          !/^\s*```/.test(lines[i])
        )
          rest.push(lines[i++].trim());
        items.push("<li>" + inline([part, ...rest].join(" ")) + "</li>");
      }
      result.push("<" + tag + ">" + items.join("") + "</" + tag + ">");
      continue;
    }
    const p = [line.trim()];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^(#{1,6})\s+/.test(lines[i]) &&
      !list(lines[i]) &&
      !/^\s*```/.test(lines[i]) &&
      !/^\s*---+\s*$/.test(lines[i]) &&
      !(
        lines[i].trim().startsWith("|") &&
        i + 1 < lines.length &&
        table(lines[i + 1])
      )
    )
      p.push(lines[i++].trim());
    result.push("<p>" + inline(p.join(" ")) + "</p>");
  }
  return result.join("\n");
}
export function readOpenApiOperations(source) {
  const lines = String(source).replace(/\r\n/g, "\n").split("\n");
  const records = [];
  let inPaths = false,
    path = "",
    current = null;
  const close = () => {
    if (current) {
      current.contract = current.lines.join("\n");
      delete current.lines;
      records.push(current);
    }
    current = null;
  };
  for (const line of lines) {
    if (line.trim() === "paths:" && !inPaths) {
      inPaths = true;
      continue;
    }
    if (inPaths && /^[a-zA-Z_][\w]*:\s*$/.test(line)) {
      close();
      break;
    }
    if (!inPaths) continue;
    const next = /^  (\/\S*):\s*(?:#.*)?$/.exec(line);
    if (next) {
      close();
      path = next[1];
      continue;
    }
    const method = /^    (get|post|put|patch|delete|head|options):\s*$/i.exec(
      line,
    );
    if (method && path) {
      close();
      current = {
        method: method[1].toUpperCase(),
        path,
        summary: "",
        responses: [],
        lines: [line],
      };
      continue;
    }
    if (!current) continue;
    current.lines.push(line);
    const summary = /^      summary:\s*(.*)$/.exec(line);
    if (summary) current.summary = summary[1].replace(/^['"]|['"]$/g, "");
    const status = /^        ['"]?(\d{3}|default)['"]?:\s*/.exec(line);
    if (status && !current.responses.includes(status[1]))
      current.responses.push(status[1]);
  }
  close();
  return records;
}
