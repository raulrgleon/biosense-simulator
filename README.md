# BioSense Simulator

Simulador local de banco para **BioSense / BioDot**.

Modela tres canales independientes:

1. **GLUCOSE** — sensor electroquímico, TIA, filtro y ADC CH1
2. **OXYGEN** — segundo sensor electroquímico, con su propio TIA, filtro y ADC CH2
3. **TEMPERATURE** — tercer canal. Hoy el valor viene del control; ADC CH3 es un marcador provisional para un sensor físico posterior

Este repositorio **no** es un dispositivo médico, **no** mide tejido real y **no** debe usarse para decisiones clínicas.

**SIMULATED · NOT FOR MEDICAL USE**

## Qué simula

Cada canal electroquímico recorre:

```text
Sensor → AFE/TIA → Filter → ADC → BioSense Algorithm
```

El algoritmo recibe los tres canales y devuelve glucosa estimada, lectura de oxígeno, temperatura y calidad de señal. Con los valores por defecto, la glucosa estimada depende del canal de glucosa. La influencia del oxígeno y el coeficiente de temperatura están en 0, así que no corrigen ni alteran esa estimación.

El objetivo futuro es sustituir los modelos marcados **PROVISIONAL** por curvas medidas en el laboratorio. La aplicación no inventa una relación entre oxígeno, glucosa oxidasa y concentración de glucosa. Solo deja el sitio donde esa relación se podrá estudiar.

## Cómo ejecutarlo

Hace falta Node.js 20+ o un navegador moderno (Chrome o Safari).

1. `npm install` y `npm start` (o abrir `index.html` para solo la UI).
2. La UI queda en `/`. La API versionada está en `/api/v1/`. El servidor MCP remoto está en `/mcp` — ver [docs/API.md](docs/API.md).
3. El caso de referencia aparece al cargar: 200 mg/dL, sensibilidad 1 nA/(mg/dL), 37 °C, ruido 0, drift 0, VREF 1.65 V, RF 1 MΩ, ADC 12 bit.
4. Pulsar **START SIMULATION** para el camino dinámico (ruido y filtro). **PAUSE** congela el tiempo. **STOP & ANALYZE** cierra la sesión y abre **Simulation results**. **RESET** vacía el historial; si hay resultados sin exportar, pide confirmación.

Chart.js 4.4.6 está incluido en `vendor/chart.umd.min.js` (licencia MIT). La UI no llama a APIs externas; el motor de simulación es el mismo que usa la API.

## Arquitectura

`app.js` sigue conteniendo el motor validado. `src/engine` lo reutiliza; `src/api` y `src/mcp` llaman a las mismas funciones de servicio y no reimplementan las ecuaciones.

`app.js` separa el cálculo de la interfaz:

| Bloque | Responsabilidad |
| --- | --- |
| `CONFIG` / `STATE` | Límites, opciones y estado de la sesión. Dos estados de filtro, uno por canal electroquímico |
| `GlucoseSensorModel` | `glucoseToCurrent` |
| `OxygenSensorModel` | `oxygenToCurrent`, `applyOxygenInfluence` |
| `TemperatureModel` | `applyTemperatureInfluence`, `applyTemperatureCompensation` |
| `TIAModel` | `calculateTIAOutput`, instanciado por separado como Glucose TIA y Oxygen TIA |
| `FilterModel` | `calculateCutoffFrequency`, `applyLowPassFilter` |
| `ADCModel` | `voltageToADC`, `adcToVoltage`. CH1 glucosa, CH2 oxígeno, CH3 temperatura |
| `BioSenseAlgorithm` | glucosa estimada, oxígeno estimado, temperatura y calidad de señal |
| `SimulationEngine` | Escenarios, paso de 0.1 s, buffer de 120 s |
| `SimulationSession` | Registro completo de la ejecución, métricas finales y exportaciones |
| `TransientAnalysis` | Respuesta a escalón y seguimiento continuo sobre `SimulationSession.samples` |
| `ExperimentEngine` | Cuatro barridos en estado estacionario |
| `Charts` | Glucosa, oxígeno y entorno. Ventana de 60 s |
| `UI` | Controles, formato, barrido y experimentos |

`runChain()` recorre los tres canales. La interfaz no recalcula ecuaciones por su cuenta.

## Ecuaciones

Unidades de trabajo: glucosa en mg/dL, corriente del modelo en nA, resistencias en Ω, condensadores en F, tensiones en V.

**Corriente del sensor**

```text
I_raw = glucosa · sensibilidad + baseline + drift + ruido
```

La sensibilidad por defecto es 1.0 nA/(mg/dL). Es un parámetro **provisional**.

**Temperatura (provisional, desactivada si el coeficiente es 0)**

```text
factor = 1 + (k / 100) · (T − 37)
I_física = I_raw · factor
```

`k` está en %/°C. No es una compensación clínica. Con k = 0, `applyTemperatureInfluence` y `applyTemperatureCompensation` son la identidad.

**Oxígeno (provisional)**

La unidad de nivel es `sim`. No es mmHg ni saturación. El valor por defecto es 50 sim y la sensibilidad por defecto es 1 nA/sim. Ambos son **PROVISIONAL / SIMULATION PARAMETER**.

```text
I_oxígeno = nivel · sensibilidad + baseline + drift + ruido
```

Ese canal tiene su propio VREF, RF y CF. No comparte el estado del TIA ni del filtro de glucosa.

**Influencia oxígeno → glucosa (apagada por defecto)**

```text
si el interruptor está OFF, o el coeficiente es 0:
    I = I_glucosa
si el interruptor está ON:
    factor_O2 = 1 + (k_O2 / 100) · (nivel − 50)
    I = I_glucosa · factor_O2
```

`applyOxygenInfluence()` es la única función de ese cruce. Está preparada para sustituirse por un modelo experimental. No se cancela sola en la estimación: si se enciende, el experimento 1 muestra el efecto sobre la glucosa estimada. Con el interruptor apagado, cambiar el oxígeno no cambia la glucosa estimada.

**TIA**

```text
I(A) = I(nA) · 1e−9
VOUT = VREF + I(A) · RF
```

Saturación si `VOUT <= 0` o `VOUT >= VCC` (3.3 V). A partir de ese punto la cadena usa la tensión recortada al raíl.

**Filtro**

```text
fc = 1 / (2 · π · RF · CF)
RC = RF · CF
alpha = dt / (RC + dt)
V_filtrada = V_anterior + alpha · (V_TIA − V_anterior)
```

Con RF = 1 MΩ y CF = 100 nF, RC = 0.1 s y fc ≈ 1.592 Hz. En reposo (simulación parada) se muestra el estado estacionario, ganancia 1 en DC. Durante la simulación el filtro es discreto, con paso fijo de 0.1 s (10 Hz).

**ADC**

```text
ADC_MAX = 2^N − 1
ADC_COUNT = round(V / VREF_ADC · ADC_MAX)   recortado a [0, ADC_MAX]
V_ADC = ADC_COUNT / ADC_MAX · VREF_ADC
LSB = VREF_ADC / ADC_MAX
```

**Reconstrucción y calibración**

```text
I_recuperada (nA) = (V_ADC − VREF) / RF · 1e9
I_compensada = I_recuperada / factor
glucosa_estimada = (I_compensada − baseline − drift) / sensibilidad
```

El baseline y el drift configurados se restan. El ruido no se resta: la estimación no conoce la muestra aleatoria.

**Ruido**

Gaussiano de media cero, generado con Box-Muller (`gaussianNoise`). La desviación es el RMS configurado, de 0 a 50 nA. Cambia en cada paso de la simulación.

**Glucosa en mmol/L**

```text
mmol/L = mg/dL / 18.01559
```

## Caso de referencia

Con glucosa 200 mg/dL, sensibilidad 1, temperatura 37 °C, ruido 0, drift 0, baseline 0, VREF 1.65 V, RF 1 MΩ y ADC de 12 bit a 3.3 V:

| Etapa | Valor |
| --- | --- |
| Corriente | 200 nA |
| VOUT | 1.850 V |
| ADC | 2296 |
| Corriente recuperada | ≈ 200.26 nA |
| Glucosa estimada | ≈ 200.26 mg/dL |

La diferencia de ≈ 0.26 mg/dL es el error de cuantificación del ADC de 12 bit, no un ajuste escondido. Al abrir la página, la línea de referencia y el panel **ENGINEERING DEBUG** muestran el resultado de las pruebas internas.

## Parámetros provisionales

Estos valores **no** provienen de un electrodo caracterizado:

- Sensibilidad: 1 mg/dL = 1 nA
- Baseline: 0 nA
- Drift: desplazamiento constante configurable, no un modelo temporal de deriva real
- Ruido: RMS gaussiano blanco, no un espectro medido
- Coeficiente de temperatura: 0 %/°C y fórmula lineal alrededor de 37 °C
- Oxígeno: unidad `sim`, nivel 50, sensibilidad 1 nA/sim
- Influencia oxígeno → glucosa: apagada, coeficiente 0
- ADC CH3: escala provisional entre 30 °C y 42 °C. La temperatura que usa el algoritmo es el valor del control, en °C

La relación provisional:

**1 mg/dL = 1 nA**

**no corresponde todavía a un electrodo físico caracterizado.** Debe sustituirse por la curva experimental del electrodo real. Hasta entonces el modelo es lineal a propósito y está marcado como PROVISIONAL en la interfaz.

## Qué habrá que reemplazar con datos experimentales

- Curva glucosa → corriente (puede dejar de ser lineal)
- Baseline y su dependencia del electrodo
- Deriva real en el tiempo
- Densidad espectral de ruido del sensor
- Coeficiente de temperatura medido, y la forma de la compensación
- Curva del sensor de oxígeno y su unidad física
- Relación experimental entre oxígeno y la corriente del sensor de glucosa (`applyOxygenInfluence`)
- Sensor físico de temperatura en el canal CH3
- Eventualmente, la función de transferencia del electrodo implantable

RF, CF, VREF, VCC y la resolución del ADC son parámetros de la electrónica de banco. Se eligen en el diseño; no describen al electrodo.

## Escenarios

Son señales de prueba, no registros clínicos:

- Stable glucose: el valor del slider
- Rising glucose: 80 → 300 mg/dL en 120 s
- Falling glucose: 340 → 60 mg/dL en 120 s
- Meal spike: subida simulada a 280 mg/dL y bajada a 150
- Hypothetical rapid change: escalones **artificiales** para estresar filtro y ADC. La glucosa verdadera salta de golpe cada 10 s. No es una señal fisiológica.
- Custom: el slider manda mientras corre la simulación

Las gráficas guardan como máximo 120 s y dibujan los últimos 60 s. El análisis transitorio usa **toda** la sesión, no ese buffer.

## Barrido de calibración

**RUN CALIBRATION SWEEP** evalúa 40, 50, 70, 100, 150, 200, 250, 300, 350 y 400 mg/dL en estado estacionario, sin ruido, con el resto de parámetros actuales. **Export CSV** descarga esa tabla.

## Métricas

Sobre el buffer de simulación (hasta 120 s):

- Error medio (con signo)
- Error absoluto medio
- RMSE
- Error máximo (valor absoluto)
- Error medio de cuantificación del ADC, en µV
- Muestras en las que el TIA de glucosa saturó desde el último RESET
- Muestras en las que el TIA de oxígeno saturó
- Muestras con clipping en ADC CH1 y en ADC CH2
- RMS del ruido de glucosa y del ruido de oxígeno en el buffer

La calidad de señal es GOOD, WARNING o INVALID. WARNING aparece por saturación de un TIA, clipping de un ADC o un RMS configurado por encima de 20 nA. INVALID aparece si una estimación deja de ser un número finito. Esos umbrales son de simulación, no criterios médicos.

## Experimentos

Calculan 121 puntos en estado estacionario, de 0 a 120 s, con la electrónica actual. No mueven la simulación en vivo.

- Experimento 1: glucosa 200 mg/dL, 37 °C, oxígeno de 0 a 100 sim
- Experimento 2: glucosa 200 mg/dL, oxígeno fijo, temperatura de 30 a 42 °C
- Experimento 3: oxígeno y temperatura fijos, glucosa de 40 a 400 mg/dL
- Experimento 4: glucosa, oxígeno, temperatura, drift y ruido a la vez

**EXPORT CSV** descarga esa tabla. El CSV del barrido de calibración de glucosa sigue siendo independiente.

## Simulation results

**STOP & ANALYZE** detiene la ejecución y conserva **todas** las muestras desde START, no solo la ventana de 120 s de las gráficas. **PAUSE** no cierra la sesión.

El panel muestra duración, número de muestras, calidad de señal y métricas de glucosa, oxígeno y temperatura. Las exportaciones son:

- `biosense_simulation_YYYY-MM-DD_HH-MM-SS.pdf` — informe único para archivar
- `biosense_simulation_YYYY-MM-DD_HH-MM-SS_raw.csv`
- `biosense_simulation_YYYY-MM-DD_HH-MM-SS_summary.csv`
- `biosense_simulation_YYYY-MM-DD_HH-MM-SS.json`
- `biosense_simulation_YYYY-MM-DD_HH-MM-SS_report.html`
- `biosense_simulation_YYYY-MM-DD_HH-MM-SS_transitions.csv` — un evento de escalón por fila; solo cabecera si no hay escalones

**EXPORT PDF** descarga un solo archivo con configuración, métricas, avisos y gráficas del run completo. CSV y JSON siguen disponibles si hace falta análisis posterior.

## Transient Response Analysis

Tras **STOP & ANALYZE** el simulador distingue dos cosas distintas:

1. **Error en estado estacionario** — precisión cuando la glucosa real ya no cambia.
2. **Error transitorio** — retraso del filtro y de la cadena de señal cuando la glucosa real sí cambia.

Hay dos análisis, porque no todos los escenarios son escalones:

**A. Respuesta a escalón (`transientAnalysis`)**

Se detecta un escalón solo si `|actual[n] − actual[n−1]| ≥ 5 mg/dL`. El escenario *rapid* genera esos saltos cada 10 s. *Rising*, *falling* y *meal* usan curvas suaves `ease01()` y **no** deben producir una tormenta de eventos.

Para cada escalón se calcula:

- tiempo de establecimiento ±5 mg/dL, con 1.0 s seguido dentro de la banda (el número de muestras sale del `dt` real, no está fijado a 10)
- tiempo de establecimiento ±2 %, con banda `max(|target| · 0.02, 1.0)` y la misma regla de 1.0 s
- tiempo de subida 10–90 % o de bajada 90–10 %, con interpolación lineal entre muestras
- error de pico, MAE y RMSE **del evento** (no sustituyen el MAE/RMSE de la sesión)
- overshoot (subida) / undershoot (bajada)
- error medio y MAE en estado estacionario **después** de establecerse a ±5 mg/dL

Si no entra en banda antes del siguiente escalón, `settling_time = null` y el estado es `NOT_SETTLED_BEFORE_NEXT_STEP`.

**B. Seguimiento continuo (`trackingAnalysis`)**

Para rampas suaves. Una muestra se considera en movimiento si la derivada de la glucosa **real** supera 0.25 mg/dL/s. Ese umbral es de análisis de simulación, no médico. También se estima un retardo de ingeniería (0 a 5 s) que minimiza el RMSE entre `estimated(t)` y `actual(t − lag)`.

**Respuesta RC teórica**

En el panel se muestran RC, fc, `dt`, alpha y los tiempos de primer orden `t63.2 ≈ τ`, `t90 ≈ 2.303 τ`, `t95 ≈ 2.996 τ`, `t98 ≈ 3.912 τ`. Son valores teóricos del filtro electrónico. **No** son la respuesta de un sensor electroquímico real: esa dinámica todavía no está modelada.

El escenario *rapid* cambia la glucosa verdadera de forma instantánea. El error transitorio grande mide sobre todo la cadena filtro/ADC ante un escalón artificial.

> Step-response metrics characterize the simulated electronic/filter chain under artificial instantaneous glucose changes. Real electrochemical sensor dynamics are not yet modeled.
