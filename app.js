(() => {
  "use strict";

  const { SUPABASE_URL, SUPABASE_ANON_KEY, WHATSAPP_CHECK_WEBHOOK_URL } = window.APP_CONFIG;
  const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  let adminPassword = null; // fica só em memória, nunca em localStorage
  let currentDraw = null;

  // ---------------------------------------------------------------------
  // Fundo animado com ovinhos flutuando
  // ---------------------------------------------------------------------
  function initEggBackground() {
    const container = document.getElementById("eggBg");
    const emojis = ["🥚", "🍳"];
    const count = 14;
    for (let i = 0; i < count; i++) {
      const span = document.createElement("span");
      span.textContent = emojis[i % emojis.length];
      span.style.left = `${Math.random() * 100}%`;
      span.style.fontSize = `${1.4 + Math.random() * 1.8}rem`;
      span.style.animationDuration = `${10 + Math.random() * 14}s`;
      span.style.animationDelay = `${Math.random() * 12}s`;
      container.appendChild(span);
    }
  }

  // ---------------------------------------------------------------------
  // Tela principal: último sorteio
  // ---------------------------------------------------------------------
  async function loadLatestDraw() {
    const winnersArea = document.getElementById("winnersArea");
    const drawMeta = document.getElementById("drawMeta");

    const { data, error } = await sb
      .from("ovos_draws")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(1);

    if (error) {
      winnersArea.innerHTML = `<div class="error-state">Não foi possível carregar o sorteio agora. Tente recarregar a página.</div>`;
      return;
    }

    if (!data || data.length === 0) {
      drawMeta.textContent = "";
      winnersArea.innerHTML = `<div class="empty-state">Nenhum sorteio realizado ainda. O primeiro sorteio acontece na próxima sexta-feira 🎉</div>`;
      currentDraw = null;
      renderCurrentDrawAdmin();
      return;
    }

    const draw = data[0];
    currentDraw = draw;
    renderCurrentDrawAdmin();
    const dateLabel = new Date(draw.draw_date + "T00:00:00").toLocaleDateString("pt-BR", {
      day: "2-digit",
      month: "long",
      year: "numeric",
    });
    drawMeta.textContent = `Sorteio de ${dateLabel} · Ciclo #${draw.cycle_number}`;

    winnersArea.innerHTML = `
      <div class="winners">
        <div class="winner-card">
          <span class="egg">🥚</span>
          <div class="name">${escapeHtml(draw.person1_name)}</div>
          <div class="role">Compra dos ovos</div>
        </div>
        <div class="winner-card">
          <span class="egg">🥚</span>
          <div class="name">${escapeHtml(draw.person2_name)}</div>
          <div class="role">Compra dos ovos</div>
        </div>
      </div>
    `;

    if (window.confetti) {
      window.confetti({ particleCount: 90, spread: 70, origin: { y: 0.5 } });
    }
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str ?? "";
    return div.innerHTML;
  }

  // ---------------------------------------------------------------------
  // Tabela de status do ciclo: quem já comprou e quem ainda falta
  // ---------------------------------------------------------------------
  async function loadCycleStatus() {
    const area = document.getElementById("cycleStatusArea");

    const { data, error } = await sb
      .from("ovos_people")
      .select("name, drawn_in_cycle")
      .eq("active", true)
      .order("name");

    if (error || !data || data.length === 0) {
      area.innerHTML = "";
      return;
    }

    const done = data.filter((p) => p.drawn_in_cycle);
    const pending = data.filter((p) => !p.drawn_in_cycle);

    const renderList = (list) =>
      list.length
        ? `<ul>${list.map((p) => `<li>${escapeHtml(p.name)}</li>`).join("")}</ul>`
        : `<p class="status-empty">Ninguém aqui.</p>`;

    area.innerHTML = `
      <h2 class="status-title">Status do ciclo</h2>
      <div class="status-columns">
        <div class="status-col">
          <h3>✅ Já foram sorteados (${done.length})</h3>
          ${renderList(done)}
        </div>
        <div class="status-col">
          <h3>⏳ Ainda vão sortear (${pending.length})</h3>
          ${renderList(pending)}
        </div>
      </div>
    `;
  }

  // ---------------------------------------------------------------------
  // Invalidar sorteio de uma pessoa (ex: ela saiu e ninguém inativou)
  // ---------------------------------------------------------------------
  function renderCurrentDrawAdmin() {
    const area = document.getElementById("currentDrawAdmin");
    if (!area) return;

    if (!currentDraw) {
      area.innerHTML = `<p class="status-empty">Nenhum sorteio ativo ainda.</p>`;
      return;
    }

    const row = (id, name) => `
      <div class="draw-admin-row">
        <span>${escapeHtml(name)}</span>
        <button type="button" class="btn btn-danger" data-invalidate="${id}">🚫 Indisponível</button>
      </div>
    `;

    area.innerHTML = `
      <h3>Sorteio atual (Ciclo #${currentDraw.cycle_number})</h3>
      ${row(currentDraw.person1_id, currentDraw.person1_name)}
      ${row(currentDraw.person2_id, currentDraw.person2_name)}
      <div class="form-msg" id="invalidateMsg"></div>
    `;

    area.querySelectorAll("[data-invalidate]").forEach((btn) => {
      btn.addEventListener("click", () => invalidateDrawPerson(btn.dataset.invalidate));
    });
  }

  async function invalidateDrawPerson(personId) {
    const msg = document.getElementById("invalidateMsg");
    const name =
      currentDraw.person1_id === personId ? currentDraw.person1_name : currentDraw.person2_name;

    const ok = confirm(
      `Marcar ${name} como indisponível?\n\nIsso vai inativá-la (não participa mais dos sorteios) e sortear outra pessoa no lugar dela só para esta semana.`
    );
    if (!ok) return;

    msg.textContent = "Processando…";
    msg.className = "form-msg";

    const { data, error } = await sb.rpc("ovos_admin_invalidate_draw", {
      p_password: adminPassword,
      p_draw_id: currentDraw.id,
      p_invalid_person_id: personId,
    });

    if (error) {
      msg.textContent = readableError(error);
      msg.className = "form-msg error";
      return;
    }

    const result = Array.isArray(data) ? data[0] : data;
    const waText = encodeURIComponent(
      "🥚 Oi! Houve uma troca no rodízio de ovos desta semana e você entrou no lugar de outra pessoa. Pode comprar 1 cartela de 30 ovos até quinta? 🛒"
    );
    const waLink = `https://wa.me/55${result.replacement_phone}?text=${waText}`;

    msg.innerHTML = `${escapeHtml(name)} foi inativado(a) e substituído(a) por <strong>${escapeHtml(
      result.replacement_name
    )}</strong>. <a href="${waLink}" target="_blank" rel="noopener">Avisar no WhatsApp</a>`;
    msg.className = "form-msg ok";

    loadPeople();
    loadLatestDraw();
    loadCycleStatus();
  }

  // ---------------------------------------------------------------------
  // Modais
  // ---------------------------------------------------------------------
  function showOverlay(el) {
    el.hidden = false;
  }
  function hideOverlay(el) {
    el.hidden = true;
  }

  function setupOverlayDismiss(overlay) {
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) hideOverlay(overlay);
    });
  }

  // ---------------------------------------------------------------------
  // Login de admin
  // ---------------------------------------------------------------------
  function initLogin() {
    const openAdminBtn = document.getElementById("openAdminBtn");
    const loginOverlay = document.getElementById("loginOverlay");
    const closeLoginBtn = document.getElementById("closeLoginBtn");
    const loginForm = document.getElementById("loginForm");
    const loginMsg = document.getElementById("loginMsg");
    const loginPassword = document.getElementById("loginPassword");
    const adminOverlay = document.getElementById("adminOverlay");

    setupOverlayDismiss(loginOverlay);

    openAdminBtn.addEventListener("click", () => {
      if (adminPassword) {
        showOverlay(adminOverlay);
        loadPeople();
        return;
      }
      loginMsg.textContent = "";
      loginMsg.className = "form-msg";
      loginPassword.value = "";
      showOverlay(loginOverlay);
      loginPassword.focus();
    });

    closeLoginBtn.addEventListener("click", () => hideOverlay(loginOverlay));

    loginForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      loginMsg.textContent = "Verificando…";
      loginMsg.className = "form-msg";

      const { data, error } = await sb.rpc("ovos_admin_login", {
        p_password: loginPassword.value,
      });

      if (error || data !== true) {
        loginMsg.textContent = "Senha incorreta.";
        loginMsg.className = "form-msg error";
        return;
      }

      adminPassword = loginPassword.value;
      hideOverlay(loginOverlay);
      showOverlay(adminOverlay);
      loadPeople();
    });
  }

  // ---------------------------------------------------------------------
  // CRUD de pessoas
  // ---------------------------------------------------------------------
  function initAdminPanel() {
    const adminOverlay = document.getElementById("adminOverlay");
    const closeAdminBtn = document.getElementById("closeAdminBtn");
    const personForm = document.getElementById("personForm");
    const personId = document.getElementById("personId");
    const personName = document.getElementById("personName");
    const personPhone = document.getElementById("personPhone");
    const personActive = document.getElementById("personActive");
    const personSubmitBtn = document.getElementById("personSubmitBtn");
    const cancelEditBtn = document.getElementById("cancelEditBtn");
    const personMsg = document.getElementById("personMsg");

    setupOverlayDismiss(adminOverlay);
    closeAdminBtn.addEventListener("click", () => hideOverlay(adminOverlay));

    function resetForm() {
      personId.value = "";
      personName.value = "";
      personPhone.value = "";
      personActive.checked = true;
      personSubmitBtn.textContent = "Adicionar pessoa";
      cancelEditBtn.hidden = true;
      personMsg.textContent = "";
      personMsg.className = "form-msg";
    }

    cancelEditBtn.addEventListener("click", resetForm);

    personForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      personMsg.textContent = "Verificando número no WhatsApp…";
      personMsg.className = "form-msg";

      const check = await checkWhatsappNumber(personPhone.value.trim());
      if (!check.ok) {
        renderPhoneCheckFailure(personPhone, personMsg, check.reason);
        return;
      }

      personMsg.textContent = "Salvando…";
      personMsg.className = "form-msg";

      try {
        if (personId.value) {
          const { error } = await sb.rpc("ovos_admin_update_person", {
            p_password: adminPassword,
            p_id: personId.value,
            p_name: personName.value,
            p_phone: personPhone.value,
            p_active: personActive.checked,
          });
          if (error) throw error;
          personMsg.textContent = "Pessoa atualizada!";
        } else {
          const { error } = await sb.rpc("ovos_admin_add_person", {
            p_password: adminPassword,
            p_name: personName.value,
            p_phone: personPhone.value,
          });
          if (error) throw error;
          personMsg.textContent = "Pessoa cadastrada!";
        }
        personMsg.className = "form-msg ok";
        resetForm();
        loadPeople();
        loadLatestDraw();
        loadCycleStatus();
      } catch (err) {
        personMsg.textContent = readableError(err);
        personMsg.className = "form-msg error";
      }
    });

    window.__startEditPerson = (row) => {
      personId.value = row.id;
      personName.value = row.name;
      personPhone.value = row.phone;
      personActive.checked = row.active;
      personSubmitBtn.textContent = "Salvar edição";
      cancelEditBtn.hidden = false;
      personMsg.textContent = "";
      personName.focus();
    };

    window.__deletePerson = async (row) => {
      if (!confirm(`Remover ${row.name} do rodízio?`)) return;
      const { error } = await sb.rpc("ovos_admin_delete_person", {
        p_password: adminPassword,
        p_id: row.id,
      });
      if (error) {
        alert(readableError(error));
        return;
      }
      loadPeople();
      loadLatestDraw();
      loadCycleStatus();
    };
  }

  function readableError(err) {
    const msg = err?.message || "";
    if (msg.includes("senha invalida")) return "Senha incorreta.";
    if (msg.includes("nao ha ninguem ativo disponivel")) {
      return "Não há ninguém ativo disponível para substituir. Cadastre mais gente antes de invalidar.";
    }
    if (msg.includes("essa pessoa nao esta neste sorteio")) {
      return "Essa pessoa não está mais no sorteio atual — recarregue a página e tente de novo.";
    }
    return "Não foi possível concluir a ação. Tente novamente.";
  }

  // ---------------------------------------------------------------------
  // Confere se o numero tem WhatsApp ativo antes de deixar salvar
  // ---------------------------------------------------------------------
  async function checkWhatsappNumber(phone) {
    if (!WHATSAPP_CHECK_WEBHOOK_URL) {
      return { ok: true };
    }

    try {
      const res = await fetch(WHATSAPP_CHECK_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ number: phone }),
      });

      const body = await res.json();
      const result = Array.isArray(body) ? body[0] : body;
      const entry = result?.data?.[0];

      if (entry?.exists === true) {
        return { ok: true };
      }

      return {
        ok: false,
        reason: "Esse número não tem WhatsApp ativo.",
      };
    } catch (err) {
      return {
        ok: false,
        reason: "Não foi possível verificar esse número agora. Tente novamente em instantes.",
      };
    }
  }

  // Mostra dicas de correção quando a verificação do número falha, com um
  // atalho pra remover o 9º dígito quando o formato permitir.
  function renderPhoneCheckFailure(phoneInput, msgEl, reason) {
    const phone = phoneInput.value.trim();
    const canStrip9 = /^\d{2}9\d{8}$/.test(phone);

    msgEl.className = "form-msg error";
    msgEl.innerHTML = `
      <div class="phone-check-alert">
        <p>${escapeHtml(reason)}</p>
        <ul>
          <li>Não digite o 55 (DDI) — coloque só DDD + número.</li>
          <li>Confira se o DDD está certo.</li>
          <li>Números de celular mais antigos às vezes não têm o 9º dígito — se o seu tiver 11 dígitos, tente sem o 9.</li>
        </ul>
        ${canStrip9 ? `<button type="button" class="btn btn-muted" id="tryWithout9Btn">Tentar sem o 9</button>` : ""}
      </div>
    `;

    const tryBtn = document.getElementById("tryWithout9Btn");
    if (tryBtn) {
      tryBtn.addEventListener("click", () => {
        phoneInput.value = phone.slice(0, 2) + phone.slice(3);
        msgEl.textContent = "";
        msgEl.className = "form-msg";
        phoneInput.focus();
      });
    }
  }

  async function loadPeople() {
    const tbody = document.getElementById("peopleTableBody");
    tbody.innerHTML = `<tr><td colspan="4">Carregando…</td></tr>`;

    const { data, error } = await sb.from("ovos_people").select("*").order("name");

    if (error) {
      tbody.innerHTML = `<tr><td colspan="4">Erro ao carregar pessoas.</td></tr>`;
      return;
    }

    if (!data || data.length === 0) {
      tbody.innerHTML = `<tr><td colspan="4">Nenhuma pessoa cadastrada ainda.</td></tr>`;
      return;
    }

    tbody.innerHTML = "";
    for (const row of data) {
      const tr = document.createElement("tr");

      const statusBadge = row.active
        ? `<span class="badge active">Ativo</span>`
        : `<span class="badge inactive">Inativo</span>`;
      const drawnBadge = row.drawn_in_cycle ? `<span class="badge drawn">Já comprou no ciclo</span>` : "";

      tr.innerHTML = `
        <td>${escapeHtml(row.name)}</td>
        <td>${escapeHtml(row.phone)}</td>
        <td>${statusBadge}${drawnBadge}</td>
        <td class="row-actions">
          <button title="Editar" data-action="edit">✏️</button>
          <button title="Excluir" data-action="delete">🗑️</button>
        </td>
      `;

      tr.querySelector('[data-action="edit"]').addEventListener("click", () => window.__startEditPerson(row));
      tr.querySelector('[data-action="delete"]').addEventListener("click", () => window.__deletePerson(row));

      tbody.appendChild(tr);
    }
  }

  // ---------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------
  document.addEventListener("DOMContentLoaded", () => {
    initEggBackground();
    initLogin();
    initAdminPanel();
    loadLatestDraw();
    loadCycleStatus();
  });
})();
