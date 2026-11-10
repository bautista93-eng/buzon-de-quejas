-- Buzón de quejas — esquema D1
-- Ejecutar en la base D1 (wrangler d1 execute ... --remote) o desde
-- el dashboard de Cloudflare (D1 > tu base > Console).

CREATE TABLE IF NOT EXISTS quejas (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  texto     TEXT    NOT NULL CHECK (length(texto) BETWEEN 1
