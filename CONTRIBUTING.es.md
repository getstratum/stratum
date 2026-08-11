# Cómo contribuir a Stratum

Gracias por tu interés en contribuir. Este documento explica cómo empezar.

## Formas de contribuir

- **Reportar bugs** — abrí un issue usando el template de bug report
- **Sugerir features** — abrí un issue usando el template de feature request
- **Pull requests** — las contribuciones de código son bienvenidas
- **Documentación** — mejoras a docs, ejemplos y guías
- **Comunidad** — respondé preguntas en Discussions

## Setup local

```bash
git clone https://github.com/getstratum/stratum.git
cd stratum
cp .env.example .env
# Agregá tus API keys al .env
docker compose up -d --build
docker exec -it $(docker compose ps -q proxy) node /app/src/migrate.js
docker exec -it $(docker compose ps -q proxy) node /app/src/seed-passwords.js
```

Dashboard: http://localhost:3000 — login con `dev@acme.com` / `dev123`

## Hacer un pull request

1. Forkear el repositorio
2. Crear una branch: `git checkout -b feat/tu-feature`
3. Hacer los cambios
4. Testear localmente con `docker compose up --build`
5. Abrir un PR contra `main`

## Reportar una vulnerabilidad de seguridad

**No** abras un issue público para vulnerabilidades de seguridad. Usá el feature de security advisory de GitHub o contactá a los maintainers directamente.

## Licencia

Al contribuir, aceptás que tus contribuciones estarán bajo la licencia MIT.
