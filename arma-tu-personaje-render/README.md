# Arma tu personaje

Configurador de personajes por departamento para Paguetodo, e-bCORP y Sirvalor ("Jugamos alineados").

- `public/index.html`: configurador público. El botón «Generar personaje» guarda la selección en la base de datos.
- `public/admin.html`: panel privado (clave ADMIN_TOKEN) para ver, filtrar, marcar y exportar solicitudes.
- `server.mjs`: servidor Node que publica la página y guarda en Postgres.

Variables de entorno en Render: `DATABASE_URL`, `ADMIN_TOKEN`.
