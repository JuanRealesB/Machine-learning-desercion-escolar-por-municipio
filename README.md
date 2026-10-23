# Alerta temprana de deserción escolar por municipio · Colombia

Proyecto de machine learning con datos abiertos que estima, para cada municipio de Colombia, la tasa de deserción escolar del año siguiente y publica los resultados en un sitio de **GitHub Pages** que se reentrena solo cada mes.

**Fuente de datos:** Ministerio de Educación Nacional, *MEN_ESTADISTICAS_EN_EDUCACION_EN_PREESCOLAR, BÁSICA Y MEDIA_POR_MUNICIPIO*, publicado en datos.gov.co con el identificador [`nudc-7mev`](https://www.datos.gov.co/d/nudc-7mev). Incluye cobertura, deserción, aprobación, reprobación y repitencia por municipio desde 2011.

## Qué hace

1. Descarga el conjunto completo desde la API Socrata de datos.gov.co.
2. Limpia códigos DANE, separadores de miles y tasas imposibles.
3. Construye pares *indicadores del año t → deserción del año t + 1*, de modo que el modelo nunca use información del futuro.
4. Compara tres modelos con validación temporal (entrena con años anteriores, evalúa en el último año conocido):
   - línea base de persistencia (repetir la deserción del año anterior),
   - regresión Ridge,
   - gradient boosting (`HistGradientBoostingRegressor`).
5. Elige el de menor error, lo reentrena con toda la historia y pronostica el año siguiente.
6. Exporta `site/data/resultados.json`, que el sitio usa para mostrar la portada, las métricas, la importancia de variables, un explorador por municipio y un simulador.

## Estructura

```
.
├── .github/workflows/pages.yml   # entrena y publica (push, manual y mensual)
├── pipeline/entrenar.py          # descarga, limpieza, modelos y exportación
├── site/                         # lo que se publica en GitHub Pages
│   ├── index.html
│   ├── assets/styles.css
│   ├── assets/app.js
│   └── data/                     # aquí se genera resultados.json
├── data/raw/                     # copia local del CSV descargado
├── requirements.txt
└── LICENSE
```

## Decisiones metodológicas

- **Sin fuga de información.** En estos datos, aprobación + reprobación + deserción del mismo año suman cerca de 100 %. Por eso el objetivo es siempre la deserción del año siguiente.
- **Validación temporal, no aleatoria.** Mezclar años al azar inflaría las métricas, porque el modelo vería el futuro de un municipio al predecir su pasado.
- **Línea base obligatoria.** La deserción es muy persistente; un modelo solo aporta si supera a “repetir el año anterior”. El sitio lo dice explícitamente cuando no ocurre.
- **Importancia por permutación** sobre el año de prueba, en lugar de la importancia interna del árbol, que favorece variables con muchos valores distintos.
- **Alerta** = 10 % de municipios con mayor deserción estimada. El umbral es un parámetro (`np.percentile(..., 90)` en `entrenar.py`).

## Ideas para ampliarlo

- Añadir resultados Saber 11 por municipio (ICFES) o indicadores de pobreza multidimensional (DANE) uniendo por código DIVIPOLA.
- Agregar un mapa coroplético con los límites municipales de geoBoundaries o del Marco Geoestadístico del DANE.
- Pasar a clasificación (¿aumentará la deserción?) y reportar precisión y exhaustividad de las alertas.
- Cuantificar la incertidumbre con regresión cuantílica (`loss="quantile"` en el gradient boosting).

## Límites y uso responsable

El modelo trabaja con promedios municipales: no identifica estudiantes ni instituciones y no sustituye los sistemas de alerta de cada colegio. Las asociaciones que aprende no son efectos causales. Un municipio en alerta necesita atención, no estigma.

## Licencia

Código bajo licencia MIT. Los datos pertenecen al Ministerio de Educación Nacional; consulta sus condiciones de uso en la [ficha del conjunto](https://www.datos.gov.co/d/nudc-7mev).
