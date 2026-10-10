import { escapeHtml, renderMarkdown, readOpenApiOperations } from "/docs/viewer-core.mjs";

const entries = [
  ["first-steps", "Primeiros passos"],
  ["user-manual", "Manual de utilização"],
  ["architecture", "Arquitetura"],
  ["manager", "Manager"],
  ["connectors", "Conectores"],
  ["whatsapp-connect-api", "Connect|API"],
  ["security", "Segurança"],
  ["deployment", "Implantação"],
  ["operations", "Operação"],
  ["workspace-isolation", "Evolução de isolamento"],
  ["release-v0.6.0", "Notas da v0.6.0"],
];
const allowed = new Map(entries);
const key = new URLSearchParams(window.location.search).get("doc") || "first-steps";
const isApi = key === "openapi";
const title = isApi ? "Referência OpenAPI" : allowed.get(key);
const nav = document.getElementById("doc-nav");
const content = document.getElementById("doc-content");
const heading = document.getElementById("doc-heading");

function showError(message) {
  content.replaceChildren();
  const p = document.createElement("p");
  p.className = "viewer-error";
  p.textContent = message;
  content.append(p);
}
function toCard(operation, index) {
  const term = (operation.method + " " + operation.path + " " + operation.summary).toLowerCase();
  const responses = operation.responses.map(code => "<span>" + escapeHtml(code) + "</span>").join(" ");
  return '<article class="api-operation" id="api-' + index + '" data-filter="' + escapeHtml(term) + '">'
    + '<div class="api-heading"><span class="api-method ' + operation.method.toLowerCase() + '">'
    + escapeHtml(operation.method) + "</span><code>" + escapeHtml(operation.path) + "</code></div>"
    + "<h3>" + escapeHtml(operation.summary || "Operação") + "</h3>"
    + (responses ? '<p class="api-response">Respostas: ' + responses + "</p>" : "")
    + '<details><summary>Ver o contrato OpenAPI desta operação</summary>'
    + '<pre><code>' + escapeHtml(operation.contract) + "</code></pre></details></article>";
}
function showApi(source) {
  const operations = readOpenApiOperations(source);
  if (!operations.length) {
    showError("O contrato OpenAPI não contém operações para exibir.");
    return;
  }
  content.innerHTML = '<h1>Referência da API</h1><p>Explore rotas, métodos, respostas e contratos sem baixar arquivos.</p>'
    + '<label for="api-search">Pesquisar operação</label>'
    + '<input id="api-search" type="search" autocomplete="off" placeholder="Ex.: /auth/login, POST, instância">'
    + '<p class="api-counter"><span id="api-count">' + operations.length + "</span> operações</p>"
    + '<section id="api-list">' + operations.map(toCard).join("") + "</section>"
    + '<p id="api-empty" hidden>Nenhum endpoint encontrado.</p>';
  const search = document.getElementById("api-search");
  const cards = [...document.querySelectorAll(".api-operation")];
  search.addEventListener("input", () => {
    const term = search.value.toLocaleLowerCase("pt-BR").trim();
    let visible = 0;
    for (const card of cards) {
      const matches = card.dataset.filter.includes(term);
      card.hidden = !matches;
      if (matches) visible++;
    }
    document.getElementById("api-count").textContent = String(visible);
    document.getElementById("api-empty").hidden = visible !== 0;
  });
}
async function init() {
  nav.innerHTML = '<a href="/docs/">Página inicial</a>'
    + '<a class="' + (isApi ? "active" : "") + '" href="/docs/viewer.html?doc=openapi">Referência da API</a>'
    + entries.map(([id, label]) => '<a class="' + (id === key ? "active" : "")
      + '" href="/docs/viewer.html?doc=' + id + '">' + escapeHtml(label) + "</a>").join("");
  if (!title) {
    heading.textContent = "Documento não encontrado";
    showError("Este documento não existe na biblioteca.");
    return;
  }
  heading.textContent = title;
  document.title = title + " · Documentação Scout";
  const url = isApi ? "/docs/api/openapi.yaml" : "/docs/guides/" + key + ".md";
  try {
    const response = await fetch(url, { headers: { Accept: "text/plain" }, credentials: "same-origin" });
    if (!response.ok) throw new Error("HTTP " + response.status);
    const source = await response.text();
    if (isApi) showApi(source);
    else {
      content.innerHTML = renderMarkdown(source);
      if (window.location.hash) {
        const target = document.getElementById(decodeURIComponent(window.location.hash.slice(1)));
        target?.scrollIntoView({ block: "start" });
      }
    }
  } catch {
    showError("Não foi possível carregar a documentação. Verifique a conexão e tente atualizar a página.");
  }
}
void init();
