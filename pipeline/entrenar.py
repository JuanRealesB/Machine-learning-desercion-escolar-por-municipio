"""
Alerta temprana de deserción escolar por municipio (Colombia)
==============================================================

Pipeline reproducible:
  1. Descarga el conjunto "MEN_ESTADISTICAS_EN_EDUCACION_EN_PREESCOLAR, BÁSICA Y
     MEDIA_POR_MUNICIPIO" (id nudc-7mev) desde datos.gov.co (API Socrata).
  2. Limpia y construye pares (indicadores del año t  ->  deserción del año t+1).
  3. Entrena y compara tres modelos con validación temporal:
       - Línea base de persistencia (deserción t+1 = deserción t)
       - Regresión Ridge (lineal, interpretable; alimenta el simulador del sitio)
       - Gradient Boosting (HistGradientBoostingRegressor)
  4. Elige el modelo con menor error en el año de prueba, lo reentrena con toda
     la historia y pronostica la deserción del año siguiente al último disponible.
  5. Exporta todo a site/data/resultados.json para el sitio de GitHub Pages.

Uso:
    python pipeline/entrenar.py                 # descarga y entrena
    python pipeline/entrenar.py --csv ruta.csv  # usa un CSV local
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd
import requests
from sklearn.ensemble import HistGradientBoostingRegressor
from sklearn.impute import SimpleImputer
from sklearn.inspection import permutation_importance
from sklearn.linear_model import RidgeCV
from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler

RAIZ = Path(__file__).resolve().parents[1]
DATASET_ID = "nudc-7mev"
URL_API = f"https://www.datos.gov.co/resource/{DATASET_ID}.csv"
URL_FICHA = f"https://www.datos.gov.co/d/{DATASET_ID}"
RUTA_RAW = RAIZ / "data" / "raw" / "men_municipios.csv"
RUTA_SALIDA = RAIZ / "site" / "data" / "resultados.json"
SEMILLA = 42

# Nombres de columna de la API Socrata -> nombres internos
RENOMBRAR = {
    "a_o": "anio",
    "c_digo_municipio": "cod_mpio",
    "municipio": "municipio",
    "departamento": "departamento",
    "poblaci_n_5_16": "poblacion_5_16",
    "tasa_matriculaci_n_5_16": "tasa_matriculacion",
    "cobertura_neta": "cobertura_neta",
    "cobertura_neta_secundaria": "cobertura_neta_secundaria",
    "cobertura_neta_media": "cobertura_neta_media",
    "cobertura_bruta": "cobertura_bruta",
    "deserci_n": "desercion",
    "deserci_n_primaria": "desercion_primaria",
    "deserci_n_secundaria": "desercion_secundaria",
    "deserci_n_media": "desercion_media",
    "aprobaci_n": "aprobacion",
    "reprobaci_n": "reprobacion",
    "repitencia": "repitencia",
    "repitencia_secundaria": "repitencia_secundaria",
}

TASAS = [c for c in RENOMBRAR.values()
         if c not in {"anio", "cod_mpio", "municipio", "departamento", "poblacion_5_16"}]

# Variables del modelo (todas medidas en el año t) y su etiqueta legible
VARIABLES = {
    "desercion": "Deserción total del año actual",
    "delta_desercion": "Cambio en la deserción frente al año anterior",
    "desercion_primaria": "Deserción en primaria",
    "desercion_secundaria": "Deserción en secundaria",
    "desercion_media": "Deserción en media",
    "aprobacion": "Tasa de aprobación",
    "reprobacion": "Tasa de reprobación",
    "repitencia": "Tasa de repitencia",
    "repitencia_secundaria": "Repitencia en secundaria",
    "cobertura_neta": "Cobertura neta total",
    "cobertura_neta_secundaria": "Cobertura neta en secundaria",
    "cobertura_neta_media": "Cobertura neta en media",
    "cobertura_bruta": "Cobertura bruta total",
    "tasa_matriculacion": "Tasa de matriculación 5 a 16 años",
    "log_poblacion": "Población de 5 a 16 años (escala log)",
}
FEATURES = list(VARIABLES)


# --------------------------------------------------------------------------
# 1. Descarga
# --------------------------------------------------------------------------
def descargar(destino: Path) -> Path:
    """Descarga el CSV completo desde la API de datos.gov.co."""
    encabezados = {}
    token = os.getenv("SOCRATA_APP_TOKEN")
    if token:
        encabezados["X-App-Token"] = token
    print(f"Descargando {URL_API} ...")
    resp = requests.get(URL_API, params={"$limit": 100000}, headers=encabezados, timeout=180)
    resp.raise_for_status()
    destino.parent.mkdir(parents=True, exist_ok=True)
    destino.write_bytes(resp.content)
    print(f"  Guardado en {destino.relative_to(RAIZ)} ({len(resp.content) / 1e6:.1f} MB)")
    return destino


# --------------------------------------------------------------------------
# 2. Limpieza
# --------------------------------------------------------------------------
def _a_entero(serie: pd.Series) -> pd.Series:
    """Enteros que a veces vienen con separador de miles ('2.336')."""
    limpio = serie.astype(str).str.replace(r"[.,\s]", "", regex=True)
    return pd.to_numeric(limpio, errors="coerce")


def _a_tasa(serie: pd.Series) -> pd.Series:
    """Tasas en porcentaje con punto decimal; las comas se tratan como decimales."""
    limpio = serie.astype(str).str.strip().str.replace(",", ".", regex=False)
    return pd.to_numeric(limpio, errors="coerce")


def cargar_y_limpiar(ruta_csv: Path) -> pd.DataFrame:
    df = pd.read_csv(ruta_csv, dtype=str)
    faltantes = [c for c in RENOMBRAR if c not in df.columns]
    if faltantes:
        raise ValueError(f"El CSV no tiene las columnas esperadas: {faltantes}")
    df = df[list(RENOMBRAR)].rename(columns=RENOMBRAR)

    df["anio"] = _a_entero(df["anio"])
    df["cod_mpio"] = _a_entero(df["cod_mpio"])
    df["poblacion_5_16"] = _a_entero(df["poblacion_5_16"])
    for c in TASAS:
        df[c] = _a_tasa(df[c])

    # Quitar agregados (nacional) y filas sin código válido
    df = df[df["cod_mpio"].between(1000, 99999)]
    df = df.dropna(subset=["anio", "cod_mpio"])
    df["anio"] = df["anio"].astype(int)
    df["cod_mpio"] = df["cod_mpio"].astype(int).astype(str).str.zfill(5)
    df["municipio"] = df["municipio"].str.strip()
    df["departamento"] = df["departamento"].str.strip()

    # Valores imposibles: tasas negativas o coberturas absurdas (p. ej. 443 %)
    for c in TASAS:
        df.loc[df[c] < 0, c] = np.nan
    for c in [c for c in TASAS if c.startswith(("cobertura", "tasa_"))]:
        df.loc[df[c] > 200, c] = np.nan
    for c in [c for c in TASAS if not c.startswith(("cobertura", "tasa_"))]:
        df.loc[df[c] > 100, c] = np.nan

    df = (df.sort_values(["cod_mpio", "anio"])
            .drop_duplicates(subset=["cod_mpio", "anio"], keep="last")
            .reset_index(drop=True))
    print(f"  {len(df):,} filas limpias · {df['cod_mpio'].nunique():,} municipios · "
          f"años {df['anio'].min()}–{df['anio'].max()}")
    return df


# --------------------------------------------------------------------------
# 3. Ingeniería de variables: año t -> deserción t+1
# --------------------------------------------------------------------------
def construir_variables(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()
    df["log_poblacion"] = np.log1p(df["poblacion_5_16"])

    previo = df[["cod_mpio", "anio", "desercion"]].copy()
    previo["anio"] += 1
    previo = previo.rename(columns={"desercion": "desercion_prev"})
    df = df.merge(previo, on=["cod_mpio", "anio"], how="left")
    df["delta_desercion"] = df["desercion"] - df["desercion_prev"]

    objetivo = df[["cod_mpio", "anio", "desercion"]].copy()
    objetivo["anio"] -= 1  # la deserción de t+1 se pega a la fila de t
    objetivo = objetivo.rename(columns={"desercion": "y_desercion_siguiente"})
    return df.merge(objetivo, on=["cod_mpio", "anio"], how="left")


# --------------------------------------------------------------------------
# 4. Modelos
# --------------------------------------------------------------------------
def modelo_ridge() -> Pipeline:
    return Pipeline([
        ("imputar", SimpleImputer(strategy="median")),
        ("escalar", StandardScaler()),
        ("ridge", RidgeCV(alphas=np.logspace(-2, 3, 30))),
    ])


def modelo_gbm() -> HistGradientBoostingRegressor:
    return HistGradientBoostingRegressor(
        learning_rate=0.05, max_iter=500, max_leaf_nodes=31, min_samples_leaf=25,
        l2_regularization=1.0, early_stopping=True, validation_fraction=0.15,
        random_state=SEMILLA,
    )


def metricas(y_real, y_pred) -> dict:
    return {
        "mae": round(float(mean_absolute_error(y_real, y_pred)), 3),
        "rmse": round(float(np.sqrt(mean_squared_error(y_real, y_pred))), 3),
        "r2": round(float(r2_score(y_real, y_pred)), 3),
    }


def _redondear(v, n=2):
    return None if v is None or (isinstance(v, float) and np.isnan(v)) else round(float(v), n)


# --------------------------------------------------------------------------
# 5. Orquestación
# --------------------------------------------------------------------------
def ejecutar(ruta_csv: Path) -> dict:
    datos = construir_variables(cargar_y_limpiar(ruta_csv))

    pares = datos.dropna(subset=["y_desercion_siguiente", "desercion"]).copy()
    pares["anio_objetivo"] = pares["anio"] + 1
    anio_prueba = int(pares["anio_objetivo"].max())
    entreno = pares[pares["anio_objetivo"] < anio_prueba]
    prueba = pares[pares["anio_objetivo"] == anio_prueba]
    print(f"  Entrenamiento: {len(entreno):,} pares (objetivos hasta {anio_prueba - 1}) · "
          f"Prueba: {len(prueba):,} pares (objetivo {anio_prueba})")

    X_tr, y_tr = entreno[FEATURES], entreno["y_desercion_siguiente"]
    X_te, y_te = prueba[FEATURES], prueba["y_desercion_siguiente"]

    ridge = modelo_ridge().fit(X_tr, y_tr)
    gbm = modelo_gbm().fit(X_tr, y_tr)
    pred = {
        "persistencia": X_te["desercion"].to_numpy(),
        "ridge": np.clip(ridge.predict(X_te), 0, 100),
        "gbm": np.clip(gbm.predict(X_te), 0, 100),
    }
    resultados_metricas = {k: metricas(y_te, v) for k, v in pred.items()}
    for k, v in resultados_metricas.items():
        print(f"  {k:<13} MAE={v['mae']:.3f}  RMSE={v['rmse']:.3f}  R²={v['r2']:.3f}")

    # El modelo con menor error absoluto en el año de prueba es el que se publica
    candidatos = {"ridge": ridge, "gbm": gbm}
    elegido = min(candidatos, key=lambda k: resultados_metricas[k]["mae"])
    print(f"  Modelo elegido para el pronóstico: {elegido}")

    imp = permutation_importance(candidatos[elegido], X_te, y_te, n_repeats=10, random_state=SEMILLA,
                                 scoring="neg_mean_absolute_error")
    importancia = sorted(
        ({"variable": f, "etiqueta": VARIABLES[f], "importancia": round(float(m), 4),
          "desviacion": round(float(s), 4)}
         for f, m, s in zip(FEATURES, imp.importances_mean, imp.importances_std)),
        key=lambda d: d["importancia"], reverse=True)

    # Reentrenar con todos los pares para pronosticar el año siguiente
    X_all, y_all = pares[FEATURES], pares["y_desercion_siguiente"]
    ridge_final = modelo_ridge().fit(X_all, y_all)
    gbm_final = modelo_gbm().fit(X_all, y_all)

    ultimo = int(datos["anio"].max())
    actual = datos[(datos["anio"] == ultimo) & datos["desercion"].notna()].copy()
    modelo_final = {"ridge": ridge_final, "gbm": gbm_final}[elegido]
    actual["pred"] = np.clip(modelo_final.predict(actual[FEATURES]), 0, 100)
    umbral = float(np.percentile(actual["pred"], 90))
    actual = actual.sort_values("pred", ascending=False)

    alertas = [{
        "codigo": r.cod_mpio, "municipio": r.municipio, "departamento": r.departamento,
        "poblacion": None if pd.isna(r.poblacion_5_16) else int(r.poblacion_5_16),
        "desercion_actual": _redondear(r.desercion),
        "desercion_pred": _redondear(r.pred),
        "alerta": bool(r.pred >= umbral),
        "x": [_redondear(getattr(r, f), 4) for f in FEATURES],
    } for r in actual.itertuples()]

    # Resumen departamental ponderado por población
    def _pond(g, col):
        w = g["poblacion_5_16"].fillna(0)
        return float(np.average(g[col], weights=w)) if w.sum() > 0 else float(g[col].mean())

    por_depto = sorted(({
        "departamento": d,
        "desercion_actual": round(_pond(g, "desercion"), 2),
        "desercion_pred": round(_pond(g, "pred"), 2),
        "municipios": int(len(g)),
        "en_alerta": int((g["pred"] >= umbral).sum()),
    } for d, g in actual.groupby("departamento")),
        key=lambda d: d["desercion_pred"], reverse=True)

    # Tendencia nacional (promedio ponderado por población 5-16)
    tendencia = []
    for anio, g in datos.dropna(subset=["desercion"]).groupby("anio"):
        w = g["poblacion_5_16"].fillna(0)
        tendencia.append({
            "anio": int(anio),
            "ponderada": round(float(np.average(g["desercion"], weights=w)), 2) if w.sum() else None,
            "mediana": round(float(g["desercion"].median()), 2),
        })

    # Parámetros del modelo Ridge para el simulador del navegador
    imp_r = ridge_final.named_steps["imputar"]
    esc_r = ridge_final.named_steps["escalar"]
    reg_r = ridge_final.named_steps["ridge"]
    simulador = {
        "variables": FEATURES,
        "etiquetas": [VARIABLES[f] for f in FEATURES],
        "medianas": [round(float(v), 4) for v in imp_r.statistics_],
        "medias": [round(float(v), 6) for v in esc_r.mean_],
        "escalas": [round(float(v), 6) for v in esc_r.scale_],
        "coeficientes": [round(float(v), 6) for v in reg_r.coef_],
        "intercepto": round(float(reg_r.intercept_), 6),
        "alpha": round(float(reg_r.alpha_), 4),
        "rangos": [[round(float(np.nanpercentile(pares[f], 2)), 2),
                    round(float(np.nanpercentile(pares[f], 98)), 2)] for f in FEATURES],
    }

    real_vs_pred = [{"m": r.municipio, "d": r.departamento,
                     "y": _redondear(r.y_desercion_siguiente), "p": _redondear(p)}
                    for r, p in zip(prueba.itertuples(), pred[elegido])]

    return {
        "meta": {
            "titulo": "Alerta temprana de deserción escolar por municipio",
            "fuente": "Ministerio de Educación Nacional — Estadísticas en educación preescolar, básica y media por municipio",
            "dataset_id": DATASET_ID,
            "url_fuente": URL_FICHA,
            "generado": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "anio_min": int(datos["anio"].min()),
            "anio_max": ultimo,
            "anio_pronostico": ultimo + 1,
            "anio_prueba": anio_prueba,
            "filas": int(len(datos)),
            "municipios": int(datos["cod_mpio"].nunique()),
            "pares_entrenamiento": int(len(entreno)),
            "pares_prueba": int(len(prueba)),
            "umbral_alerta": round(umbral, 2),
            "modelo_elegido": elegido,
        },
        "metricas": resultados_metricas,
        "importancia": importancia,
        "tendencia": tendencia,
        "real_vs_pred": real_vs_pred,
        "por_departamento": por_depto,
        "alertas": alertas,
        "simulador": simulador,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--csv", type=Path, help="Usar un CSV local en lugar de descargar")
    parser.add_argument("--salida", type=Path, default=RUTA_SALIDA)
    args = parser.parse_args()

    if args.csv:
        ruta = args.csv
    else:
        try:
            ruta = descargar(RUTA_RAW)
        except requests.RequestException as err:
            if RUTA_RAW.exists():
                print(f"  No se pudo descargar ({err}); se usa la copia local {RUTA_RAW.name}")
                ruta = RUTA_RAW
            else:
                print(f"Error: no se pudo descargar los datos y no hay copia local. {err}", file=sys.stderr)
                return 1

    resultado = ejecutar(ruta)
    args.salida.parent.mkdir(parents=True, exist_ok=True)
    args.salida.write_text(json.dumps(resultado, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"Resultados exportados a {args.salida} ({args.salida.stat().st_size / 1e3:.0f} KB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
