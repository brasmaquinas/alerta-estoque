#!/usr/bin/env node
/*
 * ALERTA DE ESTOQUE - rotina agendada (VPS) que envia o e-mail pelo Resend.
 *
 * - Lê os cadastros AD_ e o estoque (TGFEST) pelo Sankhya API Gateway.
 * - Usa a mesma regra da tela (calcularGrupo em monitorEstoque.js).
 * - Grupo CRÍTICO: um e-mail por dia enquanto continuar crítico
 *   (CHAVEEVENTO = G<ID>-<AAAAMMDD>, só reenvia se não houver STATUS 'E').
 * - Grava cada envio/falha na AD_ALERLOG. Tabelas nativas: somente leitura.
 *
 * Uso:
 *   node alerta.js                 executa (envia e grava no histórico)
 *   node alerta.js --teste         calcula e gera previa-email.html, sem enviar nem gravar
 *   node alerta.js --para x@y.com  envia o alerta só para x@y.com, sem gravar no histórico
 *   node alerta.js --config caminho/config.json
 *   node alerta.js --servico       fica rodando e executa nos horários de AGENDA_HORAS
 *                                  (para container: Easypanel, Docker)
 *
 * Configuração: config.json e/ou variáveis de ambiente (o ambiente tem prioridade).
 *
 * Requer Node.js 18+ (fetch nativo). Sem dependências.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

/* ----------------------------------------------------------------------
 * Argumentos e configuração
 * -------------------------------------------------------------------- */

function argumentos(argv) {
  const a = { teste: false, para: null, servico: false, config: path.join(__dirname, "config.json") };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--teste") a.teste = true;
    else if (argv[i] === "--para") a.para = argv[++i];
    else if (argv[i] === "--servico") a.servico = true;
    else if (argv[i] === "--config") a.config = argv[++i];
  }
  return a;
}

function carregarConfig(arquivo) {
  // Sem config.json (ex.: Easypanel), tudo vem das variáveis de ambiente.
  const c = arquivo && fs.existsSync(arquivo) ? JSON.parse(fs.readFileSync(arquivo, "utf8")) : {};
  const env = process.env;
  c.sankhya = c.sankhya || {};
  c.resend = c.resend || {};
  c.regra = c.regra || {};
  const lista = (v) => String(v).split(",").map((x) => x.trim()).filter(Boolean).map(Number);
  if (env.SANKHYA_BASE_URL) c.sankhya.baseUrl = env.SANKHYA_BASE_URL;
  if (env.SANKHYA_AUTENTICACAO) c.sankhya.autenticacao = env.SANKHYA_AUTENTICACAO;
  if (env.RESEND_REMETENTE) c.resend.remetente = env.RESEND_REMETENTE;
  if (env.RESEND_RESPONDER_PARA) c.resend.responderPara = env.RESEND_RESPONDER_PARA;
  if (env.EMPRESAS_PARTICIPANTES !== undefined) c.regra.empresasParticipantes = lista(env.EMPRESAS_PARTICIPANTES);
  if (env.SOMENTE_ESTOQUE_PROPRIO) c.regra.somenteEstoqueProprio = env.SOMENTE_ESTOQUE_PROPRIO.toUpperCase() !== "N";
  if (env.FAIXA_ATENCAO_PCT) c.regra.faixaAtencaoPct = Number(env.FAIXA_ATENCAO_PCT);
  if (env.EXCLUIR_LOCAIS_COM_NOME !== undefined) c.regra.excluirLocaisComNome = String(env.EXCLUIR_LOCAIS_COM_NOME).split(",").map((x) => x.trim()).filter(Boolean);
  if (env.CAMPO_DESCRICAO_GRUPO) c.campoDescricaoGrupo = env.CAMPO_DESCRICAO_GRUPO;
  if (env.ASSUNTO) c.assunto = env.ASSUNTO;
  c.agendaHoras = env.AGENDA_HORAS ? lista(env.AGENDA_HORAS) : c.agendaHoras || [7, 9, 11, 13, 15, 17, 19];
  c.agendaDias = env.AGENDA_DIAS ? lista(env.AGENDA_DIAS) : c.agendaDias || [1, 2, 3, 4, 5, 6]; // 0 = domingo
  if (env.SANKHYA_TOKEN) c.sankhya.token = env.SANKHYA_TOKEN;
  if (env.SANKHYA_CLIENT_ID) c.sankhya.clientId = env.SANKHYA_CLIENT_ID;
  if (env.SANKHYA_CLIENT_SECRET) c.sankhya.clientSecret = env.SANKHYA_CLIENT_SECRET;
  if (env.SANKHYA_APPKEY) c.sankhya.appkey = env.SANKHYA_APPKEY;
  if (env.SANKHYA_USUARIO) c.sankhya.usuario = env.SANKHYA_USUARIO;
  if (env.SANKHYA_SENHA) c.sankhya.senha = env.SANKHYA_SENHA;
  if (env.RESEND_API_KEY) c.resend.apiKey = env.RESEND_API_KEY;
  c.sankhya.baseUrl = (c.sankhya.baseUrl || "https://api.sankhya.com.br").replace(/\/$/, "");
  c.sankhya.autenticacao = c.sankhya.autenticacao || "oauth";
  c.regra = Object.assign({ empresasParticipantes: [], somenteEstoqueProprio: true, faixaAtencaoPct: 20, excluirLocaisComNome: ["PROJETO"] }, c.regra || {});
  c.campoDescricaoGrupo = c.campoDescricaoGrupo || "DESCRICAO";
  c.fusoHorario = c.fusoHorario || "America/Sao_Paulo";
  c.assunto = c.assunto || "[ALERTA SANKHYA]: Estoque Crítico de Módulos Solares";
  const faltando = [];
  if (!c.sankhya.token) faltando.push("SANKHYA_TOKEN");
  if (c.sankhya.autenticacao === "legado") {
    if (!c.sankhya.appkey) faltando.push("SANKHYA_APPKEY");
    if (!c.sankhya.usuario) faltando.push("SANKHYA_USUARIO");
    if (!c.sankhya.senha) faltando.push("SANKHYA_SENHA");
  } else {
    if (!c.sankhya.clientId) faltando.push("SANKHYA_CLIENT_ID");
    if (!c.sankhya.clientSecret) faltando.push("SANKHYA_CLIENT_SECRET");
  }
  if (!c.resend.apiKey) faltando.push("RESEND_API_KEY");
  if (!c.resend.remetente) faltando.push("RESEND_REMETENTE");
  if (faltando.length) throw new Error("Configuração incompleta, falta: " + faltando.join(", "));
  return c;
}

/* ----------------------------------------------------------------------
 * Sankhya API Gateway
 * -------------------------------------------------------------------- */

function decodificarMensagem(msg) {
  if (!msg) return "";
  const t = String(msg).trim();
  if (/^[A-Za-z0-9+/=\s]+$/.test(t) && t.length % 4 === 0 && t.length >= 8) {
    const txt = Buffer.from(t, "base64").toString("utf8");
    if (/^[\x09\x0A\x0D\x20-\x7E -ɏ]+$/.test(txt)) return txt.trim();
  }
  return t;
}

function comoLista(v) {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

class Sankhya {
  constructor(cfg, http) {
    this.cfg = cfg;
    this.http = http || fetch;
    this.bearer = null;
  }

  async entrar() {
    const c = this.cfg;
    let resp, corpo;
    if (c.autenticacao === "legado") {
      // Login legado do Gateway: token + appkey + usuário/senha.
      resp = await this.http(c.baseUrl + "/login", {
        method: "POST",
        headers: { token: c.token, appkey: c.appkey, username: c.usuario, password: c.senha }
      });
      corpo = await lerJson(resp, "login no Sankhya");
      this.bearer = corpo.bearerToken;
    } else {
      // Autenticação OAuth 2.0 (client credentials) + X-Token do Gateway.
      resp = await this.http(c.baseUrl + "/authenticate", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Token": c.token },
        body: new URLSearchParams({ grant_type: "client_credentials", client_id: c.clientId, client_secret: c.clientSecret }).toString()
      });
      corpo = await lerJson(resp, "autenticação no Sankhya");
      this.bearer = corpo.access_token;
    }
    if (!this.bearer) throw new Error("O Sankhya não devolveu o token de acesso: " + JSON.stringify(corpo).slice(0, 200));
  }

  async sair() {
    if (this.cfg.autenticacao !== "legado" || !this.bearer) return;
    try { await this.chamar("MobileLoginSP.logout", {}); } catch (e) { /* sessão já encerrada */ }
  }

  async chamar(serviceName, requestBody) {
    const url = this.cfg.baseUrl + "/gateway/v1/mge/service.sbr?serviceName=" + encodeURIComponent(serviceName) + "&outputType=json";
    const resp = await this.http(url, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=UTF-8", Authorization: "Bearer " + this.bearer },
      body: JSON.stringify({ serviceName, requestBody })
    });
    const env = await lerJson(resp, serviceName);
    const status = String(env.status);
    if (status === "1" || status === "2") return env.responseBody || {};
    if (status === "3") throw new Error("Sessão do Sankhya expirada (" + serviceName + ").");
    throw new Error(decodificarMensagem(env.statusMessage) || "Falha ao executar " + serviceName + ".");
  }

  /** params: [{ valor, tipo: "I" | "S" }] - sempre parametrizado, nunca concatenado. */
  async consultar(entidade, campos, expressao, params, maxPaginas) {
    const limite = maxPaginas || 50;
    let todas = [];
    for (let n = 0; n < limite; n++) {
      const dataSet = {
        rootEntity: entidade,
        includePresentationFields: "N",
        offsetPage: String(n),
        entity: { fieldset: { list: campos.join(",") } }
      };
      if (expressao) {
        dataSet.criteria = { expression: { $: expressao } };
        if (params && params.length) dataSet.criteria.parameter = params.map((p) => ({ $: String(p.valor), type: p.tipo }));
      }
      const body = await this.chamar("CRUDServiceProvider.loadRecords", { dataSet });
      const ents = body.entities;
      if (!ents) break;
      const meta = comoLista(ents.metadata && ents.metadata.fields && ents.metadata.fields.field).map((f) => String(f.name).toUpperCase());
      const nomes = meta.length ? meta : campos;
      const linhas = comoLista(ents.entity).map((e) => {
        const linha = {};
        nomes.forEach((nome, i) => {
          const cel = e["f" + i] || e[nome];
          linha[nome] = cel && cel.$ !== undefined ? String(cel.$) : null;
        });
        return linha;
      });
      todas = todas.concat(linhas);
      if (String(ents.hasMoreResult).toLowerCase() !== "true" || !linhas.length) break;
    }
    return todas;
  }

  /** Inclui (sem chave) ou altera (com chave). Devolve o ID gravado, se informado. */
  async salvar(entidade, valores, chave) {
    const localFields = {};
    for (const k of Object.keys(valores)) {
      const v = valores[k];
      localFields[k] = { $: v === null || v === undefined ? "" : String(v) };
    }
    const dataRow = { localFields };
    if (chave) {
      dataRow.key = {};
      for (const k of Object.keys(chave)) dataRow.key[k] = { $: String(chave[k]) };
    }
    const body = await this.chamar("CRUDServiceProvider.saveRecord", {
      dataSet: { rootEntity: entidade, includePresentationFields: "N", dataRow, entity: { fieldset: { list: "ID," + Object.keys(valores).join(",") } } }
    });
    const ent = body.entities && comoLista(body.entities.entity)[0];
    const id = ent && (ent.ID || ent.f0);
    return id && id.$ !== undefined ? Number(id.$) : chave ? Number(chave.ID) : null;
  }
}

async function lerJson(resp, oque) {
  const texto = await resp.text();
  if (!resp.ok) throw new Error(oque + ": HTTP " + resp.status + " " + texto.slice(0, 300));
  try { return JSON.parse(texto); } catch (e) {
    throw new Error(oque + ": resposta inesperada " + texto.slice(0, 200));
  }
}

/* ----------------------------------------------------------------------
 * Leitura e cálculo (mesma regra da tela)
 * -------------------------------------------------------------------- */

const num = (v) => (v === null || v === undefined || String(v).trim() === "" || isNaN(Number(v)) ? null : Number(v));
const flag = (v) => String(v || "").toUpperCase() === "S";

function inLista(campo, valores) {
  return {
    expr: "this." + campo + " IN (" + valores.map(() => "?").join(", ") + ")",
    params: valores.map((v) => ({ valor: v, tipo: "I" }))
  };
}

async function consultarEmLotes(sk, entidade, campos, campo, valores, tamanho) {
  let todas = [];
  for (let i = 0; i < valores.length; i += tamanho || 200) {
    const f = inLista(campo, valores.slice(i, i + (tamanho || 200)));
    todas = todas.concat(await sk.consultar(entidade, campos, f.expr, f.params, 200));
  }
  return todas;
}

async function carregarDados(sk, cfg) {
  const desc = cfg.campoDescricaoGrupo;
  const [grupos, produtos, destinatarios, locais] = await Promise.all([
    sk.consultar("AD_ALERGRUPO", ["ID", "CODGRUPO", desc, "LIMITEMIN", "ATIVO", "EMAILATIVO"]),
    sk.consultar("AD_ALERPROD", ["ID", "GRUPOID", "CODPROD", "ATIVO"]),
    sk.consultar("AD_ALERDEST", ["ID", "GRUPOID", "NOME", "EMAIL", "ATIVO"]),
    sk.consultar("AD_ALERLOCAL", ["ID", "CODLOCAL", "CODEMP", "MOTIVO", "ATIVO"])
  ]);
  const D = {
    grupos: grupos.map((g) => ({ id: num(g.ID), codGrupo: num(g.CODGRUPO), descricao: (g[desc] || "").trim(), limiteMin: num(g.LIMITEMIN) || 0, ativo: flag(g.ATIVO), emailAtivo: flag(g.EMAILATIVO) })),
    produtos: produtos.map((p) => ({ grupoId: num(p.GRUPOID), codProd: num(p.CODPROD), ativo: flag(p.ATIVO) })),
    destinatarios: destinatarios.map((d) => ({ grupoId: num(d.GRUPOID), nome: (d.NOME || "").trim(), email: (d.EMAIL || "").trim(), ativo: flag(d.ATIVO) })),
    locaisExcluidos: locais.map((l) => ({ codLocal: num(l.CODLOCAL), codEmp: num(l.CODEMP), descricao: (l.MOTIVO || "").trim(), ativo: flag(l.ATIVO) })),
    catalogo: {}, empresas: {}, estoque: [], nomesLocais: {}
  };
  const cods = [...new Set(D.produtos.filter((p) => p.ativo && p.codProd !== null).map((p) => p.codProd))];
  if (cods.length) {
    const [cat, est, emp] = await Promise.all([
      consultarEmLotes(sk, "Produto", ["CODPROD", "DESCRPROD", "CODVOL"], "CODPROD", cods),
      consultarEmLotes(sk, "Estoque", ["CODEMP", "CODPROD", "CODLOCAL", "CONTROLE", "TIPO", "ESTOQUE", "RESERVADO"], "CODPROD", cods),
      sk.consultar("Empresa", ["CODEMP", "NOMEFANTASIA"])
    ]);
    cat.forEach((p) => { D.catalogo[num(p.CODPROD)] = { descricao: (p.DESCRPROD || "").trim(), unidade: (p.CODVOL || "").trim() }; });
    emp.forEach((e) => { D.empresas[num(e.CODEMP)] = (e.NOMEFANTASIA || "").trim(); });
    D.estoque = est.map((r) => ({ codEmp: num(r.CODEMP), codProd: num(r.CODPROD), codLocal: num(r.CODLOCAL), tipo: (r.TIPO || "").trim(), estoque: num(r.ESTOQUE) || 0, reservado: num(r.RESERVADO) || 0 }));

    // Nomes dos locais usados (TGFLOC), para a regra "excluir locais com nome ...".
    // Se a leitura falhar, a execução falha: melhor não enviar do que enviar número errado.
    if ((cfg.regra.excluirLocaisComNome || []).length) {
      const locs = [...new Set(D.estoque.map((r) => r.codLocal).filter((c) => c !== null))];
      const nomes = locs.length ? await consultarEmLotes(sk, "LocalFinanceiro", ["CODLOCAL", "DESCRLOCAL"], "CODLOCAL", locs) : [];
      nomes.forEach((l) => { D.nomesLocais[num(l.CODLOCAL)] = (l.DESCRLOCAL || "").trim(); });
    }
  }
  return D;
}

const normalizar = (t) => String(t || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase();

/** Local cujo nome contém um dos termos (ex.: PROJETO), sem diferenciar acento e maiúsculas. */
function localExcluidoPeloNome(nome, regra) {
  const n = normalizar(nome);
  return !!n && (regra.excluirLocaisComNome || []).some((t) => n.indexOf(normalizar(t)) >= 0);
}

function linhaConsiderada(r, D, regra) {
  if (regra.somenteEstoqueProprio !== false && r.tipo.toUpperCase() !== "P") return false;
  const part = regra.empresasParticipantes || [];
  if (part.length && part.map(Number).indexOf(r.codEmp) < 0) return false;
  if (localExcluidoPeloNome(D.nomesLocais[r.codLocal], regra)) return false;
  return !D.locaisExcluidos.some((l) => l.ativo && l.codLocal === r.codLocal && (l.codEmp === null || l.codEmp === r.codEmp));
}

function situacao(disp, limite, faixa) {
  if (disp <= limite) return "CRITICO";
  if (disp <= limite * (1 + faixa / 100)) return "ATENCAO";
  return "NORMAL";
}

function calcularGrupo(g, D, regra) {
  const prods = {};
  D.produtos.forEach((p) => { if (p.grupoId === g.id && p.ativo) prods[p.codProd] = true; });
  const porProduto = {};
  Object.keys(prods).forEach((c) => { porProduto[c] = { codProd: Number(c), fisico: 0, reservado: 0 }; });
  D.estoque.forEach((r) => {
    if (!prods[r.codProd] || !linhaConsiderada(r, D, regra)) return;
    porProduto[r.codProd].fisico += r.estoque;
    porProduto[r.codProd].reservado += r.reservado;
  });
  const linhas = Object.values(porProduto).map((l) => {
    const c = D.catalogo[l.codProd] || {};
    return Object.assign(l, { disponivel: l.fisico - l.reservado, descricao: c.descricao || "", unidade: c.unidade || "" });
  }).sort((a, b) => a.disponivel - b.disponivel);
  let fisico = 0, reservado = 0;
  linhas.forEach((l) => { fisico += l.fisico; reservado += l.reservado; });
  const disponivel = fisico - reservado;
  return {
    grupo: g, linhas, fisico, reservado, disponivel,
    situacao: linhas.length ? situacao(disponivel, g.limiteMin, regra.faixaAtencaoPct) : "SEM_PRODUTOS"
  };
}

function destinatariosDoGrupo(g, D) {
  const vistos = {};
  return D.destinatarios.filter((d) => {
    if (!d.ativo || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.email)) return false;
    if (d.grupoId !== null && d.grupoId !== g.id) return false; // GRUPOID vazio = todos os grupos
    const k = d.email.toLowerCase();
    if (vistos[k]) return false;
    return (vistos[k] = true);
  });
}

/* ----------------------------------------------------------------------
 * E-mail
 * -------------------------------------------------------------------- */

const esc = (s) => String(s === null || s === undefined ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const qtd = (n) => Number(n).toLocaleString("pt-BR", { maximumFractionDigits: 2 });

function nomeGrupo(g) {
  return g.descricao || "Grupo " + g.id;
}

function montarEmail(r, agora, cfg) {
  const g = r.grupo;
  const quando = agora.toLocaleString("pt-BR", { timeZone: cfg.fusoHorario, dateStyle: "short", timeStyle: "short" });
  const td = 'style="padding:8px 10px;border-bottom:1px solid #e3e8e6;font-size:13px;color:#1d2b26"';
  const tdn = 'style="padding:8px 10px;border-bottom:1px solid #e3e8e6;font-size:13px;color:#1d2b26;text-align:right;white-space:nowrap"';
  const th = 'style="padding:8px 10px;background:#f1f5f3;border-bottom:1px solid #d5ddd9;font-size:12px;color:#4a5a54;text-align:left"';
  const thn = th.replace("text-align:left", "text-align:right");
  const linhas = r.linhas.map((l) =>
    "<tr><td " + td + ">" + esc(l.codProd) + "</td><td " + td + ">" + esc(l.descricao) + "</td>" +
    "<td " + tdn + ">" + qtd(l.fisico) + "</td><td " + tdn + ">" + qtd(l.reservado) + "</td>" +
    "<td " + tdn + "><strong>" + qtd(l.disponivel) + "</strong></td></tr>").join("");

  const html =
    '<!doctype html><html><body style="margin:0;padding:24px;background:#f5f7f6;font-family:Segoe UI,Arial,sans-serif">' +
    '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:680px;margin:0 auto;background:#ffffff;border:1px solid #dfe5e2;border-radius:8px">' +
    '<tr><td style="padding:18px 24px;background:#0c4f3b;border-radius:8px 8px 0 0;color:#ffffff;font-size:16px;font-weight:600">Monitor de Estoque · Brasmáquinas</td></tr>' +
    '<tr><td style="padding:24px">' +
    '<p style="margin:0 0 6px;font-size:12px;color:#b42318;font-weight:700;letter-spacing:.04em">ESTOQUE CRÍTICO</p>' +
    '<h1 style="margin:0 0 16px;font-size:20px;color:#1d2b26">' + esc(nomeGrupo(g)) + "</h1>" +
    '<table role="presentation" cellspacing="0" cellpadding="0" style="margin:0 0 20px"><tr>' +
    '<td style="padding:12px 16px;background:#fdf0ef;border:1px solid #f4c7c3;border-radius:6px"><div style="font-size:12px;color:#7a2e26">Disponível</div><div style="font-size:22px;font-weight:700;color:#b42318">' + qtd(r.disponivel) + "</div></td>" +
    '<td style="width:12px"></td>' +
    '<td style="padding:12px 16px;background:#f1f5f3;border:1px solid #d5ddd9;border-radius:6px"><div style="font-size:12px;color:#4a5a54">Limite mínimo</div><div style="font-size:22px;font-weight:700;color:#1d2b26">' + qtd(g.limiteMin) + "</div></td>" +
    "</tr></table>" +
    '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border:1px solid #e3e8e6;border-collapse:collapse">' +
    "<tr><th " + th + ">Código</th><th " + th + ">Produto</th><th " + thn + ">Físico</th><th " + thn + ">Reservado</th><th " + thn + ">Disponível</th></tr>" +
    linhas +
    "<tr><td " + td + ' colspan="2"><strong>Total</strong></td><td ' + tdn + "><strong>" + qtd(r.fisico) + "</strong></td><td " + tdn + "><strong>" + qtd(r.reservado) +
    "</strong></td><td " + tdn + "><strong>" + qtd(r.disponivel) + "</strong></td></tr></table>" +
    '<p style="margin:18px 0 0;font-size:12px;color:#5f6f69;line-height:1.5">Disponível = estoque físico − reservado (TGFEST), somente estoque próprio, sem os locais excluídos e sem locais de projeto. ' +
    "Verificado em " + esc(quando) + ". Enquanto o grupo continuar crítico, este aviso será repetido uma vez por dia.</p>" +
    "</td></tr></table></body></html>";

  const texto = "ESTOQUE CRÍTICO - " + nomeGrupo(g) + "\n\nDisponível: " + qtd(r.disponivel) + "  |  Limite mínimo: " + qtd(g.limiteMin) + "\n\n" +
    r.linhas.map((l) => l.codProd + " - " + l.descricao + ": físico " + qtd(l.fisico) + ", reservado " + qtd(l.reservado) + ", disponível " + qtd(l.disponivel)).join("\n") +
    "\n\nVerificado em " + quando + ".";
  return { assunto: cfg.assunto + " - " + nomeGrupo(g), html, texto };
}

async function enviarResend(cfg, para, email, chave, http) {
  const resp = await (http || fetch)("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + cfg.resend.apiKey,
      "Content-Type": "application/json",
      // Mesmo conteúdo + mesma chave em 24 h = o Resend não duplica o e-mail.
      "Idempotency-Key": chave + "-" + crypto.createHash("sha1").update(email.html + para.join(",")).digest("hex").slice(0, 12)
    },
    body: JSON.stringify({ from: cfg.resend.remetente, to: para, subject: email.assunto, html: email.html, text: email.texto, reply_to: cfg.resend.responderPara || undefined })
  });
  const texto = await resp.text();
  let corpo = {};
  try { corpo = JSON.parse(texto); } catch (e) { /* corpo não-JSON */ }
  if (!resp.ok) throw new Error("Resend HTTP " + resp.status + ": " + (corpo.message || texto).slice(0, 200));
  return corpo.id || "";
}

/* ----------------------------------------------------------------------
 * Execução
 * -------------------------------------------------------------------- */

function dataChave(agora, fuso) {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: fuso, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(agora);
  const v = (t) => p.find((x) => x.type === t).value;
  return v("year") + v("month") + v("day");
}

function log(msg) {
  console.log(new Date().toISOString() + " " + msg);
}

async function executar(opcoes, deps) {
  deps = deps || {};
  const cfg = deps.cfg || carregarConfig(opcoes.config);
  const agora = deps.agora || new Date();
  const sk = new Sankhya(cfg.sankhya, deps.http);
  const resumo = { criticos: 0, enviados: 0, ignorados: 0, falhas: 0 };

  await sk.entrar();
  try {
    const D = await carregarDados(sk, cfg);
    const dia = dataChave(agora, cfg.fusoHorario);
    const previas = [];

    for (const g of D.grupos.filter((x) => x.ativo)) {
      const r = calcularGrupo(g, D, cfg.regra);
      log("Grupo " + g.id + " (" + nomeGrupo(g) + "): disponível " + r.disponivel + " / limite " + g.limiteMin + " -> " + r.situacao);
      if (r.situacao !== "CRITICO") continue;
      resumo.criticos++;
      const email = montarEmail(r, agora, cfg);

      if (opcoes.teste) { previas.push(email); continue; }

      if (opcoes.para) {
        const id = await enviarResend(cfg, [opcoes.para], email, "teste-" + g.id + "-" + Date.now(), deps.http);
        log("  Teste enviado para " + opcoes.para + " (Resend " + id + ").");
        resumo.enviados++;
        continue;
      }

      if (!g.emailAtivo) { log("  E-mail desativado neste grupo (EMAILATIVO = N)."); resumo.ignorados++; continue; }
      const para = destinatariosDoGrupo(g, D).map((d) => d.email);
      if (!para.length) { log("  Nenhum destinatário ativo."); resumo.ignorados++; continue; }

      const chave = "G" + g.id + "-" + dia;
      const anteriores = await sk.consultar("AD_ALERLOG", ["ID", "STATUS"], "this.GRUPOID = ? AND this.CHAVEEVENTO = ?",
        [{ valor: g.id, tipo: "I" }, { valor: chave, tipo: "S" }]);
      if (anteriores.some((l) => String(l.STATUS).toUpperCase() === "E")) {
        log("  Já enviado hoje (" + chave + ")."); resumo.ignorados++; continue;
      }
      // Reaproveita a linha de uma tentativa anterior do mesmo dia (falha ou interrompida).
      const total = Math.round(r.disponivel), limite = Math.round(g.limiteMin);
      const base = { GRUPOID: g.id, TOTALDISP: total, LIMITE: limite, CHAVEEVENTO: chave };
      let idLog = anteriores.length ? num(anteriores[0].ID) : null;
      idLog = await sk.salvar("AD_ALERLOG", Object.assign({}, base, { STATUS: "R", ERRO: "" }), idLog ? { ID: idLog } : null);
      if (!idLog) {
        const novas = await sk.consultar("AD_ALERLOG", ["ID"], "this.GRUPOID = ? AND this.CHAVEEVENTO = ?", [{ valor: g.id, tipo: "I" }, { valor: chave, tipo: "S" }]);
        idLog = novas.map((l) => num(l.ID)).sort((a, b) => b - a)[0] || null;
      }

      try {
        const resendId = await enviarResend(cfg, para, email, chave, deps.http);
        await gravarResultado(sk, idLog, base, { STATUS: "E", RESENDID: resendId, ERRO: "" });
        log("  Enviado para " + para.join(", ") + " (Resend " + resendId + ").");
        resumo.enviados++;
      } catch (e) {
        await gravarResultado(sk, idLog, base, { STATUS: "F", ERRO: String(e.message).slice(0, 200) });
        log("  FALHA: " + e.message);
        resumo.falhas++;
      }
    }

    if (opcoes.teste) {
      const arq = path.join(path.dirname(opcoes.config || __filename), "previa-email.html");
      fs.writeFileSync(arq, previas.length ? previas.map((p) => "<h3 style=\"font-family:sans-serif\">" + esc(p.assunto) + "</h3>" + p.html).join("<hr>") : "<p>Nenhum grupo crítico agora.</p>");
      log("Modo teste: nada foi enviado nem gravado. Prévia em " + arq);
    }
  } finally {
    await sk.sair();
  }
  log("Concluído: " + resumo.criticos + " crítico(s), " + resumo.enviados + " enviado(s), " + resumo.ignorados + " ignorado(s), " + resumo.falhas + " falha(s).");
  return resumo;
}

async function gravarResultado(sk, idLog, base, valores) {
  const v = Object.assign({}, base, valores);
  if (idLog) await sk.salvar("AD_ALERLOG", v, { ID: idLog });
  else await sk.salvar("AD_ALERLOG", v, null);
}

module.exports = { executar, calcularGrupo, localExcluidoPeloNome, carregarConfig, destinatariosDoGrupo, montarEmail, dataChave, momento };

/** Hora e dia da semana no fuso configurado. */
function momento(agora, fuso) {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: fuso, hour: "numeric", hourCycle: "h23", weekday: "short" }).formatToParts(agora);
  const v = (t) => p.find((x) => x.type === t).value;
  return { hora: Number(v("hour")), dia: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(v("weekday")) };
}

/** Modo serviço: verifica a cada minuto e executa uma vez em cada horário da agenda. */
function servico(opcoes) {
  const cfg = carregarConfig(opcoes.config);
  log("Serviço iniciado. Horários: " + cfg.agendaHoras.join(", ") + "h | dias: " + cfg.agendaDias.join(",") + " (0 = domingo) | fuso " + cfg.fusoHorario);
  let ultima = null, rodando = false;
  const tique = () => {
    const agora = new Date();
    const m = momento(agora, cfg.fusoHorario);
    const chave = dataChave(agora, cfg.fusoHorario) + "-" + m.hora;
    if (rodando || chave === ultima || cfg.agendaHoras.indexOf(m.hora) < 0 || cfg.agendaDias.indexOf(m.dia) < 0) return;
    ultima = chave;
    rodando = true;
    executar(opcoes, { cfg }).catch((e) => log("ERRO: " + e.message)).then(() => { rodando = false; });
  };
  tique();
  const timer = setInterval(tique, 60 * 1000);
  const parar = () => { log("Serviço encerrado."); clearInterval(timer); process.exit(0); };
  process.on("SIGTERM", parar);
  process.on("SIGINT", parar);
}

if (require.main === module) {
  const opcoes = argumentos(process.argv.slice(2));
  if (opcoes.servico) {
    try { servico(opcoes); } catch (e) { log("ERRO: " + e.message); process.exit(1); }
  } else {
    executar(opcoes).then((r) => { process.exitCode = r.falhas ? 2 : 0; }, (e) => {
      log("ERRO: " + e.message);
      process.exitCode = 1;
    });
  }
}
