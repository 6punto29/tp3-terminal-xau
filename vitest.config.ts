// ─────────────────────────────────────────────────────────────────────────────
// vitest.config.ts
// Configuración mínima de vitest para resolver el alias "@/*" definido en
// tsconfig.json ("paths": { "@/*": ["./*"] }).
//
// Sin este archivo, vitest no entiende imports como "@/lib/engine/simulator"
// y los tests fallan con "Failed to load url". TypeScript (vía tsc) sí los
// entiende, pero vitest usa su propio resolver y necesita su propia config.
//
// Creado 07/06/2026 noche (sesión post C2 — handoff v17).
// Sin nuevas dependencias: usa "vitest/config" que ya viene con vitest 1.6.0.
// ─────────────────────────────────────────────────────────────────────────────

import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./"),
    },
  },
});
