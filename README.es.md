# Stratum

*[Read in English](README.md)*

**Un gateway de IA de código abierto que aplica las políticas de IA de tu
organización dentro de tu propia red, y muestra cuánto te cuesta la IA: en
plata, y en energía, agua y emisiones.**

![Consumo: costo, tokens y emisiones estimadas por equipo](docs/images/consumo.png)

Stratum se ubica entre tus aplicaciones y los proveedores de LLM (OpenAI,
Anthropic, Gemini, Mistral, Groq, Azure OpenAI, Ollama y otras APIs
compatibles con OpenAI). Autentica a cada persona, agente y aplicación,
aplica la política, la cuota y el presupuesto de cada equipo, evita que
datos personales y secretos lleguen al proveedor, y reenvía la consulta con
las credenciales de proveedor de tu organización. Los prompts y las
respuestas no salen de tu red salvo hacia el proveedor que elegiste.

## Probalo con un comando

```sh
git clone https://github.com/getstratum/stratum && cd stratum
make demo
```

Solo necesita Docker. Levanta la consola en <http://localhost:3000>, un
gateway, un LLM simulado en lugar de proveedores reales (sin claves, no se
paga nada) y una organización de demo con cuatro semanas de uso.
`make demo-down` la borra. Detalles y cuentas de la demo:
[deploy/demo](deploy/demo/README.md).

## Qué hace

**Control**

- Equipos, personas, agentes y claves; una política por equipo con los
  proveedores y modelos que puede usar, una cuota mensual de tokens, un
  presupuesto en US$ que puede cortar las consultas cuando se gasta, y un
  máximo de tokens por consulta.
- Los datos personales y secretos que aparecen en un prompt se ocultan antes
  de llegar al proveedor, o la consulta se rechaza, según diga la política.
- Un agente puede tener un modelo fijo; un modelo se puede apagar para toda
  la organización.
- Las aplicaciones construidas sobre el gateway (un portal de chat, un
  asistente interno) actúan **en nombre de personas** (`X-Stratum-User`):
  se aplica la política, la cuota y el presupuesto del equipo de cada
  persona, y el uso queda a su nombre. Esas aplicaciones pueden hacer que
  las personas inicien sesión con su cuenta de la consola (OpenID Connect).
- **Instrucciones para personas**: un texto en la política del equipo que
  el gateway pone primero en la instrucción de sistema de esas consultas, y
  que la aplicación puede mostrar.

**Visibilidad**

- *Consumo*: costo, tokens, errores, consultas rechazadas y latencia, por
  equipo, agente, persona, modelo, proveedor o etiqueta
  (`X-Stratum-Labels`), con la serie diaria.
- **Impacto ambiental estimado** de cada consulta: energía, agua y CO2e,
  como rango, con el método y los datos de
  [EcoLogits](https://github.com/mlco2/ecologits). Se ve en Consumo, por
  cada 1.000 tokens en Modelos, y en Inicio. Los modelos sin estimación se
  cuentan como faltantes, nunca como cero.
- Registro de consultas (solo metadatos, nunca prompts) con exportación a
  CSV, auditoría de cada cambio en la consola, alertas por email o webhook
  de Slack, un catálogo de modelos con precios que se actualiza solo, y
  métricas de Prometheus con las convenciones semánticas de GenAI.

**Operación**

- El gateway es un binario de Go (solo biblioteca estándar). Sigue
  respondiendo cuando todo menos el proveedor de LLM está caído: la
  configuración es una foto en memoria, persistida cifrada, y ni el plano
  de control, ni una base de datos, ni Valkey se llaman en el camino de la
  consulta.
- Charts de Helm para los dos planos, en alta disponibilidad por defecto;
  reglas de alerta de SLO por tasa de consumo; un despliegue de referencia
  en Google Cloud con pruebas de fallas (Stratum: 0 errores en 52.805
  consultas durante un reinicio progresivo, la pérdida de una zona, un
  failover de la base de datos y caídas de Valkey y del plano de control,
  [informe](docs/testing/gcp-2026-10-18.md)).
- Imágenes multiarquitectura firmadas, SBOM y procedencia SLSA en cada
  versión.
- Cinco roles en la consola verificados en el servidor, sesiones en el
  servidor, segundo factor obligatorio para Owner y Admin.

La consola está en español; la API, la documentación y el código, en
inglés.

<table>
<tr>
<td><img src="docs/images/inicio.png" alt="Inicio: la organización de un vistazo"></td>
<td><img src="docs/images/modelos.png" alt="Modelos: el catálogo, con precios y emisiones cada 1.000 tokens"></td>
</tr>
</table>

## Cómo está hecho

Dos planos:

- **Gateway (plano de datos)**, que corre en tu red, cerca de tus
  aplicaciones.
- **Plano de control**, donde administrás equipos, claves, políticas y
  proveedores, y ves el uso. Puede correr en cualquier lado; los gateways
  solo le piden configuración y le informan el uso (solo metadatos).

Arquitectura: [docs/architecture](docs/architecture/overview.md) (en
inglés).

> **Estado: pre-release (0.x).** La API y la configuración todavía pueden
> cambiar. Ver la [lista para el release](docs/release-checklist.md) y, si
> venís de una versión anterior, [docs/upgrading.md](docs/upgrading.md).

## Para seguir

- Gateway solo, sin plano de control, configurado con un archivo; con el
  plano de control en Docker Compose; o en Kubernetes con alta
  disponibilidad: los arranques rápidos del [README en inglés](README.md#quick-start-standalone-gateway).
- Cómo llamar al gateway y su configuración:
  [README en inglés](README.md#calling-the-gateway).
- La consola: [docs/console](docs/console).

## Contribuir y seguridad

Ver [CONTRIBUTING.md](CONTRIBUTING.md). Las vulnerabilidades se reportan de
forma privada, como dice [SECURITY.md](SECURITY.md).

## Licencia

[MIT](LICENSE) © 2026 Matech SAS, salvo el método y los datos de impacto
ambiental en `control-plane/dashboard/lib/impacts`, portados de EcoLogits y
bajo la [MPL-2.0](control-plane/dashboard/lib/impacts/data/LICENSE-MPL-2.0)
archivo por archivo.
