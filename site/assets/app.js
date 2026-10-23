/* Alerta temprana de deserción escolar — lógica del sitio.
   Lee data/resultados.json (generado por pipeline/entrenar.py).
   Cada horizonte (1 o 2 años) tiene su propio modelo; el selector cambia todo el sitio. */

(() => {
  "use strict";

  const $ = (sel) => document.querySelector(sel);
  const fmt = (v, d = 2) => (v === null || v === undefined || Number.isNaN(v))
    ? "—" : Number(v).toLocaleString("es-CO", { minimumFractionDigits: d, maximumFractionDigits: d });
  const pct = (v) => (v === null || v === undefined) ? "—" : `${fmt(v)} %`;
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const NOMBRES_MODELO = {
    persistencia: "Repetir el último dato conocido (línea base)",
    ridge: "Regresión Ridge",
    gbm: "Gradient Boosting",
  };

  let datos = null;
  let h = null;            // horizonte activo, como texto ("1", "2")
  const graficos = {};

  const pron = () => datos.pronosticos[h];
  const ANIOS_TEXTO = { 1: "un año", 2: "dos años", 3: "tres años" };
  const textoHorizonte = (n) => ANIOS_TEXTO[n] ?? `${n} años`;

  // ---------------------------------------------------------------- colores
  function color(nombre) {
    return getComputedStyle(document.documentElement).getPropertyValue(nombre).trim();
  }
  function conAlfa(hex, a) {
    const c = hex.replace("#", "");
    const n = parseInt(c.length === 3 ? c.split("").map((x) => x + x).join("") : c, 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
  }
  function estiloBase() {
    Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
    Chart.defaults.font.size = 13;
    Chart.defaults.color = color("--grafito-suave");
    Chart.defaults.borderColor = color("--borde");
    Chart.defaults.maintainAspectRatio = false;
  }
  function crearGrafico(id, config) {
    if (graficos[id]) graficos[id].destroy();
    graficos[id] = new Chart(document.getElementById(id), config);
  }

  // ---------------------------------------------------------------- carga
  async function iniciar() {
    try {
      const resp = await fetch("data/resultados.json", { cache: "no-cache" });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      datos = await resp.json();
      if (!datos.pronosticos) throw new Error("Formato antiguo");
    } catch (err) {
      const estado = $("#estado");
      estado.hidden = false;
      estado.innerHTML = "No se encontraron resultados del modelo (<code>data/resultados.json</code>). " +
        "Ejecuta <code>python pipeline/entrenar.py</code> o espera a que termine la acción de GitHub que publica el sitio.";
      $("#top-alertas").innerHTML = "<li class=\"cargando\">Sin resultados todavía.</li>";
      return;
    }
    const horizontes = Object.keys(datos.pronosticos).sort();
    const pedido = location.hash.replace("#", "");
    const porAnio = horizontes.find((k) => String(datos.pronosticos[k].anio_pronostico) === pedido);
    h = porAnio ?? horizontes[horizontes.length - 1];

    rellenarMeta();
    prepararSelector(horizontes);
    prepararExplorador();
    prepararSimulador();
    if (window.Chart) {
      window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { pintarTendencia(); pintarGraficosHorizonte(); });
    }
    cambiarHorizonte(h, false);
  }

  function rellenarMeta() {
    const m = datos.meta;
    const valores = {
      ...m,
      anio_siguiente: m.anio_max + 1,
      filas: m.filas.toLocaleString("es-CO"),
      generado: new Date(m.generado).toLocaleDateString("es-CO", { year: "numeric", month: "long", day: "numeric" }),
    };
    document.querySelectorAll("[data-meta]").forEach((el) => {
      const v = valores[el.dataset.meta];
      if (v !== undefined) el.textContent = v;
    });
    document.querySelectorAll("[data-meta-href]").forEach((el) => {
      const v = m[el.dataset.metaHref];
      if (v) el.href = v;
    });
    const hs = Object.keys(datos.pronosticos).sort();
    hs.forEach((k, i) => {
      const th = document.getElementById(`col-h${i + 1}`);
      if (th) th.textContent = `Estimada ${datos.pronosticos[k].anio_pronostico}`;
    });
  }

  function rellenarHorizonte() {
    const p = pron();
    const valores = {
      anio_pronostico: p.anio_pronostico,
      anio_prueba: p.anio_prueba,
      pares_prueba: p.pares_prueba.toLocaleString("es-CO"),
      umbral_alerta: fmt(p.umbral_alerta),
      modelo_nombre: NOMBRES_MODELO[p.modelo_elegido] ?? p.modelo_elegido,
      horizonte_texto: textoHorizonte(p.horizonte),
    };
    document.querySelectorAll("[data-h]").forEach((el) => {
      const v = valores[el.dataset.h];
      if (v !== undefined) el.textContent = v;
    });
  }

  // ---------------------------------------------------------------- selector
  function prepararSelector(horizontes) {
    $("#selector-horizonte").innerHTML = horizontes.map((k) => {
      const p = datos.pronosticos[k];
      const detalle = `a ${textoHorizonte(p.horizonte)}`;
      return `<input type="radio" name="horizonte" id="h-${k}" value="${k}">
        <label for="h-${k}"><span class="anio">${p.anio_pronostico}</span><span class="detalle">${detalle}</span></label>`;
    }).join("");
    $("#selector-horizonte").addEventListener("change", (e) => cambiarHorizonte(e.target.value, true));
  }

  function cambiarHorizonte(nuevo, actualizarEnlace) {
    h = nuevo;
    document.getElementById(`h-${h}`).checked = true;
    if (actualizarEnlace) history.replaceState(null, "", `#${pron().anio_pronostico}`);

    const p = pron();
    const partes = Object.values(datos.pronosticos)
      .map((q) => `±${fmt(q.metricas[q.modelo_elegido].mae)} p.p. para ${q.anio_pronostico}`);
    const errores = partes.length > 1 ? `${partes.slice(0, -1).join(", ")} y ${partes.at(-1)}` : partes[0];
    $("#nota-horizonte").textContent = p.horizonte === 1
      ? `Pronóstico más preciso. Error medio en la prueba: ${errores}.`
      : `Mira más lejos, con más incertidumbre. Error medio en la prueba: ${errores}.`;

    rellenarHorizonte();
    pintarTop();
    pintarMetricas();
    visibles = POR_PAGINA;
    pintarTabla();
    cargarMunicipio();
    if (window.Chart) {
      if (!graficos["g-tendencia"]) pintarTendencia();
      pintarGraficosHorizonte();
    }
  }

  // ---------------------------------------------------------------- portada
  function ordenados() {
    const p = pron();
    return datos.municipios
      .map((m, i) => ({ ...m, pred: p.pred[i], alerta: p.alerta[i], i }))
      .sort((a, b) => b.pred - a.pred);
  }

  function pintarTop() {
    const lista = $("#top-alertas");
    lista.classList.remove("listo");
    lista.innerHTML = ordenados().slice(0, 5).map((a) => `
      <li>
        <span class="nombre"><mark>${esc(a.municipio)}</mark><span class="depto">${esc(a.departamento)}</span></span>
        <span class="valor">${fmt(a.pred, 1)}&nbsp;% <small>vs. ${fmt(a.desercion_actual, 1)} % en ${datos.meta.anio_max}</small></span>
      </li>`).join("");
    void lista.offsetWidth;  // reinicia la animación del resaltador
    lista.classList.add("listo");
  }

  // ---------------------------------------------------------------- métricas
  function pintarMetricas() {
    const p = pron();
    const met = p.metricas;
    const elegido = p.modelo_elegido;
    $("#tabla-metricas").innerHTML = Object.entries(met).map(([k, v]) => `
      <tr class="${k === elegido ? "mejor" : ""}">
        <td>${NOMBRES_MODELO[k] ?? k}</td>
        <td class="num">${fmt(v.mae, 3)}</td><td class="num">${fmt(v.rmse, 3)}</td><td class="num">${fmt(v.r2, 3)}</td>
      </tr>`).join("");

    const nombre = NOMBRES_MODELO[elegido] ?? elegido;
    const base = met.persistencia.mae;
    const err = met[elegido].mae;
    const mejora = ((base - err) / base) * 100;
    $("#lectura-metricas").textContent = mejora > 0
      ? `El modelo elegido (${nombre}) se equivoca en promedio ${fmt(err)} puntos porcentuales, un ${fmt(mejora, 1)} % menos que la línea base.`
      : `En este horizonte ningún modelo supera a la línea base (${fmt(base)} p.p.): el último dato conocido ya explica casi todo. El pronóstico se publica con ${nombre} (${fmt(err)} p.p.), pero conviene leerlo con cautela.`;
  }

  // ---------------------------------------------------------------- gráficos
  function pintarTendencia() {
    estiloBase();
    const tinta = color("--tinta");
    const gris = color("--serie-2");
    const t = datos.tendencia;
    crearGrafico("g-tendencia", {
      type: "line",
      data: {
        labels: t.map((d) => d.anio),
        datasets: [
          { label: "Ponderada por población", data: t.map((d) => d.ponderada), borderColor: tinta, backgroundColor: tinta, borderWidth: 2.5, pointRadius: 3, tension: 0.25 },
          { label: "Municipio típico (mediana)", data: t.map((d) => d.mediana), borderColor: gris, backgroundColor: gris, borderDash: [6, 4], borderWidth: 2, pointRadius: 0, tension: 0.25 },
        ],
      },
      options: {
        interaction: { mode: "index", intersect: false },
        plugins: { legend: { labels: { usePointStyle: true, pointStyle: "line" } }, tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${pct(c.parsed.y)}` } } },
        scales: { y: { beginAtZero: true, title: { display: true, text: "Deserción (%)" } }, x: { grid: { display: false } } },
      },
    });
  }

  function pintarGraficosHorizonte() {
    estiloBase();
    const p = pron();
    const tinta = color("--tinta");
    const margen = color("--margen");
    const gris = color("--serie-2");

    const puntos = p.real_vs_pred.filter((d) => d.y !== null && d.p !== null);
    const maximo = Math.ceil(Math.max(...puntos.map((d) => Math.max(d.y, d.p)), 1));
    crearGrafico("g-dispersion", {
      type: "scatter",
      data: {
        datasets: [
          { label: "Municipios", data: puntos.map((d) => ({ x: d.p, y: d.y, m: d.m, d: d.d })), backgroundColor: conAlfa(tinta, 0.35), pointRadius: 3, pointHoverRadius: 6 },
          { label: "Predicción perfecta", type: "line", data: [{ x: 0, y: 0 }, { x: maximo, y: maximo }], borderColor: margen, borderWidth: 1.5, borderDash: [5, 4], pointRadius: 0 },
        ],
      },
      options: {
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: (c) => c.raw.m ? `${c.raw.m} (${c.raw.d}): real ${pct(c.raw.y)}, predicha ${pct(c.raw.x)}` : "" } },
        },
        scales: {
          x: { min: 0, max: maximo, title: { display: true, text: `Deserción predicha para ${p.anio_prueba} (%)` } },
          y: { min: 0, max: maximo, title: { display: true, text: `Deserción observada en ${p.anio_prueba} (%)` } },
        },
      },
    });

    const imp = p.importancia.filter((d) => d.importancia > 0).slice(0, 10);
    $("#contenedor-importancia").style.height = `${Math.max(240, imp.length * 34 + 60)}px`;
    crearGrafico("g-importancia", {
      type: "bar",
      data: { labels: imp.map((d) => d.etiqueta), datasets: [{ data: imp.map((d) => d.importancia), backgroundColor: tinta, borderRadius: 2, barThickness: 18 }] },
      options: {
        indexAxis: "y",
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => `Aumento del error: ${fmt(c.parsed.x, 3)} p.p.` } } },
        scales: { x: { title: { display: true, text: "Aumento del error absoluto medio (p.p.)" } }, y: { grid: { display: false } } },
      },
    });

    const dep = p.por_departamento;
    $("#contenedor-deptos").style.height = `${Math.max(320, dep.length * 26 + 80)}px`;
    crearGrafico("g-deptos", {
      type: "bar",
      data: {
        labels: dep.map((d) => d.departamento),
        datasets: [
          { label: `Deserción ${datos.meta.anio_max}`, data: dep.map((d) => d.desercion_actual), backgroundColor: gris, barThickness: 9 },
          { label: `Estimada ${p.anio_pronostico}`, data: dep.map((d) => d.desercion_pred), backgroundColor: tinta, barThickness: 9 },
        ],
      },
      options: {
        indexAxis: "y",
        plugins: { tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${pct(c.parsed.x)}` } } },
        scales: { x: { beginAtZero: true, title: { display: true, text: "Deserción (%)" } }, y: { grid: { display: false } } },
      },
    });
  }

  // ---------------------------------------------------------------- explorador
  const POR_PAGINA = 25;
  let visibles = POR_PAGINA;

  function normalizar(s) {
    return String(s).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  }

  function prepararExplorador() {
    const deptos = [...new Set(datos.municipios.map((a) => a.departamento))].sort((a, b) => a.localeCompare(b, "es"));
    $("#f-depto").insertAdjacentHTML("beforeend", deptos.map((d) => `<option>${esc(d)}</option>`).join(""));
    ["#f-depto", "#f-buscar", "#f-alerta"].forEach((s) =>
      $(s).addEventListener("input", () => { visibles = POR_PAGINA; pintarTabla(); }));
    $("#ver-mas").addEventListener("click", () => { visibles += POR_PAGINA; pintarTabla(); });
  }

  function pintarTabla() {
    const hs = Object.keys(datos.pronosticos).sort();
    const depto = $("#f-depto").value;
    const texto = normalizar($("#f-buscar").value.trim());
    const soloAlerta = $("#f-alerta").checked;
    const filas = ordenados().filter((a) =>
      (!depto || a.departamento === depto) &&
      (!texto || normalizar(a.municipio).includes(texto)) &&
      (!soloAlerta || a.alerta));

    $("#tabla-municipios").innerHTML = filas.slice(0, visibles).map((a) => {
      const cambio = a.pred - a.desercion_actual;
      const clase = cambio > 0.05 ? "sube" : "baja";
      const signo = cambio > 0 ? "+" : "";
      const nombre = a.alerta ? `<mark>${esc(a.municipio)}</mark>` : esc(a.municipio);
      const columnas = hs.map((k) => {
        const v = datos.pronosticos[k].pred[a.i];
        return k === h ? `<td class="num"><strong>${pct(v)}</strong></td>` : `<td class="num">${pct(v)}</td>`;
      }).join("");
      return `<tr>
        <td>${nombre}</td><td>${esc(a.departamento)}</td>
        <td class="num">${pct(a.desercion_actual)}</td>${columnas}
        <td class="num ${clase}">${signo}${fmt(cambio)}</td>
      </tr>`;
    }).join("") || `<tr><td colspan="${4 + hs.length}">Ningún municipio coincide con la búsqueda. Prueba con otro nombre o quita los filtros.</td></tr>`;

    const mostradas = Math.min(visibles, filas.length);
    $("#resumen-tabla").textContent = `Mostrando ${mostradas.toLocaleString("es-CO")} de ${filas.length.toLocaleString("es-CO")} municipios, ordenados por deserción estimada para ${pron().anio_pronostico}`;
    $("#ver-mas").hidden = visibles >= filas.length;
  }

  // ---------------------------------------------------------------- simulador
  let sim = [];
  let valoresBase = [];

  function predecirRidge(x) {
    const s = pron().simulador;
    let y = s.intercepto;
    for (let i = 0; i < x.length; i++) {
      const v = (x[i] === null || x[i] === undefined) ? s.medianas[i] : x[i];
      y += s.coeficientes[i] * ((v - s.medias[i]) / s.escalas[i]);
    }
    return Math.min(100, Math.max(0, y));
  }

  function prepararSimulador() {
    const grupos = {};
    datos.municipios.forEach((a, idx) => (grupos[a.departamento] ??= []).push({ a, idx }));
    $("#s-municipio").innerHTML = Object.keys(grupos).sort((a, b) => a.localeCompare(b, "es")).map((d) =>
      `<optgroup label="${esc(d)}">${grupos[d]
        .sort((p, q) => p.a.municipio.localeCompare(q.a.municipio, "es"))
        .map(({ a, idx }) => `<option value="${idx}">${esc(a.municipio)}</option>`).join("")}</optgroup>`).join("");

    $("#s-municipio").addEventListener("change", cargarMunicipio);
    $("#s-controles").addEventListener("input", (e) => {
      if (e.target.matches("input[type=range]")) e.target.dataset.tocado = "1";
      actualizarSimulacion();
    });
    $("#s-reiniciar").addEventListener("click", cargarMunicipio);
  }

  function construirControles() {
    // Las seis variables con mayor efecto estandarizado en el modelo del horizonte activo
    const s = pron().simulador;
    const v = datos.variables;
    sim = s.coeficientes.map((c, i) => ({ i, peso: Math.abs(c) }))
      .sort((a, b) => b.peso - a.peso).slice(0, 6).map((d) => d.i);
    $("#s-controles").innerHTML = sim.map((i) => {
      const [min, max] = v.rangos[i];
      const paso = Math.max((max - min) / 200, 0.01).toFixed(2);
      return `<div class="control">
        <label for="s-v${i}"><span class="fila"><span>${esc(v.etiquetas[i])}</span><output id="s-o${i}" for="s-v${i}"></output></span></label>
        <input id="s-v${i}" type="range" min="${min}" max="${max}" step="${paso}">
      </div>`;
    }).join("");
  }

  function cargarMunicipio() {
    construirControles();
    const s = pron().simulador;
    const rangos = datos.variables.rangos;
    const a = datos.municipios[Number($("#s-municipio").value)];
    valoresBase = a.x.map((v, i) => (v === null ? s.medianas[i] : v));
    sim.forEach((i) => {
      document.getElementById(`s-v${i}`).value = Math.min(Math.max(valoresBase[i], rangos[i][0]), rangos[i][1]);
    });
    $("#s-base").textContent = pct(predecirRidge(valoresBase));
    actualizarSimulacion();
  }

  function actualizarSimulacion() {
    const nombres = datos.variables.nombres;
    const x = [...valoresBase];
    sim.forEach((i) => {
      const control = document.getElementById(`s-v${i}`);
      // Mientras no se mueva el control se conserva el valor real (puede estar fuera del rango del deslizador)
      const v = control.dataset.tocado ? Number(control.value) : valoresBase[i];
      x[i] = v;
      document.getElementById(`s-o${i}`).textContent = nombres[i] === "log_poblacion"
        ? `${Math.round(Math.expm1(v)).toLocaleString("es-CO")} personas`
        : fmt(v);
    });
    const base = predecirRidge(valoresBase);
    const nuevo = predecirRidge(x);
    const dif = nuevo - base;
    $("#s-nuevo").textContent = pct(nuevo);
    $("#s-dif").textContent = Math.abs(dif) < 0.005 ? "(sin cambio)" : `(${dif > 0 ? "+" : ""}${fmt(dif)} p.p.)`;
  }

  document.addEventListener("DOMContentLoaded", iniciar);
})();
